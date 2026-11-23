import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { flowLibrary } from "../server/library.js";
import http from "node:http";
import { flowHistory, importFlow } from "../server/flows.js";
import { createViewerServer } from "../server/http.js";
import { openSession } from "../server/session.js";

test("library opens at flows, respects the selected name and cancellation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-flows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let choice = "로그인-선택.yaml";
  const library = flowLibrary(dir, async (directory, suggested) => {
    assert.equal(directory, dir);
    assert.equal(suggested, "로그인.yaml");
    return choice && join(dir, choice);
  });
  const yaml = "appId: example.app\n---\n- back\n";
  const names = [basename(await library.save("로그인", yaml))];
  choice = null;
  assert.equal(await library.save("로그인", yaml), null);
  assert.deepEqual((await library.list("로그")).sort(), names.sort());
  assert.deepEqual(await library.list("결제"), []);
  for (const name of names) {
    assert.equal(await readFile(join(dir, name), "utf8"), yaml);
    assert.deepEqual(await library.steps(name), [{ files: [join(dir, name)] }]);
  }
  await assert.rejects(library.steps("../outside.yaml"));
});

test("editor saves valid YAML and preserves the original on invalid edits or conflicts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-edit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const library = flowLibrary(dir, (dir, name) => join(dir, name));
  const base = "- back\n";
  const name = basename(await library.save("편집", base));
  assert.equal(await library.readDocument(name), base);
  await assert.rejects(library.edit(name, base, "- ["));
  assert.equal(await library.readDocument(name), base);
  const attempts = await Promise.allSettled(
    ["- hideKeyboard\n", "- scroll\n"].map((text) =>
      library.edit(name, base, text),
    ),
  );
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  await assert.rejects(library.edit(name, base, "- back\n"));
  assert.notEqual(await library.readDocument(name), base);
  await assert.rejects(library.readDocument("../outside.yaml"));
});

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
    const directory = await mkdtemp(join(tmpdir(), "viewer-mcp-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const session = await openSession({
      library: flowLibrary(directory, (dir, name) => join(dir, name)),
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
    const saved = await fetch(base + "/api/library/save/" + history[0].id, {
      method: "POST",
    });
    assert.equal(saved.status, 201);
    const name = basename((await saved.json()).path);
    assert.deepEqual(await (await fetch(base + "/api/library")).json(), [name]);
    assert.equal(
      (await post("/api/prompt", { prompt: "/run " + name, device })).text,
      "동선 실행 완료",
    );
    assert.equal(
      (await post("/api/flows/run", { yaml: file, device })).text,
      "동선 실행 완료",
    );
  },
);
