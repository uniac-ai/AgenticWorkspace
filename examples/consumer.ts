/** External consumers import package exports; this example composes distinct clients explicitly. */
import { createActors } from "../src/actors/index.js";
import { createMessages } from "../src/messages/index.js";
import { openSqlite } from "../src/persistence/index.js";
import { createWork } from "../src/work/index.js";
import { fixtureAuthority } from "./authority.js";

const store = openSqlite(":memory:");
try {
  const actors = createActors(fixtureAuthority().authority, "owner");
  const work = createWork(actors, store);
  const messages = createMessages(actors, store);
  const ticket = work.create({ title: "Review the public client composition" });
  work.update({ ticketID: ticket.ticketID, status: "active", progress: "Composing clients." });
  work.update({
    ticketID: ticket.ticketID,
    ask: {
      title: "Ready for review?",
      fields: [
        {
          name: "ready",
          label: "Ready for review?",
          required: true,
          options: [{ value: "yes" }, { value: "no", detail: "Keep composing" }],
          recommended: "yes",
        },
      ],
    },
  });
  messages.send({ recipientID: "requester", text: `Please look at ${ticket.ticketID}.` });
  const reader = createActors(fixtureAuthority().authority, "outsider");
  console.log(
    JSON.stringify({
      workstreams: createWork(reader, store).list({ ownerID: "owner", status: ["active"] }),
      asks: createWork(reader, store).asks({ routedTo: "requester" }),
      conversation: messages.list({ counterpartyID: "requester", before: "latest", limit: 20 }),
    }),
  );
} finally {
  store.close();
}
