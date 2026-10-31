# Agentic Workspace

Durable private P2P messages and organization-shared work tickets and forms for active admitted Actor clients. Four separate clients expose identity/discovery, Messages, Work tracking, and Forms. Execution and viewer MCP servers share their records and authority rules. Work/Form list filters select matching records before pagination; business write roles remain unchanged.

This package composes with Hub's canonical Actor authority and trusted admission. Version 0.3.0 requires the host's synchronous canonical relationship predicate described in the [adapter checkpoint](docs/hub-integration.md). The runnable example uses model-free fixture identities; it is not production admission.

## Run

The package declares Node **>=22.13**, matching Hub's existing engine floor. The tested CI runtimes are **22.23.4** and **24.22.1**; use either, then:

```sh
npm ci --engine-strict
npm run check
npm test
npm run build
npm run --silent start -- --actor requester --purpose execution --db ./fixture.sqlite
```

The last command serves MCP JSON-RPC on stdin/stdout and waits for an MCP client. Use `--purpose viewer` for eight read-only tools over the same database. Fixture Actors are `requester`, `owner`, `respondent`, and `outsider`. `--db` defaults to `:memory:`; a named database retains records between processes. These example flags select fixtures and do not authenticate real callers. No network port is bound. Use `npm run --silent start -- --help` for options.

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
import { createForms } from "@uniac/agentic-workspace/forms";
import { openSqlite } from "@uniac/agentic-workspace/persistence";

function workspace(authority: ActorAuthority, admittedActorID: string, databasePath: string) {
  const store = openSqlite(databasePath);
  const actors = createActors(authority, admittedActorID);
  const work = createWork(actors, store);
  return {
    actors,
    work,
    messages: createMessages(actors, store, work),
    forms: createForms(actors, store, work),
    close: () => store.close(),
  };
}
```

`ActorAuthority.get(callerID, actorID)` and `.list(callerID, query)` own directory visibility and current canonical state. The required synchronous `.within(callerID, actorID, ancestorID): boolean` supplies inclusive retained ancestry, including closed members/anchors at every depth; unknown IDs return false. Bound `ActorsClient.within(actorID, ancestorID)` revalidates its actual active caller without resolving selected profiles or changing identity. Hosts must implement this method when adopting 0.3.0. The workspace stores no Actor rows, hierarchy or credentials. The optional root `bindWorkspace` factory performs the same explicit composition and returns four distinct clients. Contracts and errors are exported at `/contracts`; SDK server construction is exported at `/mcp`.

Work lists accept `ownerWithin` and `requesterWithin`; Form lists accept `requesterWithin`, `respondentWithin` and `awaitingWithin`. These select a canonical position and all descendants, intersecting with existing personal/status filters before pagination. Requester scope expresses where a record originated; it does not establish causal ticket lineage. See [filter and refresh semantics](docs/contracts.md#list-filters).

See [design and accepted graphs](docs/design.md), [contracts and transitions](docs/contracts.md), and [the explicit composition example](examples/consumer.ts). Tests cover requester/owner role swaps, database reopen, history/cursors, authorization, revisions, exact-submission review, SDK calls, stdio process restart, and an external TypeScript consumer importing only package exports.
