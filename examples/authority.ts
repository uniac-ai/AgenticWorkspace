/** Model-free canonical authority fixture. This is example data, not a production registry. */
import type { ActorAuthority } from "../src/actors/index.js";
import type { Actor } from "../src/contracts/index.js";

export function fixtureAuthority() {
  const rows = new Map<string, Actor>([
    [
      "requester",
      {
        actorID: "requester",
        name: "Requester",
        purpose: "Request and review fixture work",
        state: "active",
      },
    ],
    [
      "owner",
      {
        actorID: "owner",
        name: "Owner",
        purpose: "Execute fixture work",
        state: "active",
      },
    ],
    [
      "respondent",
      {
        actorID: "respondent",
        name: "Respondent",
        purpose: "Answer fixture asks",
        state: "active",
      },
    ],
    [
      "outsider",
      {
        actorID: "outsider",
        name: "Outsider",
        purpose: "Test authority boundaries",
        state: "active",
      },
    ],
  ]);
  // requester is the person, the Actor the host names as its user.
  const authority: ActorAuthority = {
    get: (_caller, id) => rows.get(id),
    person: () => "requester",
  };
  return { authority, rows };
}
