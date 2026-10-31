import { z } from "zod";
import { contract, ID, ListInput, Metadata, pageOf, Revision, Text } from "./common.js";

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
  comment: Text,
  at: z.iso.datetime(),
});
export const WorkState = z.strictObject({
  ticketID: ID,
  requesterID: ID,
  ownerID: ID,
  goal: Text,
  progress: Text.optional(),
  status: WorkStatus,
  createdAt: z.iso.datetime(),
  submission: Submission.optional(),
  review: Review.optional(),
});
export const Work = WorkState.extend(Metadata);
export type WorkState = z.infer<typeof WorkState>;
export type Work = z.infer<typeof Work>;
const ticketID = z.strictObject({ ticketID: ID });
const mutation = ticketID.extend({ expectedRevision: Revision });
export const WorkContracts = {
  work_create: contract(
    "Create a durable ticket; caller requests and reviews, owner executes.",
    z.strictObject({ goal: Text, ownerID: ID }),
    Work,
    true,
  ),
  work_get: contract(
    "Read shared organization work and retained history, including accepted work.",
    ticketID,
    Work,
  ),
  work_list: contract(
    "Traverse shared work upserts matching every exact, status and inclusive canonical subtree filter.",
    ListInput.extend({
      ownerID: ID.optional(),
      requesterID: ID.optional(),
      ownerWithin: ID.optional(),
      requesterWithin: ID.optional(),
      status: WorkStatus.optional(),
    }),
    pageOf(Work),
  ),
  work_update: contract(
    "Requester edits goal/owner; owner edits progress/open-active-blocked status with revision check.",
    mutation
      .extend({
        goal: Text.optional(),
        ownerID: ID.optional(),
        progress: Text.optional(),
        status: z.enum(["open", "active", "blocked"]).optional(),
      })
      .refine(
        (v) =>
          v.goal !== undefined ||
          v.ownerID !== undefined ||
          v.progress !== undefined ||
          v.status !== undefined,
      ),
    Work,
    true,
  ),
  work_submit: contract(
    "Owner submits result and evidence for explicit review; returns a new submissionID.",
    mutation.extend({ result: Text, evidence: z.array(Text).max(100) }),
    Work,
    true,
  ),
  work_review: contract(
    "Requester reviews the exact current submission; self-review records the same reviewer identity.",
    mutation.extend({
      submissionID: ID,
      verdict: z.enum(["accepted", "changes_requested"]),
      comment: Text,
    }),
    Work,
    true,
  ),
};
