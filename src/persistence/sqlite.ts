import { DatabaseSync } from "node:sqlite";
import { requireThat } from "../contracts/common.js";
import type { HistoryEntry } from "../contracts/index.js";
import type { RecordTable, Snapshot, WorkspaceStore } from "./index.js";

const MODULES = ["messages", "work", "forms"] as const;
/**
 * Step N upgrades a database at user_version N; 0 is a 0.4 database. Snapshots change in place and
 * history keeps every original event.
 */
const UPGRADES: ((db: DatabaseSync) => void)[] = [
  // 0.5: Messages link no Work.
  (db) => db.exec("UPDATE messages SET data=json_remove(data,'$.workID')"),
];

/** One SQLite database; module tables and their history are committed together. */
export function openSqlite(path: string): WorkspaceStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  try {
    transaction(() => {
      const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get();
      const version = existing ? Number(db.prepare("PRAGMA user_version").get()?.user_version) : 0;
      if (version > UPGRADES.length)
        throw new Error(`workspace database version ${version} is newer than this package`);
      for (const name of MODULES) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ${name}_history (id TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, event TEXT NOT NULL, PRIMARY KEY (id, revision));
        `);
      }
      if (existing) for (const upgrade of UPGRADES.slice(version)) upgrade(db);
      db.exec(`PRAGMA user_version=${UPGRADES.length}`);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  function transaction<T>(callback: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function table<T>(name: (typeof MODULES)[number]): RecordTable<T> {
    const current = `SELECT m.data,m.revision,m.cursor,json_extract(h.event,'$.at') AS updated_at FROM ${name} m JOIN ${name}_history h ON h.id=m.id AND h.revision=m.revision`;
    const select = db.prepare(`${current} WHERE m.id=?`);
    const list = db.prepare(`${current} ORDER BY m.cursor ASC`);
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
      updatedAt: String(row.updated_at),
    });
    const get = (id: string) => {
      const row = select.get(id);
      return row ? decode(row) : undefined;
    };
    const latest = () => Number(head.get()?.head ?? 0);
    return {
      get,
      history: (id) => events.all(id).map((row) => JSON.parse(String(row.event))),
      head: latest,
      all: () => list.all().map(decode),
      save(id, data, event, expectedRevision): Snapshot<T> {
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
        return { ...data, revision, cursor, updatedAt: event.at };
      },
    };
  }
  return {
    messages: table("messages"),
    work: table("work"),
    forms: table("forms"),
    transaction,
    close: () => db.close(),
  };
}
