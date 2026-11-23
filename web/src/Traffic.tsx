import React from "react";

type Run = { id: string; label: string; status: string; count: number; started: number };
type Row = { index: number; time: number; method: string; host: string; port: number; path: string; status: number | null; bytes: number | null; error: boolean };
type Snapshot = { state: string; message: string; platform: string; device: string; port: number; runs: Run[]; selected?: string; rows: Row[]; page: number; pages: number };
function useRecorder() {
  const [data, setData] = React.useState<Snapshot>();
  const [run, setRun] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [revision, refresh] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      try {
        const response = await fetch(`/api/proxy?run=${encodeURIComponent(run)}&page=${page}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (!controller.signal.aborted) setData(next);
      } catch { if (!controller.signal.aborted) setData(undefined); }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 1000);
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [run, page, revision]);
  async function action(path: string) {
    setPending(true);
    setNotice("");
    try {
      const response = await fetch("/api/proxy/" + path, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (body.path) setNotice(body.path + " 저장");
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); refresh(); }
  }
  return { data, pending, notice, action, setPage, select: (id: string) => { setRun(id); setPage(0); }, run };
}
const Context = React.createContext<ReturnType<typeof useRecorder> | null>(null);
export function TrafficProvider({children}: React.PropsWithChildren) {
  return <Context.Provider value={useRecorder()}>{children}</Context.Provider>;
}
export function useProxyEnabled() {
  return React.useContext(Context)?.data?.state === "on";
}
export function ProxyToggle({device}: {device?: string}) {
  const recorder = React.useContext(Context);
  if (!recorder) return null;
  const {data, pending, action} = recorder;
  const on = data?.state === "on";
  return <button className="proxy-toggle" role="switch" aria-label="프록시 서버" aria-checked={on}
    title={on ? data.device + " · 127.0.0.1:" + data.port : "선택한 기기의 통신 기록"}
    disabled={pending || !data || (!on && !device) || !["on", "off"].includes(data.state)}
    onClick={() => void action(on ? "off" : "on/" + encodeURIComponent(device!))}>
    <i aria-hidden="true" />프록시 {on ? "ON" : data?.state === "starting" ? "연결 중" : "OFF"}
  </button>;
}

export function TrafficPanel() {
  const recorder = React.useContext(Context);
  const [expanded, expand] = React.useState("");
  const [detail, setDetail] = React.useState("");
  React.useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setDetail("불러오는 중…");
    (async () => {
      try {
        const response = await fetch("/api/proxy/detail/" + expanded, {signal: controller.signal});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        if (!controller.signal.aborted) setDetail("요청\n" + body.request + "\n\n응답\n" + body.response);
      } catch (e) { if (!controller.signal.aborted) setDetail(String(e)); }
    })();
    return () => controller.abort();
  }, [expanded]);
  if (!recorder) return null;
  const { data, pending, notice, action, setPage, select, run } = recorder;
  const selected = data?.runs.find(r => r.id === data.selected);
  return <section className="traffic-card" aria-label="동선 통신 기록">
    <header><strong>통신 기록</strong><button disabled={pending || !selected?.count || selected.status === "수집 중"}
      onClick={() => void action("save/" + selected!.id)}>파일 저장</button></header>
    {data?.runs.length ? <select aria-label="통신 기록을 볼 실행" value={run} onChange={e => select(e.target.value)}>
      <option value="">최근 실행 · {data.runs[0].label}</option>
      {data.runs.map(r => <option key={r.id} value={r.id}>{new Date(r.started).toLocaleTimeString()} · {r.label}</option>)}
    </select> : null}
    {selected && <div className="traffic-meta">{selected.status} · {selected.count}건</div>}
    <div className="traffic-rows scrollbar-quiet">
      {data?.rows.map(r => { const key = data.selected + "/" + r.index; return <div className="traffic-row" key={key}>
        <button className="traffic-entry" aria-expanded={expanded === key} onClick={() => expand(expanded === key ? "" : key)}>
        <b>{r.method}</b><span>{r.host}:{r.port}</span><small>{r.error ? "오류" : r.status ?? "—"}</small></button>
        <p>{new Date(r.time * 1000).toLocaleTimeString()} · {r.method === "CONNECT" ? "HTTPS 연결" : r.path} {r.bytes != null && `· ${r.bytes.toLocaleString()} B`}</p>
        {expanded === key && <pre>{detail}</pre>}
      </div>; })}
      {!data?.rows.length && <p>{!data ? "서버 연결 중…" : selected ? "이 실행에 기록된 통신이 없습니다." : data.state === "on" ? "동선을 실행하면 통신이 표시됩니다." : "상단에서 프록시를 켜고 동선을 실행하세요."}</p>}
    </div>
    {data && data.pages > 1 && <footer><button disabled={data.page === 0} onClick={() => setPage(data.page-1)}>이전</button>{data.page+1} / {data.pages}<button disabled={data.page+1 >= data.pages} onClick={() => setPage(data.page+1)}>다음</button></footer>}
    {data?.platform === "ios" && data.state === "on" && <p>테스트 클라이언트의 HTTP 프록시를 127.0.0.1:{data.port}로 설정하세요.</p>}
    {(notice || data?.message) && <p role="status">{notice || data?.message}</p>}
  </section>;
}
