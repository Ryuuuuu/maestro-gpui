import React from "react";
import checks from "../../assets/inspection.json";

const outcomes = ["양호", "취약", "판단 보류"] as const;
type Entry = { time: string; text: string };
type Run = { started: number; results: string[]; log: Entry[] };

function elapsed(started: number) {
  const seconds = Math.floor((performance.now() - started) / 1000);
  return [Math.floor(seconds / 60), seconds % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function Inspection({ visible }: { visible: boolean }) {
  const [run, setRun] = React.useState<Run | null>(null);
  const [selected, setSelected] = React.useState(() => checks.map((_, i) => i));
  if (!visible) return null;
  const completed = run?.results.length ?? 0;
  const current = run ? (selected[completed] ?? -1) : -1;
  function start() {
    if (!selected.length) return;
    setRun({
      started: performance.now(),
      results: [],
      log: [{ time: "00:00", text: checks[selected[0]].name + " 점검 시작" }],
    });
  }
  function record(result: string) {
    if (!run || current < 0) return;
    const time = elapsed(run.started);
    const next = checks[selected[completed + 1]];
    setRun({
      ...run,
      results: [...run.results, result],
      log: [
        { time, text: next ? next.name + " 점검 시작" : "선택 항목 점검 완료" },
        { time, text: checks[current].name + " · " + result },
        ...run.log,
      ],
    });
  }
  return (
    <section aria-label="금취 점검" className="inspection-layout">
      <section className="inspection-card">
        <header>
          <h2>점검 실행 로그</h2>
          <span>{run?.log.length ?? 0}건</span>
        </header>
        <div className="inspection-log" role="log">
          {run ? (
            run.log.map((e, i) => (
              <div key={run.log.length - i}>
                <time>+{e.time}</time>
                <span>{e.text}</span>
              </div>
            ))
          ) : (
            <p>점검을 시작하면 기록이 표시됩니다.</p>
          )}
        </div>
      </section>
      <section className="inspection-card">
        <header>
          <h2>점검 진행</h2>
          <span>
            {completed} / {selected.length} 완료
          </span>
        </header>
        <progress
          aria-label="점검 완료 수"
          max={Math.max(selected.length, 1)}
          value={completed}
        />
        <div className="inspection-content">
          <table>
            <thead>
              <tr>
                {["점검 항목", "상태", "결과"].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {checks.map((item, i) => (
                <tr key={item.name} data-active={i === current}>
                  <td>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.includes(i)}
                        disabled={!!run}
                        onChange={({ target }) =>
                          setSelected((prev) =>
                            target.checked
                              ? [...prev, i].sort((a, b) => a - b)
                              : prev.filter((n) => n !== i),
                          )
                        }
                      />
                      <strong>{item.name}</strong>
                    </label>
                    <small>{item.description}</small>
                  </td>
                  <td>
                    {!selected.includes(i)
                      ? "제외"
                      : selected.indexOf(i) < completed
                        ? "완료"
                        : i === current
                          ? "진행 중"
                          : "대기"}
                  </td>
                  <td>{run?.results[selected.indexOf(i)] ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inspection-actions">
            {current < 0 ? (
              <button
                className={run ? "primary" : "primary inspection-start"}
                disabled={!selected.length}
                onClick={() => (run ? setRun(null) : start())}
              >
                {run ? "새 점검 준비" : "선택 항목 점검 시작"}
              </button>
            ) : (
              <>
                <p>{checks[current].name} 결과 기록</p>
                {outcomes.map((value) => (
                  <button key={value} onClick={() => record(value)}>
                    {value}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </section>
    </section>
  );
}
