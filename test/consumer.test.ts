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
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(dir, archive)],
      { cwd: dir, stdio: "pipe" },
    );
    writeFileSync(
      join(dir, "consumer.ts"),
      `
import { bindWorkspace } from '@uniac/agentic-workspace';
import { createActors, type ActorAuthority } from '@uniac/agentic-workspace/actors';
import { createWork } from '@uniac/agentic-workspace/work';
import { createMessages } from '@uniac/agentic-workspace/messages';
import { createForms } from '@uniac/agentic-workspace/forms';
import { Work, Actor, ActorContracts, WorkspaceError } from '@uniac/agentic-workspace/contracts';
import { openSqlite } from '@uniac/agentic-workspace/persistence';
import { createMcpServer } from '@uniac/agentic-workspace/mcp';
const actor: Actor = {actorID:'self',name:'Consumer',purpose:'Public exports proof',state:'active'};
// @ts-expect-error Actor records have no intrinsic client classification.
const classifiedActor: Actor = {...actor,kind:'human'};
if (Actor.safeParse(classifiedActor).success) throw new Error('Actor schema accepted kind');
if (ActorContracts.actor_get.input.safeParse({kind:'human'}).success) throw new Error('Actor lookup accepted kind');
const authority: ActorAuthority = {get: (_caller,id) => id==='self'?actor:undefined,list: () => ({items:[actor],after:1})};
try {
  createActors({...authority,get:()=>classifiedActor},'self').get();
  throw new Error('Actor client accepted kind');
} catch(error) {if (!(error instanceof WorkspaceError) || error.code!=='invalid_input') throw error;}
const store = openSqlite(':memory:');
try {
  const actors = createActors(authority,'self');
  const work = createWork(actors,store);
  const messages = createMessages(actors,store,work);
  const forms = createForms(actors,work,store);
  const ticket = Work.parse(work.create({goal:'Consume exported clients',ownerID:'self'}));
  messages.send({recipientID:'self',text:'Durable public message',workID:ticket.ticketID});
  forms.create({workID:ticket.ticketID,respondentIDs:['self'],fields:[{name:'answer',label:'Ready?',required:true}]});
  const clients = bindWorkspace(authority,store,'self');
  const server = createMcpServer(clients,'viewer');
  await server.close();
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
      ],
      { cwd: dir, stdio: "pipe" },
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [join(dir, "consumer.js")], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.deepEqual(result, { goal: "Consume exported clients", messages: 1, forms: 1 });
    const installed = JSON.parse(
      readFileSync(join(dir, "node_modules/@uniac/agentic-workspace/package.json"), "utf8"),
    );
    assert.equal(installed.private, true);
    assert.equal(Object.keys(installed.exports).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
