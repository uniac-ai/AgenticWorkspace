import { z } from "zod";

export const ID = z.string().trim().min(1).max(200);
export const Text = z.string().trim().min(1).max(20000);
export const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** The smallest organization level that presents a contract; each level contains the one before. */
export const Level = z.enum(["report", "team", "organization"]);
export type Level = z.infer<typeof Level>;
export const Limit = z.number().int().min(1).max(100).default(50);
/** Directory pages keep the canonical authority's numeric position. */
export const ListInput = z.strictObject({
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: Limit,
});
/** An opaque list position; it continues only the read and filter that issued it. */
export const Next = z.string().trim().min(1).max(1000);
export const History = z.strictObject({
  revision: Revision,
  cursor: Revision,
  actorID: ID,
  at: z.iso.datetime(),
  action: Text,
  detail: z.record(z.string(), z.unknown()),
});
/** History is present only when a get asks for it. */
export const Metadata = {
  revision: Revision,
  updatedAt: z.iso.datetime(),
  history: z.array(History).optional(),
};
export const Actors = z.record(ID, z.strictObject({ name: Text }));
export type HistoryEntry = z.infer<typeof History>;
export interface Page<T> {
  items: T[];
  after: number;
}
export interface List<T> {
  items: T[];
  next: string | null;
  actors: z.infer<typeof Actors>;
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
  level: Level,
  description: string,
  input: S,
  output: z.ZodType,
  writes = false,
) {
  return { level, description, input, output, writes };
}
export const pageOf = (record: z.ZodType) =>
  z.strictObject({ items: z.array(record), after: ListInput.shape.after });
export const listOf = (record: z.ZodType) =>
  z.strictObject({ items: z.array(record), next: Next.nullable(), actors: Actors });
/** One ID or several, matching any of them. */
export const OneOrMany = z.union([ID, z.array(ID).min(1).max(100)]);
