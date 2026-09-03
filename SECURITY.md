# Security policy

## Supported versions

Security fixes are applied to the latest released version and the default branch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting when it is enabled for this repository. If that channel is unavailable, open a minimal public issue asking for a private contact route, without including technical secrets or production details. Never put a database URL, password, token, project reference, schema dump, generated migration bundle, application log, or production row in a public issue.

A useful private report contains:

- the affected version;
- the command and options with all identifiers generalized;
- a minimal reproduction made from synthetic data;
- the expected and observed behavior;
- the impact and any known workaround.

Never provide real source or destination credentials. Maintainers do not need access to a production database to investigate a report.

## Security boundaries

The CLI runs locally and invokes executables selected by the user. Only use trusted `psql` and `wrangler` binaries. `--psql` and `--wrangler` deliberately permit custom paths; a malicious executable at either path can access the environment intentionally passed to that subprocess.

The tool does not migrate authorization. RLS policies, grants, roles, functions, triggers, Supabase Auth, and application checks must be rebuilt and reviewed independently before traffic is moved.

Export bundles contain source rows. Their defensive `.gitignore` reduces accidental commits but is not encryption or access control. Delete bundles securely according to your environment's requirements after migration.
