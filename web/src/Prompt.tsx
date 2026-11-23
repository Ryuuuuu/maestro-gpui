import React from "react";
import { StatusChip } from "./StatusChip";
import { FlowEditor } from "./FlowEditor";
import { TrafficPanel } from "./Traffic";

type SavedRun = { id: string; label: string; device: string; count: number };
export function Prompt({ device }: { device?: string }) {
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [choices, setChoices] = React.useState<SavedRun[]>([]);
  const [query, setQuery] = React.useState("");
  const [names, setNames] = React.useState<string[]>([]);
  const [browsing, setBrowsing] = React.useState(false);
  const promptInput = React.useRef<HTMLInputElement>(null);
  async function refreshLibrary() {
    try {
      const r = await fetch("/api/library");
      if (!r.ok) throw new Error("저장된 동선 목록 조회 실패");
      setNames(await r.json());
    } catch (e) {
      append("× " + (e instanceof Error ? e.message : String(e)) + "\n");
    }
  }
  const picker = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [execution, setExecution] = React.useState("대기");
  const [log, setLog] = React.useState("");
  const output = React.useRef<HTMLPreElement>(null);
  const follow = React.useRef(true);
  React.useLayoutEffect(() => {
    if (follow.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [log]);
  const append = (text: string) =>
    setLog((previous) => (previous + text).slice(-120000));
  async function saveRun(id: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/library/save/" + encodeURIComponent(id), {
        method: "POST",
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setChoices([]);
      if (!body.path) return;
      append("✓ " + body.path + " 저장\n");
      await refreshLibrary();
    } catch (e) {
      append("× " + (e instanceof Error ? e.message : String(e)) + "\n");
    } finally {
      setBusy(false);
    }
  }
  async function saveFlow() {
    try {
      const r = await fetch("/api/flows");
      if (!r.ok) throw new Error("동선 목록 조회 실패");
      const runs: SavedRun[] = await r.json();
      if (!runs.length) throw new Error("저장할 성공 동선이 없습니다.");
      if (runs.length === 1) await saveRun(runs[0].id);
      else setChoices(runs);
    } catch (e) {
      append("× " + (e instanceof Error ? e.message : String(e)) + "\n");
    }
  }
  async function submit(file?: File) {
    if (busy || (!file && !value.trim())) return;
    setBusy(true);
    setExecution("실행 중");
    follow.current = true;
    append(file ? "▶ " + file.name + "\n" : "$ " + value.trim() + "\n");
    try {
      const response = await fetch(file ? "/api/flows/run" : "/api/prompt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify(
          file
            ? { yaml: await file.text(), name: file.name, device }
            : { prompt: value, device },
        ),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      if (
        response.headers.get("content-type")?.startsWith("application/json")
      ) {
        append((await response.json()).text + "\n");
        setExecution("완료");
        if (!file) setValue("");
        return;
      }
      const reader = response
        .body!.pipeThrough(new TextDecoderStream())
        .getReader();
      let pending = "",
        done = false;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += chunk.value;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.kind === "error") throw new Error(event.text);
          if (event.kind === "done") done = true;
          else append(event.text);
        }
      }
      if (!done) throw new Error("Connection closed before completion.");
      setExecution("완료");
      if (!file) setValue("");
    } catch (error) {
      setExecution("실패");
      append(
        "× " + (error instanceof Error ? error.message : String(error)) + "\n",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <aside
        className="flex min-h-0 shrink-0 flex-col gap-2 py-2 pl-4"
        style={{ width: "clamp(216px,24vw,320px)" }}
      >
        <input
          ref={promptInput}
          aria-label="Maestro prompt"
          placeholder="Ask Maestro…"
          value={value}
          readOnly={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            )
              void submit();
          }}
          className="h-9 w-full rounded-lg border border-neutral-300 bg-neutral-50 px-3 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => void saveFlow()}
          >
            성공 동선 저장
          </button>
          <button
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            동선 파일 실행
          </button>
          <button
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700"
            aria-expanded={editorOpen}
            onClick={() => {
              setEditorOpen(!editorOpen);
              if (!editorOpen) void refreshLibrary();
            }}
          >
            동선 파일 수정
          </button>
          <input
            hidden
            type="file"
            ref={picker}
            accept=".yaml,.yml"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void submit(f);
            }}
          />
        </div>
        {choices.length > 0 && (
          <select
            className="w-full rounded border text-xs dark:bg-neutral-900"
            aria-label="저장할 동선"
            value=""
            onChange={(e) => void saveRun(e.target.value)}
          >
            <option value="" disabled>
              저장할 동선 선택
            </option>
            {choices.map((run) => (
              <option key={run.id} value={run.id}>
                {run.label} · {run.device} · {run.count}회
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          aria-label="저장된 동선 검색"
          placeholder="저장된 동선 검색"
          value={query}
          onFocus={() => {
            setBrowsing(true);
            void refreshLibrary();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setBrowsing(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setBrowsing(false);
          }}
          className="h-8 w-full rounded-lg border border-neutral-300 bg-neutral-50 px-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
        {browsing && (
          <div className="max-h-32 overflow-y-auto text-xs">
            {names
              .filter((n) =>
                n
                  .normalize()
                  .toLowerCase()
                  .includes(query.normalize().toLowerCase()),
              )
              .map((n) => (
                <button
                  key={n}
                  disabled={busy}
                  className="block w-full break-all rounded px-2 py-1 text-left hover:bg-neutral-200 dark:hover:bg-neutral-800"
                  onClick={() => {
                    setValue("/run " + n);
                    setBrowsing(false);
                    promptInput.current?.focus();
                  }}
                >
                  {n}
                </button>
              ))}
            {!names.some((n) =>
              n
                .normalize()
                .toLowerCase()
                .includes(query.normalize().toLowerCase()),
            ) && <p className="px-2 text-neutral-500">검색 결과가 없습니다.</p>}
          </div>
        )}
        <div className="flow-log-heading">
          <strong>실행 로그</strong>
          <StatusChip label={execution} />
        </div>
        <pre
          ref={output}
          role="log"
          aria-label="Execution log"
          aria-live="off"
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current =
              el.scrollHeight - el.clientHeight - el.scrollTop < 24;
          }}
          className="scrollbar-quiet m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-neutral-200 bg-white p-3 font-mono text-xs leading-5 text-neutral-800"
        >
          {log}
        </pre>
        <TrafficPanel />
      </aside>
      <FlowEditor
        open={editorOpen}
        names={names}
        onCollapse={() => setEditorOpen(false)}
      />
    </>
  );
}
