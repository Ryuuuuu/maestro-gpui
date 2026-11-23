import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, stepCountIs, tool, jsonSchema } from "ai";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { once } from "node:events";
import { modelConfig } from "./config.js";
import { flowLibrary } from "./library.js";
import { flowHistory } from "./flows.js";
import { runCodex } from "./codex.js";

export function selectModel(env) {
  if (!env.MODEL) throw new Error("Set MODEL and MODEL_PROVIDER in .env");
  switch (env.MODEL_PROVIDER) {
    case "openai":
      return createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.MODEL);
    case "anthropic":
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.MODEL);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      })(env.MODEL);
    case "local":
      return createOpenAICompatible({
        name: "local",
        baseURL: env.MODEL_BASE_URL || "http://127.0.0.1:11434/v1",
        apiKey: env.LOCAL_API_KEY,
      })(env.MODEL);
    default:
      throw new Error(
        "MODEL_PROVIDER must be openai, anthropic, google or local",
      );
  }
}

export async function openSession({
  readModelConfig = modelConfig,
  library = flowLibrary(),
} = {}) {
  const launchEnv = await modelConfig();
  // Maestro probes the same port range in every process. Ask the OS for
  // independent ephemeral ports when the web and desktop launch together.
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const transport = new StdioClientTransport({
    command: launchEnv.MAESTRO_BIN || "maestro",
    args: ["mcp", "--viewer-port", String(port)],
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(launchEnv).filter(
        ([key]) =>
          ![
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GOOGLE_GENERATIVE_AI_API_KEY",
            "LOCAL_API_KEY",
          ].includes(key),
      ),
    ),
  });
  let timeout;
  const ready = new Promise((resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Maestro did not announce its Viewer URL. Check maestro mcp and Java.",
          ),
        ),
      45000,
    );
    createInterface({ input: transport.stderr }).on("line", (line) => {
      const match = line.match(
        /^mcp_viewer_ready (http:\/\/127\.0\.0\.1:\d+)\s*$/,
      );
      if (match) resolve(match[1]);
      else console.error(line);
    });
  });
  try {
    const [viewer, client] = await Promise.all([
      ready,
      createMCPClient({ transport }),
    ]);
    const flows = flowHistory();
    return {
      flows,
      library,
      async runSaved(name, device, emit) {
        const steps = await library.steps(name);
        if (!device) {
          const response = await fetch(viewer + "/api/device/targets");
          const targets = (await response.json()).devices;
          if (targets?.length !== 1)
            throw new Error("실행할 기기를 먼저 연결하거나 선택하세요.");
          device = targets[0].deviceId;
        }
        emit?.("line", "▶ flows/" + name);
        return this.replay(steps, device, emit);
      },
      async replay(steps, device, emit) {
        const tools = await client.tools();
        if (!tools.run)
          throw new Error("Maestro MCP run 도구를 찾을 수 없습니다.");
        for (const [index, step] of steps.entries()) {
          emit?.("line", "→ run " + (index + 1) + "/" + steps.length);
          const result = await tools.run.execute(
            { ...step, device_id: device },
            { toolCallId: "replay-" + index, messages: [] },
          );
          if (result.isError)
            throw new Error(
              result.content?.find((p) => p.type === "text")?.text ||
                "동선 실행 실패",
            );
          emit?.("line", "✓ run " + (index + 1) + "/" + steps.length);
        }
        return "동선 실행 완료";
      },
      viewer,
      close: () => client.close(),
      async prompt(prompt, emit, device) {
        if (/^\/run(?:\s|$)/.test(prompt))
          return this.runSaved(prompt.slice(4).trim(), device, emit);
        const record = flows.begin(prompt);
        const env = await readModelConfig();
        const tools = await client.tools();
        tools.search_saved_flows = tool({
          description:
            "Search the project flows directory by partial filename; use before running a saved flow. Empty query lists all files.",
          inputSchema: jsonSchema({
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          }),
          execute: async ({ query }) => ({
            content: [
              { type: "text", text: JSON.stringify(await library.list(query)) },
            ],
          }),
        });
        tools.run_saved_flow = tool({
          description:
            "Execute an existing saved flow by its exact filename from search_saved_flows on the current device. Ask for clarification if the request matches several files.",
          inputSchema: jsonSchema({
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          }),
          execute: async ({ name }) => ({
            content: [
              { type: "text", text: await this.runSaved(name, device, emit) },
            ],
          }),
        });
        emit?.(
          "line",
          "• " + env.MODEL_PROVIDER + (env.MODEL ? " / " + env.MODEL : ""),
        );
        for (const [name, tool] of Object.entries(tools)) {
          const execute = tool.execute;
          tool.execute = async (...args) => {
            if (device && ["run", "inspect_screen", "take_screenshot"].includes(name))
              args[0] = { ...args[0], device_id: device };
            const commit = name === "run" ? record(args[0]) : undefined;
            emit?.("line", "→ " + name);
            try {
              const result = await execute(...args);
              commit?.(result);
              emit?.("line", (result?.isError ? "× " : "✓ ") + name);
              return result;
            } catch (error) {
              emit?.("line", "× " + name + " · " + error.message);
              throw error;
            }
          };
        }
        if (device) prompt = `Selected Maestro device: ${JSON.stringify(device)}\n\n${prompt}`;
        if (env.MODEL_PROVIDER === "codex")
          return runCodex(prompt, tools, env, emit);
        const model = selectModel(env);
        const options = {
          model,
          tools,
          prompt,
          system:
            "Use the connected Maestro MCP tools to carry out the requested device task. When asked to execute a saved flow, search_saved_flows by filename, ask which file if ambiguous, then call run_saved_flow with the exact match. Report what you observed in the user’s language.",
          stopWhen: stepCountIs(32),
          maxRetries: 0,
        };
        let result;
        if (emit) {
          const stream = streamText(options);
          for await (const part of stream.fullStream) {
            if (part.type === "text-delta") emit("delta", part.text);
            if (part.type === "text-end") emit("delta", "\n");
            if (part.type === "error") throw part.error;
          }
          result = {
            text: await stream.text,
            finishReason: await stream.finishReason,
          };
        } else result = await generateText(options);
        return (
          result.text ||
          (result.finishReason === "tool-calls"
            ? "Tool step limit reached."
            : "Finished.")
        );
      },
    };
  } catch (error) {
    await transport.close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
