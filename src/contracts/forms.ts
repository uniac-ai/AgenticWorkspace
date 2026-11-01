import { z } from "zod";
import {
  contract,
  ID,
  Limit,
  listOf,
  Metadata,
  Next,
  OneOrMany,
  Revision,
  Text,
} from "./common.js";

export const Field = z.strictObject({
  name: ID,
  label: Text,
  required: z.boolean(),
  options: z.array(Text).min(1).max(100).optional(),
});
export const FormState = z.strictObject({
  formID: ID,
  workID: ID.optional(),
  requesterID: ID,
  respondentIDs: z.array(ID).min(1).max(100),
  fields: z.array(Field).min(1).max(100),
  status: z.enum(["open", "resolved", "cancelled"]),
  createdAt: z.iso.datetime(),
  responses: z.record(z.string(), z.record(z.string(), z.string())),
  resolution: z.strictObject({ text: Text, at: z.iso.datetime() }).optional(),
});
export const Form = FormState.extend(Metadata);
export type Form = z.infer<typeof Form>;
export type FormState = z.infer<typeof FormState>;
const formID = z.strictObject({ formID: ID });
const mutation = formID.extend({ expectedRevision: Revision });
export const FormContracts = {
  form_create: contract(
    "report",
    "Create a form, optionally linked to readable work; one field is a question.",
    z.strictObject({
      workID: ID.optional(),
      respondentIDs: z.array(ID).min(1).max(100),
      fields: z.array(Field).min(1).max(100),
    }),
    Form,
    true,
  ),
  form_get: contract(
    "report",
    "Read a shared organization form; history only when asked.",
    formID.extend({ history: z.boolean().default(false) }),
    Form,
  ),
  form_list: contract(
    "report",
    "List shared forms matching every filter, by update order or most recent first; awaiting requires an open designated respondent without a response entry.",
    z.strictObject({
      workID: ID.optional(),
      requesterID: OneOrMany.optional(),
      respondentID: ID.optional(),
      status: z.array(FormState.shape.status).min(1).optional(),
      awaitingActorID: ID.optional(),
      requesterWithin: ID.optional(),
      respondentWithin: ID.optional(),
      awaitingWithin: ID.optional(),
      updatedSince: z.iso.datetime().optional(),
      order: z.literal("recent").optional(),
      after: Next.optional(),
      limit: Limit,
    }),
    listOf(Form),
  ),
  form_respond: contract(
    "team",
    "Designated respondent adds or revises a complete answer while open, retaining prior responses.",
    mutation.extend({ answers: z.record(z.string(), z.string().max(20000)) }),
    Form,
    true,
  ),
  form_close: contract(
    "report",
    "Form requester records resolution/cancellation; work lifecycle is unchanged.",
    mutation.extend({ status: z.enum(["resolved", "cancelled"]), resolution: Text }),
    Form,
    true,
  ),
};
