/** Execution and viewer MCP servers over the same domain clients. SDK owns transport. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ActorContracts,
  FormContracts,
  MessageContracts,
  parse,
  requireThat,
  StatusContracts,
  WorkContracts,
  WorkspaceError,
} from "../contracts/index.js";
import type { WorkspaceClients } from "../index.js";

export type McpPurpose = "execution" | "viewer";
function publicFailure(error: unknown) {
  return error instanceof WorkspaceError
    ? { code: error.code, message: error.message }
    : { code: "internal_error", message: "workspace operation failed" };
}
function bind<S extends z.ZodType>(
  spec: { description: string; input: S; output: z.ZodType; writes: boolean },
  run: (input: z.output<S>) => unknown,
) {
  return { ...spec, run: (input: unknown) => parse(spec.output, run(parse(spec.input, input))) };
}
export function createMcpServer(clients: WorkspaceClients, purpose: McpPurpose): Server {
  const { actors, messages, work, forms, status } = clients;
  const operations = {
    actor_get: bind(ActorContracts.actor_get, (input) => actors.get(input)),
    actor_list: bind(ActorContracts.actor_list, (input) => actors.list(input)),
    message_send: bind(MessageContracts.message_send, (input) => messages.send(input)),
    message_get: bind(MessageContracts.message_get, (input) => messages.get(input)),
    message_list: bind(MessageContracts.message_list, (input) => messages.list(input)),
    work_create: bind(WorkContracts.work_create, (input) => work.create(input)),
    work_get: bind(WorkContracts.work_get, (input) => work.get(input)),
    work_list: bind(WorkContracts.work_list, (input) => work.list(input)),
    work_update: bind(WorkContracts.work_update, (input) => work.update(input)),
    work_submit: bind(WorkContracts.work_submit, (input) => work.submit(input)),
    work_review: bind(WorkContracts.work_review, (input) => work.review(input)),
    form_create: bind(FormContracts.form_create, (input) => forms.create(input)),
    form_get: bind(FormContracts.form_get, (input) => forms.get(input)),
    form_list: bind(FormContracts.form_list, (input) => forms.list(input)),
    form_respond: bind(FormContracts.form_respond, (input) => forms.respond(input)),
    form_close: bind(FormContracts.form_close, (input) => forms.close(input)),
    status_set: bind(StatusContracts.status_set, (input) => status.set(input)),
    status_get: bind(StatusContracts.status_get, (input) => status.get(input)),
  };
  const server = new Server(
    { name: `agentic-workspace-${purpose}`, version: "0.5.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      actors.get();
      return {
        tools: Object.entries(operations)
          .filter(([, op]) => purpose === "execution" || !op.writes)
          .map(([name, op]) => ({
            name,
            description: op.description,
            inputSchema: z.toJSONSchema(op.input, { io: "input" }) as {
              type: "object";
              [key: string]: unknown;
            },
            outputSchema: z.toJSONSchema(op.output) as { type: "object"; [key: string]: unknown },
            annotations: { readOnlyHint: !op.writes, openWorldHint: false },
          })),
      };
    } catch (error) {
      throw new McpError(
        error instanceof WorkspaceError ? ErrorCode.InvalidRequest : ErrorCode.InternalError,
        publicFailure(error).message,
      );
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const name = params.name;
      requireThat(Object.hasOwn(operations, name), "not_found", "tool not found");
      const operation = operations[name as keyof typeof operations];
      requireThat(
        purpose === "execution" || !operation.writes,
        "forbidden",
        "viewer exposure is read-only",
      );
      const value = operation.run(params.arguments ?? {}) as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(publicFailure(error)) }],
      };
    }
  });
  return server;
}
