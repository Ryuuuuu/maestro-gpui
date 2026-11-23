import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export async function modelConfig() {
  try {
    const file = await readFile(new URL("../.env", import.meta.url), "utf8");
    return { ...process.env, ...parseEnv(file) };
  } catch (error) {
    if (error.code === "ENOENT") return process.env;
    throw error;
  }
}
