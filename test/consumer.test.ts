import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("packed external TypeScript consumer uses only public exports", { timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-public-consumer-"));
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { filename: string }[];
    const archive = packed[0]?.filename;
    assert.ok(archive);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(dir, archive),
        "@types/node@24.10.1",
      ],
      { cwd: dir, encoding: "utf8", stdio: "pipe" },
    );
    writeFileSync(
      join(dir, "consumer.ts"),
      `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bindWorkspace } from '@uniac/agentic-workspace';
import { createActors, type ActorAuthority } from '@uniac/agentic-workspace/actors';
import { createWork } from '@uniac/agentic-workspace/work';
import { createMessages } from '@uniac/agentic-workspace/messages';
import { createForms } from '@uniac/agentic-workspace/forms';
import { Work, Actor, ActorContracts, Message, MessageContracts, WorkspaceError } from '@uniac/agentic-workspace/contracts';
import { openSqlite } from '@uniac/agentic-workspace/persistence';
import { createMcpServer } from '@uniac/agentic-workspace/mcp';
const actor: Actor = {actorID:'self',name:'Consumer',purpose:'Public exports proof',state:'active'};
// @ts-expect-error Actor records have no intrinsic client classification.
const classifiedActor: Actor = {...actor,kind:'human'};
if (Actor.safeParse(classifiedActor).success) throw new Error('Actor schema accepted kind');
if (ActorContracts.actor_get.input.safeParse({kind:'human'}).success) throw new Error('Actor lookup accepted kind');
const peer: Actor = {...actor,actorID:'peer',name:'Peer'};
const observer: Actor = {...actor,actorID:'observer',name:'Observer'};
const authority: ActorAuthority = {get: (_caller,id) => [actor,peer,observer].find(row=>row.actorID===id),list: () => ({items:[actor,peer,observer],after:3})};
try {
  createActors({...authority,get:()=>classifiedActor},'self').get();
  throw new Error('Actor client accepted kind');
} catch(error) {if (!(error instanceof WorkspaceError) || error.code!=='invalid_input') throw error;}
const store = openSqlite(':memory:');
try {
  const actors = createActors(authority,'self');
  const work = createWork(actors,store);
  const messages = createMessages(actors,store);
  const peerMessages = createMessages(createActors(authority,'peer'),store);
  assert.deepEqual(Object.keys(messages).sort(),['get','list','send']);
  assert.deepEqual(Object.keys(MessageContracts).sort(),['message_get','message_list','message_send']);
  const direct = messages.send({recipientID:'peer',text:'Hello'});
  const messageKeys = ['messageID','senderID','recipientID','text','createdAt','revision','cursor','history'].sort();
  assert.deepEqual(Object.keys(direct).sort(),messageKeys);
  assert.deepEqual(peerMessages.get({messageID:direct.messageID}),direct);
  assert.deepEqual(peerMessages.list({direction:'incoming'}).items,[direct]);
  const reply = peerMessages.send({recipientID:'self',text:'Hello back'});
  assert.notEqual(reply.messageID,direct.messageID);
  assert.deepEqual(messages.get({messageID:direct.messageID}),direct);
  assert.deepEqual(messages.list({direction:'incoming'}).items,[reply]);
  assert.deepEqual(direct.history.map(entry=>entry.action),['sent']);
  for (const field of ['acknowledgedAt','handling'])
    assert.equal(Message.safeParse({...direct,[field]:field==='handling'?{outcome:'Done',at:direct.createdAt}:direct.createdAt}).success,false);
  function publicTypes(message: Message) {
    // @ts-expect-error Messages have no public read state.
    message.acknowledgedAt;
    // @ts-expect-error Messages have no public disposition state.
    message.handling;
    // @ts-expect-error The Messages client exposes only send/get/list.
    messages.acknowledge;
    // @ts-expect-error The Messages client exposes only send/get/list.
    messages.handle;
    // @ts-expect-error No receipt contract is exported.
    MessageContracts.message_acknowledge;
    // @ts-expect-error No disposition contract is exported.
    MessageContracts.message_handle;
  }
  publicTypes(direct);
  const forms = createForms(actors,store);
  const ticket = Work.parse(work.create({goal:'Consume exported clients',ownerID:'self'}));
  const form = forms.create({respondentIDs:['peer'],fields:[{name:'answer',label:'Ready?',required:true}]});
  assert.equal(Object.hasOwn(form,'workID'),false);
  const peerForms = createForms(createActors(authority,'peer'),store);
  const answered = peerForms.respond({formID:form.formID,expectedRevision:1,answers:{answer:'yes'}});
  const closed = forms.close({formID:form.formID,expectedRevision:answered.revision,status:'resolved',resolution:'Agreed'});
  assert.equal(closed.status,'resolved');
  const pending = bindWorkspace(authority,store,'peer').forms.create({workID:ticket.ticketID,respondentIDs:['peer'],fields:[{name:'answer',label:'Optional',required:false}]});
  const clients = bindWorkspace(authority,store,'observer');
  assert.deepEqual(clients.work.list({ownerID:'self',requesterID:'self',status:'open'}).items,[ticket]);
  assert.deepEqual(clients.forms.list({workID:ticket.ticketID,requesterID:'peer',respondentID:'peer',status:'open',awaitingActorID:'peer'}).items,[pending]);
  for (const purpose of ['execution','viewer'] as const) {
    const server = createMcpServer(clients,purpose);
    const client = new Client({name:'installed-package-consumer',version:'1'});
    const [a,b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length,purpose==='execution'?16:8);
      const formTool = tools.find(tool=>tool.name==='form_get');
      assert.equal(formTool?.outputSchema?.required?.includes('workID'),false);
      const formRead = await client.callTool({name:'form_get',arguments:{formID:form.formID}});
      assert.deepEqual(formRead.structuredContent,closed);
      const workRead = await client.callTool({name:'work_list',arguments:{ownerID:'self',requesterID:'self',status:'open',limit:1}});
      assert.deepEqual((workRead.structuredContent as {items:unknown[]}).items,[ticket]);
      const awaiting = await client.callTool({name:'form_list',arguments:{workID:ticket.ticketID,requesterID:'peer',respondentID:'peer',status:'open',awaitingActorID:'peer',limit:1}});
      assert.deepEqual((awaiting.structuredContent as {items:unknown[]}).items,[pending]);
      if (purpose==='execution') {
        const denied = await client.callTool({name:'form_respond',arguments:{formID:pending.formID,expectedRevision:1,answers:{}}});
        assert.equal(JSON.parse((denied.content as {text:string}[])[0]!.text).code,'forbidden');
      }
      assert.deepEqual(tools.filter(tool=>tool.name.startsWith('message_')).map(tool=>tool.name).sort(),purpose==='execution'?['message_get','message_list','message_send']:['message_get','message_list']);
      const properties = tools.find(tool=>tool.name==='message_get')?.outputSchema?.properties;
      assert.ok(properties && typeof properties==='object');
      assert.deepEqual(Object.keys(properties).sort(),[...messageKeys,'workID'].sort());
      for (const name of ['message_acknowledge','message_handle']) {
        const result = await client.callTool({name,arguments:{messageID:direct.messageID,outcome:'Done'}});
        assert.equal(result.isError,true);
        assert.equal(JSON.parse((result.content as {text:string}[])[0]!.text).code,'not_found');
      }
      if (purpose==='execution') {
        const sent = await client.callTool({name:'message_send',arguments:{recipientID:'peer',text:'Installed MCP message'}});
        assert.equal(sent.isError,undefined);
        assert.deepEqual(Object.keys(sent.structuredContent!).sort(),messageKeys);
      }
      const read = await client.callTool({name:'message_get',arguments:{messageID:direct.messageID}});
      assert.equal(read.isError,true);
      assert.equal(JSON.parse((read.content as {text:string}[])[0]!.text).code,'not_found');
      const listed = await client.callTool({name:'message_list',arguments:{direction:'incoming'}});
      assert.deepEqual((listed.structuredContent as {items:Message[]}).items,[]);
    } finally {await client.close(); await server.close();}
  }
  console.log(JSON.stringify({goal:clients.work.get({ticketID:ticket.ticketID}).goal,messages:messages.list().items.length,forms:forms.list().items.length}));
} finally {store.close();}
`,
    );
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "consumer.ts",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node",
      ],
      { cwd: dir, encoding: "utf8", stdio: "pipe" },
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [join(dir, "consumer.js")], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.deepEqual(result, { goal: "Consume exported clients", messages: 2, forms: 2 });
    const installed = JSON.parse(
      readFileSync(join(dir, "node_modules/@uniac/agentic-workspace/package.json"), "utf8"),
    );
    assert.equal(installed.private, true);
    assert.equal(installed.version, "0.2.0");
    assert.equal(Object.keys(installed.exports).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
