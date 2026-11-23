import { parseAllDocuments, stringify } from "yaml";
import { randomUUID } from "node:crypto";

// One entry per prompt and device. Preserve separate run calls so their headers
// and explicit environment variables keep their original scopes.
export function flowHistory() {
  const records = new Map();
  return {
    begin(label) {
      const devices = new Map();
      let next = 0;
      return (input) => {
        const order = next++;
        const args = structuredClone(input);
        return (result) => {
          if (result?.isError) return;
          let payload;
          try {
            payload = JSON.parse(result.content?.[0]?.text);
          } catch {}
          if (payload?.success === false) return;
          const { device_id, env } = args;
          const step = args.yaml
            ? { yaml: args.yaml }
            : {
                files:
                  payload?.results
                    ?.filter((r) => r.success)
                    .map((r) => r.file) ?? args.files,
              };
          if (!step.yaml && !step.files?.length) return;
          if (env && Object.keys(env).length) step.env = env;
          let entry = devices.get(device_id);
          if (!entry) {
            entry = { id: randomUUID(), label, device: device_id, steps: [] };
            devices.set(device_id, entry);
            records.set(entry.id, entry);
          }
          entry.steps.push({ order, step });
        };
      };
    },
    list() {
      return [...records.values()]
        .reverse()
        .map(({ id, label, device, steps }) => ({
          id,
          label,
          device,
          count: steps.length,
        }));
    },
    export(id) {
      const entry = records.get(id);
      if (!entry) return null;
      const steps = entry.steps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((v) => v.step);
      if (steps.length === 1 && steps[0].yaml && !steps[0].env)
        return steps[0].yaml;
      return stringify({ maestroViewer: 1, steps }, { lineWidth: 0 });
    },
  };
}

export function importFlow(text) {
  if (typeof text !== "string" || !text.trim())
    throw new Error("빈 동선 파일입니다.");
  const docs = parseAllDocuments(text);
  for (const doc of docs)
    if (doc.errors.length) throw new Error(doc.errors[0].message);
  const first = docs[0]?.toJS();
  if (first?.maestroViewer === undefined) {
    if (!(
      (docs.length === 1 && Array.isArray(first) && first.length) ||
      (docs.length === 2 &&
        first &&
        typeof first === "object" &&
        !Array.isArray(first) &&
        Array.isArray(docs[1].toJS()) &&
        docs[1].toJS().length)
    ))
      throw new Error("Maestro 명령 목록이 필요합니다.");
    return [{ yaml: text }];
  }
  if (
    docs.length !== 1 ||
    first.maestroViewer !== 1 ||
    !Array.isArray(first.steps) ||
    !first.steps.length
  )
    throw new Error("지원하지 않는 동선 파일입니다.");
  for (const step of first.steps) {
    if (
      !step ||
      typeof step !== "object" ||
      Object.keys(step).some((k) => !["yaml", "files", "env"].includes(k)) ||
      "yaml" in step === "files" in step ||
      ("yaml" in step &&
        (typeof step.yaml !== "string" || !step.yaml.trim())) ||
      ("files" in step &&
        (!Array.isArray(step.files) ||
          !step.files.length ||
          step.files.some((f) => typeof f !== "string" || !f.trim()))) ||
      ("env" in step &&
        (!step.env ||
          typeof step.env !== "object" ||
          Array.isArray(step.env) ||
          Object.values(step.env).some((v) => typeof v !== "string")))
    )
      throw new Error("동선 단계 형식이 잘못되었습니다.");
  }
  return first.steps;
}
