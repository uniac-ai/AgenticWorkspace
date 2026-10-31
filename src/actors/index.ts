/** Canonical identity/discovery client; the module stores no Actors or credentials. */
import {
  Actor,
  ActorContracts,
  type Input,
  type Page,
  parse,
  requireThat,
} from "../contracts/index.js";

export interface ActorAuthority {
  /** Canonical visibility, including access to the admitted caller itself. */
  get(callerID: string, actorID: string): Actor | undefined;
  list(callerID: string, query: { after: number; limit: number }): Page<Actor>;
}
export interface ActorsClient {
  get(input?: Input<typeof ActorContracts.actor_get.input>): Actor;
  list(input?: Input<typeof ActorContracts.actor_list.input>): Page<Actor>;
}
export function createActors(authority: ActorAuthority, callerID: string): ActorsClient {
  function caller(): Actor {
    const actor = authority.get(callerID, callerID);
    requireThat(actor?.state === "active", "forbidden", "an active admitted Actor is required");
    return parse(Actor, actor);
  }
  return {
    get(input = {}) {
      const request = parse(ActorContracts.actor_get.input, input);
      const self = caller();
      if (request.actorID === undefined || request.actorID === callerID) return self;
      const actor = authority.get(callerID, request.actorID);
      requireThat(actor, "not_found", "Actor not found");
      return parse(Actor, actor);
    },
    list(input = {}) {
      const query = parse(ActorContracts.actor_list.input, input);
      caller();
      return parse(
        ActorContracts.actor_list.output,
        authority.list(callerID, query),
      ) as Page<Actor>;
    },
  };
}
export function activeActor(actors: ActorsClient, actorID: string): Actor {
  const actor = actors.get({ actorID });
  requireThat(actor.state === "active", "invalid_input", "target Actor is closed");
  return actor;
}
