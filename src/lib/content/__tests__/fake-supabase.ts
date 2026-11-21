/**
 * Test double for the Supabase client, used ONLY by unit tests of src/lib/content.
 * It records the query builder calls and returns scripted results, so tests can
 * assert exactly what would be sent to the database. Real database behaviour
 * (RLS, RPCs, constraints) is covered by tests/db against Postgres.
 */

export type FakeResult = { data: unknown; error: unknown; count?: number | null };
export type RecordedCall = [method: string, args: unknown[]];

const BUILDER_METHODS = [
  "select",
  "insert",
  "update",
  "delete",
  "upsert",
  "eq",
  "is",
  "in",
  "gt",
  "lte",
  "range",
  "order",
  "limit",
  "single",
  "maybeSingle",
] as const;

export class FakeQuery implements PromiseLike<FakeResult> {
  readonly calls: RecordedCall[] = [];

  constructor(
    readonly table: string,
    private readonly result: FakeResult,
  ) {
    for (const method of BUILDER_METHODS) {
      (this as unknown as Record<string, (...args: unknown[]) => FakeQuery>)[method] = (...args: unknown[]) => {
        this.calls.push([method, args]);
        return this;
      };
    }
  }

  methods(): string[] {
    return this.calls.map(([method]) => method);
  }

  args(method: string): unknown[] | undefined {
    return this.calls.find(([m]) => m === method)?.[1];
  }

  then<T1 = FakeResult, T2 = never>(
    onfulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

/** A fake client answering queries and RPCs, in order, from `results`. */
export function fakeSupabase(results: FakeResult[]) {
  const queue = [...results];
  const next = (): FakeResult => {
    const result = queue.shift();
    if (!result) throw new Error("fakeSupabase: unexpected extra database call");
    return result;
  };
  const queries: FakeQuery[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];

  const client = {
    from(table: string) {
      const query = new FakeQuery(table, next());
      queries.push(query);
      return query;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return next();
    },
  };

  return { client, queries, rpcs, remaining: () => queue.length };
}

export const ok = (data: unknown): FakeResult => ({ data, error: null });
export const dbError = (code: string, message = "internal detail: relation secret_table"): FakeResult => ({
  data: null,
  error: { code, message, details: "secret details", hint: "secret hint" },
});
