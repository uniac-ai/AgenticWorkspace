/** Canonical identity and membership; the module stores no Actors or credentials. */
import { Actor, ActorQuery, ID, type Input, parse, requireThat } from "../contracts/index.js";

export interface ActorAuthority {
  /** Canonical visibility, including access to the admitted caller itself. */
  get(callerID: string, actorID: string): Actor | undefined;
  /** Inclusive retained ancestry, including closed members/anchors; unknown IDs return false. */
  within(callerID: string, actorID: string, ancestorID: string): boolean;
}
export interface ActorsClient {
  get(input?: Input<typeof ActorQuery>): Actor;
  within(actorID: string, ancestorID: string): boolean;
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
    within(actorID, ancestorID) {
      const member = parse(ID, actorID);
      const ancestor = parse(ID, ancestorID);
      caller();
      return authority.within(callerID, member, ancestor);
    },
  };
}
export function activeActor(actors: ActorsClient, actorID: string): Actor {
  const actor = actors.get({ actorID });
  requireThat(actor.state === "active", "invalid_input", "target Actor is closed");
  return actor;
}
