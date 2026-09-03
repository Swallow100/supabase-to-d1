import { parseArgs } from "./args.js";
import { VERSION } from "./constants.js";
import { CliError, PlanError } from "./errors.js";
import { exportBundle } from "./exporter.js";
import { helpText } from "./help.js";
import { buildIntrospectionSql } from "./introspection.js";
import { createMigrationPlan, planHasErrors } from "./model.js";
import { formatPlan } from "./plan-format.js";
import { checkPsql, resolvePgEnvironment, runPsqlJson } from "./psql.js";
import { stableStringify } from "./util.js";
import { applyBundle, verifyBundleOnD1 } from "./wrangler.js";

export async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (options.help || !command) {
    process.stdout.write(helpText());
    return;
  }

  if (command === "plan" || command === "export") {
    const plan = await inspectSource(options);
    if (command === "plan") {
      process.stdout.write(options.json ? stableStringify(plan) : formatPlan(plan));
      if (planHasErrors(plan)) process.exitCode = 2;
      return;
    }

    if (planHasErrors(plan)) {
      process.stderr.write(formatPlan(plan));
      throw new PlanError("Export is blocked by the compatibility issues above.");
    }
    if (!options.json) process.stdout.write(formatPlan(plan));
    const pgEnvironment = resolvePgEnvironment(options.urlEnv);
    const result = await exportBundle({
      plan,
      options,
      psqlPath: options.psql,
      pgEnvironment,
    });
    const summary = {
      bundle: result.root,
      tables: result.manifest.tables.length,
      rows: result.manifest.tables.reduce((sum, table) => sum + Number(table.rows), 0),
      files: result.manifest.applyOrder.length,
    };
    process.stdout.write(options.json ? stableStringify(summary) : `Export complete: ${result.root}\n`);
    return;
  }

  if (command === "apply") {
    const result = await applyBundle(options);
    process.stdout.write(options.json ? stableStringify(result) : `${result.dryRun ? "Dry run complete" : `Applied ${result.appliedFiles} file(s)`}${result.verified ? " and verified the D1 database" : ""}.\n`);
    return;
  }

  if (command === "verify") {
    const result = await verifyBundleOnD1(options);
    process.stdout.write(options.json ? stableStringify(result) : `${result.dryRun ? "Verification dry run complete" : `Verified ${result.tables.length} table(s); no foreign-key violations found`}.\n`);
    return;
  }

  throw new CliError(`Unknown command: ${command}`);
}

async function inspectSource(options) {
  await checkPsql(options.psql);
  const pgEnvironment = resolvePgEnvironment(options.urlEnv);
  const metadata = await runPsqlJson({
    psqlPath: options.psql,
    sql: buildIntrospectionSql(options.schemas),
    pgEnvironment,
  });
  return createMigrationPlan(metadata, options);
}
