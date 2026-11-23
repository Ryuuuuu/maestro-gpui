import React from "react";
import { StatusChip } from "./StatusChip";
import checks from "../../assets/inspection.json";

type Run = {
  selected: number[];
  files: string[];
  current: number | null;
  results: string[];
  log: { time: string; text: string }[];
  status: "running" | "completed" | "failed";
};
type History = { finished: string; rows: string[]; status: string };
export function Inspection({
  visible,
  historyVisible,
  device,
}: {
  visible: boolean;
  historyVisible: boolean;
  device?: string;
}) {
  const [history, setHistory] = React.useState<History[]>([]);
  const [run, setRun] = React.useState<Run | null>(null);
  const [pending, setPending] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [requestError, setRequestError] = React.useState("");
  const [draft, setSelected] = React.useState(() => checks.map((_, i) => i));
  const selected = run?.selected ?? draft;
  React.useEffect(() => {
    const events = new EventSource("/api/inspection/stream");
    events.onmessage = (e) => {
      const snapshot = JSON.parse(e.data);
      setRun(snapshot.run);
      setHistory(snapshot.history);
      setConnected(true);
    };
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);
  const [files, setFiles] = React.useState<string[]>([]);
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [libraryStatus, setLibraryStatus] = React.useState("");
  React.useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    async function load() {
      setLibraryStatus("목록을 불러오는 중…");
      try {
        const response = await fetch("/api/library", { signal: abort.signal });
        if (!response.ok) throw new Error();
        const names: string[] = await response.json();
        if (abort.signal.aborted) return;
        setFiles(names);
        setChosen((previous) =>
          previous.filter((name) => names.includes(name)),
        );
        setLibraryStatus("");
      } catch {
        if (!abort.signal.aborted)
          setLibraryStatus("동선 목록을 불러오지 못했습니다.");
      }
    }
    void load();
    return () => abort.abort();
  }, [visible]);
  const matches = files.filter((name) =>
    name
      .normalize()
      .toLowerCase()
      .includes(query.trim().normalize().toLowerCase()),
  );
  if (historyVisible)
    return (
      <section
        aria-label="점검 이력"
        className="inspection-card my-2 ml-4 flex-1"
      >
        <header>
          <h2>점검 이력</h2>
          <span>{history.length}건</span>
        </header>
        <div className="inspection-content p-3">
          {history.length ? (
            history.map((entry, i) => (
              <article key={history.length - i} className="history-entry">
                <div className="history-title">
                  <strong>{entry.finished} · 모의 점검</strong>
                  <StatusChip
                    label={entry.status === "failed" ? "중단" : "완료"}
                  />
                </div>
                {entry.rows.map((row) => {
                  const split = row.lastIndexOf(" · ");
                  return split < 0 ? (
                    <p key={row}>{row}</p>
                  ) : (
                    <div key={row} className="history-result">
                      <span>{row.slice(0, split)}</span>
                      <StatusChip label={row.slice(split + 3)} />
                    </div>
                  );
                })}
              </article>
            ))
          ) : (
            <p>아직 완료한 점검이 없습니다.</p>
          )}
        </div>
      </section>
    );
  if (!visible) return null;
  const completed = run?.results.length ?? 0;
  const current = run?.current ?? -1;
  async function request() {
    setPending(true);
    setRequestError("");
    try {
      const res = await fetch("/api/inspection/" + (run ? "reset" : "start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(run ? {} : { selected, files: chosen, device }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
    } catch (e) {
      setRequestError(String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="금취 점검" className="inspection-layout">
      <section className="inspection-card">
        <header>
          <h2>점검 실행 로그</h2>
          <span>모의 엔진 · {run?.log.length ?? 0}건</span>
        </header>
        <div className="inspection-log" role="log">
          {run ? (
            [...run.log].reverse().map((e, i) => (
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
      <div className="inspection-center">
        <section className="inspection-card" aria-label="점검 동선 파일">
          <header>
            <h2>동선 파일 선택</h2>
            <span>{(run?.files ?? chosen).length}개 선택</span>
          </header>
          <input
            type="search"
            className="inspection-file-query"
            aria-label="점검 동선 파일 검색"
            placeholder="flows/ 파일명 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="inspection-file-list">
            {libraryStatus ||
              (!matches.length &&
                (files.length
                  ? "검색 결과가 없습니다."
                  : "저장된 동선이 없습니다.")) ||
              matches.map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    disabled={!!run}
                    checked={(run?.files ?? chosen).includes(name)}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked;
                      setChosen((prev) =>
                        checked
                          ? [...prev, name]
                          : prev.filter((n) => n !== name),
                      );
                    }}
                  />
                  {name}
                </label>
              ))}
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
                        <span className="shrink-0 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                          {item.score}점
                        </span>
                      </label>
                      <small>{item.description}</small>
                    </td>
                    <td>
                      <StatusChip
                        label={
                          !selected.includes(i)
                            ? "제외"
                            : selected.indexOf(i) < completed
                              ? "완료"
                              : i === current
                                ? "진행 중"
                                : run?.status === "failed"
                                  ? "중단"
                                  : "대기"
                        }
                      />
                    </td>
                    <td>
                      {run?.results[selected.indexOf(i)] ? (
                        <StatusChip label={run.results[selected.indexOf(i)]} />
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inspection-actions">
            {!connected && <p role="status">점검 서버 연결 중…</p>}
            {requestError && <p role="alert">{requestError}</p>}
            {run?.status === "running" ? (
              <p role="status">
                {current < 0
                  ? "모의 엔진 응답 대기"
                  : checks[current].name + " · 모의 분석 중"}
              </p>
            ) : (
              <button
                className="primary inspection-start"
                disabled={!connected || pending || !selected.length}
                onClick={request}
              >
                {run ? "새 점검 준비" : "선택 항목 점검 시작"}
              </button>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
