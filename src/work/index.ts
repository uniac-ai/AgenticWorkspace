/** Work, the unit of progress: owned, requested, completed on submit or by its requester's review. */
import { randomUUID } from "node:crypto";
import { type ActorsClient, activeActor } from "../actors/index.js";
import {
  type Input,
  type List,
  parse,
  requireThat,
  type WaitsOn,
  type Work,
  WorkContracts,
  type WorkState,
} from "../contracts/index.js";
import type { WorkspaceStore } from "../persistence/index.js";
import { now, published, recorded, stateOf, traverse } from "../records.js";

export interface WorkReader {
  get(input: Input<typeof WorkContracts.work_get.input>): Work;
}
export interface WorkClient extends WorkReader {
  create(input: Input<typeof WorkContracts.work_create.input>): Work;
  list(input?: Input<typeof WorkContracts.work_list.input>): List<Work>;
  update(input: Input<typeof WorkContracts.work_update.input>): Work;
  submit(input: Input<typeof WorkContracts.work_submit.input>): Work;
  review(input: Input<typeof WorkContracts.work_review.input>): Work;
}
export function createWork(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "work" | "transaction">,
): WorkClient {
  const table = store.work;
  const editable = (row: WorkState) =>
    requireThat(
      row.status !== "submitted" && row.status !== "accepted",
      "conflict",
      "work is frozen for review or accepted",
    );
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
      const requesters = query.requesterID === undefined ? undefined : [query.requesterID].flat();
      const waitedOn = (row: WorkState) =>
        row.waitsOn && "actorID" in row.waitsOn ? row.waitsOn.actorID : undefined;
      return traverse(
        actors,
        table,
        query,
        ["work", filter],
        (row) =>
          (query.ownerID === undefined || row.ownerID === query.ownerID) &&
          (requesters === undefined || requesters.includes(row.requesterID)) &&
          (query.waitsOnActorID === undefined || waitedOn(row) === query.waitsOnActorID) &&
          (query.ownerWithin === undefined || actors.within(row.ownerID, query.ownerWithin)) &&
          (query.requesterWithin === undefined ||
            actors.within(row.requesterID, query.requesterWithin)) &&
          (query.status === undefined || query.status.includes(row.status)) &&
          (query.updatedSince === undefined || row.updatedAt >= query.updatedSince),
        (row) => [row.requesterID, row.ownerID, row.review?.reviewerID, waitedOn(row)],
      );
    },
    update(input) {
      const request = parse(WorkContracts.work_update.input, input);
      const caller = actors.get().actorID;
      const { ticketID, expectedRevision, goal, ownerID, ...own } = request;
      const requesterEdit = goal !== undefined || ownerID !== undefined;
      requireThat(
        !requesterEdit || expectedRevision !== undefined,
        "invalid_input",
        "goal or owner edits need expectedRevision",
      );
      if (ownerID !== undefined) activeActor(actors, ownerID);
      waitable(own.waitsOn);
      return store.transaction(() => {
        const row = recorded(table, ticketID);
        editable(row);
        requireThat(
          !requesterEdit || row.requesterID === caller,
          "forbidden",
          "only requester edits goal or owner",
        );
        requireThat(
          Object.values(own).every((value) => value === undefined) || row.ownerID === caller,
          "forbidden",
          "only owner edits title, progress, status, links or waitsOn",
        );
        const detail = Object.fromEntries(
          Object.entries({ goal, ownerID, ...own }).filter(([, value]) => value !== undefined),
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
    review(input) {
      const request = parse(WorkContracts.work_review.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = recorded(table, request.ticketID);
        requireThat(row.requesterID === caller, "forbidden", "only requester reviews work");
        requireThat(
          row.status === "submitted" && row.submission?.submissionID === request.submissionID,
          "conflict",
          "review must identify the current submission",
        );
        const { ticketID: _ticketID, expectedRevision: _revision, ...verdict } = request;
        const review = { ...verdict, reviewerID: caller, at: now() };
        const data = { ...stateOf(row), status: request.verdict, review };
        return published(
          table.save(
            row.ticketID,
            request.verdict === "accepted" ? { ...data, completedAt: review.at } : data,
            { actorID: caller, at: review.at, action: "reviewed", detail: review },
            request.expectedRevision ?? row.revision,
          ),
        );
      });
    },
  };
}
