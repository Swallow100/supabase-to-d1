import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { D1_MAX_IMPORT_BYTES, MANIFEST_VERSION, PACKAGE_NAME, VERSION } from "./constants.js";
import { CliError } from "./errors.js";
import { buildIntrospectionSql } from "./introspection.js";
import { createMigrationPlan, migrationPlanFingerprint, planHasErrors } from "./model.js";
import { streamPsqlScript } from "./psql.js";
import { formatPlanMarkdown } from "./plan-format.js";
import { createInsertBatcher, renderDataFileHeader, renderIndexesSql, renderSchemaSql, renderVerifySql } from "./sql.js";
import {
  formatBytes,
  prepareEmptyDirectory,
  quoteIdentifier,
  randomMarker,
  safeFilePart,
  sha256File,
  sqlQualifiedName,
  stableStringify,
  writeText,
} from "./util.js";
import { parseCopyTextRow } from "./copy-text.js";

export async function exportBundle({ plan, options, psqlPath, pgEnvironment, stream = streamPsqlScript }) {
  if (planHasErrors(plan)) throw new CliError("The migration plan contains blockers; export was not started.", { exitCode: 2 });

  const maxFileBytes = Math.min(options.maxFileMb * 1024 * 1024, D1_MAX_IMPORT_BYTES);
  const root = await prepareEmptyDirectory(options.out, { force: options.force });
  const orderedTables = orderedPlanTables(plan);
  const marker = `__D1PORTER_${randomMarker().toUpperCase()}`;
  const script = buildExportScript(plan, orderedTables, marker);
  const writers = new Map();
  const rowCounts = new Map(plan.tables.map((table) => [table.sourceKey, 0]));
  const generatedDataFiles = [];
  let metadataBuffer = [];
  let metadataStarted = false;
  let metadataVerified = false;
  let activeTable = null;
  let activeBatcher = null;
  let completedTables = 0;

  try {
    await stream({
      psqlPath,
      script,
      pgEnvironment,
      onLine: async (line) => {
        if (line === `${marker}_META_BEGIN`) {
          if (metadataStarted || metadataVerified) throw new CliError("Unexpected metadata marker in PostgreSQL export stream.");
          metadataStarted = true;
          metadataBuffer = [];
          return;
        }
        if (line === `${marker}_META_END`) {
          if (!metadataStarted || metadataVerified) throw new CliError("Unexpected metadata end marker in PostgreSQL export stream.");
          const snapshotMetadata = parseMetadata(metadataBuffer.join("\n"));
          const snapshotPlan = createMigrationPlan(snapshotMetadata, {
            ...plan.options,
            schemas: plan.source.schemas,
          });
          if (planHasErrors(snapshotPlan) || migrationPlanFingerprint(snapshotPlan) !== migrationPlanFingerprint(plan)) {
            throw new CliError("The PostgreSQL schema changed between planning and the locked export snapshot. Run export again after schema changes stop.");
          }
          metadataStarted = false;
          metadataVerified = true;
          await writeStaticBundleFiles(root, plan, maxFileBytes);
          return;
        }
        if (metadataStarted) {
          metadataBuffer.push(line);
          return;
        }

        const beginIndex = parseMarkerIndex(line, marker, "TABLE_BEGIN");
        if (beginIndex !== null) {
          if (!metadataVerified || activeTable) throw new CliError("Unexpected table start marker in PostgreSQL export stream.");
          activeTable = orderedTables[beginIndex];
          if (!activeTable) throw new CliError("PostgreSQL export stream referenced an unknown table.");
          const groupIndex = groupIndexFor(plan, activeTable.sourceKey);
          let writer = writers.get(groupIndex);
          if (!writer) {
            const group = plan.groups[groupIndex];
            writer = new GroupSqlWriter({ root, groupIndex, group, plan, maxFileBytes });
            writers.set(groupIndex, writer);
          }
          activeBatcher = createInsertBatcher(activeTable, {
            onStatement: async (statement) => writer.writeStatement(statement),
          });
          return;
        }

        const endIndex = parseMarkerIndex(line, marker, "TABLE_END");
        if (endIndex !== null) {
          if (!activeTable || orderedTables[endIndex]?.sourceKey !== activeTable.sourceKey) {
            throw new CliError("Unexpected table end marker in PostgreSQL export stream.");
          }
          await activeBatcher.flush();
          activeTable = null;
          activeBatcher = null;
          completedTables += 1;
          return;
        }

        if (activeTable) {
          const values = parseCopyTextRow(line, activeTable.columns.length);
          await activeBatcher.add(values);
          rowCounts.set(activeTable.sourceKey, rowCounts.get(activeTable.sourceKey) + 1);
        }
      },
    });

    if (!metadataVerified || metadataStarted || activeTable || completedTables !== orderedTables.length) {
      throw new CliError("PostgreSQL export ended before all planned tables were completed.");
    }

    for (const writer of writers.values()) {
      await writer.close();
      generatedDataFiles.push(...writer.files);
    }

    const manifest = await buildManifest({ root, plan, rowCounts, dataFiles: generatedDataFiles });
    await writeText(join(root, "manifest.json"), stableStringify(manifest));
    return { root, manifest };
  } catch (error) {
    await Promise.all([...writers.values()].map((writer) => writer.abort()));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function buildExportScript(plan, orderedTables, marker) {
  const lockTargets = orderedTables.map((table) => sqlQualifiedName(table.sourceSchema, table.sourceName)).join(", ");
  const lines = [
    "\\set ON_ERROR_STOP on",
    "\\pset tuples_only on",
    "\\pset format unaligned",
    "\\pset footer off",
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    "SET LOCAL TIME ZONE 'UTC';",
    "SET LOCAL bytea_output = 'hex';",
    "SET LOCAL extra_float_digits = 3;",
    `LOCK TABLE ${lockTargets} IN ACCESS SHARE MODE;`,
    `\\echo ${marker}_META_BEGIN`,
    buildIntrospectionSql(plan.source.schemas).trim(),
    `\\echo ${marker}_META_END`,
  ];

  orderedTables.forEach((table, index) => {
    const columns = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const orderBy = table.primaryKey?.columns?.length
      ? ` ORDER BY ${table.primaryKey.columns.map(quoteIdentifier).join(", ")}`
      : "";
    lines.push(
      `\\echo ${marker}_TABLE_BEGIN_${index}`,
      `COPY (SELECT ${columns} FROM ${sqlQualifiedName(table.sourceSchema, table.sourceName)}${orderBy}) TO STDOUT WITH (FORMAT text, DELIMITER E'\\t', ENCODING 'UTF8');`,
      `\\echo ${marker}_TABLE_END_${index}`,
    );
  });
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

class GroupSqlWriter {
  constructor({ root, groupIndex, group, plan, maxFileBytes }) {
    this.root = root;
    this.groupIndex = groupIndex;
    this.group = group;
    this.maxFileBytes = maxFileBytes;
    this.cyclic = isCyclicGroup(group, plan);
    this.label = group.length > 1 ? `cycle-${group.map((key) => safeFilePart(key.split(".").at(-1))).join("-")}` : safeFilePart(plan.tables.find((table) => table.sourceKey === group[0]).targetName);
    this.part = 0;
    this.handle = null;
    this.currentBytes = 0;
    this.files = [];
  }

  async writeStatement(statement) {
    const statementBytes = Buffer.byteLength(statement, "utf8");
    if (!this.handle) await this.openPart();
    if (this.currentBytes + statementBytes > this.maxFileBytes) {
      if (this.cyclic) {
        throw new CliError(
          `A cyclic foreign-key group exceeds the configured file limit (${formatBytes(this.maxFileBytes)}). Increase --max-file-mb or migrate that cycle manually.`,
        );
      }
      await this.closeCurrent();
      await this.openPart();
    }
    await this.handle.write(statement, null, "utf8");
    this.currentBytes += statementBytes;
  }

  async openPart() {
    this.part += 1;
    const filename = `${String(this.groupIndex + 1).padStart(4, "0")}_${this.label}_${String(this.part).padStart(3, "0")}.sql`;
    const relativePath = `data/${filename}`;
    const absolutePath = join(this.root, relativePath);
    await mkdir(join(this.root, "data"), { recursive: true, mode: 0o700 });
    const header = renderDataFileHeader({ groupNumber: this.groupIndex + 1, partNumber: this.part, cyclic: this.cyclic });
    this.handle = await open(absolutePath, "wx", 0o600);
    await this.handle.write(header, null, "utf8");
    this.currentBytes = Buffer.byteLength(header, "utf8");
    this.files.push({ path: relativePath, kind: "data", group: this.groupIndex + 1 });
  }

  async closeCurrent() {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }

  async close() {
    await this.closeCurrent();
  }

  async abort() {
    try {
      await this.closeCurrent();
    } catch {
      // The enclosing export cleanup removes the entire directory.
    }
  }
}

async function writeStaticBundleFiles(root, plan, maxFileBytes) {
  const files = {
    "schema.sql": renderSchemaSql(plan),
    "indexes.sql": renderIndexesSql(plan),
    "verify.sql": renderVerifySql(plan),
    "report.md": formatPlanMarkdown(plan),
    "README.txt": bundleReadme(),
    ".gitignore": "# Generated migration bundles contain source data.\n*\n!.gitignore\n!README.txt\n",
  };
  for (const [name, content] of Object.entries(files)) {
    if (Buffer.byteLength(content, "utf8") > maxFileBytes && name.endsWith(".sql")) {
      throw new CliError(`${name} exceeds the configured file-size limit.`);
    }
    await writeText(join(root, name), content);
  }
}

async function buildManifest({ root, plan, rowCounts, dataFiles }) {
  const staticFiles = [
    { path: "schema.sql", kind: "schema" },
    ...dataFiles,
    { path: "indexes.sql", kind: "indexes" },
    { path: "verify.sql", kind: "verification" },
    { path: "report.md", kind: "report" },
    { path: "README.txt", kind: "notice" },
  ];
  const files = [];
  for (const entry of staticFiles) {
    const absolutePath = join(root, entry.path);
    const fileStat = await stat(absolutePath);
    files.push({ ...entry, bytes: fileStat.size, sha256: await sha256File(absolutePath) });
  }
  const applyOrder = ["schema.sql", ...dataFiles.map((entry) => entry.path), "indexes.sql"];
  return {
    format: "supabase-to-d1-bundle",
    version: MANIFEST_VERSION,
    complete: true,
    createdAt: new Date().toISOString(),
    tool: { name: PACKAGE_NAME, version: VERSION },
    source: {
      kind: "postgresql",
      schemas: plan.source.schemas,
      serverVersion: plan.source.serverVersion,
    },
    options: plan.options,
    tables: plan.tables.map((table) => ({
      source: table.sourceKey,
      target: table.targetName,
      columns: table.columns.length,
      rows: rowCounts.get(table.sourceKey) ?? 0,
    })),
    issues: plan.issues,
    files,
    applyOrder,
  };
}

function orderedPlanTables(plan) {
  const byKey = new Map(plan.tables.map((table) => [table.sourceKey, table]));
  return plan.groups.flatMap((group) => group.map((key) => byKey.get(key)));
}

function groupIndexFor(plan, sourceKey) {
  const index = plan.groups.findIndex((group) => group.includes(sourceKey));
  if (index < 0) throw new CliError(`Internal plan error: no dependency group for ${sourceKey}.`);
  return index;
}

function isCyclicGroup(group, plan) {
  if (group.length > 1) return true;
  const table = plan.tables.find((entry) => entry.sourceKey === group[0]);
  return table.foreignKeys.some((foreignKey) => foreignKey.referencedSourceKey === table.sourceKey);
}

function parseMarkerIndex(line, marker, type) {
  const prefix = `${marker}_${type}_`;
  if (!line.startsWith(prefix)) return null;
  const value = line.slice(prefix.length);
  if (!/^\d+$/.test(value)) throw new CliError("Malformed marker in PostgreSQL export stream.");
  return Number(value);
}

function parseMetadata(text) {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    throw new CliError("Could not parse metadata from the locked PostgreSQL export snapshot.", { cause: error });
  }
}

function bundleReadme() {
  return `SENSITIVE MIGRATION BUNDLE\n==========================\n\nThis directory can contain complete database rows and structural metadata.\nDo not commit it, upload it, send it to an issue tracker, or attach it to a bug\nreport. The included .gitignore hides bundle contents by default, but forced\nGit operations can still expose them.\n\nThe source connection URL and credentials are never written here.\nReview report.md and manifest.json before applying anything remotely.\n`;
}
