import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { flowHistory, importFlow } from "../server/flows.js";
import { createViewerServer } from "../server/http.js";
import { openSession } from "../server/session.js";

test("successful actions retain device, execution order and per-call variables", () => {
  const h = flowHistory(),
    run = h.begin("로그인");
  const first = run({ device_id: "A", yaml: "- back", env: { LANG: "ko" } });
  run({ device_id: "A", yaml: "- tapOn: Retry" })({ isError: true });
  run({ device_id: "B", yaml: "- back" })({});
  run({ device_id: "A", yaml: "- tapOn: Continue" })({});
  first({});
  const [a, b] = ["A", "B"].map((device) =>
    h.list().find((r) => r.device === device),
  );
  assert.deepEqual(importFlow(h.export(a.id)), [
    { yaml: "- back", env: { LANG: "ko" } },
    { yaml: "- tapOn: Continue" },
  ]);
  assert.equal(h.export(b.id), "- back");
  assert.throws(() => importFlow("maestroViewer: 2\nsteps: []"));
  assert.throws(() =>
    importFlow("maestroViewer: 1\nsteps: [{device_id: bad}]"),
  );
});

test(
  "save actual successful MCP YAML and replay the downloaded file",
  { skip: !process.env.TEST_FLOW_DEVICE },
  async (t) => {
    const yaml =
      "appId: com.android.settings\n---\n- waitForAnimationToEnd:\n    timeout: 1000\n";
    const device = process.env.TEST_FLOW_DEVICE;
    const provider = http.createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      const finished = JSON.parse(data).messages.some((m) => m.role === "tool");
      const message = finished
        ? { role: "assistant", content: "Finished" }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "flow",
                type: "function",
                function: {
                  name: "run",
                  arguments: JSON.stringify({ device_id: device, yaml }),
                },
              },
            ],
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "m",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              message,
              finish_reason: finished ? "stop" : "tool_calls",
            },
          ],
        }),
      );
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    t.after(() => provider.close());
    const session = await openSession({
      readModelConfig: () => ({
        MODEL_PROVIDER: "local",
        MODEL: "fixture",
        MODEL_BASE_URL: "http://127.0.0.1:" + provider.address().port,
      }),
    });
    t.after(() => session.close());
    const server = createViewerServer(session);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const base = "http://127.0.0.1:" + server.address().port;
    const post = async (path, body) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const v = await r.json();
      assert.equal(r.status, 200, v.error);
      return v;
    };
    await post("/api/prompt", { prompt: "화면 애니메이션 대기" });
    const history = await (await fetch(base + "/api/flows")).json();
    assert.equal(history.length, 1);
    const file = await (
      await fetch(base + "/api/flows/" + history[0].id)
    ).text();
    assert.equal(file, yaml);
    assert.equal(
      (await post("/api/flows/run", { yaml: file, device })).text,
      "동선 실행 완료",
    );
  },
);
