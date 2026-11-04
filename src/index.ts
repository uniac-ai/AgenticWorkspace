/** Composition returns three distinct clients with explicit module dependencies. */
import { type ActorAuthority, createActors } from "./actors/index.js";
import { createMessages } from "./messages/index.js";
import type { WorkspaceStore } from "./persistence/index.js";
import { createWork } from "./work/index.js";

/** actorID is supplied by trusted admission, never by workspace tool input. */
export function bindWorkspace(authority: ActorAuthority, store: WorkspaceStore, actorID: string) {
  const actors = createActors(authority, actorID);
  return {
    actors,
    work: createWork(actors, store),
    messages: createMessages(actors, store),
  };
}
export type WorkspaceClients = ReturnType<typeof bindWorkspace>;
