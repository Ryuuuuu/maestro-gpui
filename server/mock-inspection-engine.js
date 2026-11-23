import { setTimeout as delay } from "node:timers/promises";

// UI fixture: deterministic events only. No devices, flows or model tools are invoked.
export async function simulateInspection(
  job,
  callback,
  signal,
  interval = 650,
) {
  async function send(event) {
    const response = await fetch(callback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, ...event }),
      signal,
    });
    if (!response.ok) throw new Error("모의 엔진 이벤트 전송 실패");
  }
  for (const [position, item] of job.selected.entries()) {
    await delay(interval, undefined, { signal });
    await send({ type: "start", item });
    await delay(interval, undefined, { signal });
    await send({
      type: "log",
      item,
      text: "예시 응답을 수신했습니다. 결과를 정리합니다.",
    });
    await delay(interval, undefined, { signal });
    await send({
      type: "result",
      item,
      result: ["양호", "판단 보류", "취약"][position % 3],
    });
  }
}
