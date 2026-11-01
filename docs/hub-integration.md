# Hub integration

Hub embeds this package under its canonical Actor authority. Hub owns identity, admission, retained manager relationships and tool exposure; the package owns its records, contracts and SQLite schema.

## Required host authority

Bind the actual admitted Actor ID to a canonical synchronous `ActorAuthority` and one organization's `WorkspaceStore`. `get` and `list` retain directory visibility. `within(callerID, actorID, ancestorID): boolean` returns true for the anchor itself or any descendant through retained manager edges. Both IDs must exist; unknown member/anchor returns false, even when equal. Include closed members and anchors with no Team depth limit. Revalidate the admitted caller as for other authority reads.

Implement canonical ancestry at its owner: retained Registry get/manager edges. Team's depth-limited open-report view and the active Directory cannot supply complete historical membership. Workspace stores no hierarchy, Actor kind, relationship edit or fallback registry. Its bound `ActorsClient.within(actorID, ancestorID)` validates ID criteria and revalidates the active caller before delegation, without selected-profile lookup or caller substitution.

## Adopting 0.5

0.5 changes the public contracts; Hub's bindings and stored-record checks change with it.

- **Levels.** Every contract carries `level`: `report`, `team` or `organization`. Hub's tool definitions can carry the tag through to the clients that present a level.
- **Records.** Work and Form records carry `revision` and `updatedAt` and no `cursor`. History is present only on `work_get`/`form_get` with `history: true`, never on lists or write results.
- **Lists.** `work_list`, `form_list` and `message_list` return `{items, next, actors}` (`List<T>`); `message_list` adds `older`. `next` and `older` are opaque positions passed back as `after`/`before`. `actor_list` keeps the directory's `{items, after}` (`Page<T>`). `status` filters take a list, and `requesterID` takes one ID or a list.
- **Messages.** A Message is `{messageID, conversationID, senderID, recipientID, text, createdAt, seq}`, with no `workID`, revision or history. `createMessages(actors, store)` takes no Work reader. `message_list` accepts a `seq` as `after`, so a reader can resume from the last message it handled.
- **Persistence.** `RecordTable` snapshots carry `updatedAt` beside `revision` and `cursor`, and `save` returns the snapshot without history. A check that compares a stored Message with its original state, such as the legacy import's restart verification, leaves out `revision`, `cursor` and `updatedAt`.
- **Upgrade.** `openSqlite` upgrades a 0.4 database in place on first open and refuses one newer than the package; see [persistence](design.md#persistence-and-state-changes). Back up the home before the first start on 0.5, as for any schema change.

## Exposure

Every active admitted Actor may read all organization Work and Forms and choose any branch. Membership adds no business write role or Message access. Messages stay private to their two parties. Hub derives each tool's schema and declaration from the package contracts and uses the existing SDK protocol/transport and admitted principal.

Human and Agent clients use those same offered Tools under ordinary admitted identity. HTTP projections may compose their results; they may not read Registry/DB/admin/Provider/native paths or synthesize an elevated caller. A list's `actors` map names the Actors it mentions under the caller's own directory visibility. Message delivery positions and dedup remain client responsibilities; organization browsing grants no native execution authority.

## Verification

Node **>=22.13** remains the declared floor; CI and the packed-consumer check use **22.23.4** and **24.22.1**. Canonical host integration must prove inclusive deep/closed membership, active callers, ordinary cross-branch queries, exact schemas and unchanged business writes and Message privacy. The model-free fixture supplies a retained manager map only for package verification.
