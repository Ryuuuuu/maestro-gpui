import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { trafficRecorder } from "../server/proxy.js";
import { createViewerServer } from "../server/http.js";

const python = process.platform === "win32" ? ".tools/proxy/Scripts/python.exe" : ".tools/proxy/bin/python";
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}

test("records only the executing flow and exports a readable mitmproxy file", { skip: !existsSync(python) }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-proxy-test-"));
  const path = join(dir, "test.mitm");
  const target = { deviceId: "test-simulator", platform: "ios" };
  const maestro = http.createServer((_req, res) => res.end(JSON.stringify({ devices: [target] })));
  const viewer = await listen(maestro);
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": "fixture=private" });
    res.end("fixture response");
  });
  const url = await listen(origin);
  const traffic = trafficRecorder(async () => path);
  const request = async resource => {
    const result = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: traffic.snapshot().port, path: url + resource,
        headers: { Host: new URL(url).host } }, resolve).on("error", reject);
    });
    for await (const _chunk of result) {}
    assert.equal(result.statusCode, 200);
  };
  const app = createViewerServer({ viewer, replay: () => request("/replay"), prompt: () => request("/prompt") }, traffic);
  const base = await listen(app);
  t.after(async () => { await app.closeProxy(); app.close(); origin.close(); maestro.close(); await rm(dir, { recursive: true }); });
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const on = await post("/api/proxy/on/test-simulator");
  assert.equal(on.status, 200, await on.text());
  await request("/outside");
  assert.equal((await post("/api/flows/run", { name: "demo.yaml", yaml: "- back", device: target.deviceId })).status, 200);
  assert.equal((await post("/api/prompt", { prompt: "test", device: target.deviceId })).status, 200);
  await request("/outside");
  const {runs} = await (await fetch(base + "/api/proxy")).json();
  assert.deepEqual(runs.map(r => [r.label, r.status, r.count]), [["test", "완료", 1], ["demo.yaml", "완료", 1]]);
  assert.equal((await post("/api/proxy/off")).status, 200);
  const detail = await (await fetch(base + "/api/proxy/detail/" + runs[1].id + "/0")).json();
  assert.match(detail.response, /fixture response/);
  assert.doesNotMatch(detail.response, /fixture=private/);
  assert.equal((await post("/api/proxy/save/" + runs[1].id)).status, 200);
  const script = "from mitmproxy.io import FlowReader; import sys; f, = FlowReader(open(sys.argv[1],'rb')).stream(); print(f.request.path, f.response.get_text())";
  assert.equal(execFileSync(python, ["-c", script, path], { encoding: "utf8" }).trim(), "/replay fixture response");
});
