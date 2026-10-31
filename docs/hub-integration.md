# Hub authority and Message query binding

Workspace 0.4.0 adds only optional `counterpartyID` and `before` to `message_list`. Omitted additions preserve old forward request normalization/defaults and the original ascending Page/Message/history/output schema. The same three Message aliases remain private; Hub derives the new input contract through its ordinary binding, without changing admission, host authority or Provider state. Recent/older queries require a peer and after0, with their older boundary separate from forward polling; see [Message windows](contracts.md#message-windows).

The accepted System baseline is Hub `00f0ff3157148f0c39d3c9f1b21155588edf7045`. All Message operations remain excluded from operation-specific invocation diagnostics and diagnostic output, including malformed/refused new queries. This repository does not modify Hub. A separate Hub query integration must verify these exclusions and frozen Provider receipt/restart/scope/baseline/unknown behavior before its acceptance. Workspace validates the candidate with unchanged frozen public SDK wire/default/schema/251-page consumers; that is distinct from actual Provider receipt execution against a candidate Hub. No Provider rebuild/reset/replay or live runtime input is included.

The accepted organization-view baseline is Workspace **3d20dd7d85fc8f95787e14f1eb63d86d4db05fbe** (package 0.2.0) and Hub **d215d2d91c19c762f4ca78a9b134007c58d40935**. That delivery is complete. Workspace 0.3.0 extends the required host authority contract; this repository changes only the package, fixtures, tests and documentation. Hub/client integration and final package adoption remain separately owned.

## Required host authority

Hub owns canonical Actor identity, admission and retained manager relationships. Bind the actual admitted Actor ID to a canonical synchronous `ActorAuthority` and one organization's `WorkspaceStore`. The existing get/list methods retain directory visibility. Add the required method `within(callerID, actorID, ancestorID): boolean`, returning true for the anchor itself or any descendant through retained manager edges. Both IDs must exist; unknown member/anchor returns false, even when equal. Include closed members and anchors with no Team depth limit. Revalidate the admitted caller as for other authority reads.

Implement canonical ancestry at its owner. The accepted Hub contract uses retained Registry get/manager edges; Team's depth-limited open-report view and active Directory cannot supply complete historical membership. Workspace stores no hierarchy, Actor kind, relationship edit or fallback registry. Its bound `ActorsClient.within(actorID, ancestorID)` validates ID criteria and revalidates the active caller before delegation, without selected-profile lookup or caller substitution. Hosts must supply this method when adopting 0.3.0; there is no optional fallback.

## Selection and ordinary exposure

Workspace selects records through existing before-limit predicates. Work adds ownerWithin/requesterWithin; Forms adds requesterWithin/respondentWithin/awaitingWithin. All exact/status/subtree filters AND. Within means this position and all reports; requester scope is immutable record origin, not causal Work lineage. Awaiting is open, designated, within and no own response entry; {} counts answered. Separate respondent/awaiting predicates can match different people. Closed designated respondents remain eligible for these historical query criteria.

Every active admitted Actor may read all organization Work and Forms and choose any branch. Membership adds no business write role or Message access. Keep shared full histories, private send/get/list P2P, optional real Work association validation on creation, standalone Forms and existing revision/submission/lifecycle rules. Form reads never consult Work.

Hub continues ordinary explicit feature exposure: derive Work/Form schemas and public declarations from the reviewed package, retain the 16 execution/8 viewer operations and use the existing SDK protocol/transport and admitted principal. No Actor membership Tool, new service, exporter, ACL or organization selector is added. Hub adopts only the final root-accepted merged package pin; this Feature PR does not vendor or modify it.

Human and Agent clients use those same offered Tools under ordinary admitted identity. HTTP projections may compose their results; they may not read Registry/DB/admin/Provider/native paths or synthesize an elevated caller. Profile reads can decorate display names but cannot decide which records qualify. Native Form response binding and Message delivery/dedup remain client responsibilities; organization browsing grants no native execution authority.

## Traversal and verification

Keep independent module/lane cursors. Apply every predicate before output limit; resetting filters/anchor starts at0. The adapter scans current snapshots and uses a synchronous ancestry check per applicable candidate, so output limits do not bound scan cost. Lists are current upserts with no tombstones or immutable snapshot. Clients use bounded from-zero refresh/reconciliation; failed/partial refresh does not establish disappearance or a complete count.

Node **>=22.13** remains the declared floor; CI and exact installed-package checks use **22.23.4** and **24.22.1**. Canonical host integration must prove inclusive deep/closed membership, active callers, ordinary cross-branch queries, exact schemas and unchanged business writes/P2P. The model-free fixture supplies a retained manager map only for package verification.

No runtime, native, live-state, credential, real Actor or model action is part of this package change. Protected Human54292, Provider8787, Hub60805, SSH58509 and old54289/54290 remain untouched. No package publication, migration, merge, release or deployment is included.
