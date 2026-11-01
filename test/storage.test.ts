import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
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
/** A database as Workspace 0.4 wrote it: no user_version, and Messages may link Work. */
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
function version(file: string) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("PRAGMA user_version").get()?.user_version;
  } finally {
    db.close();
  }
}

test("a 0.4 database upgrades once in place and keeps every original event", (t) => {
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
      const pending = owner.work.get({ ticketID: "ticket" });
      assert.equal(pending.updatedAt, at);
      assert.deepEqual(pending.links, []);
      assert.equal(pending.title, "Legacy goal");
      assert.equal(pending.goal, "Legacy goal");
      assert.equal(pending.completedAt, undefined);
      const accepted = owner.work.get({ ticketID: "accepted" });
      assert.equal(accepted.completedAt, reviewedAt);
      assert.equal(accepted.title, `Ship ${Array(14).fill("release").join(" ")}…`);
      assert.equal(accepted.goal, longGoal);
      assert.equal(owner.work.get({ ticketID: "unbroken" }).title, `${"x".repeat(119)}…`);
      const form = owner.forms.get({ formID: "form" });
      assert.equal(Object.hasOwn(form, "respondentIDs"), false);
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
    assert.equal(version(file), 3);
  }
  const store = openSqlite(file);
  try {
    const outsider = bindWorkspace(fixtureAuthority().authority, store, "outsider");
    const answered = outsider.forms.respond({ formID: "form", answers: { choice: "b" } });
    assert.equal(answered.status, "open");
    assert.deepEqual(Object.keys(answered.responses), ["owner", "outsider"]);
  } finally {
    store.close();
  }
  const fresh = join(dir, "fresh.sqlite");
  openSqlite(fresh).close();
  assert.equal(version(fresh), 3);
  const newer = new DatabaseSync(file);
  newer.exec("PRAGMA user_version=99");
  newer.close();
  assert.throws(() => openSqlite(file), /version 99 is newer/);
  assert.equal(version(file), 99);
});
