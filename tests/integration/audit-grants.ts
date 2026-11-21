/**
 * Helpers for the INSERT privileges of `authenticated` on public.agent_actions
 * (LOCAL database only, through a superuser psql runner).
 *
 * One M3 test revokes INSERT to simulate a broken audit log. It must put back
 * exactly what was there before, whatever later migrations granted (M4.6c added
 * request_id), so it snapshots the grants instead of keeping a fixed column list.
 */

export type Psql = (query: string) => string;

/** Columns every migration so far grants for INSERT (M3 + M4.6c request_id). */
export const EXPECTED_AUDIT_INSERT_COLUMNS = [
  "error_code",
  "fields",
  "kind",
  "post_id",
  "project_id",
  "request_id",
  "status",
  "tool",
  "turn_id",
  "version_after",
  "version_before",
  "workspace_id",
] as const;

export type AuditInsertGrants = Readonly<{ table: boolean; columns: readonly string[] }>;

export function snapshotAuditInsertGrants(psql: Psql): AuditInsertGrants {
  const table =
    psql(
      "select count(*) from information_schema.table_privileges where table_schema = 'public' and table_name = 'agent_actions' and grantee = 'authenticated' and privilege_type = 'INSERT'",
    ) !== "0";
  // Column-level grants only (a table-level grant is restored as such).
  const raw = psql(
    `select coalesce(string_agg(a.attname, ',' order by a.attname), '')
       from pg_attribute a
      where a.attrelid = 'public.agent_actions'::regclass and a.attnum > 0 and not a.attisdropped
        and a.attacl is not null
        and exists (select 1 from aclexplode(a.attacl) x
                     where x.grantee = 'authenticated'::regrole and x.privilege_type = 'INSERT')`,
  );
  return { table, columns: raw === "" ? [] : raw.split(",") };
}

/** Puts back exactly the snapshot: clears every INSERT grant, then re-grants. */
export function restoreAuditInsertGrants(psql: Psql, snapshot: AuditInsertGrants): void {
  const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const statements = ["revoke insert on table public.agent_actions from authenticated"];
  if (snapshot.table) statements.push("grant insert on table public.agent_actions to authenticated");
  if (snapshot.columns.length > 0) {
    statements.push(
      `grant insert (${snapshot.columns.map(ident).join(", ")}) on table public.agent_actions to authenticated`,
    );
  }
  psql(statements.join("; "));
}

/** Columns of agent_actions that `authenticated` can currently INSERT, sorted. */
export function insertableAuditColumns(psql: Psql): string[] {
  const raw = psql(
    `select coalesce(string_agg(attname, ',' order by attname), '') from pg_attribute
      where attrelid = 'public.agent_actions'::regclass and attnum > 0 and not attisdropped
        and has_column_privilege('authenticated', 'public.agent_actions', attname, 'INSERT')`,
  );
  return raw === "" ? [] : raw.split(",");
}

/**
 * Early, explicit failure when the local database lost the audit INSERT grants
 * (e.g. a previous run did not restore them): otherwise every audit row would
 * just fail and the cause would be hard to see.
 */
export function assertAuditInsertGrants(psql: Psql): void {
  const actual = insertableAuditColumns(psql);
  const missing = EXPECTED_AUDIT_INSERT_COLUMNS.filter((c) => !actual.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `authenticated is missing INSERT on public.agent_actions (${missing.join(", ")}): the local database grants do not match the migrations`,
    );
  }
}
