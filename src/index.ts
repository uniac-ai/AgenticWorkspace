/** Composition returns five distinct clients with explicit module dependencies. */
import { type ActorAuthority, createActors } from "./actors/index.js";
import { createForms } from "./forms/index.js";
import { createMessages } from "./messages/index.js";
import type { WorkspaceStore } from "./persistence/index.js";
import { createStatus } from "./status/index.js";
import { createWork } from "./work/index.js";

/** actorID is supplied by trusted admission, never by workspace tool input. */
export function bindWorkspace(authority: ActorAuthority, store: WorkspaceStore, actorID: string) {
  const actors = createActors(authority, actorID);
  const work = createWork(actors, store);
  return {
    actors,
    work,
    messages: createMessages(actors, store),
    forms: createForms(actors, store, work),
    status: createStatus(actors, store),
  };
}
export type WorkspaceClients = ReturnType<typeof bindWorkspace>;
