/** Canonical identity and membership; the module stores no Actors or credentials. */
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
  /** Inclusive retained ancestry, including closed members/anchors; unknown IDs return false. */
  within(callerID: string, actorID: string, ancestorID: string): boolean;
  /** The retained manager, closed or not; null for the root and for unknown IDs. */
  manager(callerID: string, actorID: string): string | null;
}
export interface ActorsClient {
  get(input?: Input<typeof ActorQuery>): Actor;
  within(actorID: string, ancestorID: string): boolean;
  manager(actorID: string): string | null;
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
    manager(actorID) {
      const member = parse(ID, actorID);
      caller();
      return authority.manager(callerID, member);
    },
  };
}
export function activeActor(actors: ActorsClient, actorID: string): Actor {
  const actor = actors.get({ actorID });
  requireThat(actor.state === "active", "invalid_input", "target Actor is closed");
  return actor;
}
/**
 * The Actor itself while it is open; once it is closed, its nearest open manager, or null. An Actor
 * the caller can't see counts as closed, so the walk goes on past it.
 */
export function standIn(actors: ActorsClient, actorID: string): string | null {
  const seen = new Set<string>();
  for (let at: string | null = actorID; at !== null && !seen.has(at); at = actors.manager(at)) {
    if (visible(actors, at)?.state === "active") return at;
    seen.add(at);
  }
  return null;
}
function visible(actors: ActorsClient, actorID: string): Actor | undefined {
  try {
    return actors.get({ actorID });
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "not_found") return undefined;
    throw error;
  }
}
