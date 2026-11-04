/** Work, the unit of progress: owned, requested, completed on submit or by its requester's answer. */
import { randomUUID } from "node:crypto";
import { type ActorsClient, activeActor, standIn } from "../actors/index.js";
import {
  type Input,
  type List,
  parse,
  requireThat,
  SubmissionAnswer,
  type WaitsOn,
  type Work,
  WorkContracts,
  type WorkState,
} from "../contracts/index.js";
import type { RecordTable, Snapshot, WorkspaceStore } from "../persistence/index.js";
import { now, published, recorded, stateOf, traverse } from "../records.js";

export interface WorkReader {
  get(input: Input<typeof WorkContracts.work_get.input>): Work;
}
export interface WorkClient extends WorkReader {
  create(input: Input<typeof WorkContracts.work_create.input>): Work;
  list(input?: Input<typeof WorkContracts.work_list.input>): List<Work>;
  update(input: Input<typeof WorkContracts.work_update.input>): Work;
  submit(input: Input<typeof WorkContracts.work_submit.input>): Work;
  answer(input: Input<typeof WorkContracts.work_answer.input>): Work;
}
export function createWork(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "work" | "transaction">,
): WorkClient {
  const table = readAs(store.work);
  const editable = (row: WorkState) =>
    requireThat(
      row.status === "open" || row.status === "active" || row.status === "changes_requested",
      "conflict",
      "work is frozen for review, accepted or cancelled",
    );
  /** The requester's rights, which pass to its nearest open manager once it is closed. */
  const requester = (row: WorkState, caller: string) => standIn(actors, row.requesterID) === caller;
  /** What Work waits on must exist; text needs no check. */
  function waitable(waitsOn: WaitsOn | null | undefined) {
    if (waitsOn && "actorID" in waitsOn) actors.get({ actorID: waitsOn.actorID });
    if (waitsOn && "ticketID" in waitsOn) recorded(table, waitsOn.ticketID);
  }
  return {
    create(input) {
      const request = parse(WorkContracts.work_create.input, input);
      const caller = actors.get().actorID;
      const { ownerID = caller, links = [], ...fields } = request;
      activeActor(actors, ownerID);
      waitable(request.waitsOn);
      return store.transaction(() => {
        const at = now();
        const ticketID = randomUUID();
        const saved = table.save(
          ticketID,
          {
            ticketID,
            requesterID: caller,
            ownerID,
            ...fields,
            status: "open",
            links,
            createdAt: at,
          },
          { actorID: caller, at, action: "created", detail: request },
        );
        return published(saved);
      });
    },
    get(input) {
      const request = parse(WorkContracts.work_get.input, input);
      actors.get();
      return recorded(table, request.ticketID, request.history);
    },
    list(input = {}) {
      const query = parse(WorkContracts.work_list.input, input);
      actors.get();
      const { after: _after, limit: _limit, ...filter } = query;
      const indexed = {
        filter: {
          owner: query.ownerID === undefined ? undefined : [query.ownerID],
          requester: query.requesterID === undefined ? undefined : [query.requesterID].flat(),
          status: query.status,
        },
        within: { owner: query.ownerWithin, requester: query.requesterWithin },
      };
      const waitedOn = (row: WorkState) =>
        row.waitsOn && "actorID" in row.waitsOn ? row.waitsOn.actorID : undefined;
      return traverse(
        actors,
        table,
        query,
        ["work", filter],
        indexed,
        (row) =>
          (query.waitsOnActorID === undefined || waitedOn(row) === query.waitsOnActorID) &&
          (query.updatedSince === undefined || row.updatedAt >= query.updatedSince),
        (row) => [row.requesterID, row.ownerID, row.review?.reviewerID, waitedOn(row)],
      );
    },
    update(input) {
      const request = parse(WorkContracts.work_update.input, input);
      const caller = actors.get().actorID;
      const { ticketID, expectedRevision, goal, ownerID, status, ...own } = request;
      const cancel = status === "cancelled";
      const requested = { goal, ownerID, status: cancel ? status : undefined };
      const owned = { ...own, status: cancel ? undefined : status };
      const requesterEdit = Object.values(requested).some((value) => value !== undefined);
      requireThat(
        !requesterEdit || expectedRevision !== undefined,
        "invalid_input",
        "goal, owner or cancel edits need expectedRevision",
      );
      if (ownerID !== undefined) activeActor(actors, ownerID);
      waitable(own.waitsOn);
      return store.transaction(() => {
        const row = recorded(table, ticketID);
        editable(row);
        requireThat(
          !requesterEdit || requester(row, caller),
          "forbidden",
          "only requester edits goal or owner, or cancels",
        );
        requireThat(
          Object.values(owned).every((value) => value === undefined) || row.ownerID === caller,
          "forbidden",
          "only owner edits title, progress, status, links or waitsOn",
        );
        // A stored blocked reads as active; the write that first stores active says so.
        const unblocked =
          status === undefined && String(store.work.get(ticketID)?.status) === "blocked";
        const detail = Object.fromEntries(
          [
            ...Object.entries(requested),
            ...Object.entries(owned),
            ...(unblocked ? [["status", "active"]] : []),
          ].filter(([, value]) => value !== undefined),
        );
        const data = { ...stateOf(row), ...detail } as WorkState & { waitsOn?: WaitsOn | null };
        if (data.waitsOn === null) delete data.waitsOn;
        return published(
          table.save(
            ticketID,
            data,
            { actorID: caller, at: now(), action: "updated", detail },
            expectedRevision ?? row.revision,
          ),
        );
      });
    },
    submit(input) {
      const request = parse(WorkContracts.work_submit.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = recorded(table, request.ticketID);
        editable(row);
        requireThat(row.ownerID === caller, "forbidden", "only owner submits work");
        const at = now();
        const submission = {
          submissionID: randomUUID(),
          ownerID: caller,
          result: request.result,
          evidence: request.evidence,
          at,
        };
        const { review: _review, ...data } = stateOf(row);
        const completed = row.requesterID === caller;
        return published(
          table.save(
            row.ticketID,
            completed
              ? { ...data, status: "accepted", completedAt: at, submission }
              : { ...data, status: "submitted", submission },
            { actorID: caller, at, action: "submitted", detail: submission },
            request.expectedRevision ?? row.revision,
          ),
        );
      });
    },
    answer(input) {
      const request = parse(WorkContracts.work_answer.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = submitted(table, request.askID, request.ticketID);
        requireThat(!request.raise, "invalid_input", "a submission can't be raised");
        const { verdict } = parse(SubmissionAnswer, request).answers;
        requireThat(
          verdict === "accepted" || request.note !== undefined,
          "invalid_input",
          "requesting changes needs a note",
        );
        requireThat(requester(row, caller), "forbidden", "only requester answers its submission");
        requireThat(
          row.status === "submitted" && row.submission?.submissionID === request.askID,
          "conflict",
          "the submission is not current",
        );
        const at = now();
        const review = {
          submissionID: request.askID,
          reviewerID: caller,
          verdict,
          ...(request.note === undefined ? {} : { comment: request.note }),
          at,
        };
        const data = { ...stateOf(row), status: verdict, review };
        return published(
          table.save(
            row.ticketID,
            verdict === "accepted" ? { ...data, completedAt: at } : data,
            { actorID: caller, at, action: "reviewed", detail: review },
            row.revision,
          ),
        );
      });
    },
  };
}
/** Work as 0.6 reads it: a stored `blocked` is `active`, as the status column indexes it. */
function readAs<C extends string>(work: RecordTable<WorkState, C>): RecordTable<WorkState, C> {
  const read = <R extends WorkState>(row: R): R =>
    (row.status as string) === "blocked" ? { ...row, status: "active" } : row;
  return {
    get: (id) => {
      const row = work.get(id);
      return row && read(row);
    },
    where: (filter) => work.where(filter).map(read),
    values: (column, filter) => work.values(column, filter),
    history: (id) => work.history(id),
    head: () => work.head(),
    save: (id, data, event, expectedRevision) => work.save(id, data, event, expectedRevision),
  };
}
/**
 * The Work a submission is on: by its ID alone, the Work whose current submission it is; with a
 * ticketID, that Work, if the submission is one of its own.
 */
function submitted(
  table: RecordTable<WorkState, "submission">,
  submissionID: string,
  ticketID: string | undefined,
): Snapshot<WorkState> {
  const [row] =
    ticketID === undefined ? table.where({ submission: [submissionID] }) : [table.get(ticketID)];
  requireThat(
    row &&
      (row.submission?.submissionID === submissionID ||
        table
          .history(row.ticketID)
          .some(
            (event) => event.action === "submitted" && event.detail.submissionID === submissionID,
          )),
    "not_found",
    "record not found",
  );
  return row;
}
