# Architecture

The CLI is intentionally small and dependency-free at runtime.

## Pipeline

1. `src/introspection.js` builds a minimal PostgreSQL catalog query.
2. `src/model.js` converts catalog metadata into an explicit migration plan.
3. `src/exporter.js` locks selected tables, verifies the plan inside a repeatable-read snapshot, and streams COPY text rows.
4. `src/sql.js` maps values and emits size-bounded SQLite statements.
5. `src/manifest.js` records and validates bundle hashes and safe relative paths.
6. `src/wrangler.js` applies files with Wrangler and verifies row counts and foreign keys.

## Deliberate separations

The project does not import Supabase SDKs or Cloudflare APIs directly. PostgreSQL connectivity remains the responsibility of the official `psql` client and D1 connectivity remains the responsibility of Wrangler. This keeps credentials out of an additional client stack and avoids duplicating authentication behavior.

The planner is a compatibility analyzer, not a PostgreSQL SQL parser. PostgreSQL-only expressions are omitted conservatively instead of transformed by string substitution.

## Bundle format

A completed bundle contains:

- `schema.sql`
- zero or more `data/*.sql` files
- `indexes.sql`
- `verify.sql`
- `report.md`
- `manifest.json`
- `README.txt`
- `.gitignore`

`manifest.json` is written last with `complete: true`. A failed export removes the partial output directory. Apply and verify commands reject incomplete manifests and hash mismatches.
