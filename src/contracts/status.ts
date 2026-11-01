import { z } from "zod";
import { contract, ID, Links, Metadata } from "./common.js";

/** An Actor's own line, summary and links; it holds no state. */
export const StatusState = z.strictObject({
  actorID: ID,
  line: z.string().trim().min(1).max(160).optional(),
  summary: z.string().trim().min(1).max(1200).optional(),
  links: Links,
});
export const Status = StatusState.extend(Metadata);
export type Status = z.infer<typeof Status>;
export type StatusState = z.infer<typeof StatusState>;
export const StatusContracts = {
  status_set: contract(
    "report",
    "Set the caller's status line, summary or links; omitted fields keep their value.",
    StatusState.omit({ actorID: true })
      .partial()
      .refine((v) => Object.values(v).some((value) => value !== undefined)),
    Status,
    true,
  ),
  status_get: contract(
    "report",
    "Read an Actor's status, the caller's by default; history only when asked.",
    z.strictObject({ actorID: ID.optional(), history: z.boolean().default(false) }),
    Status,
  ),
};
