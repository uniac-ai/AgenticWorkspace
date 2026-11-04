# Operations, roles and transitions

Runtime request/record schemas and derived TypeScript types are maintained in [src/contracts](../src/contracts/index.ts). Requests are strict objects: extra fields, including caller identity fields, are rejected. IDs/text are trimmed and bounded. The admitted caller comes from trusted client construction. All clients require an active caller on every operation, including reads. Visibility is owned by canonical Actor authority. Work, its asks and Messages are shared within the admitted Hub organization. Record roles determine write permissions.

## Tool inventory

Every successful write returns the resulting record: its stable ID, `revision` and `updatedAt`, the time of the write that produced the current revision. History comes only from `work_get` with `history: true`, for the Work and each of its asks. Execution MCP exposes every row below. Viewer MCP exposes only reads. Actor lifecycle administration is outside this inventory.

Each contract carries `level`, the smallest organization level that presents it. Report is one agent and its person; Team adds working with other Actors; Organization adds the lifecycle and the system, none of which is in this package. Each level contains the one before it. The tag selects what a client presents; it grants and refuses nothing.

| Tool         | Level  | Input                                                                                                                                         | Purpose                                                   |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| message_send | Report | `{recipientID,text}`                                                                                                                          | Send into the pair's conversation                         |
| message_get  | Team   | `{messageID}`                                                                                                                                 | Read one message                                          |
| message_list | Report | `{between:[id,id]\|counterpartyID\|of,before?:latest\|older,after?:next\|seq,limit?}`                                                         | Read a conversation, or list an Actor's conversations     |
| work_create  | Report | `{title,goal?,ownerID?,links?,waitsOn?}`                                                                                                      | Create Work; caller requests it and owns it by default    |
| work_get     | Report | `{ticketID\|askID,history?}`                                                                                                                  | Read Work with all its asks, or an older ask with no Work |
| work_list    | Report | `{ownerID?,requesterID?:id\|id[],waitsOnActorID?,ownerWithin?,requesterWithin?,status?:[...],updatedSince?,order?:recent,after?,limit?}`      | Read matching shared Work, each with its open asks        |
| work_update  | Report | `{ticketID,expectedRevision?,title?,goal?,ownerID?,progress?,status?:open\|active\|cancelled,links?,waitsOn?}`, `{ticketID,ask}` or `{close}` | Edit or cancel Work; ask on it; close an ask              |
| work_submit  | Report | `{ticketID,expectedRevision?,result,evidence?}`                                                                                               | Submit; self-requested Work completes                     |
| work_answer  | Team   | `{askID,ticketID?,answers?:{field:value},note?,raise?:true}`                                                                                  | Answer or raise an ask, or answer the current submission  |

`work_get`, `work_update` and `work_answer` return the record the call reads or writes: Work, or an ask. An ask has `formID` and Work has `ticketID`, and each result schema is their union.

## Authority

- Every active admitted Actor may read every message and every conversation. An Actor sends to any other active Actor, never to itself. A reply is another message in the same conversation. Messages have no read, delivery or handling state, and reading changes nothing.
- Every active admitted Actor may get/list all organization Work, including history and accepted tickets. The requester edits goal and owner, cancels and answers the submission; once it is closed, its nearest open manager does. The current owner edits title, progress, status, links and waitsOn, and submits. Reassignment changes write roles and filter membership; it does not remove shared read access. New owner must be active.
- Every active admitted Actor may read every ask and its history, with its Work. The Work's owner asks on it, except the root. Any active Actor may answer an open ask, except an approval, which only the asker's managers answer. The Actor an ask is routed to may raise it, except the root. The asker closes its ask; once it is closed, its nearest open manager does. Asking, answering, raising and closing never change the Work row. Active callers retain shared history reads when counterparties close.

The host composes canonical Actor authority and a WorkspaceStore for one Hub organization. Public read does not construct an elevated identity or alter Actor visibility. List criteria do not select the caller or grant write authority.

## Lists

`work_list`, `message_list` and the hosts' `WorkClient.asks` return `{items, next, actors}`. `actors` maps every Actor ID the page mentions to `{name}`, leaving out Actors the caller can't see. `next` is an opaque position, or null when the read observed no further matching rows. Pass it back as `after` with the same filters to continue; a position from another read, filter or order is refused with `invalid_input`. Work and ask records carry no position of their own.

Work and ask lists go in update order by default: a record moves to the end of that order whenever it changes. `work_list`'s `order: "recent"` goes newest first, and its `updatedSince` keeps records whose `updatedAt` is at or after the given time, which is how a reader picks up changes since it last looked. Lists are current upserts, not snapshots: a record updated during a traversal can appear again later in update order, and a record that stops matching leaves no tombstone. Paging `order: "recent"` can skip a record that is updated between page reads, because the update moves it to the front, ahead of the pages already read. That suits a view that refetches its first page when records change; it is not a way to read every record. A reader that needs a complete current view pages in update order or lists again from the start, and reconciles IDs.

The page `limit` defaults to 50 and is at most 100. It bounds the returned rows, not the scan. Owner, requester, status, Work and route filters select rows through indexed columns, and the adapter decodes only the snapshots they keep. A subtree filter reads membership once for each Actor the column holds among the rows the other indexed filters keep, not once per row. The remaining filters then apply before the limit. A list reads the rows committed before it starts; a row committed during the read waits for the next one. The open asks a `work_list` page carries are read after the page.

### Filters

Work accepts `ownerID`, `requesterID`, `waitsOnActorID`, `status`, `ownerWithin`, `requesterWithin` and `updatedSince`. The hosts' `WorkClient.asks` accepts `requesterID`, `routedTo` (open asks routed to that Actor), `answeredBy` (asks with a response by that Actor) and `status`. All supplied filters intersect. `work_list`'s `requesterID` takes one ID or a list, matching any of them, and the asks read's takes one ID; `status` takes a list of the module's status values, matching any of them. ID filters use exact equality; `waitsOnActorID` matches Work waiting on that Actor. Filter IDs do not trigger Actor lookup, except `routedTo`, which walks each open ask's route through the host's `manager` and treats an Actor the caller can't see as closed; unknown IDs yield empty matching sets. Omit filters to list all shared records.

Subtree criteria use the required host `ActorAuthority.within(callerID, actorID, ancestorID)`, which tests the named canonical position and every descendant through retained relationships, including closed Actors and closed anchors without a depth limit. Unknown members or anchors return false. Bound `ActorsClient.within(actorID, ancestorID)` revalidates the admitted caller and delegates membership without selected-profile lookup or caller substitution.

`ownerWithin` tests current Work ownership; `requesterWithin` tests immutable record requester, the scope from which it originated. Neither implies causal ticket lineage. Any active caller may query any branch; membership grants no write role.

## Messages

A Message is `{messageID, conversationID, senderID, recipientID, text, createdAt, seq}` and never changes after it is sent.

- **`conversationID`** names the one ordered series the message belongs to. In this version it is derived from the pair, so each pair has one direct conversation, both directions included. A message to oneself, which earlier builds accepted and this one refuses, has its own. It is opaque: clients compare it and key their own positions by it.
- **`seq`** is the message's place in the one Message order, which spans every conversation and follows commit order. Clients compare it with their own positions, such as a seen-through or delivered-through `seq`.

`message_list` takes exactly one of three selectors and returns `{items, next, older, actors}`. No read mixes several conversations into one list.

- **`between: [a, b]`** reads that pair's conversation, in either order. `[a, a]` reads a self conversation stored before self messages were refused.
- **`counterpartyID`** reads the caller's conversation with that Actor, the same as `between: [caller, counterpartyID]`. A position from one form continues the other.
- **`of`** lists that Actor's conversations, newest first. Each item is its conversation's latest message, and the counterparty is its party other than `of`; a self conversation stored before self messages were refused is listed too, with `of` as both parties. `next` continues to older conversations, and `older` is null. `of` takes no `before`, and its `after` is a `next` position. A conversation that gets a message between page reads moves to the front, as with `order: "recent"`.

A conversation reads one of two ways, with items ascending.

- **Forward:** omit `before`. Rows after `after` (a `next` token or a `seq`; default from the start) come in order up to `limit`.
- **Newest window:** `before: "latest"` selects the last `limit` rows; `before: older` continues toward the start. `before` and `after` are exclusive.

`next` continues forward from the last returned row and is null when nothing newer matched; `older` continues back from the first returned row and is null at the start. A client may keep a `seq` instead of `next`, since `after` accepts either: a forward read that reached the end resumes from the last `seq` it handled. A newest window captures the Message head once, so messages sent during the read wait for the next read. Listing does not resolve the named Actors or require them to be active, so a closed Actor's conversations stay readable.

## Work

Work is the unit of progress. A Work record holds:
- `title` (at most 120 characters) and an optional `goal`;
- `progress`: a paragraph, then optionally a Markdown task list of steps, where `- [x]` marks a step done and `- [ ]` one not done. Readers take the first step not done as the current one and render a plain list as numbered steps. The Workspace stores the text as written and parses none of it;
- `status`: `open`, `active`, `submitted`, `changes_requested`, `accepted` or `cancelled`;
- `links`, each `{label?, url}` with an http or https URL;
- an optional `waitsOn`: an Actor (`{actorID}`), other Work (`{ticketID}`) or a short description (`{text}`);
- `submission` and `review`, and `completedAt` once accepted.

`work_create` makes the caller the requester and, unless `ownerID` names another active Actor, the owner. A waited-on Actor or Work must exist. `work_update` sets `waitsOn: null` to clear it and `links: []` to empty them.

New Work is `open`. In `open`, `active` or `changes_requested`, the owner may edit its fields and set `open` or `active`, and the requester may edit goal and owner, or set `cancelled`. Cancelled Work is terminal and frozen. Work that can't move without someone asks; Work held up outside the organization, or by other Work, stays `active` and says what it waits on. So `blocked` is refused, with a message that says so. A Work row stored as `blocked`, before `blocked` was refused, reads as `active` in every read, filter and rule; its next write stores `active`, and its history keeps the `blocked` write.

`work_submit` records a new submission. On Work its owner requested itself it completes at once: `accepted`, with `completedAt` and no review. Other Work enters `submitted` and is frozen until its requester answers the current submission with `work_answer`. The answer names the submission by its ID (`askID`, with an optional `ticketID` that must be the Work it is on) and gives `answers: {verdict}`; its `note` is the comment. It is stored as `review`. Accepting needs no note, sets `completedAt` and is terminal; requesting changes needs a note and returns the Work to its owner. Follow-up work gets a new ticket.

Once the requester is closed, its rights pass to its nearest open manager: the first open Actor up its retained managers. That Actor edits goal and owner, cancels, and answers the submission. Rights never pass past an Actor the caller can't see: the write is refused with `not_found`.

`expectedRevision` is optional on the owner's writes (edits and submit), which no one else makes. Goal, owner and cancel edits require it. An answer takes none: its submission ID pins it. The state, role and revision checks and the snapshot/history writes share one SQLite transaction; a stale revision conflicts. By its ID alone a submission is found only while it is current; named with its `ticketID`, an earlier submission of that Work conflicts, and an ID that was never one of its submissions is `not_found`. Resubmission retains prior evidence and reviews in history.

## Asks

An ask is part of the Work its asker owns: `work_update {ticketID, ask}` asks on it, and returns the new ask. The ask names no one to answer it. It holds:
- `title` (at most 120 characters), optional `context` and `links`;
- `fields`: each has a `name`, a `label` and `required`, and may have `options`, each `{value, detail?}`, and the asker's `recommended` value among them. A one-field ask with options is a decision; without options, a question;
- `workID`, the Work it is on;
- `approval` and `collect`, both false by default;
- `responses`, one per responder, and `raises`, `{actorID, at}` for each Actor that passed it up, in order;
- `status` (`open`, `resolved` or `cancelled`), and a `resolution` once closed.

The record keeps its Form field names (`formID`, `requesterID` for the asker) until the wire takes the model's words; arguments name it `askID`. Only the Work's owner asks, on Work that is open, active or changes requested, and the root doesn't ask. An ask is stored in its own row, so asking, answering and closing never move the Work's revision.

**Reads.** `work_get {ticketID}` returns the Work with `asks`: all of them, open and closed, in the order they were asked (asks made in the same millisecond keep update order). `work_get {askID}` returns the Work an ask is on, the same way, and the current submission's ID returns its Work. An ask stored before asks lived on Work, which named no Work, is returned alone. `work_list` items carry their open asks. Write results carry no `asks`.

**Answering.** Any active Actor answers an open ask with `work_answer {askID, answers, note?}`: a complete answer set, where required fields are nonblank, every named field exists and a choice matches an option. The response is recorded under its responder with the time it was given. A responder that answers again replaces its own response, and history keeps every earlier one. The first answer resolves the ask; an ask with `collect` stays open for more answers until its asker closes it. An answer to a closed ask conflicts.

An `approval` ask authorizes something that can't be undone, so only the asker's strict ancestors answer it: its managers up to the root, never the asker itself. The Workspace tests this with the host's `within` relation, so it needs no root identity.

**Routing and raising.** An open ask is routed to its asker's manager; once raised, to its last raiser's manager. A closed manager is skipped for its nearest open one. Raising walks the route strictly, so a manager the caller can't see refuses the raise with `not_found`. Only the hosts' routed read (`asks {routedTo}`) counts such a manager as closed and walks on past it. Nothing stores a destination: it is derived from the asker, the raises and the tree. The Actor an ask is routed to may raise it with `work_answer {askID, raise: true}`, except the root, which has no manager. A raise adds `{actorID, at}` to `raises`, keeps the ask open and routes it one manager up. It never resolves the ask, and a later answer by the raiser doesn't remove it.

**Closing.** The asker closes its open ask with `work_update {close: {askID, status, resolution}}`, as `resolved` with a `resolution` (ending a collection, or recording an answer given elsewhere) or `cancelled`. Once the asker is closed, its nearest open manager closes it. It takes no `expectedRevision`, and a closed ask refuses a second close. Answering and closing work on frozen Work too.

**When Work moves on.** Submitting, cancelling or reassigning Work cancels its open asks, since their asker no longer moves it. Each gets `status: cancelled` and a `resolution` with a fixed `text` and a `reason`: `submitted`, `cancelled` or `reassigned`. Its history entry is by the Actor who moved the Work, at the same time. A new ask on submitted, accepted or cancelled Work is refused.

**Asks stored before asks lived on Work.** They read as stored: an ask with no Work is read, answered and closed by its ID, an ask by another Actor shows under the Work it names, and an ask left open on submitted Work is still answered and closed. Such an ask's `cause` stays stored and unread, and it reads with `raises: []`. Its next write stores it without `cause`; history keeps it.

**Hosts' reads.** `WorkClient.asks({requesterID?, routedTo?, answeredBy?, status?, after?, limit?})` is not a tool. It lists asks wherever they are: an asker's own, those routed to an Actor, and those an Actor answered. Older asks with no Work are included.

**History.** These action names are part of the contract, since hosts label what changed by them.
- **An ask's history:** `created` (asked), `responded` (answered), `raised`, `resolved` (closed as resolved) and `cancelled` (closed as cancelled by its asker or stand-in, or by Q12).
- **Q12's cancellations:** only these carry `resolution.reason`.
- **A Work's history:** `created`, `updated` (every edit, a cancel included), `submitted` and `reviewed` (the answer to a submission).

## Errors and protocol

Domain clients throw `WorkspaceError` with `invalid_input`, `not_found`, `forbidden` or `conflict`. An `invalid_input` from a contract names each schema issue as `path: message`. Reads of inaccessible IDs use `not_found`. MCP successes include record/page `structuredContent` plus equivalent JSON text and an advertised output schema. MCP tool errors set `isError:true` and carry JSON text `{code,message}`; they omit structured content to avoid success-schema validation. Unexpected failures become generic `internal_error` without raw exception text. Discovery uses SDK protocol errors: domain refusals return invalid-request errors with public text; unexpected failures return internal errors with the same generic public message. Viewer calls to a mutation are refused even when sent directly without discovery.
