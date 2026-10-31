import { z } from "zod";
import { contract, ID, ListInput, Metadata, pageOf, Text } from "./common.js";

export const MessageState = z.strictObject({
  messageID: ID,
  senderID: ID,
  recipientID: ID,
  text: Text,
  workID: ID.optional(),
  createdAt: z.iso.datetime(),
});
export const Message = MessageState.extend(Metadata);
export type Message = z.infer<typeof Message>;
export type MessageState = z.infer<typeof MessageState>;
const messageID = z.strictObject({ messageID: ID });
export const MessageContracts = {
  message_send: contract(
    "Persist a direct message, optionally linked to readable work.",
    z.strictObject({ recipientID: ID, text: Text, workID: ID.optional() }),
    Message,
    true,
  ),
  message_get: contract("Read a message as one of its parties.", messageID, Message),
  message_list: contract(
    "List private correspondence forward, or select the newest peer window before latest/an exclusive cursor; return ascending rows.",
    ListInput.extend({
      direction: z.enum(["incoming", "outgoing", "all"]).default("all"),
      counterpartyID: ID.optional(),
      before: z
        .union([z.literal("latest"), z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)])
        .optional(),
    }).refine(
      (query) =>
        query.before === undefined || (query.counterpartyID !== undefined && query.after === 0),
    ),
    pageOf(Message),
  ),
};
