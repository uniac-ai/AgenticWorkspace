import { DatabaseSync } from "node:sqlite";
import { requireThat } from "../contracts/common.js";
import type { HistoryEntry } from "../contracts/index.js";
import type { Recorded, RecordTable, Snapshot, WorkspaceStore } from "./index.js";

const MODULES = ["messages", "work", "forms"] as const;

/** One SQLite database; module tables and their history are committed together. */
export function openSqlite(path: string): WorkspaceStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  for (const name of MODULES) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${name}_history (id TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, event TEXT NOT NULL, PRIMARY KEY (id, revision));
    `);
  }
  function table<T>(name: (typeof MODULES)[number]): RecordTable<T> {
    const select = db.prepare(`SELECT data,revision,cursor FROM ${name} WHERE id=?`);
    const list = db.prepare(`SELECT data,revision,cursor FROM ${name} ORDER BY cursor ASC`);
    const events = db.prepare(`SELECT event FROM ${name}_history WHERE id=? ORDER BY revision ASC`);
    const head = db.prepare(`SELECT COALESCE(MAX(cursor),0) AS head FROM ${name}_history`);
    const put = db.prepare(
      `INSERT INTO ${name}(id,data,revision,cursor) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision,cursor=excluded.cursor`,
    );
    const append = db.prepare(
      `INSERT INTO ${name}_history(id,revision,cursor,event) VALUES(?,?,?,?)`,
    );
    const decode = (row: Record<string, unknown>): Snapshot<T> => ({
      ...JSON.parse(String(row.data)),
      revision: Number(row.revision),
      cursor: Number(row.cursor),
    });
    const get = (id: string) => {
      const row = select.get(id);
      return row ? decode(row) : undefined;
    };
    const history = (id: string): HistoryEntry[] =>
      events.all(id).map((row) => JSON.parse(String(row.event)));
    const latest = () => Number(head.get()?.head ?? 0);
    return {
      get,
      history,
      head: latest,
      all: () => list.all().map(decode),
      save(id, data, event, expectedRevision): Recorded<T> {
        const current = get(id);
        requireThat(
          current ? current.revision === expectedRevision : expectedRevision === undefined,
          "conflict",
          "record revision changed",
        );
        const revision = (current?.revision ?? 0) + 1;
        const cursor = latest() + 1;
        requireThat(Number.isSafeInteger(cursor), "conflict", "cursor capacity reached");
        const entry: HistoryEntry = { ...event, revision, cursor };
        put.run(id, JSON.stringify(data), revision, cursor);
        append.run(id, revision, cursor, JSON.stringify(entry));
        return { ...data, revision, cursor, history: history(id) };
      },
    };
  }
  return {
    messages: table("messages"),
    work: table("work"),
    forms: table("forms"),
    transaction<T>(callback: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
