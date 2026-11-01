/** Immutable direct messages, each in its pair's conversation and the one Message order. */
import { createHash, randomUUID } from "node:crypto";
import { type ActorsClient, activeActor } from "../actors/index.js";
import {
  type Input,
  type List,
  type Message,
  MessageContracts,
  type MessageState,
  parse,
  requireThat,
} from "../contracts/index.js";
import type { Snapshot, WorkspaceStore } from "../persistence/index.js";
import { names, now, position, token } from "../records.js";

export interface MessagesClient {
  send(input: Input<typeof MessageContracts.message_send.input>): Message;
  get(input: Input<typeof MessageContracts.message_get.input>): Message;
  list(
    input?: Input<typeof MessageContracts.message_list.input>,
  ): List<Message> & { older: string | null };
}
/** One direct conversation per pair; the ID is opaque to clients. */
const conversationOf = (a: string, b: string) =>
  createHash("sha256")
    .update(JSON.stringify(["direct", ...[a, b].sort()]))
    .digest("base64url")
    .slice(0, 22);
const message = (row: Snapshot<MessageState>): Message => ({
  messageID: row.messageID,
  conversationID: conversationOf(row.senderID, row.recipientID),
  senderID: row.senderID,
  recipientID: row.recipientID,
  text: row.text,
  createdAt: row.createdAt,
  seq: row.cursor,
});
export function createMessages(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "messages" | "transaction">,
): MessagesClient {
  const table = store.messages;
  const visible = (row: MessageState, caller: string) =>
    row.senderID === caller || row.recipientID === caller;
  return {
    send(input) {
      const request = parse(MessageContracts.message_send.input, input);
      const caller = actors.get().actorID;
      activeActor(actors, request.recipientID);
      return store.transaction(() => {
        const at = now();
        const messageID = randomUUID();
        return message(
          table.save(
            messageID,
            { messageID, senderID: caller, ...request, createdAt: at },
            { actorID: caller, at, action: "sent", detail: request },
          ),
        );
      });
    },
    get(input) {
      const request = parse(MessageContracts.message_get.input, input);
      const caller = actors.get().actorID;
      const row = table.get(request.messageID);
      requireThat(row && visible(row, caller), "not_found", "record not found");
      return message(row);
    },
    list(input = {}) {
      const query = parse(MessageContracts.message_list.input, input);
      const caller = actors.get().actorID;
      const { before, after, limit, ...filter } = query;
      const scope = ["messages", filter];
      const matches = (row: MessageState) =>
        visible(row, caller) &&
        (query.counterpartyID === undefined ||
          (row.senderID === caller && row.recipientID === query.counterpartyID) ||
          (row.recipientID === caller && row.senderID === query.counterpartyID)) &&
        (query.direction === "all" ||
          (query.direction === "incoming" ? row.recipientID === caller : row.senderID === caller));
      const head = table.head();
      const rows = table.all().filter((row) => row.cursor <= head && matches(row));
      let items: Snapshot<MessageState>[];
      if (before !== undefined) {
        const bound = before === "latest" ? head + 1 : position(before, scope, "before");
        items = rows.filter((row) => row.cursor < bound).slice(-limit);
      } else {
        const bound =
          after === undefined ? 0 : typeof after === "number" ? after : position(after, scope);
        requireThat(bound <= head, "invalid_input", "position is beyond the module head");
        items = rows.filter((row) => row.cursor > bound).slice(0, limit);
      }
      const first = items[0];
      const last = items.at(-1);
      return {
        items: items.map(message),
        next: last && last.cursor < (rows.at(-1)?.cursor ?? 0) ? token(scope, last.cursor) : null,
        older:
          first && first.cursor > (rows[0]?.cursor ?? 0)
            ? token(scope, first.cursor, "before")
            : null,
        actors: names(
          actors,
          items.flatMap((row) => [row.senderID, row.recipientID]),
        ),
      };
    },
  };
}
