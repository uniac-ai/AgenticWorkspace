import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
import { createActors } from "../src/actors/index.js";
import { WorkspaceError } from "../src/contracts/index.js";
import { createForms } from "../src/forms/index.js";
import { bindWorkspace } from "../src/index.js";
import { openSqlite } from "../src/persistence/index.js";

const rejects = (code: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === code;
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
      const ticket = requester.work.create({ goal: "Deliver evidence", ownerID: "owner" });
      assert.equal(ticket.status, "open");
      assert.equal(requester.messages.list().items.length, 0);
      assert.equal(requester.forms.list().items.length, 0);
      const message = requester.messages.send({
        recipientID: "owner",
        text: "Inspect this work",
        workID: ticket.ticketID,
      });
      assert.deepEqual(owner.messages.get({ messageID: message.messageID }), message);
      assert.throws(
        () => outsider.messages.get({ messageID: message.messageID }),
        rejects("not_found"),
      );
      assert.equal(requester.work.get({ ticketID: ticket.ticketID }).revision, ticket.revision);
      const form = requester.forms.create({
        respondentIDs: ["respondent"],
        fields: [
          { name: "decision", label: "Which option?", required: true, options: ["yes", "no"] },
        ],
      });
      assert.equal(respondent.forms.get({ formID: form.formID }).formID, form.formID);
      assert.equal(form.workID, undefined);
      assert.deepEqual(respondent.work.get({ ticketID: ticket.ticketID }), ticket);
      assert.throws(
        () =>
          requester.forms.respond({
            formID: form.formID,
            expectedRevision: 1,
            answers: { decision: "yes" },
          }),
        rejects("forbidden"),
      );
      assert.deepEqual(outsider.forms.get({ formID: form.formID }), form);
      assert.throws(
        () =>
          respondent.forms.respond({
            formID: form.formID,
            expectedRevision: 1,
            answers: { decision: "maybe" },
          }),
        rejects("invalid_input"),
      );
      assert.throws(
        () => respondent.forms.respond({ formID: form.formID, expectedRevision: 1, answers: {} }),
        rejects("invalid_input"),
      );
      let response = respondent.forms.respond({
        formID: form.formID,
        expectedRevision: 1,
        answers: { decision: "no" },
      });
      response = respondent.forms.respond({
        formID: form.formID,
        expectedRevision: response.revision,
        answers: { decision: "yes" },
      });
      assert.deepEqual(
        response.history.filter((e) => e.action === "responded").map((e) => e.detail.answers),
        [{ decision: "no" }, { decision: "yes" }],
      );
      assert.throws(
        () =>
          respondent.forms.close({
            formID: form.formID,
            expectedRevision: response.revision,
            status: "resolved",
            resolution: "Done",
          }),
        rejects("forbidden"),
      );
      const closed = requester.forms.close({
        formID: form.formID,
        expectedRevision: response.revision,
        status: "resolved",
        resolution: "Decision recorded",
      });
      assert.equal(closed.status, "resolved");
      assert.throws(
        () =>
          requester.forms.close({
            formID: form.formID,
            expectedRevision: response.revision,
            status: "resolved",
            resolution: "Stale close",
          }),
        rejects("conflict"),
      );
      assert.throws(
        () =>
          respondent.forms.respond({
            formID: form.formID,
            expectedRevision: closed.revision,
            answers: { decision: "no" },
          }),
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
          owner.work.review({
            ticketID: ticket.ticketID,
            expectedRevision: first.revision,
            submissionID: firstSubmissionID,
            verdict: "accepted",
            comment: "Owner cannot accept",
          }),
        rejects("forbidden"),
      );
      const changes = requester.work.review({
        ticketID: ticket.ticketID,
        expectedRevision: first.revision,
        submissionID: firstSubmissionID,
        verdict: "changes_requested",
        comment: "Add second evidence",
      });
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
          requester.work.review({
            ticketID: ticket.ticketID,
            expectedRevision: second.revision,
            submissionID: firstSubmissionID,
            verdict: "accepted",
            comment: "Delayed old review",
          }),
        rejects("conflict"),
      );
      assert.throws(
        () =>
          requester.work.review({
            ticketID: ticket.ticketID,
            expectedRevision: first.revision,
            submissionID: secondSubmissionID,
            verdict: "accepted",
            comment: "Stale revision",
          }),
        rejects("conflict"),
      );
      const accepted = requester.work.review({
        ticketID: ticket.ticketID,
        expectedRevision: second.revision,
        submissionID: secondSubmissionID,
        verdict: "accepted",
        comment: "Evidence checked",
      });
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
      const retained = f.as("requester").work.get({ ticketID: ticket.ticketID });
      assert.deepEqual(retained, accepted);
      assert.equal(retained.history.filter((e) => e.action === "submitted").length, 2);
      assert.equal(retained.history.filter((e) => e.action === "reviewed").length, 2);
      assert.deepEqual(f.as("owner").messages.get({ messageID: message.messageID }), message);
      assert.deepEqual(f.as("respondent").forms.get({ formID: form.formID }), closed);
      assert.equal(
        f.as("requester").work.list({ status: "accepted" }).items[0]?.ticketID,
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
  assert.equal(requester.messages.list().items.length, 0);
  assert.equal(requester.work.list().items.length, 0);
  const direct = requester.messages.send({ recipientID: "owner", text: prose });
  assert.equal(direct.workID, undefined);
  assert.equal(
    owner.messages.list({ direction: "incoming" }).items[0]?.messageID,
    direct.messageID,
  );
  assert.equal(owner.messages.list({ direction: "outgoing" }).items.length, 0);
  assert.throws(
    () => requester.messages.send({ recipientID: "owner", text: "Missing work", workID: "absent" }),
    rejects("not_found"),
  );
  assert.throws(
    () =>
      requester.forms.create({
        workID: "absent",
        respondentIDs: ["owner"],
        fields: [{ name: "x", label: "Question", required: true }],
      }),
    rejects("not_found"),
  );
});

test("shared standalone and linked Form reads never consult Work; linked creation validates Work", (t) => {
  const f = fixture(t);
  const requester = f.as("requester");
  const owner = f.as("owner");
  const outsider = f.as("outsider");
  const withoutWork = createForms(requester.actors, f.store);
  const trap = { get: () => assert.fail("standalone Form consulted Work") };
  const directed = createForms(owner.actors, f.store, trap);
  const observer = createForms(outsider.actors, f.store, trap);
  const input = {
    respondentIDs: ["owner"],
    fields: [{ name: "answer", label: "Which option?", required: true }],
  };
  const form = createForms(requester.actors, f.store, trap).create(input);
  assert.deepEqual(directed.get({ formID: form.formID }), form);
  assert.deepEqual(directed.list().items, [form]);
  assert.deepEqual(observer.list().items, [form]);
  assert.deepEqual(observer.get({ formID: form.formID }), form);
  assert.throws(
    () =>
      observer.respond({ formID: form.formID, expectedRevision: 1, answers: { answer: "yes" } }),
    rejects("forbidden"),
  );
  assert.throws(
    () =>
      observer.close({
        formID: form.formID,
        expectedRevision: 1,
        status: "resolved",
        resolution: "Unrelated reader",
      }),
    rejects("forbidden"),
  );
  assert.throws(
    () => withoutWork.create({ ...input, respondentIDs: ["absent"] }),
    rejects("not_found"),
  );
  const ticket = requester.work.create({ goal: "Optional linked context", ownerID: "owner" });
  assert.throws(
    () => withoutWork.create({ ...input, workID: ticket.ticketID }),
    rejects("invalid_input"),
  );
  const linked = outsider.forms.create({
    ...input,
    respondentIDs: ["respondent"],
    workID: ticket.ticketID,
  });
  assert.deepEqual(observer.get({ formID: linked.formID }), linked);
  assert.deepEqual(withoutWork.get({ formID: linked.formID }), linked);
  assert.deepEqual(observer.list().items, [form, linked]);
  assert.throws(
    () =>
      outsider.work.update({
        ticketID: ticket.ticketID,
        expectedRevision: 1,
        goal: "Unrelated edit",
      }),
    rejects("forbidden"),
  );
  assert.throws(
    () =>
      outsider.work.submit({
        ticketID: ticket.ticketID,
        expectedRevision: 1,
        result: "Unrelated result",
        evidence: [],
      }),
    rejects("forbidden"),
  );
  assert.throws(
    () =>
      outsider.work.review({
        ticketID: ticket.ticketID,
        expectedRevision: 1,
        submissionID: "absent",
        verdict: "accepted",
        comment: "Unrelated review",
      }),
    rejects("forbidden"),
  );
  assert.equal(owner.forms.get({ formID: linked.formID }).workID, ticket.ticketID);
  requester.work.update({ ticketID: ticket.ticketID, expectedRevision: 1, ownerID: "outsider" });
  assert.deepEqual(owner.forms.get({ formID: linked.formID }), linked);
  assert.deepEqual(
    owner.forms.list().items.map((row) => row.formID),
    [form.formID, linked.formID],
  );
  assert.equal(outsider.forms.get({ formID: linked.formID }).formID, linked.formID);
  assert.equal(f.as("respondent").forms.get({ formID: linked.formID }).formID, linked.formID);
});

test("revision conflicts across independent SQLite connections roll back snapshots and history", async (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ goal: "Concurrent updates", ownerID: "owner" });
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
  const retained = f.as("owner").work.get({ ticketID: ticket.ticketID });
  assert.equal(retained.history.length, 2);
  const head = f.store.work.head();
  assert.throws(() =>
    f.store.transaction(() => {
      f.store.work.save(
        "rolled-back",
        {
          ticketID: "rolled-back",
          requesterID: "requester",
          ownerID: "owner",
          goal: "Must roll back",
          status: "open",
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
  const form = f.as("requester").forms.create({
    workID: ticket.ticketID,
    respondentIDs: ["owner"],
    fields: [{ name: "x", label: "Answer?", required: true }],
  });
  f.as("owner").forms.respond({
    formID: form.formID,
    expectedRevision: 1,
    answers: { x: "first answer" },
  });
  assert.throws(
    () =>
      f.as("requester").forms.close({
        formID: form.formID,
        expectedRevision: 1,
        status: "cancelled",
        resolution: "Stale close",
      }),
    rejects("conflict"),
  );
  assert.throws(
    () =>
      other.forms.respond({
        formID: form.formID,
        expectedRevision: 1,
        answers: { x: "lost answer" },
      }),
    rejects("conflict"),
  );
  assert.equal(f.as("owner").forms.get({ formID: form.formID }).history.length, 2);
});

test("multi-page filtered upserts, duplicate updated rows and disappearing matches survive reopen", (t) => {
  const f = fixture(t);
  const request = f.as("requester");
  const hidden = f
    .as("outsider")
    .work.create({ goal: "Different owner and requester", ownerID: "outsider" });
  const first = request.work.create({ goal: "First", ownerID: "owner" });
  const second = request.work.create({ goal: "Second", ownerID: "owner" });
  const third = request.work.create({ goal: "Third", ownerID: "owner" });
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
  const page2 = f.as("owner").work.list({ ...filters, after: page1.after, limit: 2 });
  assert.deepEqual(
    page2.items.map((row) => row.ticketID),
    [second.ticketID, third.ticketID],
  );
  const page3 = f.as("owner").work.list({ ...filters, after: page2.after, limit: 1 });
  assert.deepEqual(
    page3.items.map((row) => row.ticketID),
    [first.ticketID],
  );
  const scoped = f.as("owner").work.list({ ...filters, status: "open" });
  f.as("owner").work.update({ ticketID: second.ticketID, expectedRevision: 1, status: "active" });
  f.as("requester").work.update({
    ticketID: third.ticketID,
    expectedRevision: 1,
    ownerID: "respondent",
  });
  assert.deepEqual(
    f.as("owner").work.list({ ...filters, after: scoped.after, status: "open" }).items,
    [],
  );
  assert.deepEqual(
    f
      .as("owner")
      .work.list({ ...filters, status: "open" })
      .items.map((row) => row.ticketID),
    [first.ticketID],
  );
  assert.equal(
    f.as("respondent").work.list({ ownerID: "respondent" }).items[0]?.ticketID,
    third.ticketID,
  );
  for (const after of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 999])
    assert.throws(() => f.as("owner").work.list({ after }), rejects("invalid_input"));
  assert.throws(() => f.as("owner").work.list({ after: "1" } as never), rejects("invalid_input"));
  assert.equal(f.as("owner").work.list({ after: f.store.work.head() }).after, f.store.work.head());
  assert.throws(() => f.as("owner").work.list({ limit: 101 }), rejects("invalid_input"));
  f.as("outsider").messages.send({
    recipientID: "outsider",
    text: "Hidden before first inbox row",
  });
  f.as("owner").messages.send({
    recipientID: "requester",
    text: "Outgoing before incoming filter",
  });
  for (const text of ["one", "two", "three"])
    f.as("requester").messages.send({ recipientID: "owner", text });
  const inbox1 = f.as("owner").messages.list({ direction: "incoming", limit: 1 });
  f.reopen();
  const inbox2 = f
    .as("owner")
    .messages.list({ direction: "incoming", after: inbox1.after, limit: 3 });
  assert.deepEqual(
    inbox2.items.map((row) => row.text),
    ["two", "three"],
  );
  assert.throws(() => f.as("owner").messages.list({ after: 999 }), rejects("invalid_input"));
  f.as("outsider").forms.create({
    workID: hidden.ticketID,
    respondentIDs: ["outsider"],
    fields: [{ name: "x", label: "Different respondent", required: true }],
  });
  const forms = [first, second].map((ticket) =>
    f.as("requester").forms.create({
      workID: ticket.ticketID,
      respondentIDs: ["owner"],
      fields: [{ name: "x", label: "Answer?", required: true }],
    }),
  );
  const forms1 = f.as("owner").forms.list({ respondentID: "owner", limit: 1 });
  f.as("owner").forms.respond({
    formID: forms[0]?.formID ?? "",
    expectedRevision: 1,
    answers: { x: "answered" },
  });
  f.reopen();
  assert.deepEqual(
    f
      .as("owner")
      .forms.list({ respondentID: "owner", after: forms1.after })
      .items.map((row) => row.formID),
    [forms[1]?.formID, forms[0]?.formID],
  );
  assert.throws(() => f.as("owner").forms.list({ after: 999 }), rejects("invalid_input"));
});

test("shared Work/Form AND filters precede pagination; awaiting means open, designated and no response entry", (t) => {
  const f = fixture(t);
  const request = f.as("requester");
  const observer = f.as("outsider");
  observer.work.create({ goal: "Other requester", ownerID: "owner" });
  const otherOwner = request.work.create({ goal: "Other owner", ownerID: "outsider" });
  const first = request.work.create({ goal: "First match", ownerID: "owner" });
  const active = request.work.create({ goal: "Other status", ownerID: "owner" });
  f.as("owner").work.update({ ticketID: active.ticketID, expectedRevision: 1, status: "active" });
  const second = request.work.create({ goal: "Second match", ownerID: "owner" });
  assert.equal(observer.work.list().items.length, 5);
  assert.deepEqual(observer.work.get({ ticketID: first.ticketID }), first);
  const workFilters = {
    ownerID: "owner",
    requesterID: "requester",
    status: "open" as const,
    limit: 1,
  };
  const page = observer.work.list(workFilters);
  assert.deepEqual(page.items, [first]);
  const next = observer.work.list({ ...workFilters, after: page.after });
  assert.deepEqual(next.items, [second]);
  assert.deepEqual(observer.work.list({ ...workFilters, after: next.after }), {
    items: [],
    after: next.after,
  });
  assert.deepEqual(observer.work.list({ ownerID: "absent", after: page.after }), {
    items: [],
    after: page.after,
  });

  const fields = [{ name: "answer", label: "Optional answer", required: false }];
  const create = (by: string, respondentIDs: string[], workID?: string) =>
    f.as(by).forms.create({ respondentIDs, fields, ...(workID === undefined ? {} : { workID }) });
  create("outsider", ["owner", "respondent"], first.ticketID);
  create("requester", ["owner"], first.ticketID);
  const pending = create("requester", ["owner", "respondent"], first.ticketID);
  const revised = f
    .as("respondent")
    .forms.respond({ formID: pending.formID, expectedRevision: 1, answers: {} });
  const closing = create("requester", ["owner", "respondent"], first.ticketID);
  const closed = request.forms.close({
    formID: closing.formID,
    expectedRevision: 1,
    status: "cancelled",
    resolution: "Cancelled without responses",
  });
  create("requester", ["owner", "respondent"], otherOwner.ticketID);
  const responding = create("requester", ["owner", "respondent"], first.ticketID);
  const answered = f
    .as("owner")
    .forms.respond({ formID: responding.formID, expectedRevision: 1, answers: {} });
  const last = create("requester", ["owner", "respondent"], first.ticketID);
  const standalone = create("requester", ["owner", "respondent"]);
  assert.equal(observer.forms.list().items.length, 8);
  assert.deepEqual(observer.forms.get({ formID: standalone.formID }), standalone);
  assert.deepEqual(observer.forms.get({ formID: pending.formID }), revised);
  const formFilters = {
    workID: first.ticketID,
    requesterID: "requester",
    respondentID: "respondent",
    status: "open" as const,
    awaitingActorID: "owner",
    limit: 1,
  };
  const forms1 = observer.forms.list(formFilters);
  assert.deepEqual(forms1.items, [revised]);
  const forms2 = observer.forms.list({ ...formFilters, after: forms1.after });
  assert.deepEqual(forms2.items, [last]);
  assert.deepEqual(observer.forms.list({ ...formFilters, after: forms2.after }), {
    items: [],
    after: forms2.after,
  });
  assert.deepEqual(observer.forms.list({ status: "cancelled" }).items, [closed]);
  assert.deepEqual(
    observer.forms.list({ status: "cancelled", awaitingActorID: "owner" }).items,
    [],
  );
  assert.deepEqual(observer.forms.list({ respondentID: "absent", after: forms1.after }), {
    items: [],
    after: forms1.after,
  });
  assert.deepEqual(observer.forms.list({ awaitingActorID: "absent" }).items, []);
  assert.equal(
    observer.forms
      .list({ awaitingActorID: "owner" })
      .items.some((row) => row.formID === answered.formID),
    false,
  );
  assert.equal(
    observer.forms
      .list({ awaitingActorID: "respondent" })
      .items.some((row) => row.formID === revised.formID),
    false,
  );
  assert.throws(
    () =>
      observer.forms.respond({
        formID: pending.formID,
        expectedRevision: revised.revision,
        answers: {},
      }),
    rejects("forbidden"),
  );
  f.reopen();
  assert.deepEqual(f.as("outsider").forms.list({ ...formFilters, limit: 100 }).items, [
    revised,
    last,
  ]);
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
      goal: `Interleaved ${i}`,
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
  const ticket = requester.work.create({ goal: "Retained deep result", ownerID: deep });
  const submitted = f.as(deep).work.submit({
    ticketID: ticket.ticketID,
    expectedRevision: 1,
    result: "Evidence",
    evidence: [],
  });
  assert.ok(submitted.submission);
  const accepted = requester.work.review({
    ticketID: ticket.ticketID,
    expectedRevision: submitted.revision,
    submissionID: submitted.submission.submissionID,
    verdict: "accepted",
    comment: "Reviewed",
  });
  const query = {
    ownerID: "respondent",
    requesterID: "owner",
    ownerWithin: "owner",
    requesterWithin: "owner",
    status: "open" as const,
    limit: 2,
  };
  let after = 0;
  for (let i = 0; i < expected.length; i += 2) {
    const page = observer.work.list({ ...query, after });
    assert.deepEqual(page.items, expected.slice(i, i + 2));
    assert.ok(page.after > after);
    after = page.after;
  }
  assert.deepEqual(observer.work.list({ ...query, after }), { items: [], after });
  assert.deepEqual(observer.work.list({ ...query, ownerWithin: "outsider" }).items, []);
  assert.deepEqual(observer.work.list({ ...query, requesterWithin: "outsider" }).items, []);
  assert.deepEqual(observer.work.list({ ownerWithin: "absent", after }), { items: [], after });
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
  const moved = requester.work.update({
    ticketID: first.ticketID,
    expectedRevision: 1,
    ownerID: "outsider",
  });
  assert.deepEqual(observer.work.list({ ...query, after }), { items: [], after });
  const privateMessage = requester.messages.send({
    recipientID: "respondent",
    text: "Private despite organization views",
  });
  assert.throws(
    () => observer.messages.get({ messageID: privateMessage.messageID }),
    rejects("not_found"),
  );
  for (const [id, row] of f.rows)
    if (f.authority.within("outsider", id, "owner")) f.rows.set(id, { ...row, state: "closed" });
  f.reopen();
  assert.deepEqual(f.as("outsider").work.list({ ...query, limit: 100 }).items, expected.slice(1));
  assert.deepEqual(
    f
      .as("outsider")
      .work.list({ ownerWithin: "owner", requesterWithin: "owner", status: "accepted" }).items,
    [accepted],
  );
  assert.deepEqual(f.as("outsider").work.get({ ticketID: first.ticketID }), moved);
  assert.equal(moved.history.length, 2);
  assert.equal(accepted.history.length, 3);
});

test("Form subtree existential predicates stay separate across sparse pages, answers, closure and reopen", (t) => {
  const f = fixture(t);
  const requester = f.as("owner");
  const other = f.as("outsider");
  const observer = f.as("requester");
  const work = observer.work.create({ goal: "Optional context", ownerID: "owner" });
  const fields = [{ name: "answer", label: "Optional", required: false }];
  const first = requester.forms.create({
    workID: work.ticketID,
    respondentIDs: ["owner", "outsider"],
    fields,
  });
  const answeredHere = requester.forms.respond({
    formID: first.formID,
    expectedRevision: 1,
    answers: {},
  });
  const standalone = requester.forms.create({ respondentIDs: ["owner", "outsider"], fields });
  assert.deepEqual(
    observer.forms.list({ respondentWithin: "owner", awaitingWithin: "outsider" }).items,
    [answeredHere, standalone],
  );
  assert.deepEqual(
    observer.forms.list({ awaitingWithin: "owner", awaitingActorID: "outsider" }).items,
    [standalone],
  );
  assert.deepEqual(
    observer.forms.list({ respondentWithin: "outsider", awaitingWithin: "owner" }).items,
    [standalone],
  );
  const closing = requester.forms.create({ respondentIDs: ["outsider"], fields });
  const cancelled = requester.forms.close({
    formID: closing.formID,
    expectedRevision: 1,
    status: "cancelled",
    resolution: "No response required",
  });
  assert.deepEqual(
    observer.forms.list({ respondentWithin: "outsider", status: "cancelled" }).items,
    [cancelled],
  );
  assert.deepEqual(
    observer.forms.list({ awaitingWithin: "outsider", status: "cancelled" }).items,
    [],
  );
  const expected = [answeredHere];
  for (let i = 0; i < 21; i++) {
    const by = i % 3 === 0 ? other : requester;
    const row = by.forms.create({
      workID: work.ticketID,
      respondentIDs: i % 3 === 2 ? ["owner"] : ["owner", "outsider"],
      fields,
    });
    if (i % 3 === 1) expected.push(row);
  }
  const query = {
    workID: work.ticketID,
    requesterID: "owner",
    requesterWithin: "owner",
    respondentID: "owner",
    respondentWithin: "owner",
    awaitingActorID: "outsider",
    awaitingWithin: "outsider",
    status: "open" as const,
    limit: 2,
  };
  let after = 0;
  for (let i = 0; i < expected.length; i += 2) {
    const page = observer.forms.list({ ...query, after });
    assert.deepEqual(page.items, expected.slice(i, i + 2));
    assert.ok(page.after > after);
    after = page.after;
  }
  assert.deepEqual(observer.forms.list({ ...query, after }), { items: [], after });
  for (const criterion of [
    { requesterWithin: "outsider" },
    { respondentWithin: "absent" },
    { awaitingWithin: "absent" },
  ])
    assert.deepEqual(observer.forms.list({ ...query, ...criterion }).items, []);
  assert.throws(
    () => observer.forms.respond({ formID: standalone.formID, expectedRevision: 1, answers: {} }),
    rejects("forbidden"),
  );
  assert.throws(
    () =>
      observer.forms.close({
        formID: standalone.formID,
        expectedRevision: 1,
        status: "resolved",
        resolution: "No role grant",
      }),
    rejects("forbidden"),
  );
  const next = expected[1];
  assert.ok(next);
  const answeredThere = other.forms.respond({
    formID: next.formID,
    expectedRevision: 1,
    answers: {},
  });
  const resolved = requester.forms.close({
    formID: first.formID,
    expectedRevision: answeredHere.revision,
    status: "resolved",
    resolution: "Recorded",
  });
  assert.deepEqual(observer.forms.list({ ...query, after }), { items: [], after });
  for (const [id, row] of f.rows)
    if (id !== "requester") f.rows.set(id, { ...row, state: "closed" });
  f.reopen();
  assert.deepEqual(f.as("requester").forms.list({ ...query, limit: 100 }).items, expected.slice(2));
  assert.deepEqual(f.as("requester").forms.get({ formID: next.formID }), answeredThere);
  assert.equal(answeredThere.history.length, 2);
  assert.equal(resolved.history.length, 3);
  assert.equal(f.as("requester").work.get({ ticketID: work.ticketID }).revision, 1);
  assert.throws(
    () => f.as("outsider").forms.list({ awaitingWithin: "owner" }),
    rejects("forbidden"),
  );
});

test("self-review is an explicit requester call with actual reviewer identity", (t) => {
  const f = fixture(t);
  const client = f.as("requester");
  const ticket = client.work.create({ goal: "Self-owned work", ownerID: "requester" });
  const submitted = client.work.submit({
    ticketID: ticket.ticketID,
    expectedRevision: 1,
    result: "Done",
    evidence: [],
  });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.review, undefined);
  assert.ok(submitted.submission);
  const reviewed = client.work.review({
    ticketID: ticket.ticketID,
    expectedRevision: submitted.revision,
    submissionID: submitted.submission.submissionID,
    verdict: "accepted",
    comment: "Requester self-review",
  });
  assert.equal(reviewed.review?.reviewerID, "requester");
  assert.equal(reviewed.submission?.ownerID, "requester");
  assert.equal(reviewed.history.at(-1)?.actorID, "requester");
});

test("canonical visibility, active callers and retained reads after counterparty closure", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ goal: "Retain history", ownerID: "owner" });
  const message = f.as("owner").messages.send({ recipientID: "requester", text: "Retain me" });
  const owner = f.rows.get("owner");
  assert.ok(owner);
  f.rows.set("owner", { ...owner, state: "closed" });
  assert.equal(f.as("requester").work.get({ ticketID: ticket.ticketID }).ownerID, "owner");
  assert.equal(f.as("requester").messages.get({ messageID: message.messageID }).text, "Retain me");
  assert.equal(f.as("requester").actors.get({ actorID: "owner" }).state, "closed");
  assert.throws(() => f.as("owner").work.list(), rejects("forbidden"));
  assert.throws(() => f.as("owner").actors.get(), rejects("forbidden"));
  assert.throws(
    () => f.as("requester").messages.send({ recipientID: "owner", text: "Closed target" }),
    rejects("invalid_input"),
  );
  assert.deepEqual(f.as("outsider").work.get({ ticketID: ticket.ticketID }), ticket);
  const contextMessage = f.as("outsider").messages.send({
    recipientID: "requester",
    text: "Shared Work context",
    workID: ticket.ticketID,
  });
  assert.throws(
    () => f.as("respondent").messages.get({ messageID: contextMessage.messageID }),
    rejects("not_found"),
  );
  const form = f.as("requester").forms.create({
    respondentIDs: ["respondent"],
    fields: [{ name: "x", label: "Open question", required: false }],
  });
  for (const read of [
    () => f.as("owner").work.get({ ticketID: ticket.ticketID }),
    () => f.as("owner").forms.get({ formID: form.formID }),
    () => f.as("owner").forms.list({ awaitingActorID: "respondent" }),
  ])
    assert.throws(read, rejects("forbidden"));
  const restricted = bindWorkspace(
    {
      get: (caller, id) => (caller === id ? f.rows.get(id) : undefined),
      list: (caller) => ({
        items: [f.rows.get(caller)].filter(
          (row): row is NonNullable<typeof row> => row !== undefined,
        ),
        after: 1,
      }),
      within: f.authority.within,
    },
    f.store,
    "requester",
  );
  assert.deepEqual(
    restricted.actors.list().items.map((row) => row.actorID),
    ["requester"],
  );
  assert.throws(() => restricted.actors.get({ actorID: "respondent" }), rejects("not_found"));
  assert.deepEqual(restricted.work.list({ ownerID: "owner", requesterID: "requester" }).items, [
    ticket,
  ]);
  assert.deepEqual(restricted.forms.list({ awaitingActorID: "respondent" }).items, [form]);
  assert.deepEqual(restricted.forms.list({ awaitingActorID: "unknown" }).items, []);
});
