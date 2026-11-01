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
  const self = f.as("owner").send({ recipientID: "owner", text: "Self" });
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
  assert.equal(new Set([asked, other, self].map((m) => m.conversationID)).size, 3);
  for (const id of ["owner", "requester"]) assert.ok(!asked.conversationID.includes(id));
  assert.deepEqual(
    [asked, answered, other, self].map((m) => m.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(f.as("requester").get({ messageID: answered.messageID }), answered);
  assert.throws(
    () => f.as("outsider").get({ messageID: asked.messageID }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
  );
  for (const [direction, items] of [
    ["all", [asked, answered, other, self]],
    ["incoming", [asked, self]],
    ["outgoing", [answered, other, self]],
  ] as const)
    assert.deepEqual(f.as("owner").list({ direction }), {
      items,
      next: null,
      older: null,
      actors: {
        owner: { name: "Owner" },
        requester: { name: "Requester" },
        ...(direction === "incoming" ? {} : { outsider: { name: "Outsider" } }),
      },
    });
  for (const input of [
    { recipientID: "owner", text: "Linked", workID: "ticket" },
    { recipientID: "owner", text: "Threaded", conversationID: asked.conversationID },
  ])
    assert.equal(MessageContracts.message_send.input.safeParse(input).success, false);
  for (const input of [
    { after: -1 },
    { after: 0.5 },
    { after: "" },
    { before: 1 },
    { before: "LATEST" },
    { before: "latest", after: 0 },
    { limit: 0 },
    { limit: 101 },
    { direction: "bad" },
    { senderID: "other" },
  ])
    assert.throws(() => f.as("owner").list(input as never), invalid);
  assert.throws(() => f.as("owner").list({ after: f.store.messages.head() + 1 }), invalid);
  f.reopen();
  assert.deepEqual(f.as("owner").get({ messageID: self.messageID }), self);
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
    { ...conversation, direction: "incoming" as const, before: token(initial.older) },
  ])
    assert.throws(() => f.as("owner").list(misuse), invalid);
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

test("the input read spans conversations, and latest needs no counterparty", (t) => {
  const f = fixture(t);
  f.as("requester").send({ recipientID: "owner", text: "Before attaching" });
  const seen = f.as("outsider").send({ recipientID: "owner", text: "Last before attaching" });
  f.as("owner").send({ recipientID: "requester", text: "Outgoing" });
  const attach = f.as("owner").list({ direction: "incoming", before: "latest", limit: 1 });
  assert.deepEqual(attach.items, [seen]);
  const later = [
    f.as("requester").send({ recipientID: "owner", text: "First after" }),
    f.as("respondent").send({ recipientID: "owner", text: "Second after" }),
  ];
  f.as("owner").send({ recipientID: "respondent", text: "Own send" });
  const inbox = f.as("owner").list({ direction: "incoming", after: seen.seq });
  assert.deepEqual(inbox.items, later);
  assert.deepEqual(Object.keys(inbox.actors).sort(), ["owner", "requester", "respondent"]);
  assert.notEqual(later[0]?.conversationID, later[1]?.conversationID);
  assert.deepEqual(
    f
      .as("owner")
      .list({ before: "latest", limit: 2 })
      .items.map((m) => m.text),
    ["Second after", "Own send"],
  );
});

test("conversation reads keep self, direction and privacy, and closed peers' history", (t) => {
  const f = fixture(t);
  const incoming = f.as("requester").send({ recipientID: "owner", text: "Incoming" });
  const outgoing = f.as("owner").send({ recipientID: "requester", text: "Outgoing" });
  const self = f.as("owner").send({ recipientID: "owner", text: "Self once" });
  const reader = createMessages(createActors(f.authority, "owner"), f.store);
  const closed = f.rows.get("requester");
  assert.ok(closed);
  f.rows.set("requester", { ...closed, state: "closed" });
  for (const [direction, items] of [
    ["all", [incoming, outgoing]],
    ["incoming", [incoming]],
    ["outgoing", [outgoing]],
  ] as const)
    assert.deepEqual(
      reader.list({ counterpartyID: " requester ", direction, before: "latest" }).items,
      items,
    );
  for (const direction of ["all", "incoming", "outgoing"] as const)
    assert.deepEqual(reader.list({ counterpartyID: "owner", direction, before: "latest" }).items, [
      self,
    ]);
  assert.deepEqual(reader.list({ counterpartyID: "unknown", before: "latest" }), {
    items: [],
    next: null,
    older: null,
    actors: {},
  });
  assert.deepEqual(
    f.as("outsider").list({ counterpartyID: "requester", before: "latest" }).items,
    [],
  );
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
  assert.deepEqual(f.as("owner").list({ counterpartyID: "requester", after: first.seq }).items, [
    appended,
  ]);
});
