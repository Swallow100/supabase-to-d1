import { CLI_NAME, VERSION } from "./constants.js";

export function helpText() {
  return `${CLI_NAME} ${VERSION}

Plan and export PostgreSQL or Supabase tables to Cloudflare D1-compatible SQL.
No telemetry. No source credentials are written to the bundle.

Usage:
  ${CLI_NAME} plan [options]
  ${CLI_NAME} export [options]
  ${CLI_NAME} apply --bundle <dir> --database <name> [options]
  ${CLI_NAME} verify --bundle <dir> --database <name> [options]

Source options:
  --url-env <name>          Environment variable containing the PostgreSQL URL
                            (default: SUPABASE_DB_URL, fallback: DATABASE_URL)
  --schema <name>           Schema to include; repeatable (default: public)
  --include <glob,...>      Include tables matching schema.table globs
  --exclude <glob,...>      Exclude tables matching schema.table globs
  --namespace <mode>        auto, prefix, or flat (default: auto)
  --numeric <mode>          text or real (default: text)
  --external-fks <mode>     drop or error (default: drop)
  --unknown-types <mode>    error or text (default: error)
  --strict                  Treat compatibility warnings as blockers
  --psql <path>             psql executable (default: psql)
  --json                    Print machine-readable plan output

Export options:
  --out <dir>               Output directory (default: d1porter-output)
  --max-file-mb <number>    Maximum generated SQL file size (default: 4500)
  --force                   Replace a recognized generated output directory

Apply and verify options:
  --bundle <dir>            Export bundle directory
  --database <name>         D1 database name or binding
  --target <mode>           local, preview, or remote (default: local)
  --wrangler <path>         Wrangler executable (default: wrangler)
  --config <path>           Wrangler configuration file
  --cwd <path>              Working directory passed to Wrangler
  --yes                     Required for remote writes
  --dry-run                 Print commands without running them
  --skip-verify             Do not verify after apply

General:
  -h, --help                Show this help
  -v, --version             Show the version

Examples:
  export SUPABASE_DB_URL='postgresql://...'
  ${CLI_NAME} plan
  ${CLI_NAME} export --out ./d1porter-output
  ${CLI_NAME} apply --bundle ./d1porter-output --database app-db --target local
  ${CLI_NAME} apply --bundle ./d1porter-output --database app-db --target remote --yes
`;
}
