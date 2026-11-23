import React from "react";

export function FlowEditor({
  open,
  names,
  onCollapse,
}: {
  open: boolean;
  names: string[];
  onCollapse: () => void;
}) {
  const [name, setName] = React.useState("");
  const [base, setBase] = React.useState("");
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const dirty = text !== base;
  async function documentRequest(file: string, save: boolean) {
    setPending(true);
    setMessage("");
    try {
      const res = await fetch("/api/library/document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          save ? { name: file, base, text } : { name: file },
        ),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setName(file);
      setBase(save ? text : body.text);
      if (!save) setText(body.text);
      setMessage(save ? "저장했습니다." : "");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  if (!open) return null;
  const button =
    "rounded-md border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700";
  return (
    <aside
      aria-label="동선 파일 수정"
      className="my-2 ml-3 flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-700 dark:bg-neutral-900"
    >
      <header className="flex items-center justify-between">
        <strong className="text-sm">동선 파일 수정</strong>
        <button
          className={button}
          onClick={onCollapse}
          aria-label="편집기 접기"
        >
          ‹ 접기
        </button>
      </header>
      <select
        aria-label="수정할 동선 파일"
        className={button}
        value={name}
        disabled={pending || dirty}
        onChange={(e) => void documentRequest(e.target.value, false)}
      >
        <option value="" disabled>
          {names.length ? "flows/ 파일 선택" : "저장된 동선이 없습니다"}
        </option>
        {names.map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
      {name && (
        <>
          <textarea
            aria-label="동선 YAML"
            className="min-h-0 flex-1 resize-none rounded border border-neutral-300 bg-transparent p-2 font-mono"
            value={text}
            spellCheck={false}
            readOnly={pending}
            onChange={(e) => {
              setText(e.target.value);
              setMessage("");
            }}
          />
          <div className="flex gap-2">
            <button
              className={button}
              disabled={!dirty || pending}
              onClick={() => void documentRequest(name, true)}
            >
              저장
            </button>
            <button
              className={button}
              disabled={pending}
              onClick={() => void documentRequest(name, false)}
            >
              {dirty ? "변경 버리고 다시 열기" : "다시 열기"}
            </button>
          </div>
        </>
      )}
      <span role="status">
        {message || (dirty ? "저장하지 않은 변경 사항" : "")}
      </span>
    </aside>
  );
}
