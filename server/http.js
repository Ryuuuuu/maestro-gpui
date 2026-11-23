import { inspectionService } from "./inspection.js";
import { importFlow } from "./flows.js";
import { androidKeyboard } from "./android-keyboard.js";
import { trafficRecorder } from "./proxy.js";
import http from "node:http";
import { readFile } from "node:fs/promises";

const routes = new Map([
  ["/api/events/stream", "GET"],
  ["/api/device/state", "GET"],
  ["/api/device/targets", "GET"],
  ["/api/device/start", "POST"],
  ["/api/device/input", "POST"],
]);

export function createViewerServer(session, traffic = trafficRecorder()) {
  let busy = false;
  let saving = false;
  let changingProxy = false;
  const keyboard = androidKeyboard();
  const inspection = inspectionService();
  const server = http.createServer(async (req, res) => {
    function reply(status, value) {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    }
    const host = "127.0.0.1:" + req.socket.localPort;
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== "http://" + host) ||
      ![undefined, "same-origin", "none"].includes(
        req.headers["sec-fetch-site"],
      )
    )
      return reply(403, { error: "Local access only" });
    try {
      if (req.url === "/api/proxy" || req.url.startsWith("/api/proxy?")) {
        if (req.method !== "GET") return reply(405, { error: "GET required" });
        const params = new URL(req.url, "http://" + host).searchParams;
        return reply(200, traffic.snapshot(params.get("run"), params.get("page")));
      }
      if (req.url.startsWith("/api/proxy/")) {
        const detail = /^\/api\/proxy\/detail\/([0-9a-f-]{36})\/(\d+)$/.exec(req.url);
        if (detail && req.method === "GET") return reply(200, await traffic.detail(detail[1], Number(detail[2])));
        if (req.method !== "POST") return reply(405, { error: "POST required" });
        if (req.url.startsWith("/api/proxy/save/")) {
          if (saving) return reply(409, { error: "저장 창이 열려 있습니다." });
          saving = true;
          try { return reply(200, { path: await traffic.save(req.url.slice("/api/proxy/save/".length)) }); }
          finally { saving = false; }
        }
        if (busy || changingProxy) return reply(409, { error: "진행 중인 작업이 끝난 후 전환하세요." });
        changingProxy = true;
        try {
          if (req.url === "/api/proxy/off") await traffic.stop();
          else if (req.url.startsWith("/api/proxy/on/")) {
            const id = decodeURIComponent(req.url.slice("/api/proxy/on/".length));
            const response = await fetch(session.viewer + "/api/device/targets");
            const target = (await response.json()).devices?.find(d => d.deviceId === id);
            if (!target) return reply(400, { error: "연결할 기기를 먼저 선택하세요." });
            await traffic.start(target, [req.socket.localPort, new URL(session.viewer).port]);
          } else return reply(404, { error: "Route not found" });
          return reply(200, traffic.snapshot());
        } finally { changingProxy = false; }
      }
      if (req.url.startsWith("/api/inspection/")) return await inspection.handle(req,res,reply);
      if (req.url === "/" && req.method === "GET") {
        const html = await readFile(
          new URL("../web/build/raw/index.html", import.meta.url),
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (req.method === "POST" && req.url === "/api/device/keyboard") {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          return reply(415, { error: "Expected JSON" });
        let data = "";
        for await (const chunk of req) {
          data += chunk;
          if (data.length > 1024) return reply(413, { error: "Invalid key" });
        }
        const { device, code, shift } = JSON.parse(data);
        await keyboard.tap(device, code, shift);
        return reply(200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/api/library/document") {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          return reply(415, { error: "Expected JSON" });
        let data = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          data += chunk;
          if (data.length > 20 * 1024 * 1024)
            return reply(413, { error: "파일이 너무 큽니다." });
        }
        try {
          const body = JSON.parse(data);
          if (Object.hasOwn(body, "text")) {
            await session.library.edit(body.name, body.base, body.text);
            return reply(200, { saved: true });
          }
          return reply(200, {
            text: await session.library.readDocument(body.name),
          });
        } catch (error) {
          return reply(400, { error: error.message });
        }
      }
      if (req.method === "GET" && req.url === "/api/library")
        return reply(200, await session.library.list());
      if (req.method === "POST" && req.url.startsWith("/api/library/save/")) {
        const id = req.url.slice("/api/library/save/".length);
        const entry = session.flows.list().find((r) => r.id === id);
        if (!entry)
          return reply(404, { error: "저장할 성공 동선을 찾을 수 없습니다." });
        if (saving)
          return reply(409, { error: "저장 창이 이미 열려 있습니다." });
        saving = true;
        try {
          const path = await session.library.save(
            entry.label,
            session.flows.export(id),
          );
          return reply(path ? 201 : 200, { path });
        } finally {
          saving = false;
        }
      }
      if (req.method === "GET" && req.url === "/api/flows")
        return reply(200, session.flows.list());
      if (req.method === "GET" && req.url.startsWith("/api/flows/")) {
        const yaml = session.flows.export(req.url.slice("/api/flows/".length));
        if (yaml === null)
          return reply(404, { error: "동선을 찾을 수 없습니다." });
        res.writeHead(200, {
          "Content-Type": "application/yaml; charset=utf-8",
          "Content-Disposition": 'attachment; filename="maestro-flow.yaml"',
          "Cache-Control": "no-store",
        });
        return res.end(yaml);
      }
      const replay = req.url === "/api/flows/run";
      if ((req.url === "/api/prompt" || replay) && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          return reply(415, { error: "Expected JSON" });
        let data = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          data += chunk;
          if (data.length > (replay ? 8 * 1024 * 1024 : 65536))
            return reply(413, { error: "Prompt too long" });
        }
        let prompt, steps, device, label;
        try {
          const body = JSON.parse(data);
          if (replay) {
            steps = importFlow(body.yaml);
            label = typeof body.name === "string" && body.name.trim() ? body.name : "동선 파일 실행";
            device = body.device;
            if (!device) {
              const response = await fetch(
                session.viewer + "/api/device/targets",
              );
              const targets = (await response.json()).devices;
              if (targets?.length !== 1)
                throw new Error("Viewer에서 실행할 기기를 먼저 연결하세요.");
              device = targets[0].deviceId;
            }
            if (typeof device !== "string" || !device.trim())
              throw new Error("연결된 기기가 필요합니다.");
          } else {
            prompt = body.prompt;
            device = body.device;
          }
        } catch (error) {
          return reply(400, { error: error.message });
        }
        if (!replay && (typeof prompt !== "string" || !prompt.trim()))
          return reply(400, { error: "Enter a prompt" });
        if (busy || changingProxy) return reply(409, { error: "다른 작업이 진행 중입니다." });
        const streaming = req.headers.accept === "application/x-ndjson";
        let atLineStart = true,
          tail = "";
        const emit = (kind, text = "") => {
          if (!streaming || res.destroyed) return;
          if (kind === "done") {
            if (text && !tail.trimEnd().endsWith(text.trimEnd()))
              emit("line", text);
            text = "";
          } else if (kind === "line") {
            text = (atLineStart ? "" : "\n") + text + "\n";
          }
          if (text && kind !== "error") {
            atLineStart = text.endsWith("\n");
            tail = (tail + text).slice(-120000);
          }
          res.write(JSON.stringify({ kind, text }) + "\n");
        };
        if (streaming) {
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.flushHeaders();
        }
        busy = true;
        let capture, success = false;
        try {
          capture = await traffic.begin(label || prompt, device);
          const text = replay
            ? await session.replay(steps, device, streaming ? emit : undefined)
            : await session.prompt(
                prompt.trim(),
                streaming ? emit : undefined,
                device,
              );
          success = true;
          await traffic.finish(capture, true);
          if (streaming) {
            emit("done", text);
            res.end();
          } else reply(200, { text });
        } catch (error) {
          if (!success) await traffic.finish(capture, false);
          if (!streaming) throw error;
          emit("error", error.message);
          res.end();
        } finally {
          busy = false;
        }
        return;
      }
      if (routes.get(req.url) !== req.method)
        return reply(404, { error: "Route not found" });
      const upstream = http.request(
        session.viewer + req.url,
        {
          method: req.method,
          headers: req.headers["content-type"]
            ? { "content-type": req.headers["content-type"] }
            : {},
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.on("error", () => res.destroy());
          response.pipe(res);
        },
      );
      res.on("close", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent && !res.destroyed)
          reply(502, { error: "Maestro Viewer disconnected" });
      });
      req.pipe(upstream);
    } catch (error) {
      if (!res.headersSent) reply(500, { error: error.message });
    }
  });
  server.on("close", keyboard.close);
  server.on("close", inspection.close);
  server.closeProxy = () => traffic.close();
  server.on("close", () => void traffic.close().catch(error => console.error(error.message)));
  return server;
}
