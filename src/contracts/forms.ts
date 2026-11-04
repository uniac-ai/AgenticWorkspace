import { z } from "zod";
import { ID, Limit, Links, Metadata, Next, Text, Title } from "./common.js";

export const Option = z.strictObject({ value: Text, detail: Text.optional() });
/** A field with options is a choice; recommended names the asker's choice among them. */
export const Field = z.strictObject({
  name: ID,
  label: Text,
  required: z.boolean(),
  options: z.array(Option).min(1).max(100).optional(),
  recommended: Text.optional(),
});
export type Field = z.infer<typeof Field>;
export const Response = z.strictObject({
  answers: z.record(z.string(), z.string().max(20000)),
  note: Text.optional(),
  at: z.iso.datetime(),
});
/** Who passed an ask up, and when; a raise names no destination. */
export const Raise = z.strictObject({ actorID: ID, at: z.iso.datetime() });
export const AskStatus = z.enum(["open", "resolved", "cancelled"]);
/**
 * An ask, part of the Work its asker owns: open to any responder except where approval limits it.
 * Its record keeps the Form names until the wire takes the model's words.
 */
export const FormState = z.strictObject({
  formID: ID,
  requesterID: ID,
  title: Title,
  context: Text.optional(),
  links: Links,
  /** Absent only on an older ask that names no Work. */
  workID: ID.optional(),
  approval: z.boolean(),
  collect: z.boolean(),
  fields: z.array(Field).min(1).max(100),
  status: AskStatus,
  createdAt: z.iso.datetime(),
  responses: z.record(ID, Response),
  raises: z.array(Raise),
  resolution: z
    .strictObject({
      text: Text,
      /** Set when the Work's submission, cancellation or reassignment cancelled the ask. */
      reason: z.enum(["submitted", "cancelled", "reassigned"]).optional(),
      at: z.iso.datetime(),
    })
    .optional(),
});
export const Form = FormState.extend(Metadata);
export type Form = z.infer<typeof Form>;
export type FormState = z.infer<typeof FormState>;
/** A new ask: a title, context, links and fields; approval when the answer can't be undone. */
export const AskInput = z.strictObject({
  title: Title,
  context: Text.optional(),
  links: Links.optional(),
  approval: z.boolean().default(false),
  collect: z.boolean().default(false),
  fields: z.array(Field).min(1).max(100),
});
/** The asker resolves or cancels its open ask, recording why. */
export const AskClose = z.strictObject({
  askID: ID,
  status: z.enum(["resolved", "cancelled"]),
  resolution: Text,
});
/** A host's read of asks, outside any Work: an asker's, those routed to an Actor, or answered by one. */
export const AskQuery = z.strictObject({
  requesterID: ID.optional(),
  routedTo: ID.optional(),
  answeredBy: ID.optional(),
  status: z.array(AskStatus).min(1).optional(),
  after: Next.optional(),
  limit: Limit,
});
