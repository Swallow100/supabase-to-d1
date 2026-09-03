# Contributing

Contributions are welcome when they keep migrations explicit, reviewable, and conservative.

## Before opening a pull request

```bash
npm install
npm run ci
```

Use Node.js 20 or newer. Add tests for every conversion rule and every failure mode.

## Data hygiene

Only synthetic fixtures are accepted. Do not contribute:

- production table or column names;
- database dumps or generated bundles;
- real connection strings, project references, hostnames, UUIDs, tokens, or e-mail addresses;
- screenshots or logs from a real dashboard;
- copied code or configuration from a private application;
- proprietary schemas or customer data, even after partial redaction.

Create the smallest synthetic schema that reproduces the behavior. The repository runs an automated public-safety scan, but contributors remain responsible for reviewing every file and commit.

## Compatibility changes

A new automatic conversion should include:

1. PostgreSQL input metadata;
2. expected SQLite/D1 SQL;
3. a round-trip or execution test where practical;
4. documentation of semantic differences;
5. a blocker rather than a guess when correctness cannot be established.

Do not silently remove security controls or server-side behavior. RLS, roles, grants, functions, triggers, and extension behavior require explicit application-level migration work.

## Commit and pull-request scope

Keep changes focused. Explain user-visible behavior, safety implications, test coverage, and whether generated bundles remain backward-compatible.
