/** Durable tickets, owner progress, submissions and explicit requester review. */
import { randomUUID } from "node:crypto";
import { type ActorsClient, activeActor } from "../actors/index.js";
import {
  type Input,
  type Page,
  parse,
  requireThat,
  type Work,
  WorkContracts,
  type WorkState,
} from "../contracts/index.js";
import type { WorkspaceStore } from "../persistence/index.js";
import { now, recorded, traverse } from "../records.js";

export interface WorkReader {
  get(input: Input<typeof WorkContracts.work_get.input>): Work;
}
export interface WorkClient extends WorkReader {
  create(input: Input<typeof WorkContracts.work_create.input>): Work;
  list(input?: Input<typeof WorkContracts.work_list.input>): Page<Work>;
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
  function state(row: Work): WorkState {
    const { revision: _revision, cursor: _cursor, history: _history, ...data } = row;
    return data;
  }
  return {
    create(input) {
      const request = parse(WorkContracts.work_create.input, input);
      const caller = actors.get().actorID;
      activeActor(actors, request.ownerID);
      return store.transaction(() => {
        const at = now();
        const ticketID = randomUUID();
        return table.save(
          ticketID,
          {
            ticketID,
            requesterID: caller,
            ownerID: request.ownerID,
            goal: request.goal,
            status: "open",
            createdAt: at,
          },
          { actorID: caller, at, action: "created", detail: request },
        );
      });
    },
    get(input) {
      const request = parse(WorkContracts.work_get.input, input);
      actors.get();
      return recorded(table, request.ticketID);
    },
    list(input = {}) {
      const query = parse(WorkContracts.work_list.input, input);
      actors.get();
      return traverse(
        table,
        query,
        (row) =>
          (query.ownerID === undefined || row.ownerID === query.ownerID) &&
          (query.requesterID === undefined || row.requesterID === query.requesterID) &&
          (query.ownerWithin === undefined || actors.within(row.ownerID, query.ownerWithin)) &&
          (query.requesterWithin === undefined ||
            actors.within(row.requesterID, query.requesterWithin)) &&
          (query.status === undefined || row.status === query.status),
      );
    },
    update(input) {
      const request = parse(WorkContracts.work_update.input, input);
      const caller = actors.get().actorID;
      if (request.ownerID !== undefined) activeActor(actors, request.ownerID);
      return store.transaction(() => {
        const row = recorded(table, request.ticketID);
        editable(row);
        requireThat(
          (request.goal === undefined && request.ownerID === undefined) ||
            row.requesterID === caller,
          "forbidden",
          "only requester edits goal or owner",
        );
        requireThat(
          (request.progress === undefined && request.status === undefined) ||
            row.ownerID === caller,
          "forbidden",
          "only owner records progress or status",
        );
        const { ticketID, expectedRevision, ...updates } = request;
        const data = state(row);
        if (request.goal !== undefined) data.goal = request.goal;
        if (request.ownerID !== undefined) data.ownerID = request.ownerID;
        if (request.progress !== undefined) data.progress = request.progress;
        if (request.status !== undefined) data.status = request.status;
        const detail = Object.fromEntries(
          Object.entries(updates).filter(([, value]) => value !== undefined),
        );
        return table.save(
          ticketID,
          data,
          { actorID: caller, at: now(), action: "updated", detail },
          expectedRevision,
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
        const { review: _review, ...data } = state(row);
        return table.save(
          row.ticketID,
          { ...data, status: "submitted", submission },
          { actorID: caller, at, action: "submitted", detail: submission },
          request.expectedRevision,
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
        const review = {
          submissionID: request.submissionID,
          reviewerID: caller,
          verdict: request.verdict,
          comment: request.comment,
          at: now(),
        };
        return table.save(
          row.ticketID,
          { ...state(row), status: request.verdict, review },
          { actorID: caller, at: review.at, action: "reviewed", detail: review },
          request.expectedRevision,
        );
      });
    },
  };
}
