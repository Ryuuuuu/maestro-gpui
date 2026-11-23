import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { simulateInspection } from "./mock-inspection-engine.js";

const catalog = JSON.parse(
  readFileSync(new URL("../assets/inspection.json", import.meta.url), "utf8"),
);
export function inspectionService(engine = simulateInspection) {
  let run = null;
  const history = [],
    clients = new Set(),
    controller = new AbortController();
  function snapshot() {
    return JSON.stringify({ run, history });
  }
  function publish() {
    const data = "data: " + snapshot() + "\n\n";
    for (const client of clients) client.write(data);
  }
  function log(text) {
    const seconds = Math.floor((Date.now() - run.started) / 1000);
    run.log.push({
      time: [Math.floor(seconds / 60), seconds % 60]
        .map((n) => String(n).padStart(2, "0"))
        .join(":"),
      text,
    });
  }
  function finish(status) {
    run.status = status;
    run.current = null;
    history.unshift({
      finished: new Date().toLocaleString("sv-SE"),
      rows: run.selected.map(
        (id, i) => catalog[id].name + " · " + (run.results[i] ?? "미완료"),
      ),
      status,
    });
  }
  return {
    close() {
      controller.abort();
      for (const client of clients) client.end();
    },
    async handle(req, res, reply) {
      if (req.url === "/api/inspection/stream" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        res.write("data: " + snapshot() + "\n\n");
        clients.add(res);
        res.on("close", () => clients.delete(res));
        return;
      }
      if (req.method !== "POST") return reply(405, { error: "POST required" });
      if (req.headers["content-type"]?.split(";")[0] !== "application/json")
        return reply(415, { error: "Expected JSON" });
      let data = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 65536)
          return reply(413, { error: "요청이 너무 큽니다." });
      }
      let body;
      try {
        body = JSON.parse(data);
      } catch {
        return reply(400, { error: "Invalid JSON" });
      }
      if (!body || typeof body !== "object")
        return reply(400, { error: "Invalid request" });
      if (req.url === "/api/inspection/start") {
        if (run?.status === "running")
          return reply(409, { error: "점검이 이미 진행 중입니다." });
        const { selected, files, device } = body;
        if (
          !Array.isArray(selected) ||
          !selected.length ||
          new Set(selected).size !== selected.length ||
          !selected.every(
            (i) => Number.isInteger(i) && i >= 0 && i < catalog.length,
          ) ||
          !Array.isArray(files) ||
          !files.every((f) => typeof f === "string") ||
          (device != null && typeof device !== "string")
        )
          return reply(400, { error: "잘못된 점검 선택입니다." });
        run = {
          id: randomUUID(),
          selected,
          files,
          device,
          started: Date.now(),
          status: "running",
          current: null,
          log: [],
          results: [],
        };
        log("모의 엔진이 점검 요청을 수신했습니다.");
        for (const file of files) log("선택 동선 · " + file);
        const job = { ...run },
          url =
            "http://127.0.0.1:" +
            req.socket.localPort +
            "/api/inspection/event";
        publish();
        reply(202, { id: job.id });
        void engine(job, url, controller.signal).catch((error) => {
          if (
            controller.signal.aborted ||
            run?.id !== job.id ||
            run.status !== "running"
          )
            return;
          log(error.message);
          finish("failed");
          publish();
        });
        return;
      }
      if (req.url === "/api/inspection/reset") {
        if (run?.status === "running")
          return reply(409, { error: "점검이 진행 중입니다." });
        run = null;
        publish();
        return reply(200, { ok: true });
      }
      if (req.url !== "/api/inspection/event")
        return reply(404, { error: "Unknown route" });
      if (
        !run ||
        run.id !== body.id ||
        run.status !== "running" ||
        body.item !== run.selected[run.results.length]
      )
        return reply(409, { error: "현재 실행과 일치하지 않는 이벤트입니다." });
      const name = catalog[body.item].name;
      if (body.type === "start" && run.current === null) {
        run.current = body.item;
        log(name + " · 모의 분석 시작");
      } else if (
        body.item === run.current &&
        body.type === "log" &&
        typeof body.text === "string"
      ) {
        log(name + " · " + body.text);
      } else if (
        body.item === run.current &&
        body.type === "result" &&
        ["양호", "취약", "판단 보류"].includes(body.result)
      ) {
        run.results.push(body.result);
        log(name + " · 예시 결과: " + body.result);
        run.current = null;
        if (run.results.length === run.selected.length) {
          log("모의 점검 완료");
          finish("completed");
        }
      } else return reply(400, { error: "잘못된 엔진 이벤트입니다." });
      publish();
      return reply(200, { ok: true });
    },
  };
}
