import { createHash } from "node:crypto";
import type { ActorsClient } from "./actors/index.js";
import { type HistoryEntry, type List, requireThat, WorkspaceError } from "./contracts/common.js";
import type { RecordTable, Snapshot } from "./persistence/index.js";

export const now = () => new Date().toISOString();
export type Published<T> = T & { revision: number; updatedAt: string; history?: HistoryEntry[] };
/** The public record: the cursor stays internal; lists and writes carry no history. */
export function published<T>({ cursor: _cursor, ...record }: Snapshot<T>): Published<T> {
  return record as Published<T>;
}
export function recorded<T>(table: RecordTable<T>, id: string, history = false): Published<T> {
  const item = table.get(id);
  requireThat(item, "not_found", "record not found");
  return history ? { ...published(item), history: table.history(id) } : published(item);
}
/** The module state alone, for writing the next revision. */
export function stateOf<T>(row: Published<T>): T {
  const { revision: _revision, updatedAt: _updatedAt, history: _history, ...state } = row;
  return state as T;
}
const digest = (scope: unknown) =>
  createHash("sha256").update(JSON.stringify(scope)).digest("base64url").slice(0, 16);
/** An opaque position naming its read, filter and direction. */
export function token(scope: unknown, position: number, direction: "after" | "before" = "after") {
  return Buffer.from(JSON.stringify([digest(scope), direction, position])).toString("base64url");
}
export function position(
  value: string,
  scope: unknown,
  direction: "after" | "before" = "after",
): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    decoded = undefined;
  }
  const [read, way, at] = Array.isArray(decoded) ? decoded : [];
  requireThat(
    read === digest(scope) && way === direction && Number.isSafeInteger(at) && at >= 0,
    "invalid_input",
    "position does not continue this read",
  );
  return at;
}
/** Current upserts in update order, or most recent first, after every filter. */
export function traverse<T>(
  actors: ActorsClient,
  table: RecordTable<T>,
  query: { after?: string | undefined; limit: number; order?: "recent" | undefined },
  scope: unknown,
  visible: (row: Snapshot<T>) => boolean,
  mentions: (row: T) => (string | undefined)[],
): List<Published<T>> {
  const recent = query.order === "recent";
  const bound = query.after === undefined ? undefined : position(query.after, scope);
  requireThat(
    bound === undefined || bound <= table.head(),
    "invalid_input",
    "position is beyond the module head",
  );
  const rows = table
    .all()
    .filter(
      (row) =>
        (bound === undefined || (recent ? row.cursor < bound : row.cursor > bound)) && visible(row),
    );
  if (recent) rows.reverse();
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map(published),
    next: last && rows.length > items.length ? token(scope, last.cursor) : null,
    actors: names(actors, items.flatMap(mentions)),
  };
}
/** Names of the Actors a page mentions; Actors the caller can't see are left out. */
export function names(actors: ActorsClient, ids: Iterable<string | undefined>) {
  const found: [string, { name: string }][] = [];
  for (const actorID of new Set(ids)) {
    if (actorID === undefined) continue;
    try {
      found.push([actorID, { name: actors.get({ actorID }).name }]);
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.code === "not_found")) throw error;
    }
  }
  return Object.fromEntries(found);
}
