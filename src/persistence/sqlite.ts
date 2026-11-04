import { DatabaseSync, type StatementSync } from "node:sqlite";
import { requireThat } from "../contracts/common.js";
import type { HistoryEntry } from "../contracts/index.js";
import type { Filter, RecordTable, Snapshot, WorkspaceStore } from "./index.js";

/** A version 3 database also holds the status and status_history tables, which stay unread. */
const MODULES = ["messages", "work", "forms"] as const;
/**
 * Step N upgrades a database at user_version N to N + 1, and each step's comment names the version
 * it produces. 0 is a database from before storage versions, or a new one, where the data steps
 * find no rows. Snapshots change in place and history keeps every original event.
 */
const UPGRADES: ((db: DatabaseSync) => void)[] = [
  // Version 1: Messages link no Work.
  (db) => db.exec("UPDATE messages SET data=json_remove(data,'$.workID')"),
  // Version 2: Work has a title from its goal and links, and accepted Work was completed when its
  // review accepted it.
  (db) => {
    const update = db.prepare("UPDATE work SET data=? WHERE id=?");
    for (const { id, data } of db.prepare("SELECT id,data FROM work").all()) {
      const work = JSON.parse(String(data));
      const completedAt = work.status === "accepted" ? work.review?.at : undefined;
      update.run(
        JSON.stringify({ ...work, title: headline(work.goal), links: [], completedAt }),
        String(id),
      );
    }
  },
  // Version 3: asks have a title from their first field's label, name no respondents and stay open
  // until their asker closes them, as Forms did before; options carry detail, and each response the
  // time of its last answer.
  (db) => {
    const events = db.prepare("SELECT event FROM forms_history WHERE id=? ORDER BY revision");
    const update = db.prepare("UPDATE forms SET data=? WHERE id=?");
    for (const { id, data } of db.prepare("SELECT id,data FROM forms").all()) {
      const { respondentIDs: _respondents, ...form } = JSON.parse(String(data));
      const answered = new Map<string, string>();
      for (const row of events.all(String(id))) {
        const event = JSON.parse(String(row.event));
        if (event.action === "responded") answered.set(event.actorID, event.at);
      }
      const fields = form.fields.map((field: { options?: string[] }) =>
        field.options ? { ...field, options: field.options.map((value) => ({ value })) } : field,
      );
      const responses = Object.fromEntries(
        Object.entries(form.responses).map(([actorID, answers]) => [
          actorID,
          { answers, at: answered.get(actorID) },
        ]),
      );
      const title = headline(form.fields[0].label);
      const ask = { ...form, title, links: [], approval: false, collect: true, fields, responses };
      update.run(JSON.stringify(ask), String(id));
    }
  },
  // Version 4: indexed columns for the fields lists select by. A stored `blocked` is indexed as
  // `active`, the status Work reads it as, and an ask's route starts at its last raiser, else its
  // asker.
  // A party's index leads with the party and then status, so a party's Work or asks in some
  // statuses is one index range whatever the planner knows of the data.
  (db) =>
    db.exec(`
      ALTER TABLE messages ADD COLUMN sender TEXT GENERATED ALWAYS AS (json_extract(data,'$.senderID')) VIRTUAL;
      ALTER TABLE messages ADD COLUMN recipient TEXT GENERATED ALWAYS AS (json_extract(data,'$.recipientID')) VIRTUAL;
      ALTER TABLE work ADD COLUMN owner TEXT GENERATED ALWAYS AS (json_extract(data,'$.ownerID')) VIRTUAL;
      ALTER TABLE work ADD COLUMN requester TEXT GENERATED ALWAYS AS (json_extract(data,'$.requesterID')) VIRTUAL;
      ALTER TABLE work ADD COLUMN status TEXT GENERATED ALWAYS AS (CASE json_extract(data,'$.status') WHEN 'blocked' THEN 'active' ELSE json_extract(data,'$.status') END) VIRTUAL;
      ALTER TABLE work ADD COLUMN submission TEXT GENERATED ALWAYS AS (json_extract(data,'$.submission.submissionID')) VIRTUAL;
      ALTER TABLE forms ADD COLUMN requester TEXT GENERATED ALWAYS AS (json_extract(data,'$.requesterID')) VIRTUAL;
      ALTER TABLE forms ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) VIRTUAL;
      ALTER TABLE forms ADD COLUMN work TEXT GENERATED ALWAYS AS (json_extract(data,'$.workID')) VIRTUAL;
      ALTER TABLE forms ADD COLUMN route TEXT GENERATED ALWAYS AS (COALESCE(json_extract(data,'$.raises[#-1].actorID'),json_extract(data,'$.requesterID'))) VIRTUAL;
      CREATE INDEX messages_sender ON messages(sender);
      CREATE INDEX messages_recipient ON messages(recipient);
      CREATE INDEX work_owner ON work(owner,status);
      CREATE INDEX work_requester ON work(requester,status);
      CREATE INDEX work_status ON work(status);
      CREATE INDEX work_submission ON work(submission);
      CREATE INDEX forms_requester ON forms(requester,status);
      CREATE INDEX forms_work ON forms(work,status);
      CREATE INDEX forms_route ON forms(status,route);
    `),
];
/** A title from existing text: its first line, cut at a word boundary to 120 characters. */
function headline(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line.length <= 120) return line;
  const space = line.slice(0, 120).search(/\s\S*$/);
  return `${(space > 0 ? line.slice(0, space) : line.slice(0, 119)).trimEnd()}…`;
}

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
      for (const upgrade of UPGRADES.slice(version)) upgrade(db);
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
  function table<T, C extends string = never>(name: (typeof MODULES)[number]): RecordTable<T, C> {
    const current = `SELECT m.data,m.revision,m.cursor,json_extract(h.event,'$.at') AS updated_at FROM ${name} m JOIN ${name}_history h ON h.id=m.id AND h.revision=m.revision`;
    const select = db.prepare(`${current} WHERE m.id=?`);
    const columns = new Set(
      db
        .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2,3)")
        .all(name)
        .map((row) => String(row.name)),
    );
    const indexed = (column: string) => {
      if (!columns.has(column)) throw new Error(`${name} has no indexed column ${column}`);
      return column;
    };
    /** The index each column leads, so a column's distinct values come from its own index. */
    const leading = new Map(
      db
        .prepare(
          "SELECT (SELECT name FROM pragma_index_info(l.name) WHERE seqno=0) AS lead, l.name FROM pragma_index_list(?) l",
        )
        .all(name)
        .map((row) => [String(row.lead), String(row.name)]),
    );
    const statements = new Map<string, StatementSync>();
    const prepared = (sql: string) => {
      const statement = statements.get(sql) ?? db.prepare(sql);
      statements.set(sql, statement);
      return statement;
    };
    /** Each filtered column's values are bound as one JSON array. */
    const matching = (filter: Filter<C>) => {
      const entries = Object.entries<readonly string[] | undefined>(filter).filter(
        (entry): entry is [string, readonly string[]] => entry[1] !== undefined,
      );
      return {
        sql: entries
          .map(([column]) => ` AND m.${indexed(column)} IN (SELECT value FROM json_each(?))`)
          .join(""),
        values: entries.map(([, values]) => JSON.stringify(values)),
      };
    };
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
      where(filter) {
        const { sql, values } = matching(filter);
        return prepared(`${current} WHERE 1${sql} ORDER BY m.cursor ASC`)
          .all(...values)
          .map(decode);
      },
      values(column, filter) {
        const { sql, values } = matching(filter);
        const selected = indexed(column);
        const index = leading.get(selected);
        return prepared(
          `SELECT DISTINCT m.${selected} AS value FROM ${name} m${index === undefined ? "" : ` INDEXED BY ${index}`} WHERE m.${selected} IS NOT NULL${sql}`,
        )
          .all(...values)
          .map((row) => String(row.value));
      },
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
