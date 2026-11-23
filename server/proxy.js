import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { modelConfig } from "./config.js";
import { chooseFlowPath } from "./save-dialog.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const interpreter = join(root, ".tools", "proxy", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const pageSize = 20;
const readDetail = promisify(execFile);

export function trafficRecorder(choosePath = chooseFlowPath) {
  const runs = new Map();
  const pending = new Map();
  let state = "off", message = "", device = "", platform = "", port = 0;
  let child, exited, directory, active, closing;

  function snapshot(id, page = 0) {
    const list = [...runs.values()].reverse();
    const run = runs.get(id) || list[0];
    const pages = Math.max(1, Math.ceil((run?.rows.length || 0) / pageSize));
    page = Math.min(pages - 1, Math.max(0, Number.parseInt(page, 10) || 0));
    const end = (run?.rows.length || 0) - page * pageSize;
    return { state, message, device, platform, port, selected: run?.id, page, pages,
      runs: list.map(({ rows, ...info }) => ({ ...info, count: rows.length })),
      rows: run?.rows.slice(Math.max(0, end - pageSize), end).reverse() || [] };
  }

  async function start(target, reservedPorts = []) {
    if (closing || state !== "off") throw new Error("프록시 상태를 확인하세요.");
    state = "starting";
    device = target.deviceId;
    platform = target.platform;
    message = "";
    try {
      directory ??= await mkdtemp(join(tmpdir(), "maestro-traffic-"));
      const config = await modelConfig();
      if (closing) throw new Error("Viewer 종료 중입니다.");
      child = spawn(interpreter, ["-u", join(root, "server/proxy_worker.py"), directory, platform, device, ...reservedPorts.map(String)], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", MAESTRO_PROXY_HTTPS_HOSTS: config.MAESTRO_PROXY_HTTPS_HOSTS || "" },
      });
      const worker = child;
      worker.stdin.on("error", () => {});
      let failure = "";
      let ready, fail;
      const startup = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
      const timeout = setTimeout(() => {
        failure = "프록시 시작 시간이 초과되었습니다.";
        worker.stdin.end();
        fail(new Error(failure));
      }, 45000);
      worker.stderr.setEncoding("utf8").on("data", text => { failure = (failure + text).slice(-1000); });
      worker.once("error", error => {
        failure = error.code === "ENOENT" ? "npm run setup:proxy 로 mitmproxy를 먼저 설치하세요." : error.message;
      });
      createInterface({ input: worker.stdout }).on("line", line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.ready) { port = event.ready; state = "on"; ready(); }
        if (event.fatal) failure = event.fatal;
        if (event.row) {
          const rows = runs.get(event.run)?.rows;
          if (rows) rows.push({ ...event.row, index: rows.length });
        }
        const reply = pending.get(event.ack);
        if (reply) {
          pending.delete(event.ack);
          if (event.error) reply.reject(new Error(event.error));
          else reply.resolve();
        }
      });
      exited = new Promise(resolve => worker.once("close", code => {
        const error = new Error(failure || "프록시 연결이 종료되었습니다.");
        fail(error);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        if (active) { active.status = "중단"; active = null; }
        message = code === 0 && state === "stopping" ? "" : error.message;
        child = null; port = 0; state = "off";
        resolve();
      }));
      try { await startup; } finally { clearTimeout(timeout); }
    } catch (error) {
      if (!child) state = "off";
      message = error.message;
      throw error;
    }
  }

  async function stop() {
    if (!child) return;
    state = "stopping";
    child.stdin.end();
    await exited;
    if (message) throw new Error(message);
  }

  function command(op, run) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ op, run, id }) + "\n", error => {
        if (error && pending.delete(id)) reject(error);
      });
    });
  }

  return {
    snapshot, start, stop,
    async detail(id, index) {
      const row = runs.get(id)?.rows[index];
      if (!row || !Number.isInteger(row.offset)) throw new Error("통신 기록을 찾을 수 없습니다.");
      const { stdout } = await readDetail(interpreter, [join(root, "server/proxy_detail.py"),
        join(directory, id + ".mitm"), String(row.offset)], { windowsHide: true, timeout: 15000 });
      return JSON.parse(stdout);
    },
    async begin(label, target) {
      if (state === "off") return;
      if (state !== "on" || target !== device)
        throw new Error("프록시에 연결된 기기를 선택한 후 동선을 실행하세요.");
      const run = { id: randomUUID(), label: String(label).slice(0, 160), device, started: Date.now(), status: "수집 중", rows: [] };
      runs.set(run.id, run);
      active = run;
      try { await command("begin", run.id); }
      catch (error) { active = null; runs.delete(run.id); throw error; }
      return run.id;
    },
    async finish(id, success) {
      if (!id || active?.id !== id) return;
      const run = active;
      try { await command("finish", id); run.status = success ? "완료" : "실패"; }
      catch (error) { run.status = "중단"; message = error.message; }
      finally { active = null; }
    },
    async save(id) {
      const run = runs.get(id);
      if (!run || run === active || !run.rows.length) throw new Error("저장할 통신 기록이 없습니다.");
      const folder = join(root, "captures");
      await mkdir(folder, { recursive: true });
      const name = run.label.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 48);
      const path = await choosePath(folder, `traffic-${name}-${id.slice(0, 8)}.mitm`, "mitm");
      if (!path) return null;
      const tmp = join(dirname(path), "." + randomUUID() + ".tmp");
      try {
        await copyFile(join(directory, id + ".mitm"), tmp);
        await rename(tmp, path);
      } finally { await rm(tmp, { force: true }); }
      return path;
    },
    close() {
      return closing ??= (async () => {
        try { await stop(); } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })();
    },
  };
}
