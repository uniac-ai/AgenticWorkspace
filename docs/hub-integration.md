# Hub integration

Hub embeds this package under its canonical Actor authority. Hub owns identity, admission, which Actor is the person, and tool exposure; the package owns its records, contracts and SQLite schema.

## Required host authority

Bind the actual admitted Actor ID to a canonical synchronous `ActorAuthority` and one organization's `WorkspaceStore`. The authority has two methods, and every Actor sits on one flat level:

- **`get(callerID, actorID): Actor | undefined`** returns the Actor the caller may see, open or closed, with its current state, and the caller itself; `undefined` for an unknown or hidden ID.
- **`person(): string`** returns the person's Actor ID: the Actor that stands for the host's user, such as Hub's first Actor. The Workspace calls it only after revalidating an active caller. The person must be an Actor `get` returns, and Hub keeps it open, since rights that pass to a closed person pass to no one active.

The Workspace uses the person in two ways. An ask on Work its asker requested itself, or on no Work, goes to the person. A closed Actor's requester rights, its asks' closing and the asks routed to it pass to the person. The Workspace stores no Actor rows, relationships or person.

## Changes in 0.0.2

0.0.2 changes the public contracts from 0.0.1 (commit 26fd0ee) and keeps storage version 4, so a 0.0.1 store opens unchanged and needs no upgrade.

- **`ActorAuthority` is `{get, person}`.** `within` and `manager` are removed: an object literal typed `ActorAuthority` that still declares either no longer compiles, and on any other host object they are never called. `ActorsClient` drops `within` and `manager` and gains `person()`.
- **Routing.** An ask goes to its Work's requester. When its asker requested the Work itself, or it names no Work, it goes to the person. A closed requester's asks go to the person. `WorkClient.asks({routedTo})` follows this, counting a requester the caller can't see as closed, and reads each open ask the other filters keep.
- **Approvals.** Only the Actor an approval is routed to answers it, never its asker. An approval the person asks that routes back to the person, on Work it requested itself, on Work whose requester is closed, or on no Work, has no one to answer it: it stays open until the person closes it.
- **Stand-ins.** A closed Actor's stand-in is the person: a closed requester's rights (goal, owner, cancel and the answer to its submission) and a closed asker's close pass to it. `standIn` in `/actors` returns an Actor's ID while it is open and the person's once it is closed, and throws `not_found` at an Actor the caller can't see; `routedStandIn` counts such an Actor as closed. Both return a string, never null.
- **The person asks** on Work it owns, like any Actor.
- **Raising is removed:** `work_answer`'s `raise`, the `Raise` schema and an ask's `raises`. `work_answer` requires `answers`. An ask stored with `raises` reads without them, its next write stores it without them, and history keeps every `raised` event.
- **Filters.** `ownerWithin` and `requesterWithin` are removed and refused as unknown fields. `ownerID` takes one ID or a list, as `requesterID` does.
- **Tool levels are removed.** Contracts carry no `level`, `contract` takes `(description, input, output, writes)`, and `Level` is no longer exported. Every tool is offered to every Actor. The execution server exposes 9 tools and the viewer 4, as before.
- **Persistence.** `RecordTable.values` is removed, and the forms table's type no longer names `route`. The `route` column stays in the file, unread; its index, which leads with `status`, still serves status selects.

Earlier changes are in [the 0.0.1 Hub integration](https://github.com/uniac-ai/AgenticWorkspace/blob/v0.0.1/docs/hub-integration.md).

## Exposure

Every active admitted Actor may read all organization Work, asks and Messages. Reading adds no business write role. Hub derives each tool's schema and declaration from the package contracts and uses the existing SDK protocol/transport and admitted principal.

Human and Agent clients use those same offered Tools under ordinary admitted identity. HTTP projections may compose their results; they may not read Registry/DB/admin/Provider/native paths or synthesize an elevated caller. A list's `actors` map names the Actors it mentions under the caller's own Actor visibility. Message delivery positions and dedup remain client responsibilities; organization browsing grants no native execution authority.

## Verification

Node **>=22.13** remains the declared floor; CI and the packed-consumer check use **22.23.4** and **24.22.1**. Canonical host integration must prove active callers, the person's stand-in rights and routes, exact schemas and unchanged business writes. The model-free fixture names `requester` as the person only for package verification.
