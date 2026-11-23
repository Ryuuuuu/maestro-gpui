import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { chooseFlowPath } from "./save-dialog.js";
import { importFlow } from "./flows.js";

export function flowLibrary(
  directory = fileURLToPath(new URL("../flows/", import.meta.url)),
  choosePath = chooseFlowPath,
) {
  async function names() {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("flows 디렉토리를 사용할 수 없습니다.");
    return (await readdir(directory, { withFileTypes: true }))
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "ko"));
  }
  async function readDocument(name) {
    if (!(await names()).includes(name))
      throw new Error("저장된 동선 파일을 찾을 수 없습니다.");
    return readFile(join(directory, name), "utf8");
  }
  return {
    readDocument,
    async edit(name, base, text) {
      if (typeof base !== "string") throw new Error("원본 파일이 필요합니다.");
      importFlow(text);
      await readDocument(name);
      const path = join(directory, name);
      const lock = path + ".editing";
      await writeFile(lock, "", { flag: "wx" }).catch((error) => {
        if (error.code === "EEXIST")
          throw new Error("다른 창에서 저장 중입니다.");
        throw error;
      });
      const tmp = join(directory, "." + randomUUID() + ".tmp");
      try {
        if ((await readDocument(name)) !== base)
          throw new Error("파일이 변경되었습니다. 다시 불러온 뒤 저장하세요.");
        await writeFile(tmp, text, { flag: "wx" });
        await rename(tmp, path);
      } finally {
        await Promise.all([
          unlink(tmp).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          }),
          unlink(lock),
        ]);
      }
    },
    async list(query = "") {
      const term = query.normalize().toLowerCase();
      return (await names()).filter((n) =>
        n.normalize().toLowerCase().includes(term),
      );
    },
    async steps(name) {
      if (!(await names()).includes(name))
        throw new Error("저장된 동선 파일을 찾을 수 없습니다.");
      const path = join(directory, name);
      const yaml = await readFile(path, "utf8");
      const steps = importFlow(yaml);
      // Use the original path for ordinary Maestro YAML, preserving relative dependencies.
      return steps.length === 1 &&
        steps[0].yaml &&
        !steps[0].env &&
        steps[0].yaml === yaml
        ? [{ files: [path] }]
        : steps;
    },
    async save(label, yaml) {
      const stem =
        Array.from(label.normalize().replace(/[^\p{L}\p{N}_-]+/gu, "-"))
          .slice(0, 64)
          .join("")
          .replace(/^-+|-+$/g, "") || "flow";
      const prefix = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)
        ? "flow-" + stem
        : stem;
      const existing = new Set((await names()).map((n) => n.toLowerCase()));
      let name = prefix + ".yaml";
      for (let i = 2; existing.has(name.toLowerCase()); i++) {
        name = prefix + "-" + i + ".yaml";
      }
      const path = await choosePath(directory, name);
      if (!path) return null;
      const tmp = join(dirname(path), "." + randomUUID() + ".tmp");
      try {
        await writeFile(tmp, yaml, { flag: "wx" });
        await rename(tmp, path);
      } finally {
        await unlink(tmp).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return path;
    },
  };
}
