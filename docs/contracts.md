# Operations, roles and transitions

Runtime request/record schemas and derived TypeScript types are maintained in [src/contracts](../src/contracts/index.ts). Requests are strict objects: extra fields, including caller identity fields, are rejected. IDs/text are trimmed and bounded. The admitted caller comes from trusted client construction. All clients require an active caller on every operation, including reads. Directory visibility is owned by canonical Actor authority. Work and Forms are shared within the admitted Hub organization; Messages is private to its parties. Record roles determine write permissions.

## Tool inventory

Every successful mutation returns the full resulting record with stable ID, revision, cursor and retained history. Execution MCP exposes every row below. Viewer MCP exposes only rows marked read. Actor lifecycle administration is outside this inventory.

| Tool         | Input                                                                                  | Purpose                                          |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| actor_get    | `{actorID?}`                                                                           | Read self by default or a visible Actor          |
| actor_list   | `{after?,limit?}`                                                                      | Read canonical visible directory                 |
| message_send | `{recipientID,text,workID?}`                                                           | Persist direct correspondence                    |
| message_get  | `{messageID}`                                                                          | Read record/history                              |
| message_list | `{direction?:incoming\|outgoing\|all,after?,limit?}`                                   | Read visible current upserts                     |
| work_create  | `{goal,ownerID}`                                                                       | Create ticket; caller becomes requester/reviewer |
| work_get     | `{ticketID}`                                                                           | Read record/history, including accepted work     |
| work_list    | `{ownerID?,requesterID?,status?,after?,limit?}`                                        | Read matching shared current upserts             |
| work_update  | `{ticketID,expectedRevision,goal?,ownerID?,progress?,status?:open\|active\|blocked}`   | Update at least one allowed field                |
| work_submit  | `{ticketID,expectedRevision,result,evidence[]}`                                        | Persist new submissionID, result/evidence        |
| work_review  | `{ticketID,expectedRevision,submissionID,verdict:accepted\|changes_requested,comment}` | Review the exact current submission              |
| form_create  | `{workID?,respondentIDs[],fields:[{name,label,required,options?}]}`                    | Create independent or work-linked interaction    |
| form_get     | `{formID}`                                                                             | Read record/history                              |
| form_list    | `{workID?,requesterID?,respondentID?,status?,awaitingActorID?,after?,limit?}`          | Read matching shared current upserts             |
| form_respond | `{formID,expectedRevision,answers:{field:value}}`                                      | Add/revise designated respondent's answers       |
| form_close   | `{formID,expectedRevision,status:resolved\|cancelled,resolution}`                      | Persist form resolution/cancellation             |

Form answers are strings. Every response supplies a complete answer set: required fields must be nonblank, supplied field names must exist, and supplied choice answers must match an option. Revisions retain earlier answer sets. Field names, options and respondent IDs are unique. A one-field form is a question.

## Authority

- Messages are private to sender/recipient and expose only send/get/list. A reply is another direct message. Messages have no public read or handling state, and retrieval leaves the sent record and history unchanged. New recipient must be active. Optional `workID` must exist and be readable by sender; it supplies context without changing Work or Form state.
- Every active admitted Actor may get/list all organization Work, including history and accepted tickets. Requester edits goal/owner and reviews. Current owner updates progress/status and submits. Reassignment changes write roles and filter membership; it does not remove shared read access. New owner must be active.
- Every active admitted Actor may get/list all organization Forms and history, standalone or linked. Any active caller may create a Form for active visible respondents. Optional `workID` must identify existing shared Work at creation. Without `workID`, Forms never consult Work; Form reads never consult Work. Only designated respondents answer while open; only form requester closes. Responding/closing never mutates Work. Closure does not require every respondent to have answered. Active callers retain shared history reads when counterparties close.

The host composes canonical Actor authority and a WorkspaceStore for one Hub organization. Public read does not construct an elevated identity or alter directory visibility. List criteria do not select the caller or grant write authority.

## List filters

Work accepts optional `ownerID`, `requesterID` and `status`. Forms accepts optional `workID`, `requesterID`, `respondentID`, `status` and `awaitingActorID`. All supplied predicates intersect with AND before pagination. ID filters use exact equality; respondent filters test designated membership. Status values use the existing Work enum or Form `open|resolved|cancelled` enum.

`awaitingActorID` selects only open Forms that designate that Actor and have no own response entry for them. A recorded empty answer object counts as a response; closed Forms never await anyone. It may be combined with another respondent filter. Filter IDs do not trigger Actor lookup or impersonation; unknown IDs yield empty matching sets. Omit filters to traverse all shared records.

## Work transitions and concurrency

New work is `open`. In `open`, `active`, `blocked`, or `changes_requested`, requester may edit goal/owner and owner may update progress/status; `work_update` can set only `open`, `active`, or `blocked`. Owner `work_submit` creates a UUID submissionID and enters `submitted`. Ordinary edits and further submissions are frozen until requester review. Exact-current-submission review enters `accepted` or `changes_requested`. Accepted work is terminal; follow-up work gets a new ticket.

Every Work mutation after creation, and every Form response/closure, requires a positive integer `expectedRevision`. The state/role/revision checks and snapshot/history writes share one SQLite transaction. Stale revisions conflict. Review also rejects a stale/noncurrent submissionID even if the caller supplies the latest revision. Resubmission retains prior evidence and reviews in history.

Requester and owner may be the same Actor. Submission still enters `submitted` until an explicit requester review call. The review records actual reviewerID and submissionID; matching owner/reviewer identity is self-review and does not claim independent acceptance.

## Cursors

Messages, Work and Forms traverse current snapshots in ascending module cursor order, strictly after `after` (default zero). Sending assigns a Message's cursor; Messages have no public update after send. A list position is not a delivery acknowledgement. Work/Form mutations move the changed record to a new module cursor. Authorized matching rows are filtered before applying `limit` (default 50, maximum 100). Response `{items,after}` continues from the last returned row's cursor; an empty page retains the input cursor. A continuation belongs to the same module, caller and filter scope. Reset to zero when changing scope. Directory cursors are delegated to canonical authority.

For Work and Forms, an updated record can appear again after an earlier page. Status changes, reassignment or a new response can remove a record from a filter without a matching row or tombstone. Consumers needing a complete current matching view must start a fresh traversal with the same filters and reconcile IDs. Traversals do not provide an immutable snapshot or complete cache synchronization feed. Reopen retains cursor heads/history. Malformed, negative, fractional, unsafe or future module cursors return `invalid_input` and are never silently clamped/reset.

## Errors and protocol

Domain clients throw `WorkspaceError` with `invalid_input`, `not_found`, `forbidden` or `conflict`. Reads of inaccessible IDs use `not_found`. MCP successes include record/page `structuredContent` plus equivalent JSON text and an advertised output schema. MCP tool errors set `isError:true` and carry JSON text `{code,message}`; they omit structured content to avoid success-schema validation. Unexpected failures become generic `internal_error` without raw exception text. Discovery uses SDK protocol errors: domain refusals return invalid-request errors with public text; unexpected failures return internal errors with the same generic public message. Viewer calls to a mutation are refused even when sent directly without discovery.
