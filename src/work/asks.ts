/**
 * An ask's rules and writes: its fields, answers, route and closing. Asks are stored in their own
 * rows of the forms table; callers run each write inside the store's transaction.
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
  type WorkState,
} from "../contracts/index.js";
import type { RecordTable, Snapshot } from "../persistence/index.js";
import { now, published, readThrough, recorded, stateOf } from "../records.js";

type Asks = RecordTable<FormState, "requester" | "status" | "work">;
type Requesters = Pick<RecordTable<WorkState>, "get">;

/**
 * Asks as this package reads them: a `cause` stored before asks lived on Work, and the `raises`
 * earlier builds stored, are left unread.
 */
export function asksAsRead(forms: Asks): Asks {
  return readThrough(forms, (row) => {
    const {
      cause: _cause,
      raises: _raises,
      ...ask
    } = row as Snapshot<FormState> & { cause?: string; raises?: unknown };
    return ask;
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
      },
      { actorID: caller, at, action: "created", detail: { ...input, workID: ticketID } },
    ),
  );
}
/** The asker, or the person once the asker is closed, resolves or cancels its open ask. */
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
/**
 * A complete answer set by one responder; only the Actor an approval is routed to answers it, never
 * its asker.
 */
export function responded(
  actors: ActorsClient,
  forms: Asks,
  work: Requesters,
  row: Snapshot<FormState>,
  caller: string,
  answers: Record<string, string>,
  note: string | undefined,
): Form {
  requireThat(row.status === "open", "conflict", "the ask is closed");
  requireThat(
    !row.approval || (caller !== row.requesterID && router(actors, work)(row) === caller),
    "forbidden",
    "only the Actor an approval is routed to answers it, never its asker",
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
/**
 * The Actor each open ask is routed to: its Work's requester, or the person when the asker requested
 * the Work itself or the ask names no Work. A closed requester's asks go to the person. A router
 * reads each Work's requester, each stand-in and the person once. Rights use the strict stand-in;
 * only the hosts' routed read counts an Actor the caller can't see as closed.
 */
export function router(actors: ActorsClient, work: Requesters, through = standIn) {
  const requesterOf = remembered((workID) => work.get(workID)?.requesterID);
  const standInOf = remembered((actorID) => through(actors, actorID));
  let person: string | undefined;
  return (row: FormState): string => {
    const requester = row.workID === undefined ? undefined : requesterOf(row.workID);
    if (requester !== undefined && requester !== row.requesterID) return standInOf(requester);
    person ??= actors.person();
    return person;
  };
}
/** Reads each key once for the life of the returned function. */
function remembered<V>(read: (key: string) => V) {
  const values = new Map<string, V>();
  return (key: string): V => {
    if (!values.has(key)) values.set(key, read(key));
    return values.get(key) as V;
  };
}
const CANCELLED = {
  submitted: "Cancelled with the Work's submission.",
  cancelled: "Cancelled with the Work's cancellation.",
  reassigned: "Cancelled with the Work's reassignment.",
} as const;
/** Cancels the open asks on a Work whose asker no longer moves it. */
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
/** The Actors an ask mentions: its asker and responders. */
export const mentioned = (row: FormState) => [row.requesterID, ...Object.keys(row.responses)];
