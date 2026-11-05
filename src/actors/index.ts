/** Canonical identity and the person; the module stores no Actors or credentials. */
import {
  Actor,
  ActorQuery,
  ID,
  type Input,
  parse,
  requireThat,
  WorkspaceError,
} from "../contracts/index.js";

export interface ActorAuthority {
  /** Canonical visibility, including access to the admitted caller itself. */
  get(callerID: string, actorID: string): Actor | undefined;
  /**
   * The person's Actor ID: it stands in for closed Actors and receives the asks on Work their asker
   * requested itself.
   */
  person(): string;
}
export interface ActorsClient {
  get(input?: Input<typeof ActorQuery>): Actor;
  person(): string;
}
export function createActors(authority: ActorAuthority, callerID: string): ActorsClient {
  function caller(): Actor {
    const actor = authority.get(callerID, callerID);
    requireThat(actor?.state === "active", "forbidden", "an active admitted Actor is required");
    return parse(Actor, actor);
  }
  return {
    get(input = {}) {
      const request = parse(ActorQuery, input);
      const self = caller();
      if (request.actorID === undefined || request.actorID === callerID) return self;
      const actor = authority.get(callerID, request.actorID);
      requireThat(actor, "not_found", "Actor not found");
      return parse(Actor, actor);
    },
    person() {
      caller();
      return parse(ID, authority.person());
    },
  };
}
export function activeActor(actors: ActorsClient, actorID: string): Actor {
  const actor = actors.get({ actorID });
  requireThat(actor.state === "active", "invalid_input", "target Actor is closed");
  return actor;
}
/**
 * The Actor itself while it is open; once it is closed, the person. This decides who holds rights,
 * so an Actor the caller can't see is refused (`not_found`), never passed.
 */
export function standIn(actors: ActorsClient, actorID: string): string {
  return actors.get({ actorID }).state === "active" ? actorID : actors.person();
}
/**
 * As standIn, for reads that route asks: an Actor the caller can't see counts as closed, so its asks
 * go to the person. Never for authority.
 */
export function routedStandIn(actors: ActorsClient, actorID: string): string {
  return visible(actors, actorID)?.state === "active" ? actorID : actors.person();
}
function visible(actors: ActorsClient, actorID: string): Actor | undefined {
  try {
    return actors.get({ actorID });
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "not_found") return undefined;
    throw error;
  }
}
