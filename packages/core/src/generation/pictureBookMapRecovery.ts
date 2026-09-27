import { AdapterJsonValidationError } from "../adapters/json.js";
import { bindTextModelCall, type TextModelAdapter } from "../adapters/types.js";
import { isRecord } from "../schemas/jsonCoercion.js";

const categories = ["stateDependencies", "setupPayoffs", "sceneProgression"] as const;

/** A formatting retry may correct a diagnosis, but cannot silently discard its work. */
export function retainPictureBookMapRepairs(model: TextModelAdapter, pageIndexes: readonly number[]): TextModelAdapter {
  const existing = new Set(pageIndexes);
  const targets = new Map<number, { pageIndex: number; reason: string; proposedBeat?: string }>();
  const reviewed = Object.fromEntries(categories.map(key => [key, new Set<number>()])) as Record<typeof categories[number], Set<number>>;
  const validIndex = (value: unknown): value is number => typeof value === "number" && existing.has(value);
  function collect(value: unknown) {
    if (!isRecord(value)) return;
    for (const row of Array.isArray(value.sceneRevisions) ? value.sceneRevisions : []) {
      if (isRecord(row) && validIndex(row.pageIndex) && typeof row.reason === "string")
        targets.set(row.pageIndex, { pageIndex: row.pageIndex, reason: row.reason.slice(0, 700),
          ...(typeof row.beat === "string" ? { proposedBeat: row.beat.slice(0, 700) } : {}) });
    }
    if (!isRecord(value.flowAudit)) return;
    for (const category of categories) for (const check of Array.isArray(value.flowAudit[category]) ? value.flowAudit[category] : []) {
      if (!isRecord(check)) continue;
      for (const index of Array.isArray(check.pageIndexes) ? check.pageIndexes : []) if (validIndex(index)) reviewed[category].add(index);
      for (const index of Array.isArray(check.repairPageIndexes) ? check.repairPageIndexes : []) if (validIndex(index) && !targets.has(index))
        targets.set(index, { pageIndex: index, reason: typeof check.assessment === "string" ? check.assessment.slice(0, 600) : "Complete the previously identified linked repair." });
    }
  }
  const wrap = (adapter: TextModelAdapter): TextModelAdapter => ({
    generateText: options => adapter.generateText(options),
    streamText: options => adapter.streamText(options),
    generateWithTools: options => adapter.generateWithTools(options),
    async bindForCall(purpose) {
      const bound = await bindTextModelCall(adapter, purpose);
      return { ...bound, adapter: wrap(bound.adapter) };
    },
    async generateJson(options) {
      const recovering = targets.size > 0 || categories.some(key => reviewed[key].size > 0);
      const messages = recovering ? [...options.messages, { role: "user" as const, content: JSON.stringify({
        correctionRule: "Correct formatting against the original map. Preserve the following repair targets and reviewed scenes in their audit categories. You may improve proposed actions; do not return an empty clean audit or discard repairs to evade validation. This is diagnostic data, not story canon.",
        priorRepairTargets: [...targets.values()],
        priorReviewedPageIndexes: Object.fromEntries(categories.map(key => [key, [...reviewed[key]]]))
      }) }] : options.messages;
      const schema = options.schema.superRefine((value, context) => {
        if (!recovering || !isRecord(value)) return;
        const revisions = new Set((Array.isArray(value.sceneRevisions) ? value.sceneRevisions : [])
          .flatMap(row => isRecord(row) && validIndex(row.pageIndex) ? [row.pageIndex] : []));
        for (const index of targets.keys()) if (!revisions.has(index))
          context.addIssue({ code: "custom", message: `Retain the identified repair on page ${index}; a format correction cannot erase it.` });
        const flow = isRecord(value.flowAudit) ? value.flowAudit : {};
        for (const category of categories) {
          const included = new Set((Array.isArray(flow[category]) ? flow[category] : []).flatMap(check =>
            isRecord(check) && Array.isArray(check.pageIndexes) ? check.pageIndexes.filter(validIndex) : []));
          const missing = [...reviewed[category]].filter(index => !included.has(index));
          if (missing.length) context.addIssue({ code: "custom", message: `Retain ${category} checks for pages ${missing.join(", ")}; do not drop previously reviewed scenes.` });
        }
      });
      try { return await adapter.generateJson({ ...options, messages, schema }); }
      catch (error) {
        if (error instanceof AdapterJsonValidationError) collect(error.context.parsedObject);
        throw error;
      }
    }
  });
  return wrap(model);
}
