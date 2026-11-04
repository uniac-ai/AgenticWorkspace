/** Immutable direct messages, each in its pair's conversation and the one Message order; reads are open. */
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
  list(input: Input<typeof MessageContracts.message_list.input>): List<Message> & {
    older: string | null;
  };
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
  const page = (
    items: Snapshot<MessageState>[],
    next: string | null,
    older: string | null,
  ): List<Message> & { older: string | null } => ({
    items: items.map(message),
    next,
    older,
    actors: names(
      actors,
      items.flatMap((row) => [row.senderID, row.recipientID]),
    ),
  });
  /** An Actor's conversations, newest first, each as its latest message. */
  function conversations(of: string, after: string | undefined, limit: number) {
    const scope = ["messages", "of", of];
    const head = table.head();
    // Keyed by counterparty; a self message stored before they were refused is the Actor's
    // conversation with itself.
    const latest = new Map<string, Snapshot<MessageState>>();
    for (const row of [...table.where({ sender: [of] }), ...table.where({ recipient: [of] })]) {
      const peer = row.senderID === of ? row.recipientID : row.senderID;
      if (row.cursor <= head && row.cursor > (latest.get(peer)?.cursor ?? 0)) latest.set(peer, row);
    }
    const bound = after === undefined ? head + 1 : position(after, scope);
    const rows = [...latest.values()]
      .filter((row) => row.cursor < bound)
      .sort((left, right) => right.cursor - left.cursor);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return page(items, last && rows.length > items.length ? token(scope, last.cursor) : null, null);
  }
  return {
    send(input) {
      const request = parse(MessageContracts.message_send.input, input);
      const caller = actors.get().actorID;
      requireThat(
        request.recipientID !== caller,
        "invalid_input",
        "an Actor doesn't message itself",
      );
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
      actors.get();
      const row = table.get(request.messageID);
      requireThat(row, "not_found", "record not found");
      return message(row);
    },
    list(input) {
      const query = parse(MessageContracts.message_list.input, input);
      const caller = actors.get().actorID;
      const { before, after, limit } = query;
      // The contract's refinements leave `of` with only a `next` position, and name one selector.
      if (query.of !== undefined)
        return conversations(query.of, after as string | undefined, limit);
      const pair = (query.between ?? [caller, query.counterpartyID as string]).toSorted();
      const scope = ["messages", "between", pair];
      const head = table.head();
      // The pair's parties also match either one's self messages stored before they were refused;
      // only a self pair keeps them.
      const rows = table
        .where({ sender: pair, recipient: pair })
        .filter(
          (row) => row.cursor <= head && (pair[0] === pair[1] || row.senderID !== row.recipientID),
        );
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
      return page(
        items,
        last && last.cursor < (rows.at(-1)?.cursor ?? 0) ? token(scope, last.cursor) : null,
        first && first.cursor > (rows[0]?.cursor ?? 0)
          ? token(scope, first.cursor, "before")
          : null,
      );
    },
  };
}
