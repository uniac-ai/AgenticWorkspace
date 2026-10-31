/** External consumers import package exports; this example composes distinct clients explicitly. */
import { createActors } from "../src/actors/index.js";
import { createForms } from "../src/forms/index.js";
import { createMessages } from "../src/messages/index.js";
import { openSqlite } from "../src/persistence/index.js";
import { createWork } from "../src/work/index.js";
import { fixtureAuthority } from "./authority.js";

const store = openSqlite(":memory:");
try {
  const actors = createActors(fixtureAuthority().authority, "requester");
  const work = createWork(actors, store);
  const messages = createMessages(actors, store, work);
  const forms = createForms(actors, store);
  const ticket = work.create({ goal: "Review the public client composition", ownerID: "owner" });
  messages.send({
    recipientID: "owner",
    text: "Please inspect the ticket.",
    workID: ticket.ticketID,
  });
  forms.create({
    respondentIDs: ["owner"],
    fields: [{ name: "ready", label: "Ready for review?", required: true }],
  });
  const reader = createActors(fixtureAuthority().authority, "outsider");
  console.log(
    JSON.stringify({
      conversation: messages.list({ counterpartyID: "owner", before: "latest", limit: 20 }),
      ticket: createWork(reader, store).get({ ticketID: ticket.ticketID }),
      assigned: work.list({ ownerWithin: "owner", requesterWithin: "requester", status: "open" }),
      awaiting: createForms(reader, store).list({
        requesterID: "requester",
        respondentID: "owner",
        status: "open",
        awaitingActorID: "owner",
        awaitingWithin: "owner",
      }),
    }),
  );
} finally {
  store.close();
}
