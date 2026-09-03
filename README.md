# Supabase to Cloudflare D1

A local-first CLI for planning, exporting, applying, and verifying ordinary PostgreSQL tables from Supabase or any PostgreSQL database to Cloudflare D1.

It converts PostgreSQL schema and row data into reviewable, size-bounded SQLite SQL files. It does **not** pretend that Supabase Auth, Row Level Security, Storage, Realtime, functions, triggers, or application behavior can be moved automatically.

> **Project status:** early release. Test the generated bundle against a fresh local D1 database before any remote import.

## Why this exists

Cloudflare D1 accepts SQLite-compatible SQL, not PostgreSQL dumps. Moving a database therefore requires more than replacing type names: foreign keys need ordering, large `INSERT` statements must be split, PostgreSQL-only defaults and indexes must be identified, and Supabase authorization must be redesigned.

`supabase-to-d1` makes those differences explicit:

- `plan` inspects compatibility without reading table rows.
- `export` reads all selected tables from one locked, repeatable-read snapshot.
- `apply` defaults to a local D1 database.
- `verify` compares row counts and runs `PRAGMA foreign_key_check`.
- Remote writes require both `--target remote` and `--yes`.
- Source credentials are read from environment variables and are never written to the bundle.
- No telemetry, hosted service, or third-party runtime dependency.

## Install

Requirements:

- Node.js 20 or newer
- PostgreSQL `psql`
- Cloudflare Wrangler when using `apply` or `verify`

From source:

```bash
git clone https://github.com/Swallow100/supabase-to-d1.git
cd supabase-to-d1
npm ci
npm link
```

After an npm release:

```bash
npm install --global supabase-to-d1
```

Both `supabase-to-d1` and `d1porter` invoke the same CLI.

## Quick start

Use a dedicated migration database role with the minimum required `SELECT` and catalog permissions. Put the PostgreSQL URL in an environment variable rather than the command line:

```bash
export SUPABASE_DB_URL='postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require'
```

Inspect the migration first:

```bash
d1porter plan
```

Generate a private migration bundle:

```bash
d1porter export --out ./d1porter-output
```

Apply it to local D1 state associated with your Wrangler project:

```bash
d1porter apply \
  --bundle ./d1porter-output \
  --database app-db \
  --target local \
  --config ./wrangler.jsonc
```

Verify again explicitly:

```bash
d1porter verify \
  --bundle ./d1porter-output \
  --database app-db \
  --target local \
  --config ./wrangler.jsonc
```

Only after local testing, use a fresh remote D1 database:

```bash
d1porter apply \
  --bundle ./d1porter-output \
  --database app-db \
  --target remote \
  --config ./wrangler.jsonc \
  --yes
```

Cloudflare documents `wrangler d1 execute --file` as the SQL import path. Its current guidance also requires SQLite-compatible SQL, removal of explicit dump transactions, splitting oversized statements, and careful foreign-key handling. See the official D1 import guide: <https://developers.cloudflare.com/d1/best-practices/import-export-data/>.

## What is migrated

| PostgreSQL object | D1 output |
|---|---|
| Ordinary tables | `CREATE TABLE` |
| Table rows | Batched `INSERT` statements |
| Primary keys | Inline or table primary keys |
| Unique constraints | `UNIQUE` constraints |
| Included foreign keys | SQLite foreign keys |
| Ordinary btree column indexes | `CREATE INDEX` |
| PostgreSQL enums | `TEXT` plus a compact `CHECK` when practical |
| `bytea` | SQLite `BLOB` literals |
| `json` / `jsonb` | Validated JSON stored as `TEXT` |
| Dates, timestamps, UUIDs, network values | `TEXT` |
| `NUMERIC` / `DECIMAL` | Exact `TEXT` by default, optional `REAL` |

## What is deliberately not migrated

The CLI reports these rather than silently changing their meaning:

- Supabase Auth users, identities, sessions, hooks, or settings
- Supabase Storage objects, buckets, or policies
- Realtime publication and channel configuration
- Edge Functions and application secrets
- Row Level Security policies
- roles, grants, ownership, and `SECURITY DEFINER` behavior
- PostgreSQL functions, views, materialized views, and triggers
- partitioned tables, generated columns, and exclusion constraints
- partial, expression, non-btree, or otherwise PostgreSQL-specific indexes
- extensions and extension-managed objects

D1 is not a drop-in PostgreSQL runtime. Queries, transactions, authorization, server-side behavior, and application data access must be reviewed separately.

## Selection and naming

The default selection is the `public` schema.

```bash
# Repeat --schema for multiple schemas
d1porter plan --schema public --schema billing

# Match schema.table using * and ?
d1porter plan --include 'public.*' --exclude 'public.audit_*'
```

Naming modes:

- `auto`: keep table names for a single `public` schema; otherwise prefix them.
- `prefix`: always map `schema.table` to `schema__table`.
- `flat`: always drop schema names; collisions block export.

SQLite/D1 object names are case-insensitive for important collision cases. The planner blocks unsafe case-only collisions and reserved names.

## Type decisions

### Exact decimals

The default preserves `NUMERIC` values exactly as `TEXT`:

```bash
d1porter export --numeric text
```

This avoids silent decimal rounding but requires arithmetic queries to cast or be redesigned. `--numeric real` stores them as SQLite `REAL` and reports the precision loss.

### 64-bit integers

SQLite can store signed 64-bit integers, but values outside JavaScript's exact integer range can lose precision when retrieved through JavaScript APIs. The planner reports every PostgreSQL `bigint`/`int8` column so the application can choose string IDs or another representation. Cloudflare also documents this caveat in its D1 import/export guidance.

### Unknown types

Unknown or extension-defined types block export by default:

```bash
d1porter plan --unknown-types error
```

After reviewing the type's PostgreSQL text representation, it can be exported as `TEXT` explicitly:

```bash
d1porter export --unknown-types text
```

## Consistency model

`plan` uses PostgreSQL catalogs only and does not read rows. During `export`, the CLI:

1. opens a read-only, repeatable-read transaction;
2. takes `ACCESS SHARE` locks on selected tables;
3. re-runs minimal structural introspection inside that locked snapshot;
4. aborts if the plan no longer matches;
5. streams rows with PostgreSQL `COPY ... FORMAT text`;
6. removes a partial bundle if export fails.

The locks permit normal reads and writes but prevent incompatible schema changes while the snapshot is exported. Long exports can therefore delay DDL. Schedule large migrations accordingly.

## Bundle safety

An export bundle contains database rows. Treat it like a database backup.

The generated directory includes a defensive `.gitignore`, but `git add -f`, archive uploads, issue attachments, cloud synchronization, or manual copying can still expose it. The CLI does not add the PostgreSQL connection URL, password, host, Supabase project reference, or target D1 identifier to the bundle. If a source row itself stores any such value, it is exported as ordinary row data.

For deletion safety, `--force` only replaces an empty directory or a directory carrying the tool's generated-output marker. It refuses to recursively delete an unrelated non-empty directory.

Before applying a bundle, the CLI verifies each listed file against its SHA-256 hash. Manifest paths are constrained to the bundle directory.

## Supabase connections

Use a direct connection for PostgreSQL-native migration tools when IPv6 is available. On an IPv4-only network, use Supavisor session mode on port 5432. Do not use transaction-pooler mode for this export because the tool requires one session and one repeatable-read transaction. Supabase's current connection guidance is here: <https://supabase.com/docs/guides/database/connecting-to-postgres>.

For stronger TLS verification, configure standard libpq variables or URL parameters such as `sslmode=verify-full` and a trusted root certificate. The CLI passes standard `PG*` settings to `psql` and does not implement its own network client.

## Commands

```text
d1porter plan [source options]
d1porter export [source and export options]
d1porter apply --bundle <dir> --database <name> [D1 options]
d1porter verify --bundle <dir> --database <name> [D1 options]
```

Run `d1porter --help` for every option.

Useful safety modes:

```bash
# Turn every compatibility warning into a blocker
d1porter plan --strict

# See the Wrangler commands without executing them
d1porter apply --bundle ./d1porter-output --database app-db --dry-run

# Machine-readable plan or result
d1porter plan --json
```

## D1 limits handled by the exporter

The exporter keeps individual statements below a conservative 90,000-byte threshold, below D1's documented 100 KB statement limit. It also limits a generated SQL file to 4,500 MiB by default, below the documented 5 GiB import limit, and blocks tables above D1's documented 100-column limit. Current limits can change; review the official limits before a large migration: <https://developers.cloudflare.com/d1/platform/limits/>.

A single source row whose SQL representation exceeds the safe statement threshold cannot be imported through this path and blocks export without printing the value.

## Development

```bash
npm test
npm run check
npm run public-safety
npm run ci
```

The repository's tests and CI fixtures contain generated sample data only. Contributions must not include production schemas, dumps, connection strings, logs, screenshots, project references, or customer data. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT

Supabase and Cloudflare are trademarks of their respective owners. This project is independent and is not affiliated with or endorsed by either company.
