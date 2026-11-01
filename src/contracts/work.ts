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
} from "./common.js";

export const WorkStatus = z.enum([
  "open",
  "active",
  "blocked",
  "submitted",
  "changes_requested",
  "accepted",
]);
export const Submission = z.strictObject({
  submissionID: ID,
  ownerID: ID,
  result: Text,
  evidence: z.array(Text).max(100),
  at: z.iso.datetime(),
});
export const Review = z.strictObject({
  submissionID: ID,
  reviewerID: ID,
  verdict: z.enum(["accepted", "changes_requested"]),
  comment: Text.optional(),
  at: z.iso.datetime(),
});
/** What the Work waits on outside itself: an Actor, other Work, or a short description. */
export const WaitsOn = z.union([
  z.strictObject({ actorID: ID }),
  z.strictObject({ ticketID: ID }),
  z.strictObject({ text: z.string().trim().min(1).max(200) }),
]);
export const Title = z.string().trim().min(1).max(120);
export const WorkState = z.strictObject({
  ticketID: ID,
  requesterID: ID,
  ownerID: ID,
  title: Title,
  goal: Text.optional(),
  progress: Text.optional(),
  status: WorkStatus,
  links: Links,
  waitsOn: WaitsOn.optional(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  submission: Submission.optional(),
  review: Review.optional(),
});
export const Work = WorkState.extend(Metadata);
export type WorkState = z.infer<typeof WorkState>;
export type WaitsOn = z.infer<typeof WaitsOn>;
export type Work = z.infer<typeof Work>;
const ticketID = z.strictObject({ ticketID: ID });
/** The revision check is optional on the owner's own writes, which can't conflict. */
const mutation = ticketID.extend({ expectedRevision: Revision.optional() });
/** Every supplied filter must match; the page limit applies after them. */
const filter = z.strictObject({
  ownerID: ID.optional(),
  requesterID: OneOrMany.optional(),
  waitsOnActorID: ID.optional(),
  ownerWithin: ID.optional(),
  requesterWithin: ID.optional(),
  status: z.array(WorkStatus).min(1).optional(),
  updatedSince: z.iso.datetime().optional(),
  order: z.literal("recent").optional(),
});
export const WorkContracts = {
  work_create: contract(
    "report",
    "Create Work; the caller requests it and owns it unless ownerID names another Actor.",
    z.strictObject({
      title: Title,
      goal: Text.optional(),
      ownerID: ID.optional(),
      links: Links.optional(),
      waitsOn: WaitsOn.optional(),
    }),
    Work,
    true,
  ),
  work_get: contract(
    "report",
    "Read shared organization work, including accepted work; history only when asked.",
    ticketID.extend({ history: z.boolean().default(false) }),
    Work,
  ),
  work_list: contract(
    "report",
    "List shared work matching every filter, by update order or most recent first.",
    filter.extend({ after: Next.optional(), limit: Limit }),
    listOf(Work),
  ),
  work_update: contract(
    "report",
    "Owner edits title, progress, open/active/blocked status, links and waitsOn (null clears it); requester edits goal or owner with expectedRevision.",
    mutation
      .extend({
        title: Title.optional(),
        goal: Text.optional(),
        ownerID: ID.optional(),
        progress: Text.optional(),
        status: z.enum(["open", "active", "blocked"]).optional(),
        links: Links.optional(),
        waitsOn: WaitsOn.nullable().optional(),
      })
      .refine(({ ticketID: _ticketID, expectedRevision: _revision, ...edits }) =>
        Object.values(edits).some((value) => value !== undefined),
      ),
    Work,
    true,
  ),
  work_submit: contract(
    "report",
    "Owner submits the result; Work the owner requested itself completes, other Work waits for review.",
    mutation.extend({ result: Text, evidence: z.array(Text).max(100).default([]) }),
    Work,
    true,
  ),
  work_review: contract(
    "team",
    "Requester accepts or requests changes on the exact current submission; requesting changes needs a comment.",
    mutation
      .extend({
        submissionID: ID,
        verdict: z.enum(["accepted", "changes_requested"]),
        comment: Text.optional(),
      })
      .refine((v) => v.verdict === "accepted" || v.comment !== undefined),
    Work,
    true,
  ),
};
