import { z } from "zod";

export const ID = z.string().trim().min(1).max(200);
export const Text = z.string().trim().min(1).max(20000);
export const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const ListInput = z.strictObject({
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export const History = z.strictObject({
  revision: Revision,
  cursor: Revision,
  actorID: ID,
  at: z.iso.datetime(),
  action: Text,
  detail: z.record(z.string(), z.unknown()),
});
export const Metadata = { revision: Revision, cursor: Revision, history: z.array(History) };
export type HistoryEntry = z.infer<typeof History>;
export interface Page<T> {
  items: T[];
  after: number;
}
export type Input<S extends z.ZodType> = z.input<S>;

export class WorkspaceError extends Error {
  constructor(
    public readonly code: "invalid_input" | "not_found" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
  }
}
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new WorkspaceError("invalid_input", "input does not match the operation schema");
  return parsed.data;
}
export function requireThat(
  condition: unknown,
  code: WorkspaceError["code"],
  message: string,
): asserts condition {
  if (!condition) throw new WorkspaceError(code, message);
}
export function contract<S extends z.ZodType>(
  description: string,
  input: S,
  output: z.ZodType,
  writes = false,
) {
  return { description, input, output, writes };
}
export const pageOf = (record: z.ZodType) =>
  z.strictObject({ items: z.array(record), after: ListInput.shape.after });
