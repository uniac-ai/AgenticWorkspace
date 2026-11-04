/** Work, the unit of progress, and its asks: completed on submit or by its requester's answer. */
import { randomUUID } from "node:crypto";
import { type ActorsClient, activeActor, standIn } from "../actors/index.js";
import {
  AskQuery,
  type Form,
  type Input,
  type List,
  type Output,
  parse,
  requireThat,
  SubmissionAnswer,
  type WaitsOn,
  type Work,
  WorkContracts,
  type WorkState,
} from "../contracts/index.js";
import type { RecordTable, Snapshot, WorkspaceStore } from "../persistence/index.js";
import {
  names,
  now,
  published,
  readThrough,
  recorded,
  stateOf,
  subtrees,
  traverse,
} from "../records.js";
import {
  asksAsRead,
  asksOn,
  cancelOpen,
  checkFields,
  closed,
  created,
  mentioned,
  raised,
  responded,
  routedTo,
} from "./asks.js";

export interface WorkClient {
  create(input: Input<typeof WorkContracts.work_create.input>): Work;
  get(input: Input<typeof WorkContracts.work_get.input>): Work | Form;
  list(input?: Input<typeof WorkContracts.work_list.input>): List<Work>;
  update(input: Input<typeof WorkContracts.work_update.input>): Work | Form;
  submit(input: Input<typeof WorkContracts.work_submit.input>): Work;
  answer(input: Input<typeof WorkContracts.work_answer.input>): Work | Form;
  /** For hosts, not a tool: asks by asker, by route or by responder, wherever they are. */
  asks(input?: Input<typeof AskQuery>): List<Form>;
}
type Update = Output<typeof WorkContracts.work_update.input>;
type Answer = Output<typeof WorkContracts.work_answer.input>;
export function createWork(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "work" | "forms" | "transaction">,
): WorkClient {
  const table = readThrough(store.work, (row) =>
    (row.status as string) === "blocked" ? { ...row, status: "active" as const } : row,
  );
  const forms = asksAsRead(store.forms);
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
  const withAsks = (ticketID: string, history: boolean): Work => ({
    ...recorded(table, ticketID, history),
    asks: asksOn(forms, [ticketID], { open: false, history }).get(ticketID) ?? [],
  });

  function edit(request: Update, caller: string): Work {
    const {
      ticketID,
      expectedRevision,
      goal,
      ownerID,
      status,
      ask: _ask,
      close: _close,
      ...own
    } = request;
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
      const row = recorded(table, ticketID as string);
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
        status === undefined && String(store.work.get(row.ticketID)?.status) === "blocked";
      const detail = Object.fromEntries(
        [
          ...Object.entries(requested),
          ...Object.entries(owned),
          ...(unblocked ? [["status", "active"]] : []),
        ].filter(([, value]) => value !== undefined),
      );
      const data = { ...stateOf(row), ...detail } as WorkState & { waitsOn?: WaitsOn | null };
      if (data.waitsOn === null) delete data.waitsOn;
      const at = now();
      const saved = table.save(
        row.ticketID,
        data,
        { actorID: caller, at, action: "updated", detail },
        expectedRevision ?? row.revision,
      );
      // Once the owner no longer moves the Work, its open asks wait on nobody.
      if (cancel) cancelOpen(forms, row.ticketID, caller, at, "cancelled");
      else if (ownerID !== undefined && ownerID !== row.ownerID)
        cancelOpen(forms, row.ticketID, caller, at, "reassigned");
      return published(saved);
    });
  }
  function ask(ticketID: string, input: NonNullable<Update["ask"]>, caller: string): Form {
    checkFields(input.fields);
    requireThat(actors.manager(caller) !== null, "forbidden", "the root doesn't ask");
    return store.transaction(() => {
      const work = recorded(table, ticketID);
      requireThat(work.ownerID === caller, "forbidden", "only the Work's owner asks on it");
      editable(work);
      return created(forms, caller, ticketID, input);
    });
  }
  function answerSubmission(request: Answer, caller: string): Work {
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
      if (request.ticketID !== undefined) return withAsks(request.ticketID, request.history);
      const { askID } = request;
      const asked = forms.get(askID);
      if (asked === undefined)
        return withAsks(submitted(table, askID, undefined).ticketID, request.history);
      return asked.workID === undefined
        ? recorded(forms, askID, request.history)
        : withAsks(asked.workID, request.history);
    },
    list(input = {}) {
      const query = parse(WorkContracts.work_list.input, input);
      actors.get();
      const { after: _after, limit: _limit, ...filter } = query;
      const waitedOn = (row: WorkState) =>
        row.waitsOn && "actorID" in row.waitsOn ? row.waitsOn.actorID : undefined;
      const page = traverse(
        actors,
        table,
        query,
        ["work", filter],
        () =>
          subtrees(
            actors,
            table,
            {
              owner: query.ownerID === undefined ? undefined : [query.ownerID],
              requester: query.requesterID === undefined ? undefined : [query.requesterID].flat(),
              status: query.status,
            },
            { owner: query.ownerWithin, requester: query.requesterWithin },
          ),
        (row) =>
          (query.waitsOnActorID === undefined || waitedOn(row) === query.waitsOnActorID) &&
          (query.updatedSince === undefined || row.updatedAt >= query.updatedSince),
        (row) => [row.requesterID, row.ownerID, row.review?.reviewerID, waitedOn(row)],
      );
      const asks = asksOn(
        forms,
        page.items.map((item) => item.ticketID),
        { open: true, history: false },
      );
      const items = page.items.map((item) => ({ ...item, asks: asks.get(item.ticketID) ?? [] }));
      const unnamed = items
        .flatMap((item) => item.asks.flatMap(mentioned))
        .filter((actorID) => !Object.hasOwn(page.actors, actorID));
      return { ...page, items, actors: { ...page.actors, ...names(actors, unnamed) } };
    },
    update(input) {
      const request = parse(WorkContracts.work_update.input, input);
      const caller = actors.get().actorID;
      // The contract keeps each form in a call of its own, and `ask` names its Work.
      const { close } = request;
      if (close !== undefined) return store.transaction(() => closed(actors, forms, close, caller));
      if (request.ask !== undefined) return ask(request.ticketID as string, request.ask, caller);
      return edit(request, caller);
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
        const saved = table.save(
          row.ticketID,
          completed
            ? { ...data, status: "accepted", completedAt: at, submission }
            : { ...data, status: "submitted", submission },
          { actorID: caller, at, action: "submitted", detail: submission },
          request.expectedRevision ?? row.revision,
        );
        cancelOpen(forms, row.ticketID, caller, at, "submitted");
        return published(saved);
      });
    },
    answer(input) {
      const request = parse(WorkContracts.work_answer.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const asked = forms.get(request.askID);
        if (asked === undefined) return answerSubmission(request, caller);
        requireThat(
          request.ticketID === undefined || asked.workID === request.ticketID,
          "not_found",
          "record not found",
        );
        return request.raise
          ? raised(actors, forms, asked, caller)
          : responded(actors, forms, asked, caller, request.answers ?? {}, request.note);
      });
    },
    asks(input = {}) {
      const query = parse(AskQuery, input);
      actors.get();
      const { after: _after, limit: _limit, ...filter } = query;
      return traverse(
        actors,
        forms,
        query,
        ["asks", filter],
        () => {
          const requester = query.requesterID === undefined ? undefined : [query.requesterID];
          const routed = query.routedTo;
          return {
            requester,
            // Only an open ask has a route.
            status:
              routed === undefined
                ? query.status
                : (query.status ?? ["open"]).filter((status) => status === "open"),
            route: routed === undefined ? undefined : routedTo(actors, forms, routed, requester),
          };
        },
        (row) => query.answeredBy === undefined || Object.hasOwn(row.responses, query.answeredBy),
        mentioned,
      );
    },
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
