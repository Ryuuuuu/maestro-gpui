import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const win = process.platform === "win32";
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.env.PYTHON || (win ? "python" : "python3"), ["-m", "venv", ".tools/proxy"]);
run(join(root, ".tools/proxy", win ? "Scripts/python.exe" : "bin/python"), ["-m", "pip", "install", "-r", "server/requirements-proxy.txt"]);
