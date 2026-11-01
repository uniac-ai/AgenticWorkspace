/** External consumers import package exports; this example composes distinct clients explicitly. */
import { createActors } from "../src/actors/index.js";
import { createForms } from "../src/forms/index.js";
import { createMessages } from "../src/messages/index.js";
import { openSqlite } from "../src/persistence/index.js";
import { createStatus } from "../src/status/index.js";
import { createWork } from "../src/work/index.js";
import { fixtureAuthority } from "./authority.js";

const store = openSqlite(":memory:");
try {
  const actors = createActors(fixtureAuthority().authority, "owner");
  const work = createWork(actors, store);
  const messages = createMessages(actors, store);
  const forms = createForms(actors, store, work);
  const status = createStatus(actors, store);
  const ticket = work.create({ title: "Review the public client composition" });
  work.update({ ticketID: ticket.ticketID, status: "active", progress: "Composing clients." });
  forms.create({
    title: "Ready for review?",
    workID: ticket.ticketID,
    fields: [
      {
        name: "ready",
        label: "Ready for review?",
        required: true,
        options: [{ value: "yes" }, { value: "no", detail: "Keep composing" }],
        recommended: "yes",
      },
    ],
  });
  status.set({ line: "Composing the public clients" });
  messages.send({ recipientID: "requester", text: `Please look at ${ticket.ticketID}.` });
  const reader = createActors(fixtureAuthority().authority, "outsider");
  console.log(
    JSON.stringify({
      status: createStatus(reader, store).get({ actorID: "owner" }),
      workstreams: createWork(reader, store).list({ ownerID: "owner", status: ["active"] }),
      asks: createForms(reader, store).list({ requesterWithin: "requester", status: ["open"] }),
      conversation: messages.list({ counterpartyID: "requester", before: "latest", limit: 20 }),
    }),
  );
} finally {
  store.close();
}
