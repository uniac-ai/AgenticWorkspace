/** Transactional snapshots and retained module history; SQLite is the v1 implementation. */
import type {
  FormState,
  HistoryEntry,
  MessageState,
  StatusState,
  WorkState,
} from "../contracts/index.js";

/** updatedAt is the time of the event that wrote the current revision. */
export type Snapshot<T> = T & { revision: number; cursor: number; updatedAt: string };
export interface RecordTable<T> {
  get(id: string): Snapshot<T> | undefined;
  all(): Snapshot<T>[];
  history(id: string): HistoryEntry[];
  head(): number;
  /** Called inside transaction; expectedRevision is absent only for insertion. */
  save(
    id: string,
    data: T,
    event: Pick<HistoryEntry, "actorID" | "at" | "action" | "detail">,
    expectedRevision?: number,
  ): Snapshot<T>;
}
export interface WorkspaceStore {
  messages: RecordTable<MessageState>;
  work: RecordTable<WorkState>;
  forms: RecordTable<FormState>;
  status: RecordTable<StatusState>;
  /** Callback is synchronous; state checks and writes share one transaction. */
  transaction<T>(callback: () => T): T;
  close(): void;
}
export { openSqlite } from "./sqlite.js";
