import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function toolOutput(result) {
  const parts = result.content ?? [
    { type: "text", text: JSON.stringify(result) },
  ];
  return {
    success: !result.isError,
    contentItems: parts.map((part) =>
      part.type === "image"
        ? {
            type: "inputImage",
            imageUrl: `data:${part.mimeType};base64,${part.data}`,
          }
        : {
            type: "inputText",
            text: part.type === "text" ? part.text : JSON.stringify(part),
          },
    ),
  };
}

// Dynamic tools are served by the same Maestro client that owns the visible stream.
export async function runCodex(prompt, tools, env, emit) {
  const cwd = await mkdtemp(join(tmpdir(), "maestro-codex-"));
  const child = spawn(
    env.CODEX_BIN || "codex",
    [
      "app-server",
      "--stdio",
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "apps",
      "--disable",
      "plugins",
    ],
    {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let latestError = "";
  child.stderr.on("data", (chunk) => {
    latestError = (latestError + chunk).slice(-1500);
  });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const write = (message) =>
        child.stdin.write(JSON.stringify(message) + "\n");
      const request = (id, method, params) => write({ id, method, params });
      let threadId;
      let reply = "";
      let calls = 0;
      const streamedMessages = new Set();
      const pendingSetup = new Set([1, 2, 3]);
      async function handle(message) {
        if (message.error && pendingSetup.has(message.id))
          throw new Error(message.error.message);
        if (!message.method && pendingSetup.delete(message.id)) {
          if (message.id === 1) {
            write({ method: "initialized", params: {} });
            request(2, "thread/start", {
              cwd,
              ephemeral: true,
              approvalPolicy: "never",
              sandbox: "read-only",
              ...(env.MODEL ? { model: env.MODEL } : {}),
              baseInstructions:
                "You operate the user's device through the provided Maestro tools. The Viewer is already open. Use only the supplied Maestro tools. Reply in the user's language and report actual results.",
              dynamicTools: Object.entries(tools).map(([name, tool]) => ({
                type: "function",
                name,
                description: tool.description || name,
                inputSchema: tool.inputSchema.jsonSchema,
              })),
            });
          } else if (message.id === 2) {
            threadId = message.result.thread.id;
            request(3, "turn/start", {
              threadId,
              input: [{ type: "text", text: prompt }],
            });
          }
          return;
        }
        const p = message.params;
        if (message.method === "item/tool/call" && p.threadId === threadId) {
          if (++calls > 32) throw new Error("Codex reached the 32-tool limit.");
          if (!Object.hasOwn(tools, p.tool))
            throw new Error("Unknown Maestro tool: " + p.tool);
          console.error("[Codex → Maestro MCP]", p.tool);
          const result = await tools[p.tool].execute(p.arguments, {
            toolCallId: p.callId,
            messages: [],
          });
          write({ id: message.id, result: toolOutput(result) });
        } else if (message.id != null && message.method) {
          write({
            id: message.id,
            error: { code: -32601, message: "Unsupported Viewer request" },
          });
        } else if (
          message.method === "item/agentMessage/delta" &&
          p.threadId === threadId
        ) {
          streamedMessages.add(p.itemId);
          emit?.("delta", p.delta);
        } else if (
          message.method === "item/completed" &&
          p.threadId === threadId &&
          p.item.type === "agentMessage"
        ) {
          reply = p.item.text;
          if (!streamedMessages.delete(p.item.id)) emit?.("line", reply);
          else emit?.("delta", "\n");
        } else if (
          message.method === "turn/completed" &&
          p.threadId === threadId
        ) {
          if (p.turn.status !== "completed")
            throw new Error(
              p.turn.error?.message || "Codex turn " + p.turn.status,
            );
          resolve(reply || "Finished.");
        }
      }
      lines.on("line", (line) => {
        try {
          handle(JSON.parse(line)).catch(reject);
        } catch (error) {
          reject(error);
        }
      });
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.once("exit", (code) =>
        reject(new Error("Codex exited (" + code + "). " + latestError.trim())),
      );
      timer = setTimeout(
        () => reject(new Error("Codex did not finish within 10 minutes.")),
        600000,
      );
      request(1, "initialize", {
        clientInfo: { name: "maestro_viewer", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
    await rmdir(cwd).catch(() => {});
  }
}
