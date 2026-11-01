import { z } from "zod";
import { contract, ID, ListInput, pageOf, Text } from "./common.js";

export const Actor = z.strictObject({
  actorID: ID,
  name: Text,
  purpose: Text,
  state: z.enum(["active", "closed"]),
});
export type Actor = z.infer<typeof Actor>;
export const ActorContracts = {
  actor_get: contract(
    "team",
    "Get the admitted caller or a visible named Actor.",
    z.strictObject({ actorID: ID.optional() }),
    Actor,
  ),
  actor_list: contract(
    "team",
    "List Actors visible through the canonical authority.",
    ListInput,
    pageOf(Actor),
  ),
};
