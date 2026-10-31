/** Flat direct correspondence, read acknowledgements and handling outcomes. */
import { randomUUID } from "node:crypto";
import { type ActorsClient, activeActor } from "../actors/index.js";
import {
  type Input,
  type Message,
  MessageContracts,
  type MessageState,
  type Page,
  parse,
  requireThat,
} from "../contracts/index.js";
import type { WorkspaceStore } from "../persistence/index.js";
import { now, recorded, traverse } from "../records.js";
import type { WorkReader } from "../work/index.js";

export interface MessagesClient {
  send(input: Input<typeof MessageContracts.message_send.input>): Message;
  get(input: Input<typeof MessageContracts.message_get.input>): Message;
  list(input?: Input<typeof MessageContracts.message_list.input>): Page<Message>;
  acknowledge(input: Input<typeof MessageContracts.message_acknowledge.input>): Message;
  handle(input: Input<typeof MessageContracts.message_handle.input>): Message;
}
export function createMessages(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "messages" | "transaction">,
  work?: WorkReader,
): MessagesClient {
  const table = store.messages;
  const visible = (row: MessageState, caller: string) =>
    row.senderID === caller || row.recipientID === caller;
  function get(id: string, caller: string): Message {
    const row = recorded(table, id);
    requireThat(visible(row, caller), "not_found", "record not found");
    return row;
  }
  const state = (row: Message): MessageState => {
    const { revision: _revision, cursor: _cursor, history: _history, ...data } = row;
    return data;
  };
  return {
    send(input) {
      const request = parse(MessageContracts.message_send.input, input);
      const caller = actors.get().actorID;
      activeActor(actors, request.recipientID);
      if (request.workID !== undefined) {
        requireThat(work, "invalid_input", "work references require a Work client");
        work.get({ ticketID: request.workID });
      }
      return store.transaction(() => {
        const at = now();
        const messageID = randomUUID();
        return table.save(
          messageID,
          { messageID, senderID: caller, ...request, createdAt: at },
          { actorID: caller, at, action: "sent", detail: request },
        );
      });
    },
    get(input) {
      const request = parse(MessageContracts.message_get.input, input);
      return get(request.messageID, actors.get().actorID);
    },
    list(input = {}) {
      const query = parse(MessageContracts.message_list.input, input);
      const caller = actors.get().actorID;
      return traverse(
        table,
        query,
        (row) =>
          visible(row, caller) &&
          (query.direction === "all" ||
            (query.direction === "incoming"
              ? row.recipientID === caller
              : row.senderID === caller)),
      );
    },
    acknowledge(input) {
      const request = parse(MessageContracts.message_acknowledge.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = get(request.messageID, caller);
        requireThat(
          row.recipientID === caller,
          "forbidden",
          "only recipient acknowledges a message",
        );
        if (row.acknowledgedAt !== undefined) return row;
        const at = now();
        return table.save(
          row.messageID,
          { ...state(row), acknowledgedAt: at },
          { actorID: caller, at, action: "acknowledged", detail: {} },
          row.revision,
        );
      });
    },
    handle(input) {
      const request = parse(MessageContracts.message_handle.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = get(request.messageID, caller);
        requireThat(row.recipientID === caller, "forbidden", "only recipient handles a message");
        const at = now();
        const handling = { outcome: request.outcome, at };
        return table.save(
          row.messageID,
          { ...state(row), handling },
          { actorID: caller, at, action: "handled", detail: handling },
          row.revision,
        );
      });
    },
  };
}
