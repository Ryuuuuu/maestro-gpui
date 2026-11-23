import test from "node:test";
import assert from "node:assert/strict";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { selectModel } from "../server/session.js";

// Exercise each provider's wire format without a cloud account or model charges.
const providers = {
  anthropic(done) {
    return {
      type: "message",
      id: "msg1",
      role: "assistant",
      model: "test",
      content: done
        ? [{ type: "text", text: "Checked" }]
        : [{ type: "tool_use", id: "one", name: "list_devices", input: {} }],
      stop_reason: done ? "end_turn" : "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  },
  google(done) {
    return {
      candidates: [
        {
          content: {
            role: "model",
            parts: done
              ? [{ text: "Checked" }]
              : [{ functionCall: { name: "list_devices", args: {} } }],
          },
          finishReason: "STOP",
        },
      ],
    };
  },
  openai(done) {
    return {
      id: "resp1",
      object: "response",
      created_at: 1,
      model: "test",
      status: "completed",
      output: done
        ? [
            {
              type: "message",
              id: "msg1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Checked", annotations: [] },
              ],
            },
          ]
        : [
            {
              type: "function_call",
              id: "fc1",
              call_id: "one",
              name: "list_devices",
              arguments: "{}",
              status: "completed",
            },
          ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
  },
};

for (const [provider, response] of Object.entries(providers)) {
  test(provider + " sends tool results back to the model", async (t) => {
    let calls = 0;
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_, init) => {
      const body = JSON.parse(init.body);
      if (requests++ === 0)
        assert.match(JSON.stringify(body.tools), /list_devices/);
      else assert.match(JSON.stringify(body), /simulator-123/);
      return Response.json(response(calls > 0));
    });
    const model = selectModel({
      MODEL_PROVIDER: provider,
      MODEL: "test",
      ANTHROPIC_API_KEY: "fixture",
      GOOGLE_GENERATIVE_AI_API_KEY: "fixture",
      OPENAI_API_KEY: "fixture",
    });
    const result = await generateText({
      model,
      prompt: "List connected devices",
      maxRetries: 0,
      stopWhen: stepCountIs(2),
      tools: {
        list_devices: tool({
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            calls++;
            return { devices: ["simulator-123"] };
          },
        }),
      },
    });
    assert.equal(calls, 1);
    assert.equal(requests, 2);
    assert.equal(result.text, "Checked");
  });
}
