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
import type { Actor, Form, Message, Page, Work } from "../src/contracts/index.js";
import { bindWorkspace } from "../src/index.js";
import { createMcpServer, type McpPurpose } from "../src/mcp/index.js";
import { openSqlite } from "../src/persistence/index.js";

const executionNames = [
  "actor_get",
  "actor_list",
  "message_send",
  "message_get",
  "message_list",
  "work_create",
  "work_get",
  "work_list",
  "work_update",
  "work_submit",
  "work_review",
  "form_create",
  "form_get",
  "form_list",
  "form_respond",
  "form_close",
];
const viewerNames = [
  "actor_get",
  "actor_list",
  "message_get",
  "message_list",
  "work_get",
  "work_list",
  "form_get",
  "form_list",
];

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

test("SDK execution/viewer discovery and all 16 calls share records and enforce domain authority", async (t) => {
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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...executionNames].sort());
  const actorProperties = tools.find((tool) => tool.name === "actor_get")?.outputSchema?.properties;
  assert.ok(actorProperties && typeof actorProperties === "object");
  assert.equal(Object.hasOwn(actorProperties, "kind"), false);
  const viewedTools = (await viewer.listTools()).tools;
  assert.deepEqual(viewedTools.map((tool) => tool.name).sort(), [...viewerNames].sort());
  assert.ok(viewedTools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.equal((await call<Actor>(requester, "actor_get")).actorID, "requester");
  const namedActor = await call<Actor>(viewer, "actor_get", { actorID: "owner" });
  assert.equal(namedActor.actorID, "owner");
  assert.equal(Object.hasOwn(namedActor, "kind"), false);
  assert.equal((await call<Page<Actor>>(requester, "actor_list", { limit: 1 })).items.length, 1);
  const ticket = await call<Work>(requester, "work_create", {
    goal: "Protocol-delivered work",
    ownerID: "owner",
  });
  assert.equal(
    (await call<Work>(viewer, "work_get", { ticketID: ticket.ticketID })).ticketID,
    ticket.ticketID,
  );
  assert.equal((await call<Page<Work>>(viewer, "work_list")).items[0]?.ticketID, ticket.ticketID);
  const message = await call<Message>(requester, "message_send", {
    recipientID: "owner",
    text: "Protocol message",
    workID: ticket.ticketID,
  });
  assert.equal(
    (await call<Message>(viewer, "message_get", { messageID: message.messageID })).text,
    "Protocol message",
  );
  assert.equal(
    (await call<Page<Message>>(viewer, "message_list", { direction: "outgoing" })).items.length,
    1,
  );
  for (const removed of ["message_acknowledge", "message_handle"])
    for (const client of [owner, viewer])
      await refused(client, removed, { messageID: message.messageID }, "not_found");
  const form = await call<Form>(requester, "form_create", {
    respondentIDs: ["owner"],
    fields: [{ name: "answer", label: "Proceed?", required: true }],
  });
  assert.equal(
    (
      await call<Page<Form>>(outsider, "form_list", {
        requesterWithin: "requester",
        respondentWithin: "owner",
        awaitingWithin: "owner",
      })
    ).items[0]?.formID,
    form.formID,
  );
  await call(owner, "form_respond", {
    formID: form.formID,
    expectedRevision: 1,
    answers: { answer: "yes" },
  });
  const changed = await call<Form>(viewer, "form_get", { formID: form.formID });
  assert.equal(changed.responses.owner?.answer, "yes");
  assert.equal((await call<Page<Form>>(viewer, "form_list")).items.length, 1);
  assert.equal(Object.hasOwn(form, "workID"), false);
  assert.deepEqual(
    (await call<Page<Form>>(outsider, "form_list", { awaitingWithin: "outsider" })).items,
    [],
  );
  await refused(outsider, "work_list", { ownerWithin: 42 }, "invalid_input");
  const formProperties = tools.find((tool) => tool.name === "form_create")?.inputSchema;
  assert.ok(formProperties);
  assert.equal(formProperties.required?.includes("workID"), false);
  await call(requester, "form_close", {
    formID: form.formID,
    expectedRevision: changed.revision,
    status: "resolved",
    resolution: "Answers recorded",
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
  await call(requester, "work_review", {
    ticketID: ticket.ticketID,
    expectedRevision: submitted.revision,
    submissionID: submitted.submission.submissionID,
    verdict: "accepted",
    comment: "Reviewed over MCP",
  });
  assert.equal(
    (await call<Work>(viewer, "work_get", { ticketID: ticket.ticketID })).status,
    "accepted",
  );
  await refused(viewer, "work_create", { goal: "Rejected write", ownerID: "owner" }, "forbidden");
  assert.equal(
    (await call<Work>(outsider, "work_get", { ticketID: ticket.ticketID })).status,
    "accepted",
  );
  assert.equal(
    (
      await call<Page<Work>>(outsider, "work_list", {
        ownerID: "owner",
        requesterID: "requester",
        ownerWithin: "owner",
        requesterWithin: "requester",
        status: "accepted",
        limit: 1,
      })
    ).items[0]?.ticketID,
    ticket.ticketID,
  );
  assert.equal(
    (await call<Form>(outsider, "form_get", { formID: form.formID })).status,
    "resolved",
  );
  assert.equal(
    (
      await call<Page<Form>>(outsider, "form_list", {
        requesterID: "requester",
        respondentID: "owner",
        requesterWithin: "requester",
        respondentWithin: "owner",
        status: "resolved",
      })
    ).items.length,
    1,
  );
  assert.deepEqual(
    (await call<Page<Form>>(outsider, "form_list", { awaitingActorID: "owner" })).items,
    [],
  );
  await refused(
    outsider,
    "form_respond",
    { formID: form.formID, expectedRevision: changed.revision, answers: { answer: "yes" } },
    "forbidden",
  );
  await refused(outsider, "message_get", { messageID: message.messageID }, "not_found");
  await refused(
    requester,
    "work_review",
    {
      ticketID: ticket.ticketID,
      expectedRevision: 1,
      verdict: "accepted",
      comment: "Missing submission",
    },
    "invalid_input",
  );
  await refused(
    owner,
    "message_send",
    { recipientID: "requester", text: "Caller spoof", senderID: "outsider" },
    "invalid_input",
  );
  await refused(owner, "actor_create", { name: "Excluded" }, "not_found");
  await refused(requester, "actor_get", { kind: "human" }, "invalid_input");
});

test("SDK boundary sanitizes unexpected failures and checks revoked caller", async (t) => {
  const store = openSqlite(":memory:");
  const fixture = fixtureAuthority();
  const clients = bindWorkspace(
    {
      ...fixture.authority,
      within: () => {
        throw new Error("membership-credential-sentinel");
      },
    },
    store,
    "requester",
  );
  clients.work.create({ goal: "Membership failure fixture", ownerID: "owner" });
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
  store.messages.all = () => {
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
  const selection = await client.callTool({
    name: "work_list",
    arguments: { ownerWithin: "owner" },
  });
  assert.equal(JSON.stringify(selection).includes("membership-credential-sentinel"), false);
  assert.equal(selection.isError, true);
  await refused(client, "work_list", { ownerWithin: "owner" }, "internal_error");
  const actor = fixture.rows.get("requester");
  assert.ok(actor);
  fixture.rows.set("requester", { ...actor, state: "closed" });
  await refused(client, "message_list", {}, "forbidden");
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
    assert.equal((await client.listTools()).tools.length, purpose === "execution" ? 16 : 8);
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
    const callError = await client.callTool({ name: "actor_get", arguments: {} });
    assert.equal(callError.isError, true);
    assert.equal(JSON.stringify(callError).includes(sentinel), false);
    failing = false;
    assert.equal((await client.listTools()).tools.length, purpose === "execution" ? 16 : 8);
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
    await refused(client, "actor_get", {}, "forbidden");
  });
}

test("npm start target serves SDK stdio across independent processes and durable reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "fixture.sqlite");
  async function session(purpose: McpPurpose, action: (client: Client) => Promise<void>) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("dist/examples/stdio.js"),
        "--actor",
        "requester",
        "--purpose",
        purpose,
        "--db",
        db,
      ],
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
  await session("execution", async (client) => {
    const ticket = await call<Work>(client, "work_create", {
      goal: "Reopen stdio database",
      ownerID: "owner",
    });
    id = ticket.ticketID;
  });
  await session("viewer", async (client) => {
    assert.equal((await client.listTools()).tools.length, 8);
    assert.equal(
      (await call<Work>(client, "work_get", { ticketID: id })).goal,
      "Reopen stdio database",
    );
    await refused(client, "work_create", { goal: "Viewer write", ownerID: "owner" }, "forbidden");
  });
});
