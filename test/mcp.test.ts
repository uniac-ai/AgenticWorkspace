import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { fixtureAuthority } from "../examples/authority.js";
import type { Form, List, Message, Work } from "../src/contracts/index.js";
import { bindWorkspace } from "../src/index.js";
import { createMcpServer, type McpPurpose } from "../src/mcp/index.js";
import { openSqlite } from "../src/persistence/index.js";

const executionNames = [
  "message_send",
  "message_get",
  "message_list",
  "work_create",
  "work_get",
  "work_list",
  "work_update",
  "work_submit",
  "work_answer",
];
const viewerNames = ["message_get", "message_list", "work_get", "work_list"];

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} should succeed`);
  assert.ok(result.structuredContent);
  return result.structuredContent as T;
}
async function refused(client: Client, name: string, args: Record<string, unknown>, code: string) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  const errorText = (result.content as { type: string; text: string }[])[0]?.text;
  assert.ok(errorText);
  assert.equal(JSON.parse(errorText).code, code);
}

test("SDK execution/viewer discovery and all 9 calls share records and enforce domain authority", async (t) => {
  const store = openSqlite(":memory:");
  const { authority } = fixtureAuthority();
  const connections: { client: Client; server: ReturnType<typeof createMcpServer> }[] = [];
  t.after(async () => {
    for (const { client, server } of connections) {
      await client.close();
      await server.close();
    }
    store.close();
  });
  async function connect(actor: string, purpose: McpPurpose) {
    const server = createMcpServer(bindWorkspace(authority, store, actor), purpose);
    const client = new Client({ name: "independent-fixture-consumer", version: "1" });
    connections.push({ client, server });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    return client;
  }
  const requester = await connect("requester", "execution");
  const owner = await connect("owner", "execution");
  const viewer = await connect("requester", "viewer");
  const outsider = await connect("outsider", "execution");
  const tools = (await requester.listTools()).tools;
  // A client validates results only for tools it has listed.
  await owner.listTools();
  await outsider.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...executionNames].sort());
  const viewedTools = (await viewer.listTools()).tools;
  assert.deepEqual(viewedTools.map((tool) => tool.name).sort(), [...viewerNames].sort());
  assert.ok(viewedTools.every((tool) => tool.annotations?.readOnlyHint === true));
  const ticket = await call<Work>(requester, "work_create", {
    title: "Protocol-delivered work",
    ownerID: "owner",
  });
  assert.equal(
    (await call<Work>(viewer, "work_get", { ticketID: ticket.ticketID })).ticketID,
    ticket.ticketID,
  );
  assert.equal((await call<List<Work>>(viewer, "work_list")).items[0]?.ticketID, ticket.ticketID);
  assert.equal(
    (await call<Work>(viewer, "work_get", { ticketID: ticket.ticketID, history: true })).history
      ?.length,
    1,
  );
  const message = await call<Message>(requester, "message_send", {
    recipientID: "owner",
    text: "Protocol message",
  });
  assert.equal(
    (await call<Message>(viewer, "message_get", { messageID: message.messageID })).text,
    "Protocol message",
  );
  assert.equal(
    (await call<List<Message>>(viewer, "message_list", { counterpartyID: "owner" })).items.length,
    1,
  );
  assert.deepEqual((await call<List<Message>>(outsider, "message_list", { of: "owner" })).items, [
    message,
  ]);
  await refused(viewer, "message_list", { direction: "outgoing" }, "invalid_input");
  await refused(viewer, "message_list", {}, "invalid_input");
  await refused(owner, "message_send", { recipientID: "owner", text: "Self" }, "invalid_input");
  for (const removed of ["message_acknowledge", "message_handle"])
    for (const client of [owner, viewer])
      await refused(client, removed, { messageID: message.messageID }, "not_found");
  const form = await call<Form>(owner, "work_update", {
    ticketID: ticket.ticketID,
    ask: {
      title: "Proceed?",
      collect: true,
      fields: [{ name: "answer", label: "Proceed?", required: true }],
    },
  });
  assert.equal(form.workID, ticket.ticketID);
  assert.deepEqual(
    (await call<List<Work>>(outsider, "work_list", { ownerID: "owner" })).items[0]?.asks,
    [form],
  );
  await call(outsider, "work_answer", {
    askID: form.formID,
    answers: { answer: "yes" },
    note: "Over MCP",
  });
  const changed = (await call<Work>(viewer, "work_get", { askID: form.formID })).asks?.[0];
  assert.deepEqual(changed?.responses.outsider?.answers, { answer: "yes" });
  assert.equal(changed?.responses.outsider?.note, "Over MCP");
  await refused(outsider, "work_list", { ownerID: 42 }, "invalid_input");
  for (const removed of ["ownerWithin", "requesterWithin"])
    await refused(outsider, "work_list", { [removed]: "owner" }, "invalid_input");
  const updateSchema = tools.find((tool) => tool.name === "work_update")?.inputSchema;
  assert.equal(updateSchema?.type, "object");
  for (const form of ["ask", "close"])
    assert.ok(Object.hasOwn(updateSchema?.properties ?? {}, form));
  for (const name of ["work_get", "work_update", "work_answer"]) {
    const output = tools.find((tool) => tool.name === name)?.outputSchema;
    assert.equal(output?.type, "object");
    assert.equal(Array.isArray(output?.anyOf), true);
  }
  await call(owner, "work_update", {
    close: { askID: form.formID, status: "resolved", resolution: "Answers recorded" },
  });
  const update = await call<Work>(owner, "work_update", {
    ticketID: ticket.ticketID,
    expectedRevision: 1,
    progress: "Ready",
    status: "active",
  });
  const submitted = await call<Work>(owner, "work_submit", {
    ticketID: ticket.ticketID,
    expectedRevision: update.revision,
    result: "Protocol result",
    evidence: ["https://example.test/evidence"],
  });
  assert.ok(submitted.submission);
  await refused(
    requester,
    "work_answer",
    { askID: submitted.submission.submissionID, raise: true },
    "invalid_input",
  );
  await call(requester, "work_answer", {
    askID: submitted.submission.submissionID,
    answers: { verdict: "accepted" },
    note: "Reviewed over MCP",
  });
  assert.equal(
    (await call<Work>(viewer, "work_get", { ticketID: ticket.ticketID })).status,
    "accepted",
  );
  await refused(viewer, "work_create", { title: "Rejected write", ownerID: "owner" }, "forbidden");
  assert.equal(
    (await call<Work>(outsider, "work_get", { ticketID: ticket.ticketID })).status,
    "accepted",
  );
  assert.equal(
    (
      await call<List<Work>>(outsider, "work_list", {
        ownerID: ["owner", "respondent"],
        requesterID: "requester",
        status: ["accepted"],
        limit: 1,
      })
    ).items[0]?.ticketID,
    ticket.ticketID,
  );
  assert.deepEqual(
    (await call<Work>(outsider, "work_get", { askID: form.formID })).asks?.map((row) => row.status),
    ["resolved"],
  );
  await refused(
    outsider,
    "work_answer",
    { askID: form.formID, answers: { answer: "yes" } },
    "conflict",
  );
  assert.deepEqual(await call(outsider, "message_get", { messageID: message.messageID }), message);
  await refused(
    requester,
    "work_answer",
    { ticketID: ticket.ticketID, answers: { verdict: "accepted" } },
    "invalid_input",
  );
  const blocked = await owner.callTool({
    name: "work_update",
    arguments: { ticketID: ticket.ticketID, status: "blocked" },
  });
  const blockedText = (blocked.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.equal(JSON.parse(blockedText).code, "invalid_input");
  assert.match(JSON.parse(blockedText).message, /^status: blocked is gone: ask on the Work/);
  for (const removed of [
    "work_review",
    "form_create",
    "form_get",
    "form_list",
    "form_respond",
    "form_close",
  ])
    await refused(requester, removed, {}, "not_found");
  await refused(
    owner,
    "message_send",
    { recipientID: "requester", text: "Caller spoof", senderID: "outsider" },
    "invalid_input",
  );
  await refused(owner, "actor_create", { name: "Excluded" }, "not_found");
  for (const removed of ["actor_get", "actor_list", "status_set", "status_get"])
    await refused(requester, removed, {}, "not_found");
});

test("SDK boundary sanitizes unexpected failures and checks revoked caller", async (t) => {
  const store = openSqlite(":memory:");
  const fixture = fixtureAuthority();
  const authority = {
    ...fixture.authority,
    person: () => {
      throw new Error("person-credential-sentinel");
    },
  };
  const clients = bindWorkspace(authority, store, "requester");
  // owner asks an approval on Work it requested itself, so the approval routes to the person.
  const owner = bindWorkspace(authority, store, "owner").work;
  const held = owner.create({ title: "Person failure fixture" });
  const approval = owner.update({
    ticketID: held.ticketID,
    ask: {
      title: "Approve?",
      approval: true,
      fields: [{ name: "ok", label: "OK?", required: true }],
    },
  });
  assert.ok("formID" in approval);
  const server = createMcpServer(
    {
      ...clients,
      work: {
        ...clients.work,
        get: () => {
          throw new Error("credential-sentinel-do-not-emit");
        },
      },
    },
    "execution",
  );
  const client = new Client({ name: "error-consumer", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const result = await client.callTool({ name: "work_get", arguments: { ticketID: "fixture" } });
  assert.equal(JSON.stringify(result).includes("credential-sentinel"), false);
  const errorText = (result.content as { type: string; text: string }[])[0]?.text;
  assert.ok(errorText);
  assert.equal(JSON.parse(errorText).code, "internal_error");
  store.messages.where = () => {
    throw new Error("private-message-credential-sentinel");
  };
  const recentFailure = await client.callTool({
    name: "message_list",
    arguments: { counterpartyID: "owner", before: "latest" },
  });
  assert.equal(recentFailure.isError, true);
  assert.equal(
    JSON.stringify(recentFailure).includes("private-message-credential-sentinel"),
    false,
  );
  assert.equal(JSON.stringify(recentFailure).includes("counterpartyID"), false);
  const answer = { askID: approval.formID, answers: { ok: "yes" } };
  const answering = await client.callTool({ name: "work_answer", arguments: answer });
  assert.equal(JSON.stringify(answering).includes("person-credential-sentinel"), false);
  assert.equal(answering.isError, true);
  await refused(client, "work_answer", answer, "internal_error");
  const actor = fixture.rows.get("requester");
  assert.ok(actor);
  fixture.rows.set("requester", { ...actor, state: "closed" });
  await refused(client, "message_list", { counterpartyID: "owner" }, "forbidden");
});

for (const purpose of ["execution", "viewer"] as const) {
  test(`SDK discovery sanitizes authority failures and preserves caller denial: ${purpose}`, async (t) => {
    const store = openSqlite(":memory:");
    const fixture = fixtureAuthority();
    const sentinel = "canonical-authority-credential-sentinel";
    let failing = false;
    const authority = {
      ...fixture.authority,
      get(callerID: string, actorID: string) {
        if (failing) throw new Error(sentinel);
        return fixture.authority.get(callerID, actorID);
      },
    };
    const server = createMcpServer(bindWorkspace(authority, store, "requester"), purpose);
    const client = new Client({ name: "discovery-error-consumer", version: "1" });
    t.after(async () => {
      await client.close();
      await server.close();
      store.close();
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    assert.equal((await client.listTools()).tools.length, purpose === "execution" ? 9 : 4);
    failing = true;
    await assert.rejects(
      () => client.listTools(),
      (error: unknown) => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, ErrorCode.InternalError);
        assert.equal(
          JSON.stringify({ code: error.code, message: error.message, data: error.data }).includes(
            sentinel,
          ),
          false,
        );
        assert.match(error.message, /workspace operation failed/);
        return true;
      },
    );
    const callError = await client.callTool({ name: "work_list", arguments: {} });
    assert.equal(callError.isError, true);
    assert.equal(JSON.stringify(callError).includes(sentinel), false);
    failing = false;
    assert.equal((await client.listTools()).tools.length, purpose === "execution" ? 9 : 4);
    const actor = fixture.rows.get("requester");
    assert.ok(actor);
    fixture.rows.set("requester", { ...actor, state: "closed" });
    await assert.rejects(
      () => client.listTools(),
      (error: unknown) => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, ErrorCode.InvalidRequest);
        assert.match(error.message, /active admitted Actor is required/);
        return true;
      },
    );
    await refused(client, "work_list", {}, "forbidden");
  });
}

test("npm start target serves SDK stdio across independent processes and durable reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "fixture.sqlite");
  async function session(
    actor: string,
    purpose: McpPurpose,
    action: (client: Client) => Promise<void>,
  ) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/examples/stdio.js"), "--actor", actor, "--purpose", purpose, "--db", db],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-consumer", version: "1" });
    try {
      await client.connect(transport);
      await action(client);
    } finally {
      await client.close();
      await transport.close();
    }
  }
  let id = "";
  let askID = "";
  await session("requester", "execution", async (client) => {
    const ticket = await call<Work>(client, "work_create", {
      title: "Reopen stdio database",
      ownerID: "owner",
    });
    id = ticket.ticketID;
  });
  // Each client lists its tools first, so the SDK validates every result against its schema.
  await session("owner", "execution", async (client) => {
    await client.listTools();
    const question = {
      title: "Reopen?",
      fields: [{ name: "x", label: "Reopen?", required: true }],
    };
    askID = (await call<Form>(client, "work_update", { ticketID: id, ask: question })).formID;
  });
  await session("requester", "execution", async (client) => {
    await client.listTools();
    const answered = await call<Form>(client, "work_answer", { askID, answers: { x: "yes" } });
    assert.equal(answered.status, "resolved");
  });
  await session("requester", "viewer", async (client) => {
    assert.equal((await client.listTools()).tools.length, 4);
    const read = await call<Work>(client, "work_get", { askID });
    assert.equal(read.title, "Reopen stdio database");
    assert.deepEqual(
      read.asks?.map((row) => [row.formID, row.status]),
      [[askID, "resolved"]],
    );
    await refused(client, "work_create", { title: "Viewer write", ownerID: "owner" }, "forbidden");
  });
});
