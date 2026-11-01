import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
import { createActors } from "../src/actors/index.js";
import {
  ActorContracts,
  FormContracts,
  MessageContracts,
  WorkContracts,
  WorkspaceError,
} from "../src/contracts/index.js";
import { createForms } from "../src/forms/index.js";
import { bindWorkspace } from "../src/index.js";
import { openSqlite } from "../src/persistence/index.js";

const rejects = (code: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === code;
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
      assert.equal(requester.messages.list().items.length, 0);
      assert.equal(requester.forms.list().items.length, 0);
      const message = requester.messages.send({ recipientID: "owner", text: "Inspect this work" });
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
      assert.equal(response.history, undefined);
      assert.deepEqual(
        respondent.forms
          .get({ formID: form.formID, history: true })
          .history?.filter((e) => e.action === "responded")
          .map((e) => e.detail.answers),
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
      const history =
        f.as("requester").work.get({ ticketID: ticket.ticketID, history: true }).history ?? [];
      assert.equal(history.filter((e) => e.action === "submitted").length, 2);
      assert.equal(history.filter((e) => e.action === "reviewed").length, 2);
      assert.deepEqual(f.as("owner").messages.get({ messageID: message.messageID }), message);
      assert.deepEqual(f.as("respondent").forms.get({ formID: form.formID }), closed);
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
  assert.equal(requester.messages.list().items.length, 0);
  assert.equal(requester.work.list().items.length, 0);
  const direct = requester.messages.send({ recipientID: "owner", text: prose });
  assert.equal(
    owner.messages.list({ direction: "incoming" }).items[0]?.messageID,
    direct.messageID,
  );
  assert.equal(owner.messages.list({ direction: "outgoing" }).items.length, 0);
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
  const ticket = requester.work.create({ title: "Optional linked context", ownerID: "owner" });
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
  assert.equal(f.as("owner").forms.get({ formID: form.formID, history: true }).history?.length, 2);
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
  assert.throws(() => f.as("owner").forms.list({ after: owned }), rejects("invalid_input"));
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
    .messages.list({ direction: "incoming", after: next(inbox1), limit: 3 });
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
  assert.equal(forms1.items.length, 1);
  f.as("owner").forms.respond({
    formID: forms[0]?.formID ?? "",
    expectedRevision: 1,
    answers: { x: "answered" },
  });
  f.reopen();
  assert.deepEqual(
    f
      .as("owner")
      .forms.list({ respondentID: "owner", after: next(forms1) })
      .items.map((row) => row.formID),
    [forms[1]?.formID, forms[0]?.formID],
  );
  assert.throws(() => f.as("owner").forms.list({ after: 999 } as never), rejects("invalid_input"));
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
  assert.deepEqual(observer.work.get({ ticketID: first.ticketID }), first);
  const workFilters = {
    ownerID: "owner",
    requesterID: "requester",
    status: ["open" as const],
    limit: 1,
  };
  const page = observer.work.list(workFilters);
  assert.deepEqual(page.items, [first]);
  const following = observer.work.list({ ...workFilters, after: next(page) });
  assert.deepEqual(following, {
    items: [second],
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
    status: ["open" as const],
    awaitingActorID: "owner",
    limit: 1,
  };
  const forms1 = observer.forms.list(formFilters);
  assert.deepEqual(forms1.items, [revised]);
  const forms2 = observer.forms.list({ ...formFilters, after: next(forms1) });
  assert.deepEqual(forms2.items, [last]);
  assert.equal(forms2.next, null);
  assert.deepEqual(observer.forms.list({ status: ["cancelled"] }).items, [closed]);
  assert.deepEqual(
    observer.forms.list({ status: ["cancelled"], awaitingActorID: "owner" }).items,
    [],
  );
  assert.deepEqual(observer.forms.list({ respondentID: "absent" }), {
    items: [],
    next: null,
    actors: {},
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
    status: ["open" as const],
    limit: 2,
  };
  let after: string | undefined;
  for (let i = 0; i < expected.length; i += 2) {
    const page = observer.work.list({ ...query, ...(after === undefined ? {} : { after }) });
    assert.deepEqual(page.items, expected.slice(i, i + 2));
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
  const moved = requester.work.update({
    ticketID: first.ticketID,
    expectedRevision: 1,
    ownerID: "outsider",
  });
  assert.deepEqual(observer.work.list({ ...query, updatedSince: moved.updatedAt }).items, []);
  assert.deepEqual(
    observer.work.list({ ownerID: "outsider", updatedSince: moved.updatedAt }).items,
    [moved],
  );
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
      .work.list({ ownerWithin: "owner", requesterWithin: "owner", status: ["accepted"] }).items,
    [accepted],
  );
  assert.deepEqual(f.as("outsider").work.get({ ticketID: first.ticketID }), moved);
  assert.equal(moved.history, undefined);
  const histories = [first, accepted].map(
    ({ ticketID }) => f.as("outsider").work.get({ ticketID, history: true }).history?.length,
  );
  assert.deepEqual(histories, [2, 3]);
});

test("Form subtree existential predicates stay separate across sparse pages, answers, closure and reopen", (t) => {
  const f = fixture(t);
  const requester = f.as("owner");
  const other = f.as("outsider");
  const observer = f.as("requester");
  const work = observer.work.create({ title: "Optional context", ownerID: "owner" });
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
    observer.forms.list({ respondentWithin: "outsider", status: ["cancelled"] }).items,
    [cancelled],
  );
  assert.deepEqual(
    observer.forms.list({ awaitingWithin: "outsider", status: ["cancelled"] }).items,
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
    status: ["open" as const],
    limit: 2,
  };
  let after: string | undefined;
  for (let i = 0; i < expected.length; i += 2) {
    const page = observer.forms.list({ ...query, ...(after === undefined ? {} : { after }) });
    assert.deepEqual(page.items, expected.slice(i, i + 2));
    assert.equal(page.next === null, i + 2 >= expected.length);
    after = page.next ?? undefined;
  }
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
  assert.deepEqual(observer.forms.list({ ...query, updatedSince: resolved.updatedAt }).items, []);
  for (const [id, row] of f.rows)
    if (id !== "requester") f.rows.set(id, { ...row, state: "closed" });
  f.reopen();
  assert.deepEqual(f.as("requester").forms.list({ ...query, limit: 100 }).items, expected.slice(2));
  assert.deepEqual(f.as("requester").forms.get({ formID: next.formID }), answeredThere);
  const histories = [answeredThere, resolved].map(
    ({ formID }) => f.as("requester").forms.get({ formID, history: true }).history?.length,
  );
  assert.deepEqual(histories, [2, 3]);
  assert.equal(f.as("requester").work.get({ ticketID: work.ticketID }).revision, 1);
  assert.throws(
    () => f.as("outsider").forms.list({ awaitingWithin: "owner" }),
    rejects("forbidden"),
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
  const waiting = agent.work.update({
    ticketID: ticket.ticketID,
    title: "Cut the 0.5 release",
    progress: "Tagged.\n\n1. Pack\n2. Pin",
    status: "active",
    links: [link],
    waitsOn: { ticketID: blocker.ticketID },
  });
  assert.equal(waiting.revision, 2);
  assert.deepEqual(waiting.waitsOn, { ticketID: blocker.ticketID });
  for (const waitsOn of [{ actorID: "requester" }, { text: "3 PRs in CI" }])
    assert.deepEqual(agent.work.update({ ticketID: ticket.ticketID, waitsOn }).waitsOn, waitsOn);
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
    items: [ticket],
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
  const regoal = manager.work.update({
    ticketID: ticket.ticketID,
    expectedRevision: 1,
    goal: "Ship it twice",
  });
  const first = report.work.submit({ ticketID: ticket.ticketID, result: "Shipped" });
  assert.equal(first.status, "submitted");
  assert.equal(first.completedAt, undefined);
  assert.ok(first.submission);
  assert.throws(
    () =>
      manager.work.review({
        ticketID: ticket.ticketID,
        submissionID: first.submission?.submissionID ?? "",
        verdict: "changes_requested",
      }),
    rejects("invalid_input"),
  );
  const changes = manager.work.review({
    ticketID: ticket.ticketID,
    submissionID: first.submission.submissionID,
    verdict: "changes_requested",
    comment: "Once more",
  });
  assert.equal(changes.completedAt, undefined);
  const second = report.work.submit({
    ticketID: ticket.ticketID,
    expectedRevision: changes.revision,
    result: "Shipped twice",
  });
  assert.throws(
    () =>
      manager.work.review({
        ticketID: ticket.ticketID,
        submissionID: first.submission?.submissionID ?? "",
        verdict: "accepted",
      }),
    rejects("conflict"),
  );
  const accepted = manager.work.review({
    ticketID: ticket.ticketID,
    submissionID: second.submission?.submissionID ?? "",
    verdict: "accepted",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.goal, regoal.goal);
  assert.equal(accepted.completedAt, accepted.review?.at);
  assert.equal(Object.hasOwn(accepted.review ?? {}, "comment"), false);
  assert.equal(accepted.review?.reviewerID, "requester");
});

test("canonical visibility, active callers and retained reads after counterparty closure", (t) => {
  const f = fixture(t);
  const ticket = f.as("requester").work.create({ title: "Retain history", ownerID: "owner" });
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
    text: `Shared Work context: ${ticket.ticketID}`,
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

test("lists name their Actors, go newest first and select by update time and several requesters", (t) => {
  const f = fixture(t);
  const created = ["requester", "outsider", "owner"].map((by, i) =>
    f.as(by).work.create({ title: `Work ${i}`, ownerID: "respondent" }),
  );
  const [first, second, third] = created;
  assert.ok(first && second && third);
  assert.ok(first.updatedAt <= third.updatedAt);
  assert.equal(Object.hasOwn(first, "cursor"), false);
  const moved = f.as("respondent").work.update({
    ticketID: first.ticketID,
    expectedRevision: 1,
    status: "active",
  });
  assert.ok(moved.updatedAt >= first.updatedAt);
  const reader = f.as("outsider");
  const recent = reader.work.list({ order: "recent", limit: 2 });
  assert.deepEqual(recent.items, [moved, third]);
  assert.deepEqual(reader.work.list({ order: "recent", after: next(recent) }), {
    items: [second],
    next: null,
    actors: { outsider: { name: "Outsider" }, respondent: { name: "Respondent" } },
  });
  assert.deepEqual(reader.work.list({ requesterID: ["requester", "owner"] }).items, [third, moved]);
  assert.deepEqual(reader.work.list({ requesterID: "outsider" }).items, [second]);
  assert.deepEqual(reader.work.list({ status: ["open", "active"] }).items.length, 3);
  assert.deepEqual(reader.work.list({ updatedSince: moved.updatedAt }).items.at(-1), moved);
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
  const form = f.as("requester").forms.create({
    respondentIDs: ["owner"],
    fields: [{ name: "x", label: "Answer?", required: false }],
  });
  const answered = f.as("owner").forms.respond({
    formID: form.formID,
    expectedRevision: 1,
    answers: {},
  });
  assert.ok(answered.updatedAt >= form.updatedAt);
  assert.deepEqual(reader.forms.list({ order: "recent", requesterID: ["requester"] }), {
    items: [answered],
    next: null,
    actors: { owner: { name: "Owner" }, requester: { name: "Requester" } },
  });
});

test("every contract carries the level that presents it", () => {
  const levels = Object.fromEntries(
    Object.entries({
      ...ActorContracts,
      ...MessageContracts,
      ...WorkContracts,
      ...FormContracts,
    }).map(([name, spec]) => [name, spec.level]),
  );
  assert.deepEqual(levels, {
    actor_get: "team",
    actor_list: "team",
    message_send: "team",
    message_get: "team",
    message_list: "team",
    work_create: "report",
    work_get: "report",
    work_list: "report",
    work_update: "report",
    work_submit: "report",
    work_review: "team",
    form_create: "report",
    form_get: "report",
    form_list: "report",
    form_respond: "team",
    form_close: "report",
  });
});
