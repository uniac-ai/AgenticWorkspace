/** Flat direct correspondence between sender and recipient. */
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
  };
}
