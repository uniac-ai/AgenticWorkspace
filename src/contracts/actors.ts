import { z } from "zod";
import { ID, Text } from "./common.js";

export const Actor = z.strictObject({
  actorID: ID,
  name: Text,
  purpose: Text,
  state: z.enum(["active", "closed"]),
});
export type Actor = z.infer<typeof Actor>;
/** Names an Actor; the admitted caller when actorID is absent. */
export const ActorQuery = z.strictObject({ actorID: ID.optional() });
