import { z } from "zod";
import {
  contract,
  ID,
  Limit,
  Links,
  listOf,
  Metadata,
  Next,
  OneOrMany,
  Revision,
  Text,
  Title,
} from "./common.js";

export const Option = z.strictObject({ value: Text, detail: Text.optional() });
/** A field with options is a choice; recommended names the asker's choice among them. */
export const Field = z.strictObject({
  name: ID,
  label: Text,
  required: z.boolean(),
  options: z.array(Option).min(1).max(100).optional(),
  recommended: Text.optional(),
});
export const Response = z.strictObject({
  answers: z.record(z.string(), z.string().max(20000)),
  note: Text.optional(),
  at: z.iso.datetime(),
});
/** An ask: the asker's own output, open to any responder except where approval limits it. */
export const FormState = z.strictObject({
  formID: ID,
  requesterID: ID,
  title: Title,
  context: Text.optional(),
  links: Links,
  workID: ID.optional(),
  cause: ID.optional(),
  approval: z.boolean(),
  collect: z.boolean(),
  fields: z.array(Field).min(1).max(100),
  status: z.enum(["open", "resolved", "cancelled"]),
  createdAt: z.iso.datetime(),
  responses: z.record(ID, Response),
  resolution: z.strictObject({ text: Text, at: z.iso.datetime() }).optional(),
});
export const Form = FormState.extend(Metadata);
export type Form = z.infer<typeof Form>;
export type FormState = z.infer<typeof FormState>;
const formID = z.strictObject({ formID: ID });
export const FormContracts = {
  form_create: contract(
    "report",
    "Ask: a title, context, links and fields; optionally the Work it blocks, the report's ask it carries up (cause), approval or collect.",
    z.strictObject({
      title: Title,
      context: Text.optional(),
      links: Links.optional(),
      workID: ID.optional(),
      cause: ID.optional(),
      approval: z.boolean().default(false),
      collect: z.boolean().default(false),
      fields: z.array(Field).min(1).max(100),
    }),
    Form,
    true,
  ),
  form_get: contract(
    "report",
    "Read a shared organization ask; history only when asked.",
    formID.extend({ history: z.boolean().default(false) }),
    Form,
  ),
  form_list: contract(
    "report",
    "List shared asks matching every filter, by update order or most recent first.",
    z.strictObject({
      workID: ID.optional(),
      requesterID: OneOrMany.optional(),
      requesterWithin: ID.optional(),
      status: z.array(FormState.shape.status).min(1).optional(),
      updatedSince: z.iso.datetime().optional(),
      order: z.literal("recent").optional(),
      after: Next.optional(),
      limit: Limit,
    }),
    listOf(Form),
  ),
  form_respond: contract(
    "team",
    "Answer an open ask completely, with an optional note; the first answer resolves it unless it collects. Only the asker's managers answer an approval.",
    formID.extend({
      answers: z.record(z.string(), z.string().max(20000)),
      note: Text.optional(),
      expectedRevision: Revision.optional(),
    }),
    Form,
    true,
  ),
  form_close: contract(
    "report",
    "The asker resolves or cancels its open ask, recording why; Work is unchanged.",
    formID.extend({
      expectedRevision: Revision,
      status: z.enum(["resolved", "cancelled"]),
      resolution: Text,
    }),
    Form,
    true,
  ),
};
