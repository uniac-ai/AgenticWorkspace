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
/** Indexed columns, each kept to one of its listed values; an absent column keeps every row. */
export type Filter<C extends string> = { [K in C]?: readonly string[] | undefined };
export interface RecordTable<T, C extends string = never> {
  get(id: string): Snapshot<T> | undefined;
  /** Current snapshots in cursor order whose every filtered column holds one of its values. */
  where(filter: Filter<C>): Snapshot<T>[];
  /** The distinct values one indexed column holds among the rows a filter keeps. */
  values(column: C, filter: Filter<C>): string[];
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
  messages: RecordTable<MessageState, "sender" | "recipient">;
  /** A stored `blocked` status is indexed as `active`; submission is the current submission's ID. */
  work: RecordTable<WorkState, "owner" | "requester" | "status" | "submission">;
  /** route is where an ask's route starts: its last raiser, else its asker. */
  forms: RecordTable<FormState, "requester" | "status" | "work" | "route">;
  status: RecordTable<StatusState>;
  /** Callback is synchronous; state checks and writes share one transaction. */
  transaction<T>(callback: () => T): T;
  close(): void;
}
export { openSqlite } from "./sqlite.js";
