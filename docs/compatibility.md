# Compatibility notes

## PostgreSQL and SQLite are different systems

The tool moves a deliberately limited relational subset. A successful export means that the generated SQL is structurally importable; it does not mean the original application will behave identically.

## Authorization

PostgreSQL RLS, roles, grants, and privileged functions are not represented in D1 table DDL. Authorization must be enforced through authenticated Worker code and carefully scoped queries. A planner warning is produced whenever RLS or policies are detected.

## Defaults and generated values

Common constant defaults and current date/time defaults are converted. A single integer primary key backed by an identity or sequence becomes `INTEGER PRIMARY KEY AUTOINCREMENT`. UUID generators and PostgreSQL-specific expressions are omitted with warnings.

## Indexes

Only valid, ready, non-partial btree indexes whose keys are ordinary columns are converted. Expression indexes, operator classes, sort/null-order semantics, partial predicates, INCLUDE columns, and non-btree access methods require manual redesign.

## Data types

- Integer types use SQLite `INTEGER` and must fit signed 64-bit range.
- Floating-point types use `REAL`; NaN and infinity block export.
- Exact numeric values use `TEXT` by default.
- Boolean values use `INTEGER` with a 0/1 check.
- JSON is validated and stored as `TEXT`.
- `bytea` uses hexadecimal BLOB literals.
- Arrays preserve PostgreSQL's text representation and require application rewrites.
- Unknown extension-defined values block unless `--unknown-types text` is selected explicitly.

## Foreign keys

Dependencies are topologically ordered. Strongly connected components are emitted together with deferred foreign-key checks. Foreign keys to excluded tables are omitted with a warning by default or become blockers with `--external-fks error`.
