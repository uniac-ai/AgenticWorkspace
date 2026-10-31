import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { fixtureAuthority } from "../examples/authority.js";
import { createActors } from "../src/actors/index.js";
import { MessageContracts, WorkspaceError } from "../src/contracts/index.js";
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

test("legacy Message requests normalize and serialize identically, including forward empty/refusal/reopen", (t) => {
  // Frozen 0.3 literals are independent of candidate defaults and query helpers.
  const legacy = z.strictObject({
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
    direction: z.enum(["incoming", "outgoing", "all"]).default("all"),
  });
  for (const input of [
    {},
    { after: 0 },
    { limit: 1 },
    ...["incoming", "outgoing", "all"].map((direction) => ({ after: 2, limit: 100, direction })),
  ])
    assert.equal(
      JSON.stringify(MessageContracts.message_list.input.parse(input)),
      JSON.stringify(legacy.parse(input)),
    );
  for (const input of [
    { after: -1 },
    { after: 0.5 },
    { after: "0" },
    { limit: 0 },
    { limit: 101 },
    { direction: "bad" },
    { senderID: "other" },
  ]) {
    assert.equal(legacy.safeParse(input).success, false);
    assert.equal(MessageContracts.message_list.input.safeParse(input).success, false);
  }
  const f = fixture(t);
  const q = f.as("owner").send({ recipientID: "outsider", text: "Outgoing other peer" });
  f.as("respondent").send({ recipientID: "outsider", text: "Foreign parties" });
  const incoming = f.as("requester").send({ recipientID: "owner", text: "Incoming" });
  const outgoing = f.as("owner").send({ recipientID: "requester", text: "Outgoing" });
  const self = f.as("owner").send({ recipientID: "owner", text: "Self" });
  const last = f.as("requester").send({ recipientID: "owner", text: "Last" });
  for (const [direction, items] of [
    ["all", [q, incoming, outgoing, self, last]],
    ["incoming", [incoming, self, last]],
    ["outgoing", [q, outgoing, self]],
  ] as const) {
    assert.equal(
      JSON.stringify(f.as("owner").list({ direction })),
      JSON.stringify({ items, after: items.at(-1)?.cursor }),
    );
    assert.deepEqual(f.as("owner").list({ direction, after: last.cursor }), {
      items: [],
      after: last.cursor,
    });
  }
  assert.deepEqual(
    f.as("owner").list({ after: incoming.cursor, direction: "outgoing", limit: 1 }),
    { items: [outgoing], after: outgoing.cursor },
  );
  assert.throws(() => f.as("owner").list({ after: f.store.messages.head() + 1 }), invalid);
  f.reopen();
  assert.deepEqual(f.as("owner").list(), {
    items: [q, incoming, outgoing, self, last],
    after: last.cursor,
  });
});

test("peer latest/older qualifies sparse interleaved rows before 100-row pages and preserves forward own-send gaps", (t) => {
  const f = fixture(t);
  const peer = [];
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
  const initial = f.as("owner").list({ counterpartyID: "requester", before: "latest", limit: 100 });
  assert.deepEqual(initial.items, peer.slice(-100));
  assert.equal(initial.after, peer.at(-1)?.cursor);
  let before = initial.items[0]?.cursor;
  const all = [...initial.items];
  for (const expected of [peer.slice(51, 151), peer.slice(0, 51)]) {
    assert.ok(before);
    const older = f.as("owner").list({ counterpartyID: "requester", before, limit: 100 });
    assert.deepEqual(older.items, expected);
    assert.equal(older.after, expected.at(-1)?.cursor);
    all.unshift(...older.items);
    before = older.items[0]?.cursor;
  }
  assert.deepEqual(all, peer);
  assert.ok(before);
  assert.deepEqual(f.as("owner").list({ counterpartyID: "requester", before }), {
    items: [],
    after: 0,
  });
  const gap = f
    .as("requester")
    .send({ recipientID: "owner", text: "Unseen inbound before own reply" });
  const own = f
    .as("owner")
    .send({ recipientID: "requester", text: "Own reply is not a polling checkpoint" });
  const forward = f
    .as("owner")
    .list({ counterpartyID: "requester", after: initial.after, limit: 1 });
  assert.deepEqual(forward, { items: [gap], after: gap.cursor });
  assert.deepEqual(f.as("owner").list({ counterpartyID: "requester", after: forward.after }), {
    items: [own],
    after: own.cursor,
  });
  assert.deepEqual(
    f
      .as("owner")
      .list({ counterpartyID: "requester", before: initial.items[0]?.cursor, limit: 100 }).items,
    peer.slice(51, 151),
  );
  f.reopen();
  assert.deepEqual(
    f.as("owner").list({ counterpartyID: "requester", before: "latest", limit: 2 }).items,
    [gap, own],
  );
  assert.deepEqual(f.as("owner").get({ messageID: peer[0]?.messageID ?? "" }), peer[0]);
});

test("peer criteria preserve self/direction/privacy and closed history without selected-profile lookup", (t) => {
  const f = fixture(t);
  const incoming = f.as("requester").send({ recipientID: "owner", text: "Incoming" });
  const outgoing = f.as("owner").send({ recipientID: "requester", text: "Outgoing" });
  const self = f.as("owner").send({ recipientID: "owner", text: "Self once" });
  const reader = createMessages(
    createActors(
      {
        ...f.authority,
        get(caller, id) {
          assert.equal(id, caller, "listing must not resolve the selected profile");
          return f.rows.get(id);
        },
      },
      "owner",
    ),
    f.store,
  );
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
  assert.deepEqual(reader.list({ counterpartyID: "owner", before: "latest", limit: 1 }).items, [
    self,
  ]);
  assert.deepEqual(reader.list({ counterpartyID: "owner", before: self.cursor, limit: 1 }), {
    items: [],
    after: 0,
  });
  assert.deepEqual(reader.list({ counterpartyID: "unknown", before: "latest" }), {
    items: [],
    after: 0,
  });
  assert.deepEqual(reader.list({ counterpartyID: "unknown", after: self.cursor }), {
    items: [],
    after: self.cursor,
  });
  assert.deepEqual(f.as("outsider").list({ counterpartyID: "requester", before: "latest" }), {
    items: [],
    after: 0,
  });
  assert.throws(
    () => f.as("owner").send({ recipientID: "requester", text: "Closed recipient" }),
    invalid,
  );
  for (const input of [
    { before: "latest" },
    { counterpartyID: "requester", before: "latest", after: 1 },
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "LATEST", null, {}].map((before) => ({
      counterpartyID: "requester",
      before,
    })),
    { counterpartyID: " " },
    { counterpartyID: 42 },
    { callerID: "requester" },
    { order: "desc" },
  ])
    assert.throws(() => reader.list(input as never), invalid);
  assert.deepEqual(
    reader.list({ counterpartyID: "requester", before: Number.MAX_SAFE_INTEGER }).items,
    [incoming, outgoing],
  );
  assert.deepEqual(reader.list({ counterpartyID: "requester", before: outgoing.cursor }).items, [
    incoming,
  ]);
  assert.deepEqual(reader.get({ messageID: incoming.messageID }), incoming);
  const caller = f.rows.get("owner");
  assert.ok(caller);
  f.rows.set("owner", { ...caller, state: "closed" });
  assert.throws(
    () => reader.list({ counterpartyID: "requester", before: "latest" }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
  );
});

test("recent head is captured once across appends, with safe maximum and tied timestamps", (t) => {
  const f = fixture(t);
  const first = f.as("requester").send({ recipientID: "owner", text: "Before head" });
  let headCalls = 0;
  let appended: typeof first | undefined;
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
  assert.deepEqual(recent.list({ counterpartyID: "requester", before: "latest" }), {
    items: [first],
    after: first.cursor,
  });
  assert.equal(headCalls, 1);
  assert.ok(appended);
  assert.deepEqual(f.as("owner").list({ counterpartyID: "requester", after: first.cursor }).items, [
    appended,
  ]);
  const max = Number.MAX_SAFE_INTEGER;
  const rows = [max - 2, max].map((cursor) => ({ ...first, messageID: `safe-${cursor}`, cursor }));
  const maximum = createMessages(createActors(f.authority, "owner"), {
    transaction: f.store.transaction,
    messages: { ...f.store.messages, head: () => max, all: () => rows },
  });
  assert.deepEqual(
    maximum
      .list({ counterpartyID: "requester", before: "latest", limit: 1 })
      .items.map((row) => row.cursor),
    [max],
  );
  assert.equal(maximum.list({ counterpartyID: "requester", before: "latest" }).after, max);
  assert.deepEqual(
    maximum.list({ counterpartyID: "requester", before: max }).items.map((row) => row.cursor),
    [max - 2],
  );
  assert.deepEqual(maximum.list({ counterpartyID: "requester", before: max - 2 }), {
    items: [],
    after: 0,
  });
});
