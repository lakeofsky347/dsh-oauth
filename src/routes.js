/** Restore only settings written by this pull, leaving later user edits intact. */
import { isDeepStrictEqual } from "node:util";

const NS = "llm-pi-ai";
const at = (object, path) => path.reduce((value, key) => value?.[key], object);
const descriptor = (settings) => settings.describe({ redactSecrets: false }).find((row) => row.ns === NS);

/** Capture the prior user values for the exact paths being changed. */
export async function writeRoute(settings, id, models, codingPlan, previous) {
  const row = descriptor(settings);
  if (!row) throw new Error("llm-pi-ai 设置尚未挂载");
  const providerPath = ["providers", id];
  const provider = at(row.user, providerPath);
  const entries = codingPlan && provider === undefined
    ? [{ path: providerPath, value: codingPlan }]
    : Object.entries(codingPlan ?? { models }).map(([key, value]) => ({ path: [...providerPath, key], value }));
  const edits = entries.map(({ path, value }) => {
    const earlier = previous?.edits?.find((edit) => isDeepStrictEqual(edit.path, path));
    const before = at(row.user, path);
    return { path, written: value, ...(earlier && isDeepStrictEqual(before, earlier.written)
      ? (Object.hasOwn(earlier, "before") ? { before: earlier.before } : {})
      : before === undefined ? {} : { before }) };
  });
  // A second Qwen pull still owns the initially created provider entry.
  const owned = previous?.edits?.find((edit) => isDeepStrictEqual(edit.path, providerPath));
  if (codingPlan && owned && isDeepStrictEqual(provider, owned.written)) {
    edits.splice(0, edits.length, { ...owned, written: { ...provider, ...codingPlan } });
  }
  await settings.mutate(NS, edits.map((edit) => ({ op: "set", path: edit.path, value: edit.written })), row.revision);
  const rollback = { edits: edits.map((edit) => {
    const before = at(row.user, edit.path);
    return { path: edit.path, written: edit.written, ...(before === undefined ? {} : { before }) };
  }) };
  return { edits, rollback };
}

/** Missing legacy ownership data never authorizes deleting a whole provider. */
export async function restoreRoute(settings, route) {
  if (!Array.isArray(route?.edits)) return;
  const row = descriptor(settings);
  if (!row) throw new Error("llm-pi-ai 设置尚未挂载，稍后重试清理");
  const ops = route.edits.filter((edit) => isDeepStrictEqual(at(row.user, edit.path), edit.written))
    .map((edit) => Object.hasOwn(edit, "before")
      ? { op: "set", path: edit.path, value: edit.before }
      : { op: "unset", path: edit.path });
  if (ops.length > 0) await settings.mutate(NS, ops, row.revision);
}
