/** Each Actor's own status: one record, replaced in place, readable by the organization. */
import type { ActorsClient } from "../actors/index.js";
import {
  type Input,
  parse,
  type Status,
  StatusContracts,
  type StatusState,
} from "../contracts/index.js";
import type { WorkspaceStore } from "../persistence/index.js";
import { now, published, recorded, stateOf } from "../records.js";

export interface StatusClient {
  set(input: Input<typeof StatusContracts.status_set.input>): Status;
  get(input?: Input<typeof StatusContracts.status_get.input>): Status;
}
export function createStatus(
  actors: ActorsClient,
  store: Pick<WorkspaceStore, "status" | "transaction">,
): StatusClient {
  const table = store.status;
  return {
    set(input) {
      const request = parse(StatusContracts.status_set.input, input);
      const caller = actors.get().actorID;
      return store.transaction(() => {
        const row = table.get(caller);
        const current: StatusState = row ? stateOf(published(row)) : { actorID: caller, links: [] };
        const changes = Object.fromEntries(
          Object.entries(request).filter(([, value]) => value !== undefined),
        );
        return published(
          table.save(
            caller,
            { ...current, ...changes },
            { actorID: caller, at: now(), action: "set", detail: changes },
            row?.revision,
          ),
        );
      });
    },
    get(input = {}) {
      const request = parse(StatusContracts.status_get.input, input);
      const caller = actors.get().actorID;
      return recorded(table, request.actorID ?? caller, request.history);
    },
  };
}
