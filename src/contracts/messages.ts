import { z } from "zod";
import { contract, ID, ListInput, Metadata, pageOf, Text } from "./common.js";

export const MessageState = z.strictObject({
  messageID: ID,
  senderID: ID,
  recipientID: ID,
  text: Text,
  workID: ID.optional(),
  createdAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().optional(),
  handling: z.strictObject({ outcome: Text, at: z.iso.datetime() }).optional(),
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
  message_get: contract(
    "Read a message as one of its parties; reading has no acknowledgement effect.",
    messageID,
    Message,
  ),
  message_list: contract(
    "Traverse current visible incoming/outgoing message upserts.",
    ListInput.extend({ direction: z.enum(["incoming", "outgoing", "all"]).default("all") }),
    pageOf(Message),
  ),
  message_acknowledge: contract(
    "Record the recipient's read acknowledgement independently of handling.",
    messageID,
    Message,
    true,
  ),
  message_handle: contract(
    "Record a recipient handling outcome independently of read acknowledgement.",
    messageID.extend({ outcome: Text }),
    Message,
    true,
  ),
};
