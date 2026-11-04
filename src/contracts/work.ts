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
import { AskClose, AskInput, Form } from "./forms.js";

/** A `blocked` stored before it was refused reads as `active`; `cancelled` is its requester's terminal state. */
export const WorkStatus = z.enum([
  "open",
  "active",
  "submitted",
  "changes_requested",
  "accepted",
  "cancelled",
]);
/** Why `blocked` is refused: Work that can't move asks, and Work held up elsewhere stays active. */
const BLOCKED_GONE =
  "blocked is gone: ask on the Work with work_update {ticketID, ask}, or keep it active and say what it waits on with waitsOn";
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
/**
 * work_answer's answers to a submission, the Work's ask to its requester, rooted at the input so a
 * refusal names `answers.verdict`; the answer's note is the comment.
 */
export const SubmissionAnswer = z.object({
  answers: z.strictObject({ verdict: Review.shape.verdict }),
});
/** What the Work waits on outside itself: an Actor, other Work, or a short description. */
export const WaitsOn = z.union([
  z.strictObject({ actorID: ID }),
  z.strictObject({ ticketID: ID }),
  z.strictObject({ text: z.string().trim().min(1).max(200) }),
]);
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
/** Asks come only with reads: all of them from work_get, the open ones from work_list. */
export const Work = WorkState.extend(Metadata).extend({ asks: z.array(Form).optional() });
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
    "Read Work with all its asks, by ticketID, or by askID: the Work an ask (or the current submission) is on, or an older ask with no Work alone. History only when asked, for the Work and each ask.",
    z
      .strictObject({
        ticketID: ID.optional(),
        askID: ID.optional(),
        history: z.boolean().default(false),
      })
      .refine(
        (
          v,
        ): v is typeof v &
          ({ ticketID: string; askID?: undefined } | { ticketID?: undefined; askID: string }) =>
          (v.ticketID === undefined) !== (v.askID === undefined),
        { error: "name exactly one of ticketID or askID" },
      ),
    z.union([Work, Form]),
  ),
  work_list: contract(
    "report",
    "List shared work matching every filter, by update order or most recent first; each item carries its open asks.",
    filter.extend({ after: Next.optional(), limit: Limit }),
    listOf(Work),
  ),
  work_update: contract(
    "report",
    "One of three forms, each in a call of its own. Edits: the owner edits title, progress, open/active status, links and waitsOn (null clears it); the requester edits goal or owner, or cancels, with expectedRevision. Progress is a paragraph, then optionally a Markdown task list of steps: `- [x]` done, `- [ ]` not done. {ticketID, ask}: the owner asks on its Work and gets the ask back; mark approval when the answer can't be undone. {close}: the asker resolves or cancels its open ask, recording why.",
    z
      .strictObject({
        ticketID: ID.optional(),
        expectedRevision: Revision.optional(),
        title: Title.optional(),
        goal: Text.optional(),
        ownerID: ID.optional(),
        progress: Text.optional(),
        status: z
          .enum(["open", "active", "cancelled"], {
            error: (issue) => (issue.input === "blocked" ? BLOCKED_GONE : undefined),
          })
          .optional(),
        links: Links.optional(),
        waitsOn: WaitsOn.nullable().optional(),
        ask: AskInput.optional(),
        close: AskClose.optional(),
      })
      .refine(
        ({ ticketID, expectedRevision, ask, close, ...edits }) => {
          const edited = Object.values(edits).some((value) => value !== undefined);
          if (close !== undefined)
            return !edited && !ask && ticketID === undefined && expectedRevision === undefined;
          if (ask !== undefined)
            return !edited && ticketID !== undefined && expectedRevision === undefined;
          return edited && ticketID !== undefined;
        },
        {
          error:
            "use one form per call: edits with ticketID; {ticketID, ask} and nothing else; or {close} and nothing else",
        },
      ),
    z.union([Work, Form]),
    true,
  ),
  work_submit: contract(
    "report",
    "Owner submits the result; Work the owner requested itself completes, other Work waits for its requester's answer.",
    mutation.extend({ result: Text, evidence: z.array(Text).max(100).default([]) }),
    Work,
    true,
  ),
  work_answer: contract(
    "team",
    "Answer an ask by its askID: answers for its fields and an optional note. Any Actor answers; only the asker's managers answer an approval; the first answer resolves the ask unless it collects. raise: true, by the Actor the ask is routed to, passes it one manager up. Or answer the Work's current submission by its ID: answers {verdict: accepted or changes_requested}, the note as the comment, which requesting changes needs; only its requester answers, or its nearest open manager once it is closed.",
    z
      .strictObject({
        askID: ID,
        ticketID: ID.optional(),
        answers: z.record(z.string(), z.string().max(20000)).optional(),
        note: Text.optional(),
        raise: z.literal(true).optional(),
      })
      .refine(
        (v) =>
          v.raise ? v.answers === undefined && v.note === undefined : v.answers !== undefined,
        { error: "give answers, or raise: true with no answers or note" },
      ),
    z.union([Work, Form]),
    true,
  ),
};
