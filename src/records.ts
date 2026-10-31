import { type Page, requireThat } from "./contracts/common.js";
import type { Recorded, RecordTable, Snapshot } from "./persistence/index.js";

export const now = () => new Date().toISOString();
export function recorded<T>(table: RecordTable<T>, id: string): Recorded<T> {
  const item = table.get(id);
  requireThat(item, "not_found", "record not found");
  return { ...item, history: table.history(id) };
}
/** Current upserts only; filter/authority scope may lose records without tombstones. */
export function traverse<T>(
  table: RecordTable<T>,
  query: { after: number; limit: number },
  visible: (record: Snapshot<T>) => boolean,
): Page<Recorded<T>> {
  requireThat(query.after <= table.head(), "invalid_input", "cursor is beyond the module head");
  const rows = table
    .all()
    .filter((row) => row.cursor > query.after && visible(row))
    .slice(0, query.limit);
  return {
    items: rows.map((row) => ({ ...row, history: table.history(idOf(row)) })),
    after: rows.at(-1)?.cursor ?? query.after,
  };
}
function idOf(value: unknown): string {
  const row = value as { messageID?: string; ticketID?: string; formID?: string };
  return (row.messageID ?? row.ticketID ?? row.formID) as string;
}
