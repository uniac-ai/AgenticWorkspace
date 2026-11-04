import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureAuthority } from "../examples/authority.js";
import { createActors } from "../src/actors/index.js";
import { type Message, MessageContracts, WorkspaceError } from "../src/contracts/index.js";
import { createMessages } from "../src/messages/index.js";
import { openSqlite } from "../src/persistence/index.js";

const invalid = (error: unknown) =>
  error instanceof WorkspaceError && error.code === "invalid_input";
function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "workspace-message-query-"));
  const file = join(dir, "messages.sqlite");
  const canonical = fixtureAuthority();
  let store = openSqlite(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ...canonical,
    get store() {
      return store;
    },
    as: (id: string) => createMessages(createActors(canonical.authority, id), store),
    reopen() {
      store.close();
      store = openSqlite(file);
    },
  };
}
function token(value: string | null): string {
  assert.ok(value);
  return value;
}

test("a Message is immutable, in its pair's conversation and the one commit order", (t) => {
  const f = fixture(t);
  const asked = f.as("requester").send({ recipientID: "owner", text: "Question" });
  const answered = f.as("owner").send({ recipientID: "requester", text: "Answer" });
  const other = f.as("owner").send({ recipientID: "outsider", text: "Other pair" });
  assert.deepEqual(Object.keys(asked), [
    "messageID",
    "conversationID",
    "senderID",
    "recipientID",
    "text",
    "createdAt",
    "seq",
  ]);
  assert.equal(asked.conversationID, answered.conversationID);
  assert.notEqual(asked.conversationID, other.conversationID);
  for (const id of ["owner", "requester"]) assert.ok(!asked.conversationID.includes(id));
  assert.deepEqual(
    [asked, answered, other].map((m) => m.seq),
    [1, 2, 3],
  );
  assert.deepEqual(f.as("requester").get({ messageID: answered.messageID }), answered);
  assert.deepEqual(f.as("outsider").get({ messageID: asked.messageID }), asked);
  for (const recipientID of ["owner", " owner "])
    assert.throws(() => f.as("owner").send({ recipientID, text: "Self" }), invalid);
  assert.deepEqual(f.as("respondent").list({ of: "owner" }), {
    items: [other, answered],
    next: null,
    older: null,
    actors: {
      owner: { name: "Owner" },
      requester: { name: "Requester" },
      outsider: { name: "Outsider" },
    },
  });
  for (const input of [
    { recipientID: "owner", text: "Linked", workID: "ticket" },
    { recipientID: "owner", text: "Threaded", conversationID: asked.conversationID },
  ])
    assert.equal(MessageContracts.message_send.input.safeParse(input).success, false);
  const pair = { counterpartyID: "requester" };
  for (const input of [
    {},
    { before: "latest" },
    { ...pair, direction: "incoming" },
    { ...pair, of: "owner" },
    { ...pair, between: ["owner", "requester"] },
    { between: ["owner"] },
    { between: ["owner", "requester", "outsider"] },
    { of: "owner", before: "latest" },
    { of: "owner", after: 1 },
    { ...pair, after: -1 },
    { ...pair, after: 0.5 },
    { ...pair, after: "" },
    { ...pair, before: 1 },
    { ...pair, before: "LATEST" },
    { ...pair, before: "latest", after: 0 },
    { ...pair, limit: 0 },
    { ...pair, limit: 101 },
    { ...pair, senderID: "other" },
  ])
    assert.throws(() => f.as("owner").list(input as never), invalid);
  assert.throws(() => f.as("owner").list({ ...pair, after: f.store.messages.head() + 1 }), invalid);
  f.reopen();
  assert.deepEqual(f.as("owner").get({ messageID: other.messageID }), other);
});

test("a conversation pages from latest to its start and forward from a token or a seq", (t) => {
  const f = fixture(t);
  const peer: Message[] = [];
  for (let i = 0; i < 251; i++) {
    f.as("owner").send({ recipientID: "outsider", text: `Other peer ${i}` });
    f.as("respondent").send({ recipientID: "outsider", text: `Foreign ${i}` });
    peer.push(
      (i % 2 === 0 ? f.as("requester") : f.as("owner")).send({
        recipientID: i % 2 === 0 ? "owner" : "requester",
        text: `Peer ${i}`,
      }),
    );
  }
  const conversation = { counterpartyID: "requester" };
  const initial = f.as("owner").list({ ...conversation, before: "latest", limit: 100 });
  assert.deepEqual(initial.items, peer.slice(-100));
  assert.equal(initial.next, null);
  const all = [...initial.items];
  let older = initial.older;
  for (const expected of [peer.slice(51, 151), peer.slice(0, 51)]) {
    const page = f.as("owner").list({ ...conversation, before: token(older), limit: 100 });
    assert.deepEqual(page.items, expected);
    assert.ok(page.next);
    all.unshift(...page.items);
    older = page.older;
  }
  assert.equal(older, null);
  assert.deepEqual(all, peer);
  for (const misuse of [
    { ...conversation, after: token(initial.older) },
    { counterpartyID: "outsider", before: token(initial.older) },
    { of: "owner", after: token(initial.older) },
  ])
    assert.throws(() => f.as("owner").list(misuse), invalid);
  const between = { between: ["requester", "owner"], before: token(initial.older), limit: 100 };
  assert.deepEqual(f.as("outsider").list(between).items, peer.slice(51, 151));
  const ahead = f.as("owner").list({ ...conversation, after: 0, limit: 1 });
  assert.deepEqual(
    f.as("outsider").list({ between: ["owner", "requester"], after: token(ahead.next), limit: 1 })
      .items,
    peer.slice(1, 2),
  );
  const gap = f.as("requester").send({ recipientID: "owner", text: "Unseen inbound" });
  const own = f.as("owner").send({ recipientID: "requester", text: "Own reply" });
  const position = initial.items.at(-1)?.seq ?? 0;
  const forward = f.as("owner").list({ ...conversation, after: position, limit: 1 });
  assert.deepEqual(forward.items, [gap]);
  assert.deepEqual(f.as("owner").list({ ...conversation, after: token(forward.next) }).items, [
    own,
  ]);
  assert.deepEqual(f.as("owner").list({ ...conversation, after: own.seq }).items, []);
  f.reopen();
  assert.deepEqual(f.as("owner").list({ ...conversation, before: "latest", limit: 2 }).items, [
    gap,
    own,
  ]);
});

test("an Actor's conversations come newest first, each as its latest message", (t) => {
  const f = fixture(t);
  f.as("requester").send({ recipientID: "owner", text: "First pair, first" });
  const second = f.as("outsider").send({ recipientID: "owner", text: "Second pair" });
  const third = f.as("owner").send({ recipientID: "respondent", text: "Third pair" });
  f.as("requester").send({ recipientID: "outsider", text: "Not the owner's" });
  const first = f.as("owner").send({ recipientID: "requester", text: "First pair, latest" });
  const page = f.as("respondent").list({ of: "owner", limit: 2 });
  assert.deepEqual(page.items, [first, third]);
  assert.equal(page.older, null);
  const rest = f.as("respondent").list({ of: "owner", after: token(page.next), limit: 2 });
  assert.deepEqual(rest.items, [second]);
  assert.equal(rest.next, null);
  assert.deepEqual(Object.keys(rest.actors).sort(), ["outsider", "owner"]);
  // A conversation that gets a message between page reads moves ahead of the pages already read.
  const moved = f.as("outsider").send({ recipientID: "owner", text: "Second pair, again" });
  assert.deepEqual(
    f.as("respondent").list({ of: "owner", after: token(page.next), limit: 2 }).items,
    [],
  );
  assert.deepEqual(f.as("owner").list({ of: "owner" }).items, [moved, first, third]);
  assert.deepEqual(f.as("owner").list({ of: "absent" }).items, []);
  assert.throws(() => f.as("owner").list({ of: "requester", after: token(page.next) }), invalid);
});

test("conversations are open to every Actor, keep 0.5 self messages and closed peers' history", (t) => {
  const f = fixture(t);
  const incoming = f.as("requester").send({ recipientID: "owner", text: "Incoming" });
  const outgoing = f.as("owner").send({ recipientID: "requester", text: "Outgoing" });
  const at = new Date().toISOString();
  const state = {
    messageID: "self",
    senderID: "owner",
    recipientID: "owner",
    text: "Self",
    createdAt: at,
  };
  f.store.transaction(() =>
    f.store.messages.save("self", state, { actorID: "owner", at, action: "sent", detail: {} }),
  );
  const self = f.as("owner").get({ messageID: "self" });
  const reader = createMessages(createActors(f.authority, "owner"), f.store);
  const closed = f.rows.get("requester");
  assert.ok(closed);
  f.rows.set("requester", { ...closed, state: "closed" });
  assert.deepEqual(reader.list({ counterpartyID: " requester ", before: "latest" }).items, [
    incoming,
    outgoing,
  ]);
  for (const between of [
    ["owner", "requester"],
    ["requester", "owner"],
  ])
    assert.deepEqual(f.as("outsider").list({ between, before: "latest" }).items, [
      incoming,
      outgoing,
    ]);
  assert.deepEqual(reader.list({ counterpartyID: "owner", before: "latest" }).items, [self]);
  assert.deepEqual(f.as("outsider").list({ between: ["owner", "owner"] }).items, [self]);
  assert.deepEqual(f.as("outsider").list({ of: "owner" }).items, [self, outgoing]);
  assert.deepEqual(reader.list({ counterpartyID: "unknown", before: "latest" }), {
    items: [],
    next: null,
    older: null,
    actors: {},
  });
  assert.throws(
    () => f.as("owner").send({ recipientID: "requester", text: "Closed recipient" }),
    invalid,
  );
  const caller = f.rows.get("owner");
  assert.ok(caller);
  f.rows.set("owner", { ...caller, state: "closed" });
  assert.throws(
    () => reader.list({ counterpartyID: "requester", before: "latest" }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
  );
});

test("a latest window captures the head once across appends", (t) => {
  const f = fixture(t);
  const first = f.as("requester").send({ recipientID: "owner", text: "Before head" });
  let headCalls = 0;
  let appended: Message | undefined;
  const recent = createMessages(createActors(f.authority, "owner"), {
    transaction: f.store.transaction,
    messages: {
      ...f.store.messages,
      head() {
        headCalls++;
        const head = f.store.messages.head();
        appended = f.as("requester").send({ recipientID: "owner", text: "After observed head" });
        return head;
      },
    },
  });
  const window = recent.list({ counterpartyID: "requester", before: "latest" });
  assert.deepEqual(window.items, [first]);
  assert.equal(window.next, null);
  assert.equal(headCalls, 1);
  assert.ok(appended);
  const observed = appended;
  assert.deepEqual(f.as("owner").list({ counterpartyID: "requester", after: first.seq }).items, [
    observed,
  ]);
  const listed = recent.list({ of: "owner" });
  assert.equal(headCalls, 2);
  assert.deepEqual(listed.items, [observed]);
  assert.deepEqual(f.as("owner").list({ of: "owner" }).items, [appended]);
});
