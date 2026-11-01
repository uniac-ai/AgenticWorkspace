# Operations, roles and transitions

Runtime request/record schemas and derived TypeScript types are maintained in [src/contracts](../src/contracts/index.ts). Requests are strict objects: extra fields, including caller identity fields, are rejected. IDs/text are trimmed and bounded. The admitted caller comes from trusted client construction. All clients require an active caller on every operation, including reads. Directory visibility is owned by canonical Actor authority. Work and Forms are shared within the admitted Hub organization; Messages is private to its parties. Record roles determine write permissions.

## Tool inventory

Every successful write returns the resulting record: its stable ID, `revision` and `updatedAt`, the time of the write that produced the current revision. History comes only from `work_get` and `form_get` with `history: true`. Execution MCP exposes every row below. Viewer MCP exposes only reads. Actor lifecycle administration is outside this inventory.

Each contract carries `level`, the smallest organization level that presents it. Report is one agent and its person; Team adds working with other Actors; Organization adds the lifecycle and the system, none of which is in this package. Each level contains the one before it. The tag selects what a client presents; it grants and refuses nothing.

| Tool         | Level  | Input                                                                                                                                                                       | Purpose                                          |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| actor_get    | Team   | `{actorID?}`                                                                                                                                                                | Read self by default or a visible Actor          |
| actor_list   | Team   | `{after?,limit?}`                                                                                                                                                           | Read canonical visible directory                 |
| message_send | Team   | `{recipientID,text}`                                                                                                                                                        | Send into the pair's conversation                |
| message_get  | Team   | `{messageID}`                                                                                                                                                               | Read one message as a party                      |
| message_list | Team   | `{direction?:incoming\|outgoing\|all,counterpartyID?,before?:latest\|older,after?:next\|seq,limit?}`                                                                        | Read a conversation or the caller's input        |
| work_create  | Report | `{goal,ownerID}`                                                                                                                                                            | Create ticket; caller becomes requester/reviewer |
| work_get     | Report | `{ticketID,history?}`                                                                                                                                                       | Read a ticket, including accepted work           |
| work_list    | Report | `{ownerID?,requesterID?:id\|id[],ownerWithin?,requesterWithin?,status?:[...],updatedSince?,order?:recent,after?,limit?}`                                                    | Read matching shared tickets                     |
| work_update  | Report | `{ticketID,expectedRevision,goal?,ownerID?,progress?,status?:open\|active\|blocked}`                                                                                        | Update at least one allowed field                |
| work_submit  | Report | `{ticketID,expectedRevision,result,evidence[]}`                                                                                                                             | Persist new submissionID, result/evidence        |
| work_review  | Team   | `{ticketID,expectedRevision,submissionID,verdict:accepted\|changes_requested,comment}`                                                                                      | Review the exact current submission              |
| form_create  | Report | `{workID?,respondentIDs[],fields:[{name,label,required,options?}]}`                                                                                                         | Create independent or work-linked interaction    |
| form_get     | Report | `{formID,history?}`                                                                                                                                                         | Read a form                                      |
| form_list    | Report | `{workID?,requesterID?:id\|id[],respondentID?,status?:[...],awaitingActorID?,requesterWithin?,respondentWithin?,awaitingWithin?,updatedSince?,order?:recent,after?,limit?}` | Read matching shared forms                       |
| form_respond | Team   | `{formID,expectedRevision,answers:{field:value}}`                                                                                                                           | Add/revise designated respondent's answers       |
| form_close   | Report | `{formID,expectedRevision,status:resolved\|cancelled,resolution}`                                                                                                           | Persist form resolution/cancellation             |

Form answers are strings. Every response supplies a complete answer set: required fields must be nonblank, supplied field names must exist, and supplied choice answers must match an option. Revisions retain earlier answer sets. Field names, options and respondent IDs are unique. A one-field form is a question.

## Authority

- Messages are private to sender and recipient and expose only send/get/list. A reply is another message in the same conversation. Messages have no read, delivery or handling state, and reading changes nothing. The recipient must be active when the message is sent.
- Every active admitted Actor may get/list all organization Work, including history and accepted tickets. Requester edits goal/owner and reviews. Current owner updates progress/status and submits. Reassignment changes write roles and filter membership; it does not remove shared read access. New owner must be active.
- Every active admitted Actor may get/list all organization Forms and history, standalone or linked. Any active caller may create a Form for active visible respondents. Optional `workID` must identify existing shared Work at creation. Without `workID`, Forms never consult Work; Form reads never consult Work. Only designated respondents answer while open; only form requester closes. Responding/closing never mutates Work. Closure does not require every respondent to have answered. Active callers retain shared history reads when counterparties close.

The host composes canonical Actor authority and a WorkspaceStore for one Hub organization. Public read does not construct an elevated identity or alter directory visibility. List criteria do not select the caller or grant write authority.

## Lists

`work_list`, `form_list` and `message_list` return `{items, next, actors}`. `actors` maps every Actor ID the page mentions to `{name}`, leaving out Actors the caller's directory can't see. `next` is an opaque position, or null when the read observed no further matching rows. Pass it back as `after` with the same filters to continue; a position from another read, filter or order is refused with `invalid_input`. Work and Form records carry no position of their own.

Work and Form lists go in update order by default: a record moves to the end of that order whenever it changes. `order: "recent"` goes newest first. `updatedSince` keeps records whose `updatedAt` is at or after the given time, which is how a reader picks up changes since it last looked. Lists are current upserts, not snapshots: a record updated during a traversal can appear again later in update order, or be passed over newest first, and a record that stops matching leaves no tombstone. A reader that needs a complete current view lists again from the start and reconciles IDs.

The page `limit` defaults to 50 and is at most 100. It bounds the returned rows, not the scan: the v1 adapter loads current snapshots and applies every filter before the limit.

### Filters

Work accepts `ownerID`, `requesterID`, `status`, `ownerWithin`, `requesterWithin` and `updatedSince`. Forms accepts `workID`, `requesterID`, `respondentID`, `status`, `awaitingActorID`, `requesterWithin`, `respondentWithin`, `awaitingWithin` and `updatedSince`. All supplied filters intersect. `requesterID` takes one ID or a list, matching any of them; `status` takes a list of the module's status values, matching any of them. ID filters use exact equality; respondent filters test designated membership. Filter IDs do not trigger Actor lookup; unknown IDs yield empty matching sets. Omit filters to list all shared records.

`awaitingActorID` selects only open Forms that designate that Actor and have no own response entry for them. A recorded empty answer object counts as a response; closed Forms never await anyone. It may be combined with another respondent filter.

Subtree criteria use the required host `ActorAuthority.within(callerID, actorID, ancestorID)`, which tests the named canonical position and every descendant through retained relationships, including closed Actors and closed anchors without a depth limit. Unknown members or anchors return false. Bound `ActorsClient.within(actorID, ancestorID)` revalidates the admitted caller and delegates membership without selected-profile lookup or caller substitution.

`ownerWithin` tests current Work ownership; `requesterWithin` tests immutable record requester, the scope from which it originated. Neither implies causal ticket lineage. `respondentWithin` selects any designated respondent in the subtree. `awaitingWithin` selects any designated respondent in the subtree with no own response entry, only while the Form is open. Members OR within each existential predicate; separate respondent and awaiting predicates may match different respondents. Any active caller may query any branch; membership grants no write role or Message access.

## Messages

A Message is `{messageID, conversationID, senderID, recipientID, text, createdAt, seq}` and never changes after it is sent.

- **`conversationID`** names the one ordered series the message belongs to. In this version it is derived from the pair, so each pair has one direct conversation, both directions included, and a message to oneself has its own. It is opaque: clients compare it and key their own positions by it.
- **`seq`** is the message's place in the one Message order, which spans every conversation and follows commit order. Clients compare it with their own positions, such as a seen-through or delivered-through `seq`.

`message_list` reads one of two ways, and returns `{items, next, older, actors}` with items ascending.

- **Forward:** omit `before`. Rows after `after` (a `next` token or a `seq`; default from the start) come in order up to `limit`. `{direction: "incoming", after}` is an Actor's input across its conversations; with `counterpartyID` it is one conversation.
- **Newest window:** `before: "latest"` selects the last `limit` matching rows; `before: older` continues toward the start. It works with or without `counterpartyID`. `before` and `after` are exclusive.

`next` continues forward from the last returned row and is null when nothing newer matched; `older` continues back from the first returned row and is null at the start. A client may keep a `seq` instead of `next`, since `after` accepts either: a forward read that reached the end resumes from the last `seq` it handled. A newest window captures the Message head once, so messages sent during the read wait for the next read. Self selection matches self-to-self once. Listing does not resolve the selected peer or require it to be active; closed-peer history remains readable to an active party. Root, manager and subtree membership grant no Message access.

## Work transitions and concurrency

New work is `open`. In `open`, `active`, `blocked`, or `changes_requested`, requester may edit goal/owner and owner may update progress/status; `work_update` can set only `open`, `active`, or `blocked`. Owner `work_submit` creates a UUID submissionID and enters `submitted`. Ordinary edits and further submissions are frozen until requester review. Exact-current-submission review enters `accepted` or `changes_requested`. Accepted work is terminal; follow-up work gets a new ticket.

Every Work mutation after creation, and every Form response/closure, requires a positive integer `expectedRevision`. The state/role/revision checks and snapshot/history writes share one SQLite transaction. Stale revisions conflict. Review also rejects a stale/noncurrent submissionID even if the caller supplies the latest revision. Resubmission retains prior evidence and reviews in history.

Requester and owner may be the same Actor. Submission still enters `submitted` until an explicit requester review call. The review records actual reviewerID and submissionID; matching owner/reviewer identity is self-review and does not claim independent acceptance.

## Errors and protocol

Domain clients throw `WorkspaceError` with `invalid_input`, `not_found`, `forbidden` or `conflict`. Reads of inaccessible IDs use `not_found`. MCP successes include record/page `structuredContent` plus equivalent JSON text and an advertised output schema. MCP tool errors set `isError:true` and carry JSON text `{code,message}`; they omit structured content to avoid success-schema validation. Unexpected failures become generic `internal_error` without raw exception text. Discovery uses SDK protocol errors: domain refusals return invalid-request errors with public text; unexpected failures return internal errors with the same generic public message. Viewer calls to a mutation are refused even when sent directly without discovery.
