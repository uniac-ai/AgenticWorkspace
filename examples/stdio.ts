import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bindWorkspace } from "../src/index.js";
import { createMcpServer } from "../src/mcp/index.js";
import { openSqlite } from "../src/persistence/index.js";
import { fixtureAuthority } from "./authority.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.error(
    "Model-free fixture: npm start -- [--actor requester|owner|respondent|outsider] [--purpose execution|viewer] [--db PATH]\nDefaults: requester, execution, :memory:. JSON-RPC uses stdin/stdout.",
  );
} else {
  const options = z
    .strictObject({
      "--actor": z.enum(["requester", "owner", "respondent", "outsider"]).default("requester"),
      "--purpose": z.enum(["execution", "viewer"]).default("execution"),
      "--db": z.string().min(1).default(":memory:"),
    })
    .parse(
      Object.fromEntries(
        Array.from({ length: Math.ceil(args.length / 2) }, (_, i) => [
          args[i * 2],
          args[i * 2 + 1],
        ]),
      ),
    );
  const store = openSqlite(options["--db"]);
  const server = createMcpServer(
    bindWorkspace(fixtureAuthority().authority, store, options["--actor"]),
    options["--purpose"],
  );
  server.onclose = () => store.close();
  await server.connect(new StdioServerTransport());
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server.close();
    });
}
