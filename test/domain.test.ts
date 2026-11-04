import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
import { createActors } from "../src/actors/index.js";
import {
  type Form,
  MessageContracts,
  type Work,
  WorkContracts,
  WorkspaceError,
} from "../src/contracts/index.js";
import { bindWorkspace } from "../src/index.js";
import { openSqlite } from "../src/persistence/index.js";
import { createWork } from "../src/work/index.js";

const rejects = (code: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === code;
/** The ask a write or read returns. */
function ask(record: Work | Form): Form {
  assert.ok("formID" in record);
  return record;
}
/** Work as a read returns it: with its asks, here none. */
const listed = (row: Work) => ({ ...row, asks: [] });
/** The Work a write or read returns. */
function work(record: Work | Form): Work {
  assert.ok("ticketID" in record);
  return record;
}
const habit =
  "blocked is gone: ask on the Work with work_update {ticketID, ask}, or keep it active and say what it waits on with waitsOn";
function next(page: { next: string | null }): string {
  assert.ok(page.next);
  return page.next;
}
function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "workspace-domain-"));
  const file = join(dir, "records.sqlite");
  const { authority, rows, managers } = fixtureAuthority();
  let store = openSqlite(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    rows,
    managers,
    authority,
    file,
    get store() {
      return store;
    },
    as: (id: string) => bindWorkspace(authority, store, id),
    reopen: () => {
      store.close();
      store = openSqlite(file);
    },
    second: () => {
      const other = openSqlite(file);
      t.after(() => other.close());
      return bindWorkspace(authority, other, "owner");
    },
  };
}

for (const requesterClient of ["human", "software"] as const)
  for (const ownerClient of ["human", "software"] as const) {
    test(`identical role rules and independent transitions: ${requesterClient}/${ownerClient}`, (t) => {
      const f = fixture(t);
      const requester = f.as("requester");
      const owner = f.as("owner");
      const respondent = f.as("respondent");
      const outsider = f.as("outsider");
      const ticket = requester.work.create({ title: "Deliver evidence", ownerID: "owner" });
      assert.equal(ticket.status, "open");
      assert.equal(requester.messages.list({ of: "requester" }).items.length, 0);
      assert.deepEqual(work(requester.work.get({ ticketID: ticket.ticketID })).asks, []);
      const message = requester.messages.send({ recipientID: "owner", text: "Inspect this work" });
      assert.deepEqual(owner.messages.get({ messageID: message.messageID }), message);
      assert.deepEqual(outsider.messages.get({ messageID: message.messageID }), message);
      const form = ask(
        owner.work.update({
          ticketID: ticket.ticketID,
          ask: {
            title: "Which option?",
            collect: true,
            fields: [
              {
                name: "decision",
                label: "Which option?",
                required: true,
                options: [{ value: "yes" }, { value: "no" }],
              },
            ],
          },
        }),
      );
      assert.equal(form.workID, ticket.ticketID);
      assert.deepEqual(form.raises, []);
      assert.equal(requester.work.get({ ticketID: ticket.ticketID }).revision, ticket.revision);
      const shared = work(respondent.work.get({ askID: form.formID }));
      assert.deepEqual(shared.asks, [form]);
      assert.deepEqual(outsider.work.get({ askID: form.formID }), shared);
      for (const answers of [{ decision: "maybe" }, {}])
        assert.throws(
          () => respondent.work.answer({ askID: form.formID, answers }),
          rejects("invalid_input"),
        );
      ask(respondent.work.answer({ askID: form.formID, answers: { decision: "no" } }));
      const response = ask(
        respondent.work.answer({ askID: form.formID, answers: { decision: "yes" } }),
      );
      assert.equal(response.history, undefined);
      assert.equal(response.status, "open");
      assert.deepEqual(
        work(respondent.work.get({ askID: form.formID, history: true }))
          .asks?.[0]?.history?.filter((e) => e.action === "responded")
          .map((e) => e.detail.answers),
        [{ decision: "no" }, { decision: "yes" }],
      );
      const close = { askID: form.formID, status: "resolved" as const, resolution: "Done" };
      assert.throws(() => respondent.work.update({ close }), rejects("forbidden"));
      const closed = ask(
        owner.work.update({ close: { ...close, resolution: "Decision recorded" } }),
      );
      assert.equal(closed.status, "resolved");
      assert.throws(() => owner.work.update({ close }), rejects("conflict"));
      assert.throws(
        () => respondent.work.answer({ askID: form.formID, answers: { decision: "no" } }),
        rejects("conflict"),
      );
      assert.equal(requester.work.get({ ticketID: ticket.ticketID }).revision, ticket.revision);
      assert.throws(
        () =>
          owner.work.update({ ticketID: ticket.ticketID, expectedRevision: 1, goal: "Other goal" }),
        rejects("forbidden"),
      );
      assert.throws(
        () =>
          requester.work.update({
            ticketID: ticket.ticketID,
            expectedRevision: 1,
            progress: "Working",
          }),
        rejects("forbidden"),
      );
      assert.throws(
        () =>
          owner.work.update({
            ticketID: ticket.ticketID,
            expectedRevision: 1,
            status: "accepted",
          } as never),
        rejects("invalid_input"),
      );
      const progress = owner.work.update({
        ticketID: ticket.ticketID,
        expectedRevision: 1,
        status: "active",
        progress: "Evidence collected",
      });
      const first = owner.work.submit({
        ticketID: ticket.ticketID,
        expectedRevision: progress.revision,
        result: "Attempt one",
        evidence: ["file:attempt-one.txt"],
      });
      assert.ok(first.submission);
      const firstSubmissionID = first.submission.submissionID;
      assert.throws(
        () =>
          requester.work.update({
            ticketID: ticket.ticketID,
            expectedRevision: first.revision,
            goal: "Bypass review",
          }),
        rejects("conflict"),
      );
      assert.throws(
        () =>
          owner.work.answer({
            askID: firstSubmissionID,
            ticketID: ticket.ticketID,
            answers: { verdict: "accepted" },
            note: "Owner cannot accept",
          }),
        rejects("forbidden"),
      );
      const changes = work(
        requester.work.answer({
          askID: firstSubmissionID,
          ticketID: ticket.ticketID,
          answers: { verdict: "changes_requested" },
          note: "Add second evidence",
        }),
      );
      const second = owner.work.submit({
        ticketID: ticket.ticketID,
        expectedRevision: changes.revision,
        result: "Attempt two",
        evidence: ["file:attempt-two.txt"],
      });
      assert.ok(second.submission);
      const secondSubmissionID = second.submission.submissionID;
      assert.throws(
        () =>
          requester.work.answer({
            askID: firstSubmissionID,
            ticketID: ticket.ticketID,
            answers: { verdict: "accepted" },
            note: "Delayed old review",
          }),
        rejects("conflict"),
      );
      const accepted = work(
        requester.work.answer({
          askID: secondSubmissionID,
          ticketID: ticket.ticketID,
          answers: { verdict: "accepted" },
          note: "Evidence checked",
        }),
      );
      assert.equal(accepted.review?.reviewerID, "requester");
      assert.equal(accepted.status, "accepted");
      assert.throws(
        () =>
          owner.work.update({
            ticketID: ticket.ticketID,
            expectedRevision: accepted.revision,
            status: "open",
          }),
        rejects("conflict"),
      );
      f.reopen();
      const { asks, ...retained } = work(f.as("requester").work.get({ ticketID: ticket.ticketID }));
      assert.deepEqual(retained, accepted);
      assert.deepEqual(asks, [closed]);
      const history =
        f.as("requester").work.get({ ticketID: ticket.ticketID, history: true }).history ?? [];
      assert.equal(history.filter((e) => e.action === "submitted").length, 2);
      assert.equal(history.filter((e) => e.action === "reviewed").length, 2);
      assert.deepEqual(f.as("owner").messages.get({ messageID: message.messageID }), message);
      assert.deepEqual(work(f.as("respondent").work.get({ askID: form.formID })).asks, [closed]);
      assert.equal(
        f.as("requester").work.list({ status: ["accepted"] }).items[0]?.ticketID,
        ticket.ticketID,
      );
    });
  }

test("direct messages need no work and arbitrary prose creates no record", (t) => {
  const f = fixture(t);
  const requester = f.as("requester");
  const owner = f.as("owner");
  const prose = "Please do some work";
  assert.ok(prose);
  assert.equal(requester.messages.list({ of: "requester" }).items.length, 0);
  assert.equal(requester.work.list().items.length, 0);
  const direct = requester.messages.send({ recipientID: "owner", text: prose });
  assert.deepEqual(owner.messages.list({ counterpartyID: "requester" }).items, [direct]);
  assert.throws(
    () =>
      requester.messages.send({
        recipientID: "owner",
        text: "Messages link no Work",
        workID: "absent",
      } as never),
    rejects("invalid_input"),
  );
  assert.throws(
    () =>
      owner.work.update({
        ticketID: "absent",
        ask: { title: "Question", fields: [{ name: "x", label: "Question", required: true }] },
      }),
    rejects("not_found"),
  );
});

test("an ask sits on Work its asker owns, and an ask stored before reads where it was left", (t) => {
  const f = fixture(t);
  const requester = f.as("requester");
  const owner = f.as("owner");
  const outsider = f.as("outsider");
  const question = {
    title: "Which option?",
    fields: [{ name: "answer", label: "Which?", required: true }],
  };
  const ticket = requester.work.create({ title: "Linked context", ownerID: "owner" });
  const own = requester.work.create({ title: "The root's own" });
  for (const [by, ticketID, code] of [
    [outsider, ticket.ticketID, "forbidden"],
    [requester, own.ticketID, "forbidden"],
    [owner, "absent", "not_found"],
  ] as const)
    assert.throws(() => by.work.update({ ticketID, ask: question }), rejects(code));
  for (const input of [
    { ticketID: ticket.ticketID, ask: { ...question, cause: "carried" } },
    { ticketID: ticket.ticketID, ask: { ...question, workID: ticket.ticketID } },
    { ticketID: ticket.ticketID, ask: question, progress: "Both" },
    { ticketID: ticket.ticketID, ask: question, expectedRevision: 1 },
    { ask: question },
    { ticketID: ticket.ticketID, close: { askID: "x", status: "resolved", resolution: "x" } },
    {
      ticketID: ticket.ticketID,
      ask: { ...question, fields: [question.fields[0], question.fields[0]] },
    },
    {
      ticketID: ticket.ticketID,
      ask: {
        ...question,
        fields: [
          { name: "a", label: "A", required: true, options: [{ value: "x" }], recommended: "y" },
        ],
      },
    },
  ])
    assert.throws(() => owner.work.update(input as never), rejects("invalid_input"));
  const linked = ask(owner.work.update({ ticketID: ticket.ticketID, ask: question }));
  assert.equal(requester.work.get({ ticketID: ticket.ticketID }).revision, ticket.revision);
  assert.deepEqual(work(outsider.work.get({ askID: linked.formID })).asks, [linked]);
  // Asks stored before asks lived on Work: one with no Work and a cause, and one by another Actor
  // on this Work.
  const at = new Date().toISOString();
  const stored = (formID: string, requesterID: string, extra: object) => {
    const row = {
      formID,
      requesterID,
      title: formID,
      links: [],
      approval: false,
      collect: false,
      fields: [{ name: "answer", label: "Which?", required: true }],
      status: "open",
      createdAt: at,
      responses: {},
      ...extra,
    } as never;
    f.store.transaction(() =>
      f.store.forms.save(formID, row, { actorID: requesterID, at, action: "created", detail: row }),
    );
  };
  stored("orphan", "respondent", { cause: "carried" });
  stored("foreign", "outsider", { workID: ticket.ticketID });
  const orphan = ask(outsider.work.get({ askID: "orphan", history: true }));
  assert.equal(Object.hasOwn(orphan, "cause"), false);
  assert.deepEqual(orphan.raises, []);
  assert.equal(orphan.history?.[0]?.detail.cause, "carried");
  assert.deepEqual(
    work(outsider.work.get({ ticketID: ticket.ticketID })).asks?.map((row) => row.formID),
    [linked.formID, "foreign"],
  );
  assert.deepEqual(
    requester.work.asks({ requesterID: "respondent" }).items.map((row) => row.formID),
    ["orphan"],
  );
  // An older ask with no Work routes like any ask: respondent's to its manager, owner.
  assert.deepEqual(
    requester.work.asks({ routedTo: "owner" }).items.map((row) => row.formID),
    ["orphan"],
  );
  assert.equal(
    ask(owner.work.answer({ askID: "orphan", answers: { answer: "yes" } })).status,
    "resolved",
  );
  assert.throws(
    () =>
      owner.work.answer({ askID: linked.formID, ticketID: own.ticketID, answers: { answer: "x" } }),
    rejects("not_found"),
  );
  // Reassigning the Work cancels its open asks, the older one included (Q12).
  const moved = work(
    requester.work.update({
      ticketID: ticket.ticketID,
      expectedRevision: 1,
      ownerID: "respondent",
    }),
  );
  assert.equal(moved.asks, undefined);
  const cancelled =
    work(outsider.work.get({ ticketID: ticket.ticketID, history: true })).asks ?? [];
  assert.deepEqual(
    cancelled.map((row) => [row.status, row.resolution?.reason, row.resolution?.text]),
    [
      ["cancelled", "reassigned", "Cancelled with the Work's reassignment."],
      ["cancelled", "reassigned", "Cancelled with the Work's reassignment."],
    ],
  );
  assert.deepEqual(
    cancelled.map((row) => row.history?.at(-1)?.actorID),
    ["requester", "requester"],
  );
  assert.equal(cancelled[0]?.resolution?.at, moved.updatedAt);
});

test("revision conflicts across independent SQLite connections roll back snapshots and history", async (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Concurrent updates", ownerID: "owner" });
  const other = f.second();
  const attempts = await Promise.allSettled(
    ["first", "second"].map((progress, i) =>
      Promise.resolve().then(() =>
        (i === 0 ? f.as("owner") : other).work.update({
          ticketID: ticket.ticketID,
          expectedRevision: 1,
          progress,
        }),
      ),
    ),
  );
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const failure = attempts.find((result) => result.status === "rejected");
  assert.ok(failure?.status === "rejected" && rejects("conflict")(failure.reason));
  const retained = f.as("owner").work.get({ ticketID: ticket.ticketID, history: true });
  assert.equal(retained.history?.length, 2);
  const head = f.store.work.head();
  assert.throws(() =>
    f.store.transaction(() => {
      f.store.work.save(
        "rolled-back",
        {
          ticketID: "rolled-back",
          requesterID: "requester",
          ownerID: "owner",
          title: "Must roll back",
          status: "open",
          links: [],
          createdAt: new Date().toISOString(),
        },
        { actorID: "owner", at: new Date().toISOString(), action: "created", detail: {} },
      );
      throw new Error("abort transaction");
    }),
  );
  assert.equal(f.store.work.get("rolled-back"), undefined);
  assert.deepEqual(f.store.work.history("rolled-back"), []);
  assert.equal(f.store.work.head(), head);
  const question = ask(
    f.as("owner").work.update({
      ticketID: ticket.ticketID,
      ask: { title: "Answer?", fields: [{ name: "x", label: "Answer?", required: true }] },
    }),
  );
  ask(f.as("respondent").work.answer({ askID: question.formID, answers: { x: "first answer" } }));
  assert.throws(
    () => other.work.answer({ askID: question.formID, answers: { x: "lost answer" } }),
    rejects("conflict"),
  );
  assert.equal(
    work(f.as("owner").work.get({ askID: question.formID, history: true })).asks?.[0]?.history
      ?.length,
    2,
  );
});

test("multi-page filtered upserts, duplicate updated rows and disappearing matches survive reopen", (t) => {
  const f = fixture(t);
  const request = f.as("requester");
  const hidden = f
    .as("outsider")
    .work.create({ title: "Different owner and requester", ownerID: "outsider" });
  const first = request.work.create({ title: "First", ownerID: "owner" });
  const second = request.work.create({ title: "Second", ownerID: "owner" });
  const third = request.work.create({ title: "Third", ownerID: "owner" });
  const filters = { ownerID: "owner", requesterID: "requester" };
  const page1 = f.as("owner").work.list({ ...filters, limit: 1 });
  assert.deepEqual(
    page1.items.map((row) => row.ticketID),
    [first.ticketID],
  );
  f.as("owner").work.update({
    ticketID: first.ticketID,
    expectedRevision: 1,
    progress: "Moved after page one",
  });
  f.reopen();
  const page2 = f.as("owner").work.list({ ...filters, after: next(page1), limit: 2 });
  assert.deepEqual(
    page2.items.map((row) => row.ticketID),
    [second.ticketID, third.ticketID],
  );
  const page3 = f.as("owner").work.list({ ...filters, after: next(page2), limit: 1 });
  assert.deepEqual(
    page3.items.map((row) => row.ticketID),
    [first.ticketID],
  );
  assert.equal(page3.next, null);
  const scoped = f.as("owner").work.list({ ...filters, status: ["open"] });
  assert.equal(scoped.items.length, 3);
  assert.equal(scoped.next, null);
  f.as("owner").work.update({ ticketID: second.ticketID, expectedRevision: 1, status: "active" });
  f.as("requester").work.update({
    ticketID: third.ticketID,
    expectedRevision: 1,
    ownerID: "respondent",
  });
  assert.deepEqual(
    f
      .as("owner")
      .work.list({ ...filters, status: ["open"] })
      .items.map((row) => row.ticketID),
    [first.ticketID],
  );
  assert.equal(
    f.as("respondent").work.list({ ownerID: "respondent" }).items[0]?.ticketID,
    third.ticketID,
  );
  const owned = next(f.as("owner").work.list({ ownerID: "owner", limit: 1 }));
  for (const after of [0, 1, "", "1", "not a position", owned])
    assert.throws(
      () => f.as("owner").work.list({ ...filters, after } as never),
      rejects("invalid_input"),
    );
  assert.throws(
    () => f.as("owner").work.list({ ownerID: "owner", order: "recent", after: owned }),
    rejects("invalid_input"),
  );
  assert.throws(() => f.as("owner").work.list({ limit: 101 }), rejects("invalid_input"));
  f.as("outsider").messages.send({
    recipientID: "respondent",
    text: "Another pair's",
  });
  f.as("owner").messages.send({ recipientID: "requester", text: "zero" });
  for (const text of ["one", "two", "three"])
    f.as("requester").messages.send({ recipientID: "owner", text });
  const pair = { counterpartyID: "requester" };
  const firstMessages = f.as("owner").messages.list({ ...pair, limit: 2 });
  f.reopen();
  const restMessages = f
    .as("owner")
    .messages.list({ ...pair, after: next(firstMessages), limit: 3 });
  assert.deepEqual(
    restMessages.items.map((row) => row.text),
    ["two", "three"],
  );
  assert.throws(
    () => f.as("owner").messages.list({ ...pair, after: 999 }),
    rejects("invalid_input"),
  );
  const question = { title: "Answer?", fields: [{ name: "x", label: "Answer?", required: true }] };
  f.as("outsider").work.update({ ticketID: hidden.ticketID, ask: question });
  const asks = [first, second].map((ticket) =>
    ask(f.as("owner").work.update({ ticketID: ticket.ticketID, ask: question })),
  );
  const asks1 = f.as("requester").work.asks({ requesterID: "owner", limit: 1 });
  assert.deepEqual(asks1.items, [asks[0]]);
  f.as("respondent").work.answer({ askID: asks[0]?.formID ?? "", answers: { x: "answered" } });
  f.reopen();
  assert.deepEqual(
    f
      .as("requester")
      .work.asks({ requesterID: "owner", after: next(asks1) })
      .items.map((row) => row.formID),
    [asks[1]?.formID, asks[0]?.formID],
  );
  assert.throws(
    () => f.as("requester").work.asks({ requesterID: "owner", after: owned }),
    rejects("invalid_input"),
  );
});

test("shared Work/Form AND filters precede pagination; awaiting means open, designated and no response entry", (t) => {
  const f = fixture(t);
  const request = f.as("requester");
  const observer = f.as("outsider");
  observer.work.create({ title: "Other requester", ownerID: "owner" });
  const otherOwner = request.work.create({ title: "Other owner", ownerID: "outsider" });
  const first = request.work.create({ title: "First match", ownerID: "owner" });
  const active = request.work.create({ title: "Other status", ownerID: "owner" });
  f.as("owner").work.update({ ticketID: active.ticketID, expectedRevision: 1, status: "active" });
  const second = request.work.create({ title: "Second match", ownerID: "owner" });
  assert.equal(observer.work.list().items.length, 5);
  assert.deepEqual(observer.work.get({ ticketID: first.ticketID }), listed(first));
  const workFilters = {
    ownerID: "owner",
    requesterID: "requester",
    status: ["open" as const],
    limit: 1,
  };
  const page = observer.work.list(workFilters);
  assert.deepEqual(page.items, [listed(first)]);
  const following = observer.work.list({ ...workFilters, after: next(page) });
  assert.deepEqual(following, {
    items: [listed(second)],
    next: null,
    actors: { owner: { name: "Owner" }, requester: { name: "Requester" } },
  });
  assert.throws(
    () => observer.work.list({ ownerID: "absent", after: next(page) }),
    rejects("invalid_input"),
  );
  assert.deepEqual(observer.work.list({ ownerID: "absent" }), {
    items: [],
    next: null,
    actors: {},
  });

  const fields = [{ name: "answer", label: "Optional answer", required: false }];
  const create = (ticketID: string) =>
    ask(f.as("owner").work.update({ ticketID, ask: { title: "Optional answer", fields } }));
  const pending = create(first.ticketID);
  const closing = create(first.ticketID);
  const closed = ask(
    f.as("owner").work.update({
      close: {
        askID: closing.formID,
        status: "cancelled",
        resolution: "Cancelled without answers",
      },
    }),
  );
  const responding = create(first.ticketID);
  const answered = ask(f.as("respondent").work.answer({ askID: responding.formID, answers: {} }));
  const elsewhere = ask(
    f
      .as("outsider")
      .work.update({ ticketID: otherOwner.ticketID, ask: { title: "Theirs", fields } }),
  );
  const last = create(first.ticketID);
  // work_list items carry only their open asks; work_get carries all of them.
  const page100 = observer.work.list({ ...workFilters, limit: 100 }).items;
  assert.deepEqual(
    page100.map((item) => [item.ticketID, item.asks?.map((row) => row.formID)]),
    [
      [first.ticketID, [pending.formID, last.formID]],
      [second.ticketID, []],
    ],
  );
  assert.deepEqual(
    work(observer.work.get({ ticketID: first.ticketID })).asks?.map((row) => row.formID),
    [pending.formID, closing.formID, responding.formID, last.formID],
  );
  const query = { requesterID: "owner", status: ["open" as const], limit: 1 };
  const asks1 = observer.work.asks(query);
  assert.deepEqual(asks1.items, [pending]);
  const asks2 = observer.work.asks({ ...query, after: next(asks1) });
  assert.deepEqual(asks2.items, [last]);
  assert.equal(asks2.next, null);
  assert.deepEqual(observer.work.asks({ status: ["cancelled"] }).items, [closed]);
  assert.deepEqual(observer.work.asks({ status: ["resolved"] }).items, [answered]);
  assert.deepEqual(observer.work.asks({ requesterID: "outsider" }).items, [elsewhere]);
  assert.deepEqual(observer.work.asks({ requesterID: "absent" }), {
    items: [],
    next: null,
    actors: {},
  });
  f.reopen();
  assert.deepEqual(f.as("outsider").work.asks({ ...query, limit: 100 }).items, [pending, last]);
});

test("canonical membership includes deep and closed ancestry under the actual active caller", () => {
  const f = fixtureAuthority();
  const template = f.rows.get("respondent");
  assert.ok(template);
  let parent = "respondent";
  for (let i = 0; i < 25; i++) {
    const id = `closed-${i}`;
    f.rows.set(id, { ...template, actorID: id, state: "closed" });
    f.managers.set(id, parent);
    parent = id;
  }
  for (const id of ["owner", "respondent"]) {
    const row = f.rows.get(id);
    assert.ok(row);
    f.rows.set(id, { ...row, state: "closed" });
  }
  const principals: string[] = [];
  const actors = createActors(
    {
      ...f.authority,
      get(callerID, actorID) {
        assert.equal(actorID, callerID, "membership must not resolve selected profiles");
        return f.rows.get(actorID);
      },
      within(callerID, actorID, ancestorID) {
        principals.push(callerID);
        return f.authority.within(callerID, actorID, ancestorID);
      },
    },
    "outsider",
  );
  assert.equal(actors.within(` ${parent} `, " owner "), true);
  assert.equal(actors.within("owner", "owner"), true);
  assert.equal(actors.within(parent, parent), true);
  assert.equal(actors.within("outsider", "owner"), false);
  assert.equal(actors.within("requester", "owner"), false);
  for (const [member, anchor] of [
    ["absent", "owner"],
    ["owner", "absent"],
    ["absent", "absent"],
  ])
    assert.equal(actors.within(member as string, anchor as string), false);
  assert.ok(principals.every((id) => id === "outsider"));
  assert.throws(() => actors.within("", "owner"), rejects("invalid_input"));
  assert.throws(
    () => createActors(f.authority, "owner").within(parent, "owner"),
    rejects("forbidden"),
  );
});

test("Work subtree filters intersect before sparse pages and retain closed deep histories after reassignment", (t) => {
  const f = fixture(t);
  const requester = f.as("owner");
  const observer = f.as("outsider");
  const expected = [];
  for (let i = 0; i < 21; i++) {
    const by = i % 3 === 0 ? observer : requester;
    const row = by.work.create({
      title: `Interleaved ${i}`,
      ownerID: i % 3 === 2 ? "outsider" : "respondent",
    });
    if (i % 3 === 1) expected.push(row);
  }
  const template = f.rows.get("respondent");
  assert.ok(template);
  let deep = "respondent";
  for (let i = 0; i < 25; i++) {
    const id = `deep-${i}`;
    f.rows.set(id, { ...template, actorID: id });
    f.managers.set(id, deep);
    deep = id;
  }
  const ticket = requester.work.create({ title: "Retained deep result", ownerID: deep });
  const submitted = f.as(deep).work.submit({
    ticketID: ticket.ticketID,
    expectedRevision: 1,
    result: "Evidence",
    evidence: [],
  });
  assert.ok(submitted.submission);
  const accepted = work(
    requester.work.answer({
      askID: submitted.submission.submissionID,
      ticketID: ticket.ticketID,
      answers: { verdict: "accepted" },
      note: "Reviewed",
    }),
  );
  const query = {
    ownerID: "respondent",
    requesterID: "owner",
    ownerWithin: "owner",
    requesterWithin: "owner",
    status: ["open" as const],
    limit: 2,
  };
  let after: string | undefined;
  for (let i = 0; i < expected.length; i += 2) {
    const page = observer.work.list({ ...query, ...(after === undefined ? {} : { after }) });
    assert.deepEqual(page.items, expected.slice(i, i + 2).map(listed));
    assert.equal(page.next === null, i + 2 >= expected.length);
    after = page.next ?? undefined;
  }
  assert.deepEqual(observer.work.list({ ...query, ownerWithin: "outsider" }).items, []);
  assert.deepEqual(observer.work.list({ ...query, requesterWithin: "outsider" }).items, []);
  assert.deepEqual(observer.work.list({ ownerWithin: "absent" }).items, []);
  assert.equal(
    observer.work.list({ ownerWithin: "owner", requesterWithin: "outsider" }).items.length,
    7,
  );
  const first = expected[0];
  assert.ok(first);
  assert.throws(
    () =>
      observer.work.update({
        ticketID: first.ticketID,
        expectedRevision: 1,
        goal: "No role grant",
      }),
    rejects("forbidden"),
  );
  const moved = work(
    requester.work.update({
      ticketID: first.ticketID,
      expectedRevision: 1,
      ownerID: "outsider",
    }),
  );
  assert.deepEqual(observer.work.list({ ...query, updatedSince: moved.updatedAt }).items, []);
  assert.deepEqual(
    observer.work.list({ ownerID: "outsider", updatedSince: moved.updatedAt }).items,
    [listed(moved)],
  );
  const openMessage = requester.messages.send({
    recipientID: "respondent",
    text: "Open to organization views",
  });
  assert.deepEqual(observer.messages.get({ messageID: openMessage.messageID }), openMessage);
  for (const [id, row] of f.rows)
    if (f.authority.within("outsider", id, "owner")) f.rows.set(id, { ...row, state: "closed" });
  f.reopen();
  assert.deepEqual(
    f.as("outsider").work.list({ ...query, limit: 100 }).items,
    expected.slice(1).map(listed),
  );
  assert.deepEqual(
    f
      .as("outsider")
      .work.list({ ownerWithin: "owner", requesterWithin: "owner", status: ["accepted"] }).items,
    [listed(accepted)],
  );
  assert.deepEqual(f.as("outsider").work.get({ ticketID: first.ticketID }), listed(moved));
  assert.equal(moved.history, undefined);
  const histories = [first, accepted].map(
    ({ ticketID }) => f.as("outsider").work.get({ ticketID, history: true }).history?.length,
  );
  assert.deepEqual(histories, [2, 3]);
});

test("subtree filters read membership once per Actor, not once per row", (t) => {
  const f = fixture(t);
  const requester = f.as("requester");
  for (let i = 0; i < 30; i++)
    requester.work.create({ title: `Row ${i}`, ownerID: i % 2 === 0 ? "owner" : "outsider" });
  const within = f.authority.within;
  let reads = 0;
  f.authority.within = (...args) => {
    reads++;
    return within(...args);
  };
  assert.equal(requester.work.list({ ownerWithin: "owner", limit: 100 }).items.length, 15);
  assert.equal(reads, 2);
  reads = 0;
  assert.equal(
    requester.work.list({ ownerID: "owner", ownerWithin: "requester" }).items.length,
    15,
  );
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(requester.work.list({ requesterWithin: "requester" }).items.length, 30);
  assert.equal(reads, 1);
});

test("a subtree list reads up to the head it captured while another connection writes", (t) => {
  const f = fixture(t);
  const first = f.as("requester").work.create({ title: "Before the read", ownerID: "owner" });
  const other = f.second();
  const written: string[] = [];
  const work = createWork(createActors(f.authority, "requester"), {
    transaction: f.store.transaction,
    forms: f.store.forms,
    work: {
      ...f.store.work,
      values(column, filter) {
        const values = f.store.work.values(column, filter);
        // A new owner's Work, then a known owner's, both committed before the rows are read.
        for (const ownerID of ["respondent", "owner"])
          written.push(other.work.create({ title: "During the read", ownerID }).ticketID);
        return values;
      },
    },
  });
  assert.deepEqual(work.list({ ownerWithin: "requester" }).items, [listed(first)]);
  assert.deepEqual(
    f
      .as("requester")
      .work.list({ ownerWithin: "requester" })
      .items.map((row) => row.ticketID),
    [first.ticketID, ...written],
  );
});

test("an ask is answered by any Actor and resolves on the first answer unless it collects", (t) => {
  const f = fixture(t);
  const asker = f.as("owner");
  const ticket = asker.work.create({ title: "Publish" });
  const choice = {
    name: "choice",
    label: "Publish now?",
    required: true,
    options: [{ value: "Publish after CI", detail: "Waits about ten minutes" }, { value: "Hold" }],
    recommended: "Publish after CI",
  };
  const asked = ask(
    asker.work.update({
      ticketID: ticket.ticketID,
      ask: {
        title: "Publish 0.5.0?",
        context: "CI is running on the release commit.",
        links: [{ label: "Release PR", url: "https://example.test/pull/9" }],
        fields: [choice],
      },
    }),
  );
  assert.deepEqual(
    {
      requesterID: asked.requesterID,
      workID: asked.workID,
      approval: asked.approval,
      collect: asked.collect,
      status: asked.status,
      responses: asked.responses,
    },
    {
      requesterID: "owner",
      workID: ticket.ticketID,
      approval: false,
      collect: false,
      status: "open",
      responses: {},
    },
  );
  const answered = ask(
    f.as("outsider").work.answer({
      askID: asked.formID,
      answers: { choice: "Hold" },
      note: "Wait for the changelog",
    }),
  );
  assert.equal(answered.status, "resolved");
  assert.deepEqual(answered.responses.outsider, {
    answers: { choice: "Hold" },
    note: "Wait for the changelog",
    at: answered.updatedAt,
  });
  assert.throws(
    () => f.as("requester").work.answer({ askID: asked.formID, answers: { choice: "Hold" } }),
    rejects("conflict"),
  );
  const collecting = ask(
    asker.work.update({
      ticketID: ticket.ticketID,
      ask: {
        title: "Your views?",
        collect: true,
        fields: [{ name: "view", label: "Your view?", required: false }],
      },
    }),
  );
  const first = ask(f.as("respondent").work.answer({ askID: collecting.formID, answers: {} }));
  f.as("respondent").work.answer({ askID: collecting.formID, answers: { view: "Ship it" } });
  const second = ask(
    f.as("requester").work.answer({ askID: collecting.formID, answers: { view: "Agreed" } }),
  );
  assert.equal(first.status, "open");
  assert.equal(second.status, "open");
  assert.deepEqual(
    Object.entries(second.responses).map(([id, response]) => [id, response.answers]),
    [
      ["respondent", { view: "Ship it" }],
      ["requester", { view: "Agreed" }],
    ],
  );
  const closed = ask(
    asker.work.update({
      close: { askID: collecting.formID, status: "resolved", resolution: "Both views recorded" },
    }),
  );
  assert.deepEqual(closed.resolution, { text: "Both views recorded", at: closed.updatedAt });
  assert.deepEqual(f.as("outsider").work.asks({ requesterID: "owner", answeredBy: "requester" }), {
    items: [closed],
    next: null,
    actors: {
      owner: { name: "Owner" },
      requester: { name: "Requester" },
      respondent: { name: "Respondent" },
    },
  });
  assert.deepEqual(
    f.as("outsider").work.asks({ requesterID: "owner", answeredBy: "outsider" }).items,
    [answered],
  );
});

test("only the asker's managers answer an approval, up to the root and never the asker", (t) => {
  const f = fixture(t);
  const approval = (by: string) => {
    const ticket = f.as(by).work.create({ title: "Migrate" });
    return ask(
      f.as(by).work.update({
        ticketID: ticket.ticketID,
        ask: {
          title: "Run the migration?",
          approval: true,
          fields: [
            {
              name: "decision",
              label: "Run it?",
              required: true,
              options: [{ value: "Run" }, { value: "Hold" }],
            },
          ],
        },
      }),
    );
  };
  const answer = { answers: { decision: "Run" } };
  const asked = approval("respondent");
  assert.equal(asked.approval, true);
  for (const by of ["respondent", "outsider"])
    assert.throws(
      () => f.as(by).work.answer({ askID: asked.formID, ...answer }),
      rejects("forbidden"),
    );
  assert.equal(
    ask(f.as("owner").work.answer({ askID: asked.formID, ...answer })).status,
    "resolved",
  );
  const deeper = approval("respondent");
  assert.equal(
    ask(f.as("requester").work.answer({ askID: deeper.formID, ...answer })).status,
    "resolved",
  );
  assert.throws(() => approval("requester"), rejects("forbidden"));
});

test("a raise passes an open ask one manager up, past closed managers, and never resolves it", (t) => {
  const f = fixture(t);
  // respondent reports to owner, who reports to the root, requester.
  const ticket = f.as("respondent").work.create({ title: "Pick a region" });
  const question = {
    title: "Which region?",
    fields: [{ name: "region", label: "Region", required: true }],
  };
  const asked = ask(f.as("respondent").work.update({ ticketID: ticket.ticketID, ask: question }));
  const routed = (actorID: string) =>
    f
      .as("outsider")
      .work.asks({ routedTo: actorID })
      .items.map((row) => row.formID);
  assert.deepEqual(routed("owner"), [asked.formID]);
  assert.deepEqual(routed("requester"), []);
  // An Actor's own asks route to its manager, never to itself.
  const mine = f.as("owner").work.create({ title: "Owner's own" });
  const own = ask(f.as("owner").work.update({ ticketID: mine.ticketID, ask: question }));
  assert.deepEqual(routed("owner"), [asked.formID]);
  assert.deepEqual(routed("requester"), [own.formID]);
  const page = f.as("outsider").work.asks({ routedTo: "requester", limit: 1 });
  assert.deepEqual(page.items, [own]);
  assert.equal(page.next, null);
  f.as("owner").work.update({
    close: { askID: own.formID, status: "cancelled", resolution: "Mine" },
  });
  for (const by of ["requester", "respondent", "outsider"])
    assert.throws(
      () => f.as(by).work.answer({ askID: asked.formID, raise: true }),
      rejects("forbidden"),
    );
  const raised = ask(f.as("owner").work.answer({ askID: asked.formID, raise: true }));
  assert.equal(raised.status, "open");
  assert.deepEqual(f.as("outsider").work.asks({ answeredBy: "owner" }).items, []);
  assert.deepEqual(raised.raises, [{ actorID: "owner", at: raised.updatedAt }]);
  assert.deepEqual(routed("owner"), []);
  assert.deepEqual(routed("requester"), [asked.formID]);
  assert.deepEqual(
    work(f.as("outsider").work.get({ askID: asked.formID, history: true })).asks?.[0]?.history?.at(
      -1,
    )?.action,
    "raised",
  );
  // The root raises nothing: it has no manager.
  assert.throws(
    () => f.as("requester").work.answer({ askID: asked.formID, raise: true }),
    rejects("forbidden"),
  );
  const answered = ask(
    f.as("owner").work.answer({ askID: asked.formID, answers: { region: "eu-west" } }),
  );
  assert.deepEqual(answered.raises, raised.raises);
  assert.equal(answered.status, "resolved");
  assert.deepEqual(routed("requester"), []);
  assert.throws(
    () => f.as("requester").work.answer({ askID: asked.formID, raise: true }),
    rejects("conflict"),
  );
  // A closed manager is skipped: the ask routes to the nearest open one.
  const skipped = ask(f.as("respondent").work.update({ ticketID: ticket.ticketID, ask: question }));
  const owner = f.rows.get("owner");
  assert.ok(owner);
  f.rows.set("owner", { ...owner, state: "closed" });
  assert.deepEqual(routed("requester"), [skipped.formID]);
  assert.deepEqual(
    f.as("requester").work.asks({ routedTo: "requester", status: ["resolved"] }).items,
    [],
  );
  assert.throws(
    () => f.as("requester").work.answer({ askID: skipped.formID, raise: true }),
    rejects("forbidden"),
  );
});

test("a closed manager's stand-in raises an ask routed past it", (t) => {
  const f = fixture(t);
  // deep reports to respondent, which reports to owner, under the root, requester.
  const template = f.rows.get("respondent");
  assert.ok(template);
  f.rows.set("deep", { ...template, actorID: "deep", name: "Deep" });
  f.managers.set("deep", "respondent");
  const ticket = f.as("deep").work.create({ title: "Deep work" });
  const asked = ask(
    f.as("deep").work.update({
      ticketID: ticket.ticketID,
      ask: { title: "Proceed?", fields: [{ name: "x", label: "Proceed?", required: true }] },
    }),
  );
  f.rows.set("respondent", { ...template, state: "closed" });
  assert.throws(
    () => f.as("requester").work.answer({ askID: asked.formID, raise: true }),
    rejects("forbidden"),
  );
  const raised = ask(f.as("owner").work.answer({ askID: asked.formID, raise: true }));
  assert.deepEqual(
    raised.raises.map((raise) => raise.actorID),
    ["owner"],
  );
  assert.deepEqual(
    f
      .as("outsider")
      .work.asks({ routedTo: "requester" })
      .items.map((row) => row.formID),
    [asked.formID],
  );
});

test("a cancel that also reassigns cancels the open asks as cancelled", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Both", ownerID: "owner" });
  const asked = ask(
    f.as("owner").work.update({
      ticketID: ticket.ticketID,
      ask: { title: "Go?", fields: [{ name: "x", label: "Go?", required: true }] },
    }),
  );
  const done = work(
    f.as("requester").work.update({
      ticketID: ticket.ticketID,
      expectedRevision: 1,
      ownerID: "respondent",
      status: "cancelled",
    }),
  );
  assert.deepEqual([done.status, done.ownerID], ["cancelled", "respondent"]);
  const [after] = work(f.as("owner").work.get({ askID: asked.formID })).asks ?? [];
  assert.equal(after?.resolution?.reason, "cancelled");
});

test("the asker closes its ask, or its nearest open manager once it is closed, on frozen Work too", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Review", ownerID: "respondent" });
  const question = {
    title: "Ready?",
    collect: true,
    fields: [{ name: "x", label: "Ready?", required: false }],
  };
  const open = ask(f.as("respondent").work.update({ ticketID: ticket.ticketID, ask: question }));
  const later = ask(f.as("respondent").work.update({ ticketID: ticket.ticketID, ask: question }));
  const close = (askID: string) => ({
    close: { askID, status: "resolved" as const, resolution: "Done" },
  });
  assert.throws(() => f.as("owner").work.update(close(open.formID)), rejects("forbidden"));
  ask(f.as("respondent").work.update(close(open.formID)));
  assert.throws(() => f.as("respondent").work.update(close(open.formID)), rejects("conflict"));
  // Submitting cancels the open asks; asking on frozen Work is refused.
  const sent = work(f.as("respondent").work.submit({ ticketID: ticket.ticketID, result: "Done" }));
  const after = work(f.as("outsider").work.get({ ticketID: ticket.ticketID })).asks ?? [];
  assert.deepEqual(
    after.map((row) => [row.formID, row.status, row.resolution?.reason]),
    [
      [open.formID, "resolved", undefined],
      [later.formID, "cancelled", "submitted"],
    ],
  );
  assert.equal(after[1]?.resolution?.at, sent.updatedAt);
  // A submission is the Work's ask to its requester: its ID finds the Work too.
  assert.equal(
    work(f.as("outsider").work.get({ askID: sent.submission?.submissionID ?? "" })).ticketID,
    ticket.ticketID,
  );
  assert.throws(
    () => f.as("respondent").work.update({ ticketID: ticket.ticketID, ask: question }),
    rejects("conflict"),
  );
  // An older ask left open on submitted Work is still answered and closed, by a stand-in once its
  // asker is closed.
  const at = new Date().toISOString();
  const row = {
    formID: "left",
    requesterID: "respondent",
    title: "Left open",
    links: [],
    workID: ticket.ticketID,
    approval: false,
    collect: true,
    fields: [{ name: "x", label: "Still useful?", required: false }],
    status: "open",
    createdAt: at,
    responses: {},
  } as never;
  f.store.transaction(() =>
    f.store.forms.save("left", row, { actorID: "respondent", at, action: "created", detail: {} }),
  );
  ask(f.as("outsider").work.answer({ askID: "left", answers: { x: "Still useful" } }));
  const respondent = f.rows.get("respondent");
  assert.ok(respondent);
  f.rows.set("respondent", { ...respondent, state: "closed" });
  assert.throws(() => f.as("requester").work.update(close("left")), rejects("forbidden"));
  assert.equal(ask(f.as("owner").work.update(close("left"))).status, "resolved");
});

test("cancelling Work cancels its open asks with the reason", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Maybe", ownerID: "owner" });
  const asked = ask(
    f.as("owner").work.update({
      ticketID: ticket.ticketID,
      ask: { title: "Go?", fields: [{ name: "x", label: "Go?", required: true }] },
    }),
  );
  const cancelled = work(
    f
      .as("requester")
      .work.update({ ticketID: ticket.ticketID, expectedRevision: 1, status: "cancelled" }),
  );
  const [after] = work(f.as("owner").work.get({ askID: asked.formID })).asks ?? [];
  assert.deepEqual(after?.resolution, {
    text: "Cancelled with the Work's cancellation.",
    reason: "cancelled",
    at: cancelled.updatedAt,
  });
  assert.throws(
    () => f.as("owner").work.answer({ askID: asked.formID, answers: { x: "Late" } }),
    rejects("conflict"),
  );
});

test("an Actor's own Work: defaults to itself, edits without revisions and completes on submit", (t) => {
  const f = fixture(t);
  const agent = f.as("owner");
  const ticket = agent.work.create({ title: "Cut the release" });
  assert.equal(ticket.requesterID, "owner");
  assert.equal(ticket.ownerID, "owner");
  assert.deepEqual(ticket.links, []);
  assert.equal(Object.hasOwn(ticket, "goal"), false);
  const blocker = agent.work.create({ title: "Wait for CI", goal: "Three checks pass" });
  const link = { label: "PR", url: "https://example.test/pull/1" };
  const waiting = work(
    agent.work.update({
      ticketID: ticket.ticketID,
      title: "Cut the 0.5 release",
      progress: "Tagged.\n\n1. Pack\n2. Pin",
      status: "active",
      links: [link],
      waitsOn: { ticketID: blocker.ticketID },
    }),
  );
  assert.equal(waiting.revision, 2);
  assert.deepEqual(waiting.waitsOn, { ticketID: blocker.ticketID });
  for (const waitsOn of [{ actorID: "requester" }, { text: "3 PRs in CI" }])
    assert.deepEqual(
      work(agent.work.update({ ticketID: ticket.ticketID, waitsOn })).waitsOn,
      waitsOn,
    );
  assert.deepEqual(
    agent.work.list({ waitsOnActorID: "requester" }).items.map((row) => row.ticketID),
    [],
  );
  const cleared = agent.work.update({ ticketID: ticket.ticketID, waitsOn: null });
  assert.equal(Object.hasOwn(cleared, "waitsOn"), false);
  for (const waitsOn of [{ actorID: "absent" }, { ticketID: "absent" }])
    assert.throws(
      () => agent.work.update({ ticketID: ticket.ticketID, waitsOn }),
      rejects("not_found"),
    );
  for (const edit of [
    { links: [{ url: "javascript:alert(1)" }] },
    { links: [{ url: "file:///tmp/evidence" }] },
    { title: "x".repeat(121) },
    { waitsOn: { text: "" } },
    { waitsOn: { actorID: "requester", text: "both" } },
    {},
  ])
    assert.throws(
      () => agent.work.update({ ticketID: ticket.ticketID, ...edit } as never),
      rejects("invalid_input"),
    );
  assert.throws(
    () => agent.work.update({ ticketID: ticket.ticketID, goal: "Requester edit" }),
    rejects("invalid_input"),
  );
  assert.throws(
    () => agent.work.update({ ticketID: ticket.ticketID, expectedRevision: 1, title: "Stale" }),
    rejects("conflict"),
  );
  const done = agent.work.submit({ ticketID: ticket.ticketID, result: "Released" });
  assert.equal(done.status, "accepted");
  assert.equal(done.completedAt, done.submission?.at);
  assert.deepEqual(done.submission?.evidence, []);
  assert.equal(done.review, undefined);
  assert.throws(
    () => agent.work.update({ ticketID: ticket.ticketID, progress: "After completion" }),
    rejects("conflict"),
  );
  assert.deepEqual(
    agent.work.list({ status: ["accepted"], order: "recent" }).items.map((row) => row.ticketID),
    [ticket.ticketID],
  );
});

test("Work another Actor requested waits for review; accepting needs no comment", (t) => {
  const f = fixture(t);
  const manager = f.as("requester");
  const report = f.as("owner");
  const ticket = manager.work.create({
    title: "Assigned",
    goal: "Ship it",
    ownerID: "owner",
    waitsOn: { actorID: "respondent" },
  });
  assert.deepEqual(manager.work.list({ waitsOnActorID: "respondent" }), {
    items: [listed(ticket)],
    next: null,
    actors: {
      owner: { name: "Owner" },
      requester: { name: "Requester" },
      respondent: { name: "Respondent" },
    },
  });
  assert.throws(
    () => report.work.update({ ticketID: ticket.ticketID, expectedRevision: 1, goal: "Mine" }),
    rejects("forbidden"),
  );
  assert.throws(
    () => manager.work.update({ ticketID: ticket.ticketID, title: "Not the owner's" }),
    rejects("forbidden"),
  );
  const regoal = work(
    manager.work.update({
      ticketID: ticket.ticketID,
      expectedRevision: 1,
      goal: "Ship it twice",
    }),
  );
  const first = report.work.submit({ ticketID: ticket.ticketID, result: "Shipped" });
  assert.equal(first.status, "submitted");
  assert.equal(first.completedAt, undefined);
  assert.ok(first.submission);
  assert.throws(
    () =>
      manager.work.answer({
        askID: first.submission?.submissionID ?? "",
        answers: { verdict: "changes_requested" },
      }),
    rejects("invalid_input"),
  );
  const changes = work(
    manager.work.answer({
      askID: first.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Once more",
    }),
  );
  assert.equal(changes.completedAt, undefined);
  const second = report.work.submit({
    ticketID: ticket.ticketID,
    expectedRevision: changes.revision,
    result: "Shipped twice",
  });
  assert.throws(
    () =>
      manager.work.answer({
        askID: first.submission?.submissionID ?? "",
        ticketID: ticket.ticketID,
        answers: { verdict: "accepted" },
      }),
    rejects("conflict"),
  );
  assert.throws(
    () =>
      manager.work.answer({
        askID: first.submission?.submissionID ?? "",
        answers: { verdict: "accepted" },
      }),
    rejects("not_found"),
  );
  const accepted = work(
    manager.work.answer({
      askID: second.submission?.submissionID ?? "",
      answers: { verdict: "accepted" },
    }),
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.goal, regoal.goal);
  assert.equal(accepted.completedAt, accepted.review?.at);
  assert.equal(Object.hasOwn(accepted.review ?? {}, "comment"), false);
  assert.equal(accepted.review?.reviewerID, "requester");
});

test("a stored blocked reads as active, and setting blocked is refused with the habit", (t) => {
  const f = fixture(t);
  const at = new Date().toISOString();
  const held = {
    ticketID: "held",
    requesterID: "requester",
    ownerID: "owner",
    title: "Held up",
    status: "blocked",
    links: [],
    waitsOn: { text: "CI" },
    createdAt: at,
  } as never;
  f.store.transaction(() =>
    f.store.work.save("held", held, { actorID: "owner", at, action: "updated", detail: held }),
  );
  const owner = f.as("owner");
  assert.equal(owner.work.get({ ticketID: "held" }).status, "active");
  assert.deepEqual(work(owner.work.get({ ticketID: "held" })).waitsOn, { text: "CI" });
  assert.deepEqual(
    owner.work.list({ status: ["active"] }).items.map((row) => [row.ticketID, row.status]),
    [["held", "active"]],
  );
  assert.throws(() => owner.work.list({ status: ["blocked" as never] }), rejects("invalid_input"));
  assert.throws(
    () => owner.work.update({ ticketID: "held", status: "blocked" as never }),
    (error: unknown) =>
      error instanceof WorkspaceError &&
      error.code === "invalid_input" &&
      error.message === `status: ${habit}`,
  );
  // A host that validates with the contract itself, as the Hub does, gets the same words.
  const issues = WorkContracts.work_update.input.safeParse({ ticketID: "held", status: "blocked" })
    .error?.issues;
  assert.deepEqual(
    issues?.map((issue) => issue.message),
    [habit],
  );
  const edited = owner.work.update({ ticketID: "held", progress: "Still on CI" });
  assert.equal(edited.status, "active");
  assert.equal(f.store.work.get("held")?.status, "active");
  assert.deepEqual(owner.work.get({ ticketID: "held", history: true }).history?.at(-1)?.detail, {
    progress: "Still on CI",
    status: "active",
  });
  assert.equal(owner.work.submit({ ticketID: "held", result: "Green" }).status, "submitted");
  const history = owner.work.get({ ticketID: "held", history: true }).history ?? [];
  assert.equal(history[0]?.detail.status, "blocked");
});

test("the requester cancels Work while it can move, and cancelled Work is frozen", (t) => {
  const f = fixture(t);
  const requester = f.as("requester");
  const owner = f.as("owner");
  const ticket = requester.work.create({ title: "Maybe later", ownerID: "owner" });
  const started = owner.work.update({ ticketID: ticket.ticketID, status: "active" });
  assert.throws(
    () => requester.work.update({ ticketID: ticket.ticketID, status: "cancelled" }),
    rejects("invalid_input"),
  );
  assert.throws(
    () =>
      owner.work.update({
        ticketID: ticket.ticketID,
        expectedRevision: started.revision,
        status: "cancelled",
      }),
    rejects("forbidden"),
  );
  const cancelled = work(
    requester.work.update({
      ticketID: ticket.ticketID,
      expectedRevision: started.revision,
      status: "cancelled",
    }),
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.completedAt, undefined);
  assert.deepEqual(
    requester.work.get({ ticketID: ticket.ticketID, history: true }).history?.at(-1)?.detail,
    { status: "cancelled" },
  );
  for (const write of [
    () => owner.work.update({ ticketID: ticket.ticketID, progress: "Late" }),
    () => owner.work.submit({ ticketID: ticket.ticketID, result: "Late" }),
    () =>
      requester.work.update({
        ticketID: ticket.ticketID,
        expectedRevision: cancelled.revision,
        goal: "Revived",
      }),
    () =>
      requester.work.update({
        ticketID: ticket.ticketID,
        expectedRevision: cancelled.revision,
        status: "cancelled",
      }),
  ])
    assert.throws(write, rejects("conflict"));
  const sent = requester.work.create({ title: "In review", ownerID: "owner" });
  const submitted = owner.work.submit({ ticketID: sent.ticketID, result: "Done" });
  const cancelSent = (expectedRevision: number) =>
    requester.work.update({ ticketID: sent.ticketID, expectedRevision, status: "cancelled" });
  assert.throws(() => cancelSent(submitted.revision), rejects("conflict"));
  const changes = work(
    requester.work.answer({
      askID: submitted.submission?.submissionID ?? "",
      answers: { verdict: "changes_requested" },
      note: "Not needed after all",
    }),
  );
  assert.throws(
    () =>
      f.as("outsider").work.update({
        ticketID: sent.ticketID,
        expectedRevision: changes.revision,
        status: "cancelled",
      }),
    rejects("forbidden"),
  );
  assert.equal(cancelSent(changes.revision).status, "cancelled");
  const done = requester.work.create({ title: "Done", ownerID: "owner" });
  const finished = owner.work.submit({ ticketID: done.ticketID, result: "Done" });
  const accepted = work(
    requester.work.answer({
      askID: finished.submission?.submissionID ?? "",
      answers: { verdict: "accepted" },
    }),
  );
  assert.throws(
    () =>
      requester.work.update({
        ticketID: done.ticketID,
        expectedRevision: accepted.revision,
        status: "cancelled",
      }),
    rejects("conflict"),
  );
  const own = owner.work.create({ title: "Own idea" });
  assert.equal(
    owner.work.update({ ticketID: own.ticketID, expectedRevision: 1, status: "cancelled" }).status,
    "cancelled",
  );
  assert.deepEqual(
    requester.work.list({ status: ["cancelled"] }).items.map((row) => row.ticketID),
    [ticket.ticketID, sent.ticketID, own.ticketID],
  );
});

test("a closed requester's rights pass to its nearest open manager, past closed ones", (t) => {
  const f = fixture(t);
  // respondent reports to owner, who reports to the root, requester.
  const asked = f.as("respondent").work.create({ title: "Submitted", ownerID: "outsider" });
  const open = f.as("respondent").work.create({ title: "Not started", ownerID: "outsider" });
  const sent = f.as("outsider").work.submit({ ticketID: asked.ticketID, result: "Done" });
  const close = (id: string) => {
    const row = f.rows.get(id);
    assert.ok(row);
    f.rows.set(id, { ...row, state: "closed" });
  };
  // While the requester is open, its rights stay its own.
  assert.throws(
    () =>
      f.as("owner").work.update({ ticketID: open.ticketID, expectedRevision: 1, goal: "Early" }),
    rejects("forbidden"),
  );
  close("respondent");
  const submissionID = sent.submission?.submissionID ?? "";
  const verdict = { askID: submissionID, answers: { verdict: "accepted" } };
  for (const id of ["requester", "outsider"])
    assert.throws(() => f.as(id).work.answer(verdict), rejects("forbidden"));
  const goal = { ticketID: open.ticketID, expectedRevision: 1, goal: "Rescued" };
  assert.throws(() => f.as("requester").work.update(goal), rejects("forbidden"));
  assert.equal(work(f.as("owner").work.update(goal)).goal, "Rescued");
  close("owner");
  assert.equal(f.as("requester").work.answer(verdict).status, "accepted");
  const moved = work(
    f.as("requester").work.update({
      ticketID: open.ticketID,
      expectedRevision: 2,
      ownerID: "requester",
    }),
  );
  assert.equal(moved.ownerID, "requester");
  assert.equal(
    f.as("requester").work.update({
      ticketID: open.ticketID,
      expectedRevision: moved.revision,
      status: "cancelled",
    }).status,
    "cancelled",
  );
  // A manager chain that loops through closed Actors leaves no one the requester's rights.
  const stranded = f.as("outsider").work.create({ title: "Looped", ownerID: "requester" });
  f.managers.set("outsider", "respondent");
  f.managers.set("owner", "respondent");
  close("outsider");
  assert.throws(
    () =>
      f.as("requester").work.update({
        ticketID: stranded.ticketID,
        expectedRevision: 1,
        goal: "Looped",
      }),
    rejects("forbidden"),
  );
});

test("a submission is answered by its ID with a verdict, and its note is the comment", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Review me", ownerID: "owner" });
  const sent = f.as("owner").work.submit({ ticketID: ticket.ticketID, result: "Done" });
  const askID = sent.submission?.submissionID ?? "";
  const requester = f.as("requester");
  for (const answers of [{}, { verdict: "maybe" }, { verdict: "accepted", extra: "x" }])
    assert.throws(() => requester.work.answer({ askID, answers }), rejects("invalid_input"));
  assert.throws(
    () => requester.work.answer({ askID, answers: { verdict: "maybe" } }),
    (error: unknown) =>
      error instanceof WorkspaceError && /^answers\.verdict: /.test(error.message),
  );
  for (const input of [
    { askID },
    { askID, raise: true as const, answers: { verdict: "accepted" } },
  ])
    assert.throws(() => requester.work.answer(input), rejects("invalid_input"));
  assert.throws(
    () => requester.work.answer({ askID, raise: true }),
    (error: unknown) => error instanceof WorkspaceError && /can't be raised/.test(error.message),
  );
  assert.throws(
    () => requester.work.answer({ askID: "absent", answers: { verdict: "accepted" } }),
    rejects("not_found"),
  );
  const other = requester.work.create({ title: "Other", ownerID: "owner" });
  assert.throws(
    () =>
      requester.work.answer({ askID, ticketID: other.ticketID, answers: { verdict: "accepted" } }),
    rejects("not_found"),
  );
  const changes = work(
    requester.work.answer({
      askID,
      ticketID: ticket.ticketID,
      answers: { verdict: "changes_requested" },
      note: "Add the evidence",
    }),
  );
  assert.deepEqual(
    [
      changes.status,
      changes.review?.verdict,
      changes.review?.comment,
      changes.review?.submissionID,
    ],
    ["changes_requested", "changes_requested", "Add the evidence", askID],
  );
  assert.throws(
    () => requester.work.answer({ askID, answers: { verdict: "accepted" } }),
    rejects("conflict"),
  );
});

test("canonical visibility, active callers and retained reads after counterparty closure", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Retain history", ownerID: "owner" });
  const message = f.as("owner").messages.send({ recipientID: "requester", text: "Retain me" });
  const owner = f.rows.get("owner");
  assert.ok(owner);
  f.rows.set("owner", { ...owner, state: "closed" });
  assert.equal(work(f.as("requester").work.get({ ticketID: ticket.ticketID })).ownerID, "owner");
  assert.equal(f.as("requester").messages.get({ messageID: message.messageID }).text, "Retain me");
  assert.equal(f.as("requester").actors.get({ actorID: "owner" }).state, "closed");
  assert.throws(() => f.as("owner").work.list(), rejects("forbidden"));
  assert.throws(() => f.as("owner").actors.get(), rejects("forbidden"));
  assert.throws(
    () => f.as("requester").messages.send({ recipientID: "owner", text: "Closed target" }),
    rejects("invalid_input"),
  );
  assert.deepEqual(f.as("outsider").work.get({ ticketID: ticket.ticketID }), {
    ...ticket,
    asks: [],
  });
  const contextMessage = f.as("outsider").messages.send({
    recipientID: "requester",
    text: `Shared Work context: ${ticket.ticketID}`,
  });
  assert.equal(
    f.as("respondent").messages.get({ messageID: contextMessage.messageID }).text,
    contextMessage.text,
  );
  const asked = f.as("outsider").work.create({ title: "Outsider's" });
  const form = ask(
    f.as("outsider").work.update({
      ticketID: asked.ticketID,
      ask: {
        title: "Open question",
        fields: [{ name: "x", label: "Open question", required: false }],
      },
    }),
  );
  for (const read of [
    () => f.as("owner").work.get({ ticketID: ticket.ticketID }),
    () => f.as("owner").work.get({ askID: form.formID }),
    () => f.as("owner").work.asks({ requesterID: "outsider" }),
  ])
    assert.throws(read, rejects("forbidden"));
  const restricted = bindWorkspace(
    {
      get: (caller, id) => (caller === id ? f.rows.get(id) : undefined),
      within: f.authority.within,
      manager: f.authority.manager,
    },
    f.store,
    "requester",
  );
  assert.throws(() => restricted.actors.get({ actorID: "respondent" }), rejects("not_found"));
  assert.deepEqual(restricted.work.list({ ownerID: "owner", requesterID: "requester" }).items, [
    { ...ticket, asks: [] },
  ]);
  assert.deepEqual(restricted.work.asks({ requesterID: "outsider" }), {
    items: [form],
    next: null,
    actors: {},
  });
  assert.deepEqual(restricted.work.asks({ requesterID: "unknown" }).items, []);
  // Routing walks past Actors the caller can't see, as names() leaves them out: respondent's ask
  // routes through owner, which this authority hides, to the root.
  const deeper = f.as("respondent").work.create({ title: "Respondent's" });
  const routed = ask(
    f.as("respondent").work.update({
      ticketID: deeper.ticketID,
      ask: { title: "Deeper", fields: [{ name: "x", label: "Deeper", required: false }] },
    }),
  );
  assert.deepEqual(
    restricted.work.asks({ routedTo: "requester" }).items.map((row) => row.formID),
    [form.formID, routed.formID],
  );
});

test("rights never pass past an Actor the caller can't see; only the routed read walks past it", (t) => {
  const f = fixture(t);
  // outsider and owner report to the root, requester; respondent to owner; deep to respondent.
  const template = f.rows.get("respondent");
  assert.ok(template);
  f.rows.set("deep", { ...template, actorID: "deep", name: "Deep" });
  f.managers.set("deep", "respondent");
  const question = { title: "Go?", fields: [{ name: "x", label: "Go?", required: true }] };
  const requested = f.as("outsider").work.create({ title: "Outsider's request", ownerID: "owner" });
  const sent = work(f.as("owner").work.submit({ ticketID: requested.ticketID, result: "Done" }));
  const open = f.as("outsider").work.create({ title: "Outsider's other", ownerID: "owner" });
  const own = f.as("outsider").work.create({ title: "Outsider's own" });
  const outsiderAsk = ask(f.as("outsider").work.update({ ticketID: own.ticketID, ask: question }));
  const deepWork = f.as("deep").work.create({ title: "Deep's own" });
  const deepAsk = ask(f.as("deep").work.update({ ticketID: deepWork.ticketID, ask: question }));
  // A host that hides one open Actor from every caller.
  const hiding = (hidden: string, caller: string) =>
    bindWorkspace(
      {
        get: (_caller, id) => (id === hidden ? undefined : f.rows.get(id)),
        within: f.authority.within,
        manager: f.authority.manager,
      },
      f.store,
      caller,
    ).work;
  const root = hiding("outsider", "requester");
  for (const write of [
    () => root.update({ ticketID: open.ticketID, expectedRevision: 1, goal: "Taken over" }),
    () => root.update({ ticketID: open.ticketID, expectedRevision: 1, ownerID: "respondent" }),
    () => root.update({ ticketID: open.ticketID, expectedRevision: 1, status: "cancelled" }),
    () =>
      root.update({
        close: { askID: outsiderAsk.formID, status: "cancelled", resolution: "Mine" },
      }),
    () =>
      root.answer({
        askID: sent.submission?.submissionID ?? "",
        answers: { verdict: "accepted" },
      }),
  ])
    assert.throws(write, rejects("not_found"));
  const manager = hiding("respondent", "owner");
  assert.throws(() => manager.answer({ askID: deepAsk.formID, raise: true }), rejects("not_found"));
  // The routed read alone counts the hidden respondent as closed and walks on to owner.
  assert.deepEqual(
    manager.asks({ routedTo: "owner" }).items.map((row) => row.formID),
    [deepAsk.formID],
  );
  // Nothing above was written.
  const read = f.as("outsider").work;
  assert.equal(read.get({ ticketID: open.ticketID }).revision, 1);
  assert.equal(work(read.get({ ticketID: requested.ticketID })).status, "submitted");
  assert.equal(work(read.get({ askID: outsiderAsk.formID })).asks?.[0]?.status, "open");
  assert.deepEqual(work(read.get({ askID: deepAsk.formID })).asks?.[0]?.raises, []);
});

test("lists name their Actors, go newest first and select by update time and several requesters", (t) => {
  const f = fixture(t);
  const created = ["requester", "outsider", "owner"].map((by, i) =>
    f.as(by).work.create({ title: `Work ${i}`, ownerID: "respondent" }),
  );
  const [first, second, third] = created;
  assert.ok(first && second && third);
  assert.ok(first.updatedAt <= third.updatedAt);
  assert.equal(Object.hasOwn(first, "cursor"), false);
  const moved = work(
    f.as("respondent").work.update({
      ticketID: first.ticketID,
      expectedRevision: 1,
      status: "active",
    }),
  );
  assert.ok(moved.updatedAt >= first.updatedAt);
  const reader = f.as("outsider");
  const recent = reader.work.list({ order: "recent", limit: 2 });
  assert.deepEqual(recent.items, [moved, third].map(listed));
  assert.deepEqual(reader.work.list({ order: "recent", after: next(recent) }), {
    items: [listed(second)],
    next: null,
    actors: { outsider: { name: "Outsider" }, respondent: { name: "Respondent" } },
  });
  assert.deepEqual(
    reader.work.list({ requesterID: ["requester", "owner"] }).items,
    [third, moved].map(listed),
  );
  assert.deepEqual(reader.work.list({ requesterID: "outsider" }).items, [listed(second)]);
  assert.deepEqual(reader.work.list({ status: ["open", "active"] }).items.length, 3);
  assert.deepEqual(reader.work.list({ updatedSince: moved.updatedAt }).items.at(-1), listed(moved));
  assert.deepEqual(reader.work.list({ updatedSince: "2999-01-01T00:00:00.000Z" }).items, []);
  assert.throws(() => reader.work.list({ requesterID: [] }), rejects("invalid_input"));
  assert.throws(() => reader.work.list({ status: [] }), rejects("invalid_input"));
  assert.throws(() => reader.work.list({ order: "oldest" } as never), rejects("invalid_input"));
  const hidden = f.rows.get("owner");
  assert.ok(hidden);
  f.rows.delete("owner");
  assert.deepEqual(reader.work.list({ requesterID: "owner" }).actors, {
    respondent: { name: "Respondent" },
  });
  f.rows.set("owner", hidden);
  const form = ask(
    f.as("respondent").work.update({
      ticketID: first.ticketID,
      ask: { title: "Answer?", fields: [{ name: "x", label: "Answer?", required: false }] },
    }),
  );
  assert.deepEqual(reader.work.list({ requesterID: "requester" }).actors, {
    requester: { name: "Requester" },
    respondent: { name: "Respondent" },
  });
  const answered = ask(f.as("owner").work.answer({ askID: form.formID, answers: {} }));
  assert.ok(answered.updatedAt >= form.updatedAt);
  assert.deepEqual(reader.work.asks({ answeredBy: "owner" }), {
    items: [answered],
    next: null,
    actors: { owner: { name: "Owner" }, respondent: { name: "Respondent" } },
  });
});

test("every contract carries the level that presents it", () => {
  const levels = Object.fromEntries(
    Object.entries({
      ...MessageContracts,
      ...WorkContracts,
    }).map(([name, spec]) => [name, spec.level]),
  );
  assert.deepEqual(levels, {
    message_send: "report",
    message_get: "team",
    message_list: "report",
    work_create: "report",
    work_get: "report",
    work_list: "report",
    work_update: "report",
    work_submit: "report",
    work_answer: "team",
  });
});
