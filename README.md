# Agentic Workspace

Durable pair conversations, Work and asks, shared within the organization by active admitted Actor clients. Three separate clients expose identity, Messages, and Work tracking with its asks. Execution and viewer MCP servers share their records and authority rules. Work and ask list filters select matching records before pagination; business write roles remain unchanged.

This package composes with Hub's canonical Actor authority and trusted admission, which names the person, as described in [Hub integration](docs/hub-integration.md). [Changes since 0.0.1](docs/hub-integration.md#changes-since-001) lists what changes for hosts. The runnable example uses model-free fixture identities; it is not production admission.

## Run

The package declares Node **>=22.13**, matching Hub's existing engine floor. The tested CI runtimes are **22.23.4** and **24.22.1**; use either, then:

```sh
npm ci --engine-strict
npm run check
npm test
npm run build
npm run --silent start -- --actor requester --purpose execution --db ./fixture.sqlite
```

The last command serves MCP JSON-RPC on stdin/stdout and waits for an MCP client. Use `--purpose viewer` for four read-only tools over the same database. Fixture Actors are `requester`, `owner`, `respondent`, and `outsider`. `--db` defaults to `:memory:`; a named database retains records between processes. These example flags select fixtures and do not authenticate real callers. No network port is bound. Use `npm run --silent start -- --help` for options.

An MCP client can start the already-built entry point directly:

```json
{
  "command": "node",
  "args": [
    "/absolute/checkout/dist/examples/stdio.js",
    "--actor",
    "requester",
    "--purpose",
    "execution",
    "--db",
    "/absolute/path/fixture.sqlite"
  ]
}
```

## Public clients

Install a local packed artifact (`npm pack`, then `npm install /path/to/archive.tgz`) in another project. Each module has its own public export. Trusted admission supplies the caller ID and a canonical synchronous authority client; tool arguments cannot select the caller.

```ts
import { createActors, type ActorAuthority } from "@uniac/agentic-workspace/actors";
import { createWork } from "@uniac/agentic-workspace/work";
import { createMessages } from "@uniac/agentic-workspace/messages";
import { openSqlite } from "@uniac/agentic-workspace/persistence";

function workspace(authority: ActorAuthority, admittedActorID: string, databasePath: string) {
  const store = openSqlite(databasePath);
  const actors = createActors(authority, admittedActorID);
  return {
    actors,
    work: createWork(actors, store),
    messages: createMessages(actors, store),
    close: () => store.close(),
  };
}
```

`ActorAuthority.get(callerID, actorID)` owns visibility and current canonical state. The required synchronous `.person(): string` names the person, the Actor that stands for the host's user: asks on Work their asker requested itself, or on no Work, go to it, and a closed Actor's rights pass to it. Bound `ActorsClient.person()` revalidates its actual active caller first. Every Actor sits on one flat level, and the workspace stores no Actor rows, relationships or credentials. The optional top-level `bindWorkspace` factory performs the same explicit composition and returns three distinct clients. Contracts and errors are exported at `/contracts`; SDK server construction is exported at `/mcp`.

Lists return `{items, next, actors}`: the page, an opaque position for the next page (null at the end) and the names of the Actors it mentions. Work lists filter by status lists, one or several owners or requesters and `updatedSince`, and go newest first with `order: "recent"`. Records carry `updatedAt`; history comes only from a get with `history: true`. See [lists](docs/contracts.md#lists).

Work is the unit of progress: a title, progress, links and what it waits on, owned and requested by the caller unless it names another owner. Work an Actor requested itself completes when it submits; other Work waits for its requester's answer (`work_answer`). The requester may cancel open, active or changes-requested Work, and a closed requester's rights pass to the person. See [Work](docs/contracts.md#work).

An ask is part of the Work its asker owns: `work_update {ticketID, ask}` adds a title, context, links and fields with options and a recommended choice. Any Actor answers it with `work_answer`, and the first answer resolves it unless it collects answers. An ask goes to its Work's requester, or to the person when its asker requested the Work itself or once the requester is closed, and only that Actor answers an approval, never its asker. `work_get` returns Work with its asks, and `work_list` items carry their open asks. See [asks](docs/contracts.md#asks).

Each Message belongs to its pair's conversation (`conversationID`) and carries its place in the one Message order (`seq`). `messages.list({counterpartyID, before:"latest", limit:20})` returns the caller's conversation with that Actor, newest window ascending, with `older` for the page before it. `{between: [a, b]}` reads any pair's conversation the same way, and either form with `after` goes forward from a `next` position or the last `seq` a reader handled. `{of: actorID}` lists an Actor's conversations, newest first, each as its latest message. Every Actor reads every conversation. See [Messages](docs/contracts.md#messages).

See [design and accepted graphs](docs/design.md), [contracts and transitions](docs/contracts.md), and [the explicit composition example](examples/consumer.ts). Tests cover requester/owner role swaps, database reopen, history/cursors, authorization, revisions, exact-submission review, SDK calls, stdio process restart, and an external TypeScript consumer importing only package exports.

[MIT license](LICENSE).
