"""Local mitmproxy engine. Stdin controls run boundaries; stdout carries metadata."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from contextlib import contextmanager, nullcontext

from mitmproxy import ctx, io, options
from mitmproxy.tools.dump import DumpMaster


def emit(**event):
    print(json.dumps(event, ensure_ascii=True), flush=True)


@contextmanager
def device_lease(directory, device):
    """Serialize web/native routing and keep recovery information across disconnects."""
    stamp = directory / hashlib.sha256(device.encode()).hexdigest()
    with stamp.with_suffix(".lock").open("a+b") as lock:
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError("이 기기는 다른 Viewer에서 프록시를 사용 중입니다.") from error
        yield stamp.with_suffix(".json")


@contextmanager
def android_route(device, port, directory):
    def adb(*args):
        result = subprocess.run(["adb", "-s", device, *args], capture_output=True,
                                text=True, timeout=8,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "ADB 연결을 확인하세요.")
        return result.stdout.strip()

    def setting(key):
        return adb("shell", "settings", "get", "global", key)

    def restore(journal):
        if journal.exists():
            route = json.loads(journal.read_text())
            if setting("http_proxy") == route["address"]:
                adb("shell", "settings", "put", "global", "http_proxy", ":0")
                if route["previous"] != ":0":
                    adb("shell", "settings", "delete", "global", "http_proxy")
            forwards = [line.split()[-2:] for line in adb("reverse", "--list").splitlines()]
            if [route["remote"], route["local"]] in forwards:
                adb("reverse", "--remove", route["remote"])
            journal.unlink()

    with device_lease(directory, device) as journal:
        restore(journal)
        previous = setting("http_proxy")
        if (previous not in ("", "null", ":0") or
                setting("global_http_proxy_host") not in ("", "null") or
                setting("global_proxy_pac_url") not in ("", "null")):
            raise ValueError("기기에 다른 프록시가 설정되어 있습니다. 해당 프록시를 끈 후 다시 시도하세요.")
        remote = int(adb("reverse", "tcp:0", f"tcp:{port}"))
        address = f"127.0.0.1:{remote}"
        try:
            tmp = journal.with_suffix(".tmp")
            tmp.write_text(json.dumps(dict(address=address, previous=previous,
                                           remote=f"tcp:{remote}", local=f"tcp:{port}")))
            tmp.replace(journal)
        except OSError:
            adb("reverse", "--remove", f"tcp:{remote}")
            raise
        try:
            adb("shell", "settings", "put", "global", "http_proxy", address)
            if setting("http_proxy") != address:
                raise ValueError("Android 프록시 설정을 적용하지 못했습니다.")
            yield
        finally:
            restore(journal)


class Recorder:
    def __init__(self, directory, hosts, reserved_ports):
        self.directory = directory
        self.hosts = hosts
        self.reserved_ports = reserved_ports
        self.ready = asyncio.Event()
        self.file = None
        self.pending = {}

    def running(self):
        self.ready.set()

    def server_connect(self, data):
        # A proxied phone must not acquire the viewer's local control privileges.
        if data.server.address and data.server.address[1] in self.reserved_ports:
            data.server.error = "Reserved Viewer control port"

    def tls_clienthello(self, data):
        host = (data.client_hello.sni or "").lower().rstrip(".")
        if host not in self.hosts:
            data.ignore_connection = True

    def begin(self, run):
        if self.file or not re.fullmatch(r"[0-9a-f-]{36}", run):
            raise ValueError("잘못된 기록 시작 요청입니다.")
        self.file = (self.directory / (run + ".mitm")).open("xb")
        self.writer = io.FlowWriter(self.file)
        self.run = run

    def requestheaders(self, flow):
        if self.file:
            self.pending[flow.id] = flow

    http_connect = requestheaders

    def record(self, flow):
        if self.pending.pop(flow.id, None) is None:
            return
        offset = self.file.tell()
        self.writer.add(flow)
        self.file.flush()
        request, response = flow.request, flow.response
        emit(run=self.run, row={"offset": offset,
            "method": request.method, "host": request.host, "port": request.port,
            "path": request.path.split("?", 1)[0][:512], "time": request.timestamp_start,
            "status": response.status_code if response else None,
            "error": bool(flow.error),
            "bytes": len(response.raw_content or b"") if response else None,
        })

    response = record
    error = record
    http_connected = record
    http_connect_error = record

    def finish(self):
        if self.file:
            try:
                for flow in list(self.pending.values()):
                    self.record(flow)
            finally:
                self.file.close()
                self.file = None


async def main():
    directory, platform, device, *ports = sys.argv[1:]
    config = Path(__file__).resolve().parents[1] / ".tools" / "proxy-config"
    config.mkdir(parents=True, exist_ok=True)
    master = DumpMaster(options.Options(listen_host="127.0.0.1", listen_port=0,
                        confdir=str(config)), with_termlog=False, with_dumper=False)
    hosts = {h.strip().lower().rstrip(".") for h in os.getenv("MAESTRO_PROXY_HTTPS_HOSTS", "").split(",") if h.strip()}
    recorder = Recorder(Path(directory), hosts, set(map(int, ports)))
    master.addons.add(recorder)
    commands = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def read_commands():
        try:
            for line in sys.stdin:
                loop.call_soon_threadsafe(commands.put_nowait, json.loads(line))
        finally:
            loop.call_soon_threadsafe(commands.put_nowait, None)

    threading.Thread(target=read_commands, daemon=True).start()
    engine = asyncio.create_task(master.run())
    ready = asyncio.create_task(recorder.ready.wait())
    try:
        await asyncio.wait([engine, ready], return_when=asyncio.FIRST_COMPLETED)
        if engine.done():
            await engine
            raise RuntimeError("프록시 리스너 시작 실패")
        port = ctx.master.addons.get("proxyserver").listen_addrs()[0][1]
        route = android_route(device, port, config) if platform == "android" else nullcontext()
        with route:
            emit(ready=port)
            while True:
                cmd = await commands.get()
                if cmd is None:
                    break
                try:
                    if cmd["op"] == "begin":
                        recorder.begin(cmd["run"])
                    elif cmd["op"] == "finish":
                        recorder.finish()
                    else:
                        raise ValueError("알 수 없는 기록 요청")
                    emit(ack=cmd["id"])
                except Exception as error:
                    emit(ack=cmd["id"], error=str(error))
    finally:
        ready.cancel()
        recorder.finish()
        master.shutdown()
        await engine


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        emit(fatal=str(error))
        sys.exit(1)
