/** Structured interactions with optional work context, responses and resolution. */
import { randomUUID } from "node:crypto";
import { type ActorsClient, activeActor } from "../actors/index.js";
import {
  type Form,
  FormContracts,
  type FormState,
  type Input,
  type Page,
  parse,
  requireThat,
  WorkspaceError,
} from "../contracts/index.js";
import type { WorkspaceStore } from "../persistence/index.js";
import { now, recorded, traverse } from "../records.js";
import type { WorkReader } from "../work/index.js";

export interface FormsClient {
  create(input: Input<typeof FormContracts.form_create.input>): Form;
  get(input: Input<typeof FormContracts.form_get.input>): Form;
  list(input?: Input<typeof FormContracts.form_list.input>): Page<Form>;
  respond(input: Input<typeof FormContracts.form_respond.input>): Form;
  close(input: Input<typeof FormContracts.form_close.input>): Form;
}
export function createForms(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "forms" | "transaction">,
  work?: WorkReader,
): FormsClient {
  const table = store.forms;
  function visible(row: FormState, caller: string): boolean {
    if (row.requesterID === caller || row.respondentIDs.includes(caller)) return true;
    if (row.workID === undefined || work === undefined) return false;
    try {
      work.get({ ticketID: row.workID });
      return true;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "not_found") return false;
      throw error;
    }
  }
  function get(id: string, caller: string): Form {
    const row = recorded(table, id);
    requireThat(visible(row, caller), "not_found", "record not found");
    return row;
  }
  const state = (row: Form): FormState => {
    const { revision: _revision, cursor: _cursor, history: _history, ...data } = row;
    return data;
  };
  return {
    create(input) {
      const request = parse(FormContracts.form_create.input, input);
      const caller = actors.get().actorID;
      if (request.workID !== undefined) {
        requireThat(work, "invalid_input", "work references require a Work client");
        work.get({ ticketID: request.workID });
      }
      requireThat(
        new Set(request.respondentIDs).size === request.respondentIDs.length,
        "invalid_input",
        "respondents must be unique",
      );
      requireThat(
        new Set(request.fields.map((field) => field.name)).size === request.fields.length,
        "invalid_input",
        "field names must be unique",
      );
      for (const field of request.fields)
        requireThat(
          field.options === undefined || new Set(field.options).size === field.options.length,
          "invalid_input",
          "field options must be unique",
        );
      for (const id of request.respondentIDs) activeActor(actors, id);
      return store.transaction(() => {
        const at = now();
        const formID = randomUUID();
        return table.save(
          formID,
          { formID, requesterID: caller, ...request, status: "open", responses: {}, createdAt: at },
          { actorID: caller, at, action: "created", detail: request },
        );
      });
    },
    get(input) {
      const request = parse(FormContracts.form_get.input, input);
      return get(request.formID, actors.get().actorID);
    },
    list(input = {}) {
      const query = parse(FormContracts.form_list.input, input);
      const caller = actors.get().actorID;
      return traverse(
        table,
        query,
        (row) =>
          (query.workID === undefined || row.workID === query.workID) && visible(row, caller),
      );
    },
    respond(input) {
      const request = parse(FormContracts.form_respond.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = get(request.formID, caller);
        requireThat(
          row.respondentIDs.includes(caller),
          "forbidden",
          "only a designated respondent answers",
        );
        requireThat(row.status === "open", "conflict", "form is closed");
        for (const name of Object.keys(request.answers))
          requireThat(
            row.fields.some((field) => field.name === name),
            "invalid_input",
            "answer names an unknown field",
          );
        for (const field of row.fields) {
          const answer = Object.hasOwn(request.answers, field.name)
            ? request.answers[field.name]
            : undefined;
          requireThat(
            !field.required || (answer !== undefined && answer.trim().length > 0),
            "invalid_input",
            "required answer is missing",
          );
          requireThat(
            answer === undefined || field.options === undefined || field.options.includes(answer),
            "invalid_input",
            "answer is outside field options",
          );
        }
        return table.save(
          row.formID,
          { ...state(row), responses: { ...row.responses, [caller]: request.answers } },
          { actorID: caller, at: now(), action: "responded", detail: { answers: request.answers } },
          request.expectedRevision,
        );
      });
    },
    close(input) {
      const request = parse(FormContracts.form_close.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = get(request.formID, caller);
        requireThat(row.requesterID === caller, "forbidden", "only form requester closes a form");
        requireThat(row.status === "open", "conflict", "form is closed");
        const at = now();
        const resolution = { text: request.resolution, at };
        return table.save(
          row.formID,
          { ...state(row), status: request.status, resolution },
          { actorID: caller, at, action: request.status, detail: resolution },
          request.expectedRevision,
        );
      });
    },
  };
}
