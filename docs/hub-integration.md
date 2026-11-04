# Hub integration

Hub embeds this package under its canonical Actor authority. Hub owns identity, admission, retained manager relationships and tool exposure; the package owns its records, contracts and SQLite schema.

## Required host authority

Bind the actual admitted Actor ID to a canonical synchronous `ActorAuthority` and one organization's `WorkspaceStore`. `get` retains visibility. `within(callerID, actorID, ancestorID): boolean` returns true for the anchor itself or any descendant through retained manager edges. Both IDs must exist; unknown member/anchor returns false, even when equal. Include closed members and anchors with no Team depth limit. `manager(callerID, actorID): string | null` returns an Actor's retained manager, closed or not, and null for the root and for unknown IDs. Revalidate the admitted caller as for other authority reads.

Implement canonical ancestry at its owner: retained Registry get/manager edges. Team's depth-limited open-report view and the active Directory cannot supply complete historical membership. Workspace stores no hierarchy, Actor kind, relationship edit or fallback registry. Its bound `ActorsClient.within(actorID, ancestorID)` validates ID criteria and revalidates the active caller before delegation, without selected-profile lookup or caller substitution.

## Adopting 0.6

0.6 changes the public contracts and the persistence interface; Hub's bindings change with it.

- **Persistence.** `RecordTable.all()` is replaced by `where(filter)`. It returns the current snapshots, in cursor order, whose every filtered indexed column holds one of the listed values; `where({})` returns every row. `values(column, filter)` returns one column's distinct values among the rows a filter keeps. The `WorkspaceStore` types name each table's indexed columns.
- **Upgrade.** `openSqlite` upgrades a 0.5 database (version 3) to version 4 on first open. The upgrade adds the indexed columns and rewrites no record; see [persistence](design.md#persistence-and-state-changes). Back up the home before the first start on 0.6.
- **Status is removed** (`status_set`, `status_get`, `StatusContracts`, the `Status` and `StatusState` schemas and types, `createStatus`, `StatusClient`, `/status` and `bindWorkspace().status`). Hosts derive an Actor's headline from its Work. A 0.5 database's `status` and `status_history` tables stay in the file, unread.
- **Directory tools are removed** (`actor_get`, `actor_list`, `ActorContracts`, `Page`, `pageOf`, `ListInput` and `ActorsClient.list`). `ActorAuthority` drops `list`: an object literal typed `ActorAuthority` that still declares it no longer compiles, and on any other host object it is never called. `ActorsClient` keeps `get` and `within` for the other modules, and its input schema is `ActorQuery`.
- **Messages are open.** Any active Actor reads any message and any conversation. `message_send` and `message_list` are at the Report level, and a message to oneself is refused with `invalid_input`. `message_list` takes exactly one of `between: [a, b]`, `counterpartyID` or `of` ([Messages](contracts.md#messages)). `direction` and a read with no selector are refused. A `{counterpartyID, before: "latest"}` read returns what it did, but a `next` or `older` position issued by 0.5 is refused with `invalid_input`; a stored `seq` still continues a forward read. A reader of an Actor's input across conversations pages `of` until a conversation's latest `seq` is one it has handled, then reads each newer conversation `after` its position.
- **`ActorAuthority.manager` is required.** It is used to find a closed requester's nearest open manager. `ActorsClient` gains `manager(actorID)`, and `standIn` in `/actors` returns an Actor's ID while it is open, its nearest open manager's once it is closed, or null when no manager is open (a chain that loops counts as none).
- **Refusals name their issues.** An input outside a contract is refused with `invalid_input` and a message naming each schema issue (`path: message`), as the Hub's own validation does, instead of one fixed sentence.
- **Work status.** `blocked` is gone: `work_update` refuses it with a message naming the habit (ask, or stay active with `waitsOn`), the same words from the Workspace and from a host that validates with the contract, and `work_list` refuses it as a `status` filter. A stored `blocked` reads as `active`, so a `status: ["active"]` filter finds it. `cancelled` is new: the requester sets it with `expectedRevision` on `open`, `active` or `changes_requested` Work, and it is terminal.
- **`work_review` is replaced by `work_answer`** (Team): `{askID: submissionID, ticketID?, answers: {verdict}, note?}`, where the note is the comment and requesting changes needs one. It takes no `expectedRevision`. A submission is found by its ID alone while it is current. With `ticketID`, an earlier submission of that Work conflicts, and an ID that was never one of its submissions is `not_found`. `raise` is refused for a submission.
- **A closed requester's rights** (goal, owner, cancel and the answer to its submission) pass to its nearest open manager.
- **Tools.** The execution server exposes 14 tools and the viewer 6.
- **Subtree filters.** `ownerWithin` and `requesterWithin` call `ActorAuthority.within` once for each Actor the column holds, not once per row. Owner, requester and status lookups decode only the rows they select.

## Adopting 0.5

0.5 changes the public contracts; Hub's bindings and stored-record checks change with it.

- **Levels.** Every contract carries `level`: `report`, `team` or `organization`. Hub's tool definitions can carry the tag through to the clients that present a level.
- **Records.** Work and Form records carry `revision` and `updatedAt` and no `cursor`. History is present only on `work_get`/`form_get` with `history: true`, never on lists or write results.
- **Lists.** `work_list`, `form_list` and `message_list` return `{items, next, actors}` (`List<T>`); `message_list` adds `older`. `next` and `older` are opaque positions passed back as `after`/`before`. `actor_list` keeps the directory's `{items, after}` (`Page<T>`). `status` filters take a list, and `requesterID` takes one ID or a list.
- **Work.** `work_create` takes a required `title`, an optional `goal`, and an `ownerID` that defaults to the caller; Work gains `links`, `waitsOn` and `completedAt`. Owner writes and reviews take `expectedRevision` optionally. Submitting Work the owner requested itself accepts it at once. Accepting needs no comment.
- **Asks.** Forms name no respondents: `respondentIDs` and the `respondentID`, `respondentWithin`, `awaitingActorID` and `awaitingWithin` filters are gone. An ask gains `title`, `context`, `links`, `cause`, `approval`, `collect`, option `detail` and `recommended`. Any Actor answers, with an optional `note`, and each response is `{answers, note?, at}` under its responder. The first answer resolves an ask unless it collects. Only the asker's strict ancestors answer an approval, through the same `within` relation.
- **Status.** A new module: `status_set` and `status_get`, a `status` table in the same database, `createStatus` at `/status`, and `status` in `bindWorkspace`. The execution server exposes 18 tools and the viewer 9.
- **Messages.** A Message is `{messageID, conversationID, senderID, recipientID, text, createdAt, seq}`, with no `workID`, revision or history. `createMessages(actors, store)` takes no Work reader. `message_list` accepts a `seq` as `after`, so a reader can resume from the last message it handled.
- **Persistence.** `RecordTable` snapshots carry `updatedAt` beside `revision` and `cursor`, and `save` returns the snapshot without history. A check that compares a stored Message with its original state, such as the legacy import's restart verification, leaves out `revision`, `cursor` and `updatedAt`.
- **Upgrade.** `openSqlite` upgrades a 0.4 database in place on first open and refuses one newer than the package; see [persistence](design.md#persistence-and-state-changes). Back up the home before the first start on 0.5, as for any schema change.

## Exposure

Every active admitted Actor may read all organization Work, Forms and Messages and choose any branch. Membership adds no business write role. Hub derives each tool's schema and declaration from the package contracts and uses the existing SDK protocol/transport and admitted principal.

Human and Agent clients use those same offered Tools under ordinary admitted identity. HTTP projections may compose their results; they may not read Registry/DB/admin/Provider/native paths or synthesize an elevated caller. A list's `actors` map names the Actors it mentions under the caller's own Actor visibility. Message delivery positions and dedup remain client responsibilities; organization browsing grants no native execution authority.

## Verification

Node **>=22.13** remains the declared floor; CI and the packed-consumer check use **22.23.4** and **24.22.1**. Canonical host integration must prove inclusive deep/closed membership, active callers, ordinary cross-branch queries, exact schemas and unchanged business writes. The model-free fixture supplies a retained manager map only for package verification.
