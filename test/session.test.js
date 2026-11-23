import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { openSession, selectModel } from "../server/session.js";
import { createViewerServer } from "../server/http.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}

test("provider selection preserves the configured model ID", () => {
  for (const provider of ["openai", "anthropic", "google", "local"]) {
    assert.equal(
      selectModel({ MODEL_PROVIDER: provider, MODEL: "configured-model" })
        .modelId,
      "configured-model",
    );
  }
});

test("prompt requests are local, serialized, and recover after failure", async (t) => {
  let release;
  const session = {
    prompt: () =>
      new Promise((_, reject) => {
        release = reject;
      }),
  };
  const server = createViewerServer(session);
  const url = await listen(server);
  t.after(() => server.close());
  const post = (body, headers) =>
    fetch(url + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ prompt: "x" }, { origin: "http://unrelated.test" })).status,
    403,
  );
  assert.equal((await post({ prompt: " " })).status, 400);
  const running = post({ prompt: "first" });
  while (!release) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post({ prompt: "second" })).status, 409);
  release(new Error("Model unavailable"));
  assert.equal((await running).status, 500);
  session.prompt = async (prompt) => prompt;
  assert.deepEqual(await (await post({ prompt: " retry " })).json(), {
    text: "retry",
  });
});

test(
  "prompt calls real Maestro list_devices and returns its tool result to the model",
  { skip: !process.env.TEST_MAESTRO },
  async (t) => {
    let toolResult;
    const provider = http.createServer(async (req, res) => {
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const request = JSON.parse(bytes);
      const tool = request.messages.find((m) => m.role === "tool");
      toolResult = tool?.content;
      const message = tool
        ? { role: "assistant", content: "Device list checked." }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "device_list",
                type: "function",
                function: { name: "list_devices", arguments: "{}" },
              },
            ],
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            { index: 0, message, finish_reason: tool ? "stop" : "tool_calls" },
          ],
        }),
      );
    });
    process.env.MODEL_BASE_URL = await listen(provider);
    process.env.MODEL_PROVIDER = "local";
    process.env.MODEL = "fixture";
    t.after(() => provider.close());
    const session = await openSession({ readModelConfig: () => process.env });
    t.after(() => session.close());
    const server = createViewerServer(session);
    const url = await listen(server);
    t.after(() => server.close());
    assert.ok(
      Array.isArray(
        (await (await fetch(url + "/api/device/targets")).json()).devices,
      ),
    );
    const response = await fetch(url + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "List devices" }),
    });
    assert.deepEqual(await response.json(), { text: "Device list checked." });
    assert.match(JSON.stringify(toolResult), /devices/);
    assert.doesNotMatch(
      JSON.stringify(toolResult),
      /failed to list|unknown tool|tool not found|isError":true/i,
    );
  },
);
