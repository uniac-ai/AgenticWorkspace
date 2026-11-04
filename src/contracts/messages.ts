import { z } from "zod";
import { contract, ID, Limit, listOf, Next, Text } from "./common.js";

/** What the Messages module stores; a Message is immutable once sent. */
export const MessageState = z.strictObject({
  messageID: ID,
  senderID: ID,
  recipientID: ID,
  text: Text,
  createdAt: z.iso.datetime(),
});
/** A place in the one Message order, which follows commit order across every conversation. */
export const Seq = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const Message = z.strictObject({
  messageID: ID,
  conversationID: ID,
  senderID: ID,
  recipientID: ID,
  text: Text,
  createdAt: z.iso.datetime(),
  seq: Seq,
});
export type Message = z.infer<typeof Message>;
export type MessageState = z.infer<typeof MessageState>;
const messageID = z.strictObject({ messageID: ID });
export const MessageContracts = {
  message_send: contract(
    "report",
    "Send a message to another Actor; it joins the pair's conversation.",
    z.strictObject({ recipientID: ID, text: Text }),
    Message,
    true,
  ),
  message_get: contract("team", "Read a message.", messageID, Message),
  message_list: contract(
    "report",
    "Name exactly one of between, counterpartyID or of. between (two Actors) or counterpartyID (the caller and one Actor) reads one conversation ascending: forward after a position or seq, or the newest window before latest/older. of lists an Actor's conversations, newest first, each as its latest message, continuing only after next.",
    z
      .strictObject({
        between: z.array(ID).length(2).optional(),
        counterpartyID: ID.optional(),
        of: ID.optional(),
        before: z.union([z.literal("latest"), Next]).optional(),
        after: z.union([Next, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]).optional(),
        limit: Limit,
      })
      .refine(
        ({ between, counterpartyID, of }) =>
          [between, counterpartyID, of].filter((value) => value !== undefined).length === 1,
        { error: "name exactly one of between, counterpartyID or of" },
      )
      .refine(({ before, after }) => before === undefined || after === undefined, {
        error: "give before or after, not both",
      })
      .refine(
        ({ of, before, after }) =>
          of === undefined || (before === undefined && typeof after !== "number"),
        { error: "of continues only after a next position" },
      ),
    listOf(Message).extend({ older: Next.nullable() }),
  ),
};
