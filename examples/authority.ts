/** Model-free canonical authority fixture. This is example data, not a production registry. */
import type { ActorAuthority } from "../src/actors/index.js";
import { type Actor, requireThat } from "../src/contracts/index.js";

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
        purpose: "Answer fixture forms",
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
  const managers = new Map<string, string | null>([
    ["requester", null],
    ["owner", "requester"],
    ["respondent", "owner"],
    ["outsider", "requester"],
  ]);
  const authority: ActorAuthority = {
    get: (_caller, id) => rows.get(id),
    list: (_caller, query) => {
      const all = [...rows.values()];
      requireThat(
        query.after <= all.length,
        "invalid_input",
        "directory cursor is beyond fixture head",
      );
      const items = all.slice(query.after, query.after + query.limit);
      return { items, after: query.after + items.length };
    },
    within: (_caller, actorID, ancestorID) => {
      if (!rows.has(ancestorID)) return false;
      for (
        let at: string | null | undefined = actorID;
        at != null && rows.has(at);
        at = managers.get(at)
      )
        if (at === ancestorID) return true;
      return false;
    },
  };
  return { authority, rows, managers };
}
