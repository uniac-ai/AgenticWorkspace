# Operations, roles and transitions

Runtime request/record schemas and derived TypeScript types are maintained in [src/contracts](../src/contracts/index.ts). Requests are strict objects: extra fields, including caller identity fields, are rejected. IDs/text are trimmed and bounded. The admitted caller comes from trusted client construction. All clients require an active caller on every operation, including reads. Directory visibility is owned by canonical Actor authority. Work, Forms and Status are shared within the admitted Hub organization; Messages is private to its parties. Record roles determine write permissions.

## Tool inventory

Every successful write returns the resulting record: its stable ID, `revision` and `updatedAt`, the time of the write that produced the current revision. History comes only from `work_get`, `form_get` and `status_get` with `history: true`. Execution MCP exposes every row below. Viewer MCP exposes only reads. Actor lifecycle administration is outside this inventory.

Each contract carries `level`, the smallest organization level that presents it. Report is one agent and its person; Team adds working with other Actors; Organization adds the lifecycle and the system, none of which is in this package. Each level contains the one before it. The tag selects what a client presents; it grants and refuses nothing.

| Tool         | Level  | Input                                                                                                                                    | Purpose                                                |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| actor_get    | Team   | `{actorID?}`                                                                                                                             | Read self by default or a visible Actor                |
| actor_list   | Team   | `{after?,limit?}`                                                                                                                        | Read canonical visible directory                       |
| message_send | Team   | `{recipientID,text}`                                                                                                                     | Send into the pair's conversation                      |
| message_get  | Team   | `{messageID}`                                                                                                                            | Read one message as a party                            |
| message_list | Team   | `{direction?:incoming\|outgoing\|all,counterpartyID?,before?:latest\|older,after?:next\|seq,limit?}`                                     | Read a conversation or the caller's input              |
| work_create  | Report | `{title,goal?,ownerID?,links?,waitsOn?}`                                                                                                 | Create Work; caller requests it and owns it by default |
| work_get     | Report | `{ticketID,history?}`                                                                                                                    | Read a ticket, including accepted work                 |
| work_list    | Report | `{ownerID?,requesterID?:id\|id[],waitsOnActorID?,ownerWithin?,requesterWithin?,status?:[...],updatedSince?,order?:recent,after?,limit?}` | Read matching shared tickets                           |
| work_update  | Report | `{ticketID,expectedRevision?,title?,goal?,ownerID?,progress?,status?:open\|active\|blocked,links?,waitsOn?}`                             | Update at least one allowed field                      |
| work_submit  | Report | `{ticketID,expectedRevision?,result,evidence?}`                                                                                          | Submit; self-requested Work completes                  |
| work_review  | Team   | `{ticketID,expectedRevision?,submissionID,verdict:accepted\|changes_requested,comment?}`                                                 | Review the exact current submission                    |
| form_create  | Report | `{title,context?,links?,workID?,cause?,approval?,collect?,fields:[{name,label,required,options?:[{value,detail?}],recommended?}]}`       | Ask                                                    |
| form_get     | Report | `{formID,history?}`                                                                                                                      | Read an ask                                            |
| form_list    | Report | `{workID?,requesterID?:id\|id[],requesterWithin?,status?:[...],updatedSince?,order?:recent,after?,limit?}`                               | Read matching shared asks                              |
| form_respond | Team   | `{formID,expectedRevision?,answers:{field:value},note?}`                                                                                 | Answer an open ask                                     |
| form_close   | Report | `{formID,expectedRevision,status:resolved\|cancelled,resolution}`                                                                        | The asker resolves or cancels its ask                  |
| status_set   | Report | `{line?,summary?,links?}`                                                                                                                | Set the caller's status                                |
| status_get   | Report | `{actorID?,history?}`                                                                                                                    | Read an Actor's status, the caller's by default        |

A Form is an ask; the tools keep the `form_*` names.

## Authority

- Messages are private to sender and recipient and expose only send/get/list. A reply is another message in the same conversation. Messages have no read, delivery or handling state, and reading changes nothing. The recipient must be active when the message is sent.
- Every active admitted Actor may get/list all organization Work, including history and accepted tickets. The requester edits goal and owner and reviews. The current owner edits title, progress, status, links and waitsOn, and submits. Reassignment changes write roles and filter membership; it does not remove shared read access. New owner must be active.
- Every active admitted Actor may get/list all organization asks and history, and may ask. Any active Actor may answer an open ask, except an approval, which only the asker's managers answer. Only the asker closes its ask. Answering and closing never change Work, and Form reads never consult Work. Active callers retain shared history reads when counterparties close.
- Every active admitted Actor may read any Actor's status. Only the Actor itself sets it.

The host composes canonical Actor authority and a WorkspaceStore for one Hub organization. Public read does not construct an elevated identity or alter directory visibility. List criteria do not select the caller or grant write authority.

## Lists

`work_list`, `form_list` and `message_list` return `{items, next, actors}`. `actors` maps every Actor ID the page mentions to `{name}`, leaving out Actors the caller's directory can't see. `next` is an opaque position, or null when the read observed no further matching rows. Pass it back as `after` with the same filters to continue; a position from another read, filter or order is refused with `invalid_input`. Work and Form records carry no position of their own.

Work and Form lists go in update order by default: a record moves to the end of that order whenever it changes. `order: "recent"` goes newest first. `updatedSince` keeps records whose `updatedAt` is at or after the given time, which is how a reader picks up changes since it last looked. Lists are current upserts, not snapshots: a record updated during a traversal can appear again later in update order, and a record that stops matching leaves no tombstone. Paging `order: "recent"` can skip a record that is updated between page reads, because the update moves it to the front, ahead of the pages already read. That suits a view that refetches its first page when records change; it is not a way to read every record. A reader that needs a complete current view pages in update order or lists again from the start, and reconciles IDs.

The page `limit` defaults to 50 and is at most 100. It bounds the returned rows, not the scan: the v1 adapter loads current snapshots and applies every filter before the limit.

### Filters

Work accepts `ownerID`, `requesterID`, `waitsOnActorID`, `status`, `ownerWithin`, `requesterWithin` and `updatedSince`. Forms accepts `workID`, `requesterID`, `status`, `requesterWithin` and `updatedSince`. All supplied filters intersect. `requesterID` takes one ID or a list, matching any of them; `status` takes a list of the module's status values, matching any of them. ID filters use exact equality; `waitsOnActorID` matches Work waiting on that Actor. Filter IDs do not trigger Actor lookup; unknown IDs yield empty matching sets. Omit filters to list all shared records.

Subtree criteria use the required host `ActorAuthority.within(callerID, actorID, ancestorID)`, which tests the named canonical position and every descendant through retained relationships, including closed Actors and closed anchors without a depth limit. Unknown members or anchors return false. Bound `ActorsClient.within(actorID, ancestorID)` revalidates the admitted caller and delegates membership without selected-profile lookup or caller substitution.

`ownerWithin` tests current Work ownership; `requesterWithin` tests immutable record requester, the scope from which it originated. Neither implies causal ticket lineage. Any active caller may query any branch; membership grants no write role or Message access.

## Messages

A Message is `{messageID, conversationID, senderID, recipientID, text, createdAt, seq}` and never changes after it is sent.

- **`conversationID`** names the one ordered series the message belongs to. In this version it is derived from the pair, so each pair has one direct conversation, both directions included, and a message to oneself has its own. It is opaque: clients compare it and key their own positions by it.
- **`seq`** is the message's place in the one Message order, which spans every conversation and follows commit order. Clients compare it with their own positions, such as a seen-through or delivered-through `seq`.

`message_list` reads one of two ways, and returns `{items, next, older, actors}` with items ascending.

- **Forward:** omit `before`. Rows after `after` (a `next` token or a `seq`; default from the start) come in order up to `limit`. `{direction: "incoming", after}` is an Actor's input across its conversations; with `counterpartyID` it is one conversation.
- **Newest window:** `before: "latest"` selects the last `limit` matching rows; `before: older` continues toward the start. It works with or without `counterpartyID`. `before` and `after` are exclusive.

`next` continues forward from the last returned row and is null when nothing newer matched; `older` continues back from the first returned row and is null at the start. A client may keep a `seq` instead of `next`, since `after` accepts either: a forward read that reached the end resumes from the last `seq` it handled. A newest window captures the Message head once, so messages sent during the read wait for the next read. Self selection matches self-to-self once. Listing does not resolve the selected peer or require it to be active; closed-peer history remains readable to an active party. Root, manager and subtree membership grant no Message access.

## Work

Work is the unit of progress. A Work record holds:
- `title` (at most 120 characters) and an optional `goal`;
- `progress`: a paragraph, then optionally a Markdown task list of steps, where `- [x]` marks a step done and `- [ ]` one not done. Readers take the first step not done as the current one and render a plain list as numbered steps. The Workspace stores the text as written and parses none of it;
- `status`;
- `links`, each `{label?, url}` with an http or https URL;
- an optional `waitsOn`: an Actor (`{actorID}`), other Work (`{ticketID}`) or a short description (`{text}`);
- `submission` and `review`, and `completedAt` once accepted.

`work_create` makes the caller the requester and, unless `ownerID` names another active Actor, the owner. A waited-on Actor or Work must exist. `work_update` sets `waitsOn: null` to clear it and `links: []` to empty them.

New Work is `open`. In `open`, `active`, `blocked` or `changes_requested`, the owner may edit its fields and set `open`, `active` or `blocked`, and the requester may edit goal and owner. `work_submit` records a new submission. On Work its owner requested itself it completes at once: `accepted`, with `completedAt` and no review. Other Work enters `submitted` and is frozen until the requester reviews the exact current submission. Accepting needs no comment, sets `completedAt` and is terminal; requesting changes needs a comment and returns the Work to its owner. Follow-up work gets a new ticket.

`expectedRevision` is optional on the owner's writes (edits and submit), which no one else makes, and on a review, which the `submissionID` pins. Goal and owner edits require it. The state, role and revision checks and the snapshot/history writes share one SQLite transaction; a stale revision or a noncurrent submission conflicts. Resubmission retains prior evidence and reviews in history.

## Asks

An ask is its asker's own output: it names no one to answer it. It holds:
- `title` (at most 120 characters), optional `context` and `links`;
- `fields`: each has a `name`, a `label` and `required`, and may have `options`, each `{value, detail?}`, and the asker's `recommended` value among them. A one-field ask with options is a decision; without options, a question;
- optional `workID`, the existing shared Work it blocks, and `cause`, the existing ask of a report that this ask carries up;
- `approval` and `collect`, both false by default.

Any active Actor may answer an open ask with `form_respond`: a complete answer set, where required fields are nonblank, every named field exists and a choice matches an option, and an optional `note`. The response is recorded under its responder with the time it was given; a responder that answers again replaces its own response, and history keeps every earlier one. The first answer resolves the ask. An ask with `collect` stays open for more answers until its asker closes it. `expectedRevision` is optional on an answer: an answer to a resolved ask conflicts, and answers to a collecting ask don't overwrite each other.

An `approval` ask authorizes something that can't be undone, so only the asker's strict ancestors answer it: its managers up to the root, never the asker itself. The Workspace tests this with the host's `within` relation, so it needs no root identity. The root's own approvals have no one above to answer them; the asker closes them, as it does to record an answer its person gave in its session.

The asker closes its open ask with `form_close`, with `expectedRevision`, as `resolved` with a `resolution` (ending a collection, or recording an answer given elsewhere) or `cancelled`. A closed ask doesn't change again.

## Status

Each Actor has one status, replaced in place: an optional `line` (at most 160 characters), an optional `summary` (at most 1,200) and `links`. It holds no state: an Actor's state is derived from its Work and asks. `status_set` changes the fields it names and keeps the others; only the Actor itself sets it. `status_get` reads any Actor's status, the caller's by default, and is `not_found` until the Actor first sets one.

## Errors and protocol

Domain clients throw `WorkspaceError` with `invalid_input`, `not_found`, `forbidden` or `conflict`. Reads of inaccessible IDs use `not_found`. MCP successes include record/page `structuredContent` plus equivalent JSON text and an advertised output schema. MCP tool errors set `isError:true` and carry JSON text `{code,message}`; they omit structured content to avoid success-schema validation. Unexpected failures become generic `internal_error` without raw exception text. Discovery uses SDK protocol errors: domain refusals return invalid-request errors with public text; unexpected failures return internal errors with the same generic public message. Viewer calls to a mutation are refused even when sent directly without discovery.
