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
  const forms = createForms(actors, work, store);
  const ticket = work.create({ goal: "Review the public client composition", ownerID: "owner" });
  messages.send({
    recipientID: "owner",
    text: "Please inspect the ticket.",
    workID: ticket.ticketID,
  });
  forms.create({
    workID: ticket.ticketID,
    respondentIDs: ["owner"],
    fields: [{ name: "ready", label: "Ready for review?", required: true }],
  });
  console.log(JSON.stringify(work.get({ ticketID: ticket.ticketID })));
} finally {
  store.close();
}
