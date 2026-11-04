import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
import type { Form, Work } from "../src/contracts/index.js";
import { bindWorkspace } from "../src/index.js";
import { openSqlite } from "../src/persistence/index.js";

const at = "2026-10-31T12:00:00.000Z";
const reviewedAt = "2026-10-31T13:00:00.000Z";
const longGoal = `Ship ${"release ".repeat(20).trim()}\nDetails on the second line`;
const answeredAt = "2026-10-31T14:00:00.000Z";
const ask = {
  respondentIDs: ["owner", "respondent"],
  fields: [{ name: "choice", label: "Which?", required: true, options: ["a", "b"] }],
};
type Event = { actorID: string; at: string; action: string; detail: object };
/** A database from before storage versions: no user_version, and Messages may link Work. */
function legacy(file: string) {
  const db = new DatabaseSync(file);
  let cursor = 0;
  function insert(name: string, id: string, data: object, action: string, detail: object) {
    record(name, id, data, [{ actorID: "requester", at, action, detail }]);
  }
  function record(name: string, id: string, data: object, events: Event[]) {
    events.forEach((event, i) => {
      cursor++;
      db.prepare(`INSERT INTO ${name}_history(id,revision,cursor,event) VALUES(?,?,?,?)`).run(
        id,
        i + 1,
        cursor,
        JSON.stringify({ ...event, revision: i + 1, cursor }),
      );
    });
    db.prepare(`INSERT INTO ${name}(id,revision,cursor,data) VALUES(?,?,?,?)`).run(
      id,
      events.length,
      cursor,
      JSON.stringify(data),
    );
  }
  for (const name of ["messages", "work", "forms"])
    db.exec(`
      CREATE TABLE ${name} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE ${name}_history (id TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, event TEXT NOT NULL, PRIMARY KEY (id, revision));
    `);
  const goal = { goal: "Legacy goal", ownerID: "owner" };
  insert(
    "work",
    "ticket",
    { ticketID: "ticket", requesterID: "requester", ...goal, status: "open", createdAt: at },
    "created",
    goal,
  );
  insert(
    "work",
    "accepted",
    {
      ticketID: "accepted",
      requesterID: "requester",
      ...goal,
      goal: longGoal,
      status: "accepted",
      createdAt: at,
      submission: { submissionID: "s", ownerID: "owner", result: "Done", evidence: [], at },
      review: {
        submissionID: "s",
        reviewerID: "requester",
        verdict: "accepted",
        comment: "Checked",
        at: reviewedAt,
      },
    },
    "created",
    goal,
  );
  const unbroken = { goal: "x".repeat(130), ownerID: "owner" };
  insert(
    "work",
    "unbroken",
    { ticketID: "unbroken", requesterID: "requester", ...unbroken, status: "open", createdAt: at },
    "created",
    unbroken,
  );
  record(
    "forms",
    "form",
    {
      formID: "form",
      requesterID: "requester",
      ...ask,
      status: "open",
      responses: { owner: { choice: "a" } },
      createdAt: at,
    },
    [
      { actorID: "requester", at, action: "created", detail: ask },
      { actorID: "owner", at, action: "responded", detail: { answers: { choice: "b" } } },
      {
        actorID: "owner",
        at: answeredAt,
        action: "responded",
        detail: { answers: { choice: "a" } },
      },
    ],
  );
  const sent = { recipientID: "owner", text: "Linked", workID: "ticket" };
  insert(
    "messages",
    "message",
    { messageID: "message", senderID: "requester", ...sent, createdAt: at },
    "sent",
    sent,
  );
  db.close();
}
function work(record: Work | Form): Work {
  assert.ok("ticketID" in record);
  return record;
}
function version(file: string) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("PRAGMA user_version").get()?.user_version;
  } finally {
    db.close();
  }
}

test("a version 0 database upgrades once in place and keeps every original event", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "legacy.sqlite");
  legacy(file);
  for (let open = 0; open < 2; open++) {
    const store = openSqlite(file);
    try {
      const owner = bindWorkspace(fixtureAuthority().authority, store, "owner");
      const message = owner.messages.get({ messageID: "message" });
      assert.equal(Object.hasOwn(message, "workID"), false);
      assert.equal(message.seq, 7);
      assert.equal(store.messages.history("message")[0]?.detail.workID, "ticket");
      const pending = work(owner.work.get({ ticketID: "ticket" }));
      assert.equal(pending.updatedAt, at);
      assert.deepEqual(pending.links, []);
      assert.equal(pending.title, "Legacy goal");
      assert.equal(pending.goal, "Legacy goal");
      assert.equal(pending.completedAt, undefined);
      const accepted = work(owner.work.get({ ticketID: "accepted" }));
      assert.equal(accepted.completedAt, reviewedAt);
      assert.equal(accepted.title, `Ship ${Array(14).fill("release").join(" ")}…`);
      assert.equal(accepted.goal, longGoal);
      assert.equal(owner.work.get({ ticketID: "unbroken" }).title, `${"x".repeat(119)}…`);
      // This Form names no Work, so it reads alone.
      const form = owner.work.get({ askID: "form" });
      assert.ok("formID" in form);
      assert.equal(Object.hasOwn(form, "respondentIDs"), false);
      assert.deepEqual(form.raises, []);
      assert.equal(form.title, "Which?");
      assert.equal(form.fields[0]?.label, "Which?");
      assert.deepEqual(
        [form.links, form.approval, form.collect, form.status, form.updatedAt],
        [[], false, true, "open", answeredAt],
      );
      assert.deepEqual(form.fields[0]?.options, [{ value: "a" }, { value: "b" }]);
      assert.deepEqual(form.responses, { owner: { answers: { choice: "a" }, at: answeredAt } });
      assert.deepEqual(store.forms.history("form")[0]?.detail, ask);
    } finally {
      store.close();
    }
    assert.equal(version(file), 4);
    assert.deepEqual(indexes(file, "forms"), ["forms_requester", "forms_route", "forms_work"]);
  }
  const store = openSqlite(file);
  try {
    const outsider = bindWorkspace(fixtureAuthority().authority, store, "outsider");
    const answered = outsider.work.answer({ askID: "form", answers: { choice: "b" } });
    assert.ok("formID" in answered);
    assert.equal(answered.status, "open");
    assert.deepEqual(Object.keys(answered.responses), ["owner", "outsider"]);
  } finally {
    store.close();
  }
  const fresh = join(dir, "fresh.sqlite");
  openSqlite(fresh).close();
  assert.equal(version(fresh), 4);
  const tables = new DatabaseSync(fresh);
  assert.equal(tables.prepare("SELECT 1 FROM sqlite_schema WHERE name='status'").get(), undefined);
  tables.close();
  assert.deepEqual(indexes(fresh, "work"), [
    "work_owner",
    "work_requester",
    "work_status",
    "work_submission",
  ]);
});

const rows = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return ["messages", "work", "forms", "status"].flatMap((name) => [
      db.prepare(`SELECT id,revision,cursor,data FROM ${name} ORDER BY id`).all(),
      db.prepare(`SELECT id,revision,cursor,event FROM ${name}_history ORDER BY cursor`).all(),
    ]);
  } finally {
    db.close();
  }
};
function indexes(file: string, name: string) {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
      )
      .all(name)
      .map((row) => String(row.name))
      .sort();
  } finally {
    db.close();
  }
}
/** A version 3 database, with a Status table. */
function version3(file: string) {
  const db = new DatabaseSync(file);
  let cursor = 0;
  for (const name of ["messages", "work", "forms", "status"])
    db.exec(`
      CREATE TABLE ${name} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE ${name}_history (id TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL UNIQUE, event TEXT NOT NULL, PRIMARY KEY (id, revision));
    `);
  function insert(name: string, id: string, data: object) {
    cursor++;
    const event = { actorID: "owner", at, action: "created", detail: {}, revision: 1, cursor };
    db.prepare(`INSERT INTO ${name}_history(id,revision,cursor,event) VALUES(?,?,?,?)`).run(
      id,
      1,
      cursor,
      JSON.stringify(event),
    );
    db.prepare(`INSERT INTO ${name}(id,revision,cursor,data) VALUES(?,?,?,?)`).run(
      id,
      1,
      cursor,
      JSON.stringify(data),
    );
  }
  const work = { requesterID: "requester", ownerID: "owner", links: [], createdAt: at };
  insert("work", "held", { ...work, ticketID: "held", title: "Held", status: "blocked" });
  const asked = {
    formID: "asked",
    requesterID: "owner",
    title: "Which?",
    links: [],
    workID: "held",
    cause: "carried",
    approval: false,
    collect: false,
    fields: [{ name: "x", label: "Which?", required: true }],
    status: "open",
    createdAt: at,
    responses: {},
  };
  insert("forms", "asked", asked);
  const sent = { senderID: "requester", recipientID: "owner", text: "Hi", createdAt: at };
  insert("messages", "m", { messageID: "m", ...sent });
  insert("status", "owner", { actorID: "owner", line: "Holding", links: [] });
  db.exec("PRAGMA user_version=3");
  db.close();
}

test("a version 3 database upgrades to version 4 by indexing fields, rewriting no record", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "version3.sqlite");
  version3(file);
  const before = rows(file);
  openSqlite(file).close();
  assert.equal(version(file), 4);
  assert.deepEqual(rows(file), before);
  assert.deepEqual(indexes(file, "messages"), ["messages_recipient", "messages_sender"]);
  assert.deepEqual(indexes(file, "work"), [
    "work_owner",
    "work_requester",
    "work_status",
    "work_submission",
  ]);
  assert.deepEqual(indexes(file, "forms"), ["forms_requester", "forms_route", "forms_work"]);
  assert.deepEqual(indexes(file, "status"), []);
  const store = openSqlite(file);
  try {
    assert.deepEqual(
      store.work.where({ status: ["active"] }).map((row) => [row.ticketID, row.status]),
      [["held", "blocked"]],
    );
    assert.deepEqual(store.forms.values("route", { work: ["held"] }), ["owner"]);
    const owner = bindWorkspace(fixtureAuthority().authority, store, "owner").work;
    assert.deepEqual(
      owner.list({ status: ["active"] }).items.map((row) => [row.ticketID, row.status]),
      [["held", "active"]],
    );
  } finally {
    store.close();
  }
  assert.deepEqual(rows(file), before);
});

test("a newer database is refused unchanged, and a failed step rolls back every step", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-refusal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const newer = join(dir, "newer.sqlite");
  version3(newer);
  const db = new DatabaseSync(newer);
  db.exec("PRAGMA user_version=5");
  db.close();
  const before = rows(newer);
  assert.throws(() => openSqlite(newer), /version 5 is newer/);
  assert.equal(version(newer), 5);
  assert.deepEqual(rows(newer), before);
  assert.deepEqual(indexes(newer, "work"), []);
  const broken = join(dir, "broken.sqlite");
  version3(broken);
  const bad = new DatabaseSync(broken);
  bad.exec("UPDATE work SET data='not json'");
  bad.close();
  assert.throws(() => openSqlite(broken), /malformed JSON/);
  assert.equal(version(broken), 3);
  assert.deepEqual(indexes(broken, "messages"), []);
});

test("indexed lookups select current snapshots by column values, through their indexes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-lookup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "lookups.sqlite");
  let store = openSqlite(file);
  const event = { actorID: "owner", at, action: "created", detail: {} };
  const work = (ticketID: string, ownerID: string, status: "open" | "accepted") =>
    store.work.save(
      ticketID,
      {
        ticketID,
        requesterID: "requester",
        ownerID,
        title: ticketID,
        status,
        links: [],
        createdAt: at,
      },
      event,
    );
  const ask = (formID: string, requesterID: string, extra: object = {}) =>
    store.forms.save(
      formID,
      {
        formID,
        requesterID,
        title: formID,
        links: [],
        approval: false,
        collect: false,
        fields: [{ name: "x", label: "X", required: true }],
        status: "open",
        createdAt: at,
        responses: {},
        raises: [],
        ...extra,
      },
      event,
    );
  store.transaction(() => {
    for (let i = 0; i < 300; i++) work(`w${i}`, `o${i % 100}`, i % 3 === 0 ? "accepted" : "open");
    ask("plain", "owner", { workID: "w1" });
    // A raise is how an ask passed up is stored; its route starts at the raiser.
    ask("raised", "respondent", { raises: [{ actorID: "owner", at }] });
    ask("closed", "outsider", { status: "resolved" });
    ask("unraised", "outsider", { raises: [] });
    const raises = [
      { actorID: "owner", at },
      { actorID: "requester", at },
    ];
    ask("twice", "respondent", { raises });
  });
  store.close();
  store = openSqlite(file);
  t.after(() => store.close());
  const ids = (snapshots: { cursor: number }[]) => snapshots.map((row) => row.cursor);
  assert.deepEqual(
    store.work.where({ owner: ["o1"], status: ["open"] }).map((row) => row.ticketID),
    ["w1", "w101"],
  );
  assert.deepEqual(ids(store.forms.where({})), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(store.forms.where({ requester: undefined })), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    store.forms
      .where({ requester: ["owner", "respondent"], status: ["open"] })
      .map((row) => row.formID),
    ["plain", "raised", "twice"],
  );
  assert.deepEqual(store.forms.where({ requester: ["owner"], status: ["resolved"] }), []);
  assert.deepEqual(store.forms.where({ requester: [] }), []);
  assert.deepEqual(store.forms.values("route", { status: ["open"] }).sort(), [
    "outsider",
    "owner",
    "requester",
  ]);
  assert.deepEqual(
    store.forms.where({ status: ["open"], route: ["owner"] }).map((row) => row.formID),
    ["plain", "raised"],
  );
  assert.deepEqual(store.forms.values("requester", {}).sort(), ["outsider", "owner", "respondent"]);
  assert.deepEqual(store.forms.values("route", { requester: [] }), []);
  assert.deepEqual(store.forms.where({ work: ["w1"] })[0]?.updatedAt, at);
  assert.deepEqual(
    store.work.values("owner", { status: ["accepted"] }).sort(),
    [...new Set(Array.from({ length: 100 }, (_, i) => `o${(i * 3) % 100}`))].sort(),
  );
  const many = Array.from({ length: 40000 }, (_, i) => `o${i}`);
  assert.equal(store.work.where({ owner: many }).length, 300);
  assert.throws(() => store.work.where({ data: ["x"] } as never), /no indexed column data/);
  assert.throws(() => store.work.values("cursor" as never, {}), /no indexed column cursor/);
  const db = new DatabaseSync(file);
  try {
    const current =
      "SELECT m.data FROM work m JOIN work_history h ON h.id=m.id AND h.revision=m.revision WHERE 1";
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${current} AND m.owner IN (SELECT value FROM json_each(?)) AND m.status IN (SELECT value FROM json_each(?)) ORDER BY m.cursor ASC`,
      )
      .all('["o1"]', '["open"]')
      .map((row) => String(row.detail))
      .join("; ");
    // One range of the owner's index, with no index statistics needed to choose it.
    assert.match(plan, /SEARCH m USING INDEX work_owner \(owner=\? AND status=\?\)/);
    // A party's distinct values under a status filter, as a subtree filter reads them, come from
    // the party's own index rather than the status index.
    const values = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT DISTINCT m.owner AS value FROM work m INDEXED BY work_owner WHERE m.owner IS NOT NULL AND m.status IN (SELECT value FROM json_each(?))",
      )
      .all('["open"]')
      .map((row) => String(row.detail))
      .join("; ");
    assert.match(values, /SEARCH m USING (COVERING )?INDEX work_owner/);
  } finally {
    db.close();
  }
});
