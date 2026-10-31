import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
import { WorkspaceError } from "../src/contracts/index.js";
import { createForms } from "../src/forms/index.js";
import { bindWorkspace } from "../src/index.js";
import { openSqlite } from "../src/persistence/index.js";

const rejects = (code: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === code;
function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "workspace-domain-"));
  const file = join(dir, "records.sqlite");
  const { authority, rows } = fixtureAuthority();
  let store = openSqlite(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    rows,
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
      assert.throws(() => respondent.work.get({ ticketID: ticket.ticketID }), rejects("not_found"));
      assert.throws(
        () =>
          requester.forms.respond({
            formID: form.formID,
            expectedRevision: 1,
            answers: { decision: "yes" },
          }),
        rejects("forbidden"),
      );
      assert.throws(() => outsider.forms.get({ formID: form.formID }), rejects("not_found"));
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

test("standalone forms never consult Work; linked forms retain validation and current-party visibility", (t) => {
  const f = fixture(t);
  const requester = f.as("requester");
  const owner = f.as("owner");
  const outsider = f.as("outsider");
  const withoutWork = createForms(requester.actors, f.store);
  const trap = { get: () => assert.fail("standalone Form consulted Work") };
  const directed = createForms(owner.actors, f.store, trap);
  const hidden = createForms(outsider.actors, f.store, trap);
  const input = {
    respondentIDs: ["owner"],
    fields: [{ name: "answer", label: "Which option?", required: true }],
  };
  const form = createForms(requester.actors, f.store, trap).create(input);
  assert.deepEqual(directed.get({ formID: form.formID }), form);
  assert.deepEqual(directed.list().items, [form]);
  assert.deepEqual(hidden.list().items, []);
  assert.throws(() => hidden.get({ formID: form.formID }), rejects("not_found"));
  assert.throws(
    () => withoutWork.create({ ...input, respondentIDs: ["absent"] }),
    rejects("not_found"),
  );
  const ticket = requester.work.create({ goal: "Optional linked context", ownerID: "owner" });
  assert.throws(
    () => withoutWork.create({ ...input, workID: ticket.ticketID }),
    rejects("invalid_input"),
  );
  assert.throws(
    () => outsider.forms.create({ ...input, workID: ticket.ticketID }),
    rejects("not_found"),
  );
  const linked = requester.forms.create({
    ...input,
    respondentIDs: ["respondent"],
    workID: ticket.ticketID,
  });
  assert.equal(owner.forms.get({ formID: linked.formID }).workID, ticket.ticketID);
  requester.work.update({ ticketID: ticket.ticketID, expectedRevision: 1, ownerID: "outsider" });
  assert.throws(() => owner.forms.get({ formID: linked.formID }), rejects("not_found"));
  assert.deepEqual(
    owner.forms.list().items.map((row) => row.formID),
    [form.formID],
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

test("multi-page scoped upserts, duplicate updated rows and disappearing scope survive reopen", (t) => {
  const f = fixture(t);
  const request = f.as("requester");
  const hidden = f
    .as("outsider")
    .work.create({ goal: "Outside the caller scope", ownerID: "outsider" });
  const first = request.work.create({ goal: "First", ownerID: "owner" });
  const second = request.work.create({ goal: "Second", ownerID: "owner" });
  const third = request.work.create({ goal: "Third", ownerID: "owner" });
  const page1 = f.as("owner").work.list({ limit: 1 });
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
  const page2 = f.as("owner").work.list({ after: page1.after, limit: 2 });
  assert.deepEqual(
    page2.items.map((row) => row.ticketID),
    [second.ticketID, third.ticketID],
  );
  const page3 = f.as("owner").work.list({ after: page2.after, limit: 1 });
  assert.deepEqual(
    page3.items.map((row) => row.ticketID),
    [first.ticketID],
  );
  const scoped = f.as("owner").work.list({ status: "open" });
  f.as("owner").work.update({ ticketID: second.ticketID, expectedRevision: 1, status: "active" });
  f.as("requester").work.update({
    ticketID: third.ticketID,
    expectedRevision: 1,
    ownerID: "respondent",
  });
  assert.deepEqual(f.as("owner").work.list({ after: scoped.after, status: "open" }).items, []);
  assert.deepEqual(
    f
      .as("owner")
      .work.list({ status: "open" })
      .items.map((row) => row.ticketID),
    [first.ticketID],
  );
  assert.equal(f.as("respondent").work.list().items[0]?.ticketID, third.ticketID);
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
    fields: [{ name: "x", label: "Private question", required: true }],
  });
  const forms = [first, second].map((ticket) =>
    f.as("requester").forms.create({
      workID: ticket.ticketID,
      respondentIDs: ["owner"],
      fields: [{ name: "x", label: "Answer?", required: true }],
    }),
  );
  const forms1 = f.as("owner").forms.list({ limit: 1 });
  f.as("owner").forms.respond({
    formID: forms[0]?.formID ?? "",
    expectedRevision: 1,
    answers: { x: "answered" },
  });
  f.reopen();
  assert.deepEqual(
    f
      .as("owner")
      .forms.list({ after: forms1.after })
      .items.map((row) => row.formID),
    [forms[1]?.formID, forms[0]?.formID],
  );
  assert.throws(() => f.as("owner").forms.list({ after: 999 }), rejects("invalid_input"));
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
  assert.throws(
    () => f.as("outsider").work.get({ ticketID: ticket.ticketID }),
    rejects("not_found"),
  );
  assert.throws(
    () =>
      f.as("outsider").messages.send({
        recipientID: "requester",
        text: "Private reference",
        workID: ticket.ticketID,
      }),
    rejects("not_found"),
  );
  const restricted = bindWorkspace(
    {
      get: (caller, id) => (caller === id ? f.rows.get(id) : undefined),
      list: (caller) => ({
        items: [f.rows.get(caller)].filter(
          (row): row is NonNullable<typeof row> => row !== undefined,
        ),
        after: 1,
      }),
    },
    f.store,
    "requester",
  );
  assert.deepEqual(
    restricted.actors.list().items.map((row) => row.actorID),
    ["requester"],
  );
  assert.throws(() => restricted.actors.get({ actorID: "respondent" }), rejects("not_found"));
});
