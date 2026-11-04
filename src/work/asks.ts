/**
 * An ask's rules and writes: its fields, answers, raises, route and closing. Asks are stored in
 * their own rows of the forms table; callers run each write inside the store's transaction.
 */
import { randomUUID } from "node:crypto";
import { type ActorsClient, standIn } from "../actors/index.js";
import {
  type AskClose,
  type AskInput,
  type Field,
  type Form,
  type FormState,
  type Output,
  requireThat,
} from "../contracts/index.js";
import type { RecordTable, Snapshot } from "../persistence/index.js";
import { now, published, readThrough, recorded, stateOf } from "../records.js";

type Asks = RecordTable<FormState, "requester" | "status" | "work" | "route">;

/** Asks as 0.6 reads them: a 0.5 ask's `cause` is left unread, and it has no raises. */
export function asksAsRead(forms: Asks): Asks {
  return readThrough(forms, (row) => {
    const { cause: _cause, ...ask } = row as Snapshot<FormState> & { cause?: string };
    return { ...ask, raises: ask.raises ?? [] };
  });
}
export function checkFields(fields: Field[]) {
  requireThat(
    new Set(fields.map((field) => field.name)).size === fields.length,
    "invalid_input",
    "field names must be unique",
  );
  for (const field of fields) {
    const values = field.options?.map((option) => option.value);
    requireThat(
      values === undefined || new Set(values).size === values.length,
      "invalid_input",
      "field options must be unique",
    );
    requireThat(
      field.recommended === undefined || values?.includes(field.recommended),
      "invalid_input",
      "recommended must be one of the field's options",
    );
  }
}
/**
 * Each Work's asks, by its ID, in the order they were asked (asks in the same millisecond keep
 * update order); the open ones only when asked, and each with its history when asked.
 */
export function asksOn(
  forms: Asks,
  ticketIDs: string[],
  options: { open: boolean; history: boolean },
) {
  const asks = new Map<string, Form[]>(ticketIDs.map((id) => [id, []]));
  const rows = forms
    .where({ work: ticketIDs, status: options.open ? ["open"] : undefined })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const row of rows)
    asks
      .get(row.workID as string)
      ?.push(
        options.history
          ? { ...published(row), history: forms.history(row.formID) }
          : published(row),
      );
  return asks;
}
/** A new ask on a Work, by its owner, which the caller has checked may ask on it. */
export function created(
  forms: Asks,
  caller: string,
  ticketID: string,
  input: Output<typeof AskInput>,
): Form {
  const at = now();
  const formID = randomUUID();
  const { links = [], ...asked } = input;
  return published(
    forms.save(
      formID,
      {
        formID,
        requesterID: caller,
        ...asked,
        links,
        workID: ticketID,
        status: "open",
        createdAt: at,
        responses: {},
        raises: [],
      },
      { actorID: caller, at, action: "created", detail: { ...input, workID: ticketID } },
    ),
  );
}
/** The asker, or its nearest open manager once it is closed, resolves or cancels its open ask. */
export function closed(
  actors: ActorsClient,
  forms: Asks,
  request: Output<typeof AskClose>,
  caller: string,
): Form {
  const row = recorded(forms, request.askID);
  requireThat(
    standIn(actors, row.requesterID) === caller,
    "forbidden",
    "only the asker closes its ask",
  );
  requireThat(row.status === "open", "conflict", "the ask is closed");
  const resolution = { text: request.resolution, at: now() };
  return published(
    forms.save(
      row.formID,
      { ...stateOf(row), status: request.status, resolution },
      { actorID: caller, at: resolution.at, action: request.status, detail: resolution },
      row.revision,
    ),
  );
}
/** A complete answer set by one responder; only the asker's strict managers answer an approval. */
export function responded(
  actors: ActorsClient,
  forms: Asks,
  row: Snapshot<FormState>,
  caller: string,
  answers: Record<string, string>,
  note: string | undefined,
): Form {
  requireThat(row.status === "open", "conflict", "the ask is closed");
  requireThat(
    !row.approval || (caller !== row.requesterID && actors.within(row.requesterID, caller)),
    "forbidden",
    "only the asker's managers answer an approval",
  );
  for (const name of Object.keys(answers))
    requireThat(
      row.fields.some((field) => field.name === name),
      "invalid_input",
      "answer names an unknown field",
    );
  for (const field of row.fields) {
    const answer = Object.hasOwn(answers, field.name) ? answers[field.name] : undefined;
    requireThat(
      !field.required || (answer !== undefined && answer.trim().length > 0),
      "invalid_input",
      "required answer is missing",
    );
    requireThat(
      answer === undefined ||
        field.options === undefined ||
        field.options.some((option) => option.value === answer),
      "invalid_input",
      "answer is outside field options",
    );
  }
  const at = now();
  const answer = { answers, ...(note === undefined ? {} : { note }) };
  return published(
    forms.save(
      row.formID,
      {
        ...stateOf(published(row)),
        status: row.collect ? "open" : "resolved",
        responses: { ...row.responses, [caller]: { ...answer, at } },
      },
      { actorID: caller, at, action: "responded", detail: answer },
      row.revision,
    ),
  );
}
/** The Actor an open ask is routed to passes it one manager up; a raise never resolves it. */
export function raised(
  actors: ActorsClient,
  forms: Asks,
  row: Snapshot<FormState>,
  caller: string,
): Form {
  requireThat(row.status === "open", "conflict", "the ask is closed");
  requireThat(
    routeOf(actors, row) === caller && above(actors, caller) !== null,
    "forbidden",
    "only the Actor the ask is routed to raises it, to an open manager above it",
  );
  const raise = { actorID: caller, at: now() };
  return published(
    forms.save(
      row.formID,
      { ...stateOf(published(row)), raises: [...row.raises, raise] },
      { actorID: caller, at: raise.at, action: "raised", detail: raise },
      row.revision,
    ),
  );
}
/** Where an Actor's asks route: its manager, or that manager's nearest open manager. */
function above(actors: ActorsClient, actorID: string) {
  const manager = actors.manager(actorID);
  return manager === null ? null : standIn(actors, manager);
}
/** The Actor an open ask is routed to, from its last raiser or else its asker; null for none. */
export function routeOf(actors: ActorsClient, row: FormState) {
  return row.status === "open"
    ? above(actors, row.raises.at(-1)?.actorID ?? row.requesterID)
    : null;
}
/** The route origins of open asks, among those the filter keeps, that route to an Actor. */
export function routedTo(
  actors: ActorsClient,
  forms: Asks,
  actorID: string,
  requester: string[] | undefined,
) {
  return forms
    .values("route", { status: ["open"], requester })
    .filter((origin) => above(actors, origin) === actorID);
}
const CANCELLED = {
  submitted: "Cancelled with the Work's submission.",
  cancelled: "Cancelled with the Work's cancellation.",
  reassigned: "Cancelled with the Work's reassignment.",
} as const;
/** Cancels the open asks on a Work whose asker no longer moves it (Q12). */
export function cancelOpen(
  forms: Asks,
  ticketID: string,
  actorID: string,
  at: string,
  reason: keyof typeof CANCELLED,
) {
  for (const row of forms.where({ work: [ticketID], status: ["open"] })) {
    const resolution = { text: CANCELLED[reason], reason, at };
    forms.save(
      row.formID,
      { ...stateOf(published(row)), status: "cancelled", resolution },
      { actorID, at, action: "cancelled", detail: resolution },
      row.revision,
    );
  }
}
/** The Actors an ask mentions: its asker, responders and raisers. */
export const mentioned = (row: FormState) => [
  row.requesterID,
  ...Object.keys(row.responses),
  ...row.raises.map((raise) => raise.actorID),
];
