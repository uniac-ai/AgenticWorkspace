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
    "team",
    "Send a message to one Actor; it joins the pair's conversation.",
    z.strictObject({ recipientID: ID, text: Text }),
    Message,
    true,
  ),
  message_get: contract("team", "Read a message as one of its parties.", messageID, Message),
  message_list: contract(
    "team",
    "List the caller's messages ascending: forward after a position, or the newest window before latest/older; counterpartyID selects one conversation.",
    z
      .strictObject({
        direction: z.enum(["incoming", "outgoing", "all"]).default("all"),
        counterpartyID: ID.optional(),
        before: z.union([z.literal("latest"), Next]).optional(),
        after: z.union([Next, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]).optional(),
        limit: Limit,
      })
      .refine((query) => query.before === undefined || query.after === undefined),
    listOf(Message).extend({ older: Next.nullable() }),
  ),
};
