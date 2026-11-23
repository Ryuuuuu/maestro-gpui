import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Standard USB keyboard descriptor: eight modifier bits and six HID key usages.
const descriptor = [
  5, 1, 9, 6, 161, 1, 5, 7, 25, 224, 41, 231, 21, 0, 37, 1, 117, 1, 149, 8, 129,
  2, 149, 1, 117, 8, 129, 1, 149, 6, 117, 8, 21, 0, 38, 255, 0, 25, 0, 42, 255,
  0, 129, 0, 192,
];

export function androidKeyboard() {
  let active,
    serial,
    idle,
    queue = Promise.resolve();
  function close() {
    clearTimeout(idle);
    active?.stdin.end();
    active = undefined;
  }
  async function tap(device, code, shift) {
    clearTimeout(idle);
    if (!active || serial !== device) {
      close();
      const proc = spawn("adb", ["-s", device, "shell", "-T", "hid", "-"], {
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      active = proc;
      serial = device;
      let reason = "";
      proc.stderr.on("data", (data) => {
        reason = (reason + data).slice(-512);
      });
      proc.stdin.on("error", () => {});
      proc.on("close", () => {
        if (active === proc) active = undefined;
      });
      await once(proc, "spawn");
      proc.stdin.write(
        JSON.stringify({
          id: 1,
          command: "register",
          name: "Maestro Viewer Keyboard",
          vid: 0x18d1,
          pid: 0x502d,
          bus: "usb",
          descriptor,
        }) + "\n",
      );
      await delay(1000);
      if (active !== proc)
        throw new Error(
          reason || "Android 하드웨어 키보드를 연결할 수 없습니다.",
        );
    }
    const input = active.stdin;
    idle = setTimeout(close, 90_000);
    idle.unref();
    for (const report of [
      [shift ? 2 : 0, 0, code, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]) {
      await new Promise((resolve, reject) =>
        input.write(
          JSON.stringify({ id: 1, command: "report", report }) + "\n",
          (err) => (err ? reject(err) : resolve()),
        ),
      );
    }
  }
  return {
    close,
    tap(device, code, shift) {
      if (
        typeof device !== "string" ||
        !device ||
        device.length > 256 ||
        !Number.isInteger(code) ||
        code < 4 ||
        code > 144
      )
        throw new Error("잘못된 키 입력입니다.");
      const result = queue.then(() => tap(device, code, shift));
      queue = result.catch(() => {});
      return result;
    },
  };
}
