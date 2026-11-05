import { createHash } from "node:crypto";
import type { ActorsClient } from "./actors/index.js";
import { type HistoryEntry, type List, requireThat, WorkspaceError } from "./contracts/common.js";
import type { Filter, RecordTable, Snapshot } from "./persistence/index.js";

export const now = () => new Date().toISOString();
export type Published<T> = T & { revision: number; updatedAt: string; history?: HistoryEntry[] };
/** The public record: the cursor stays internal; lists and writes carry no history. */
export function published<T>({ cursor: _cursor, ...record }: Snapshot<T>): Published<T> {
  return record as Published<T>;
}
export function recorded<T, C extends string>(
  table: RecordTable<T, C>,
  id: string,
  history = false,
): Published<T> {
  const item = table.get(id);
  requireThat(item, "not_found", "record not found");
  return history ? { ...published(item), history: table.history(id) } : published(item);
}
/** A table whose reads pass each current snapshot through `read`, as the module reads it. */
export function readThrough<T, C extends string>(
  table: RecordTable<T, C>,
  read: (row: Snapshot<T>) => Snapshot<T>,
): RecordTable<T, C> {
  return {
    get: (id) => {
      const row = table.get(id);
      return row && read(row);
    },
    where: (filter) => table.where(filter).map(read),
    history: (id) => table.history(id),
    head: () => table.head(),
    save: (id, data, event, expectedRevision) => table.save(id, data, event, expectedRevision),
  };
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
/**
 * Current upserts in update order, or most recent first, after every filter. Rows are read up to
 * the module head captured first, and the indexed filter is selected after it, so a write
 * committed during the read waits for the next page.
 */
export function traverse<T, C extends string>(
  actors: ActorsClient,
  table: RecordTable<T, C>,
  query: { after?: string | undefined; limit: number; order?: "recent" | undefined },
  scope: unknown,
  indexed: () => Filter<C>,
  visible: (row: Snapshot<T>) => boolean,
  mentions: (row: T) => (string | undefined)[],
): List<Published<T>> {
  const recent = query.order === "recent";
  const head = table.head();
  const bound = query.after === undefined ? undefined : position(query.after, scope);
  requireThat(
    bound === undefined || bound <= head,
    "invalid_input",
    "position is beyond the module head",
  );
  const rows = table
    .where(indexed())
    .filter(
      (row) =>
        row.cursor <= head &&
        (bound === undefined || (recent ? row.cursor < bound : row.cursor > bound)) &&
        visible(row),
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
