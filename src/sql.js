import { SAFE_STATEMENT_BYTES } from "./constants.js";
import { CliError } from "./errors.js";
import { serializeValue } from "./type-mapping.js";
import { quoteIdentifier, quoteSqlString } from "./util.js";

export function renderSchemaSql(plan) {
  const statements = plan.groups.flatMap((group) =>
    group.map((key) => renderCreateTable(tableByKey(plan, key))),
  );
  for (const statement of statements) assertStatementSize(statement, "CREATE TABLE");
  return `${header("schema")}${statements.join("\n\n")}\n`;
}

export function renderIndexesSql(plan) {
  const statements = [];
  for (const table of plan.tables) {
    for (const index of table.indexes) {
      const unique = index.unique ? "UNIQUE " : "";
      const statement = `CREATE ${unique}INDEX ${quoteIdentifier(index.targetName)} ON ${quoteIdentifier(table.targetName)} (${index.columns.map(quoteIdentifier).join(", ")});`;
      assertStatementSize(statement, "CREATE INDEX");
      statements.push(statement);
    }
  }
  return `${header("indexes")}${statements.length > 0 ? `${statements.join("\n")}\n` : "-- No ordinary secondary indexes were selected.\n"}`;
}

export function renderVerifySql(plan) {
  const counts = plan.tables.map((table) =>
    `SELECT ${quoteSqlString(table.targetName)} AS table_name, COUNT(*) AS row_count FROM ${quoteIdentifier(table.targetName)};`,
  );
  for (const statement of counts) assertStatementSize(statement, "verification query");
  const countSql = counts.length > 0 ? counts.join("\n") : "SELECT NULL AS table_name, 0 AS row_count WHERE 0;";
  return `${header("manual verification")}-- Compare these counts with manifest.json.\n${countSql}\n\nPRAGMA foreign_key_check;\n`;
}

export function createInsertBatcher(table, { onStatement, maxStatementBytes = SAFE_STATEMENT_BYTES, maxRows = 250 }) {
  const prefix = `INSERT INTO ${quoteIdentifier(table.targetName)} (${table.columns.map((column) => quoteIdentifier(column.name)).join(", ")}) VALUES\n`;
  let rows = [];
  let byteLength = Buffer.byteLength(prefix, "utf8") + 2;

  async function flush() {
    if (rows.length === 0) return;
    const statement = `${prefix}${rows.join(",\n")};\n`;
    assertStatementSize(statement, `INSERT into ${table.targetName}`, maxStatementBytes);
    await onStatement(statement);
    rows = [];
    byteLength = Buffer.byteLength(prefix, "utf8") + 2;
  }

  return {
    async add(values) {
      if (values.length !== table.columns.length) {
        throw new CliError(`Row width did not match the planned columns for ${table.sourceKey}.`);
      }
      const tuple = `(${values.map((value, index) => serializeValue(value, table.columns[index])).join(", ")})`;
      const tupleBytes = Buffer.byteLength(tuple, "utf8");
      const singleStatementBytes = Buffer.byteLength(prefix, "utf8") + tupleBytes + 2;
      if (singleStatementBytes > maxStatementBytes) {
        throw new CliError(
          `A row in ${table.sourceKey} requires a SQL statement larger than the safe D1 limit. The value itself is not printed.`,
        );
      }
      const separatorBytes = rows.length > 0 ? 2 : 0;
      if (rows.length >= maxRows || byteLength + separatorBytes + tupleBytes > maxStatementBytes) {
        await flush();
      }
      rows.push(tuple);
      byteLength += (rows.length > 1 ? 2 : 0) + tupleBytes;
    },
    flush,
  };
}

export function renderDataFileHeader({ groupNumber, partNumber, cyclic }) {
  return `${header(`data group ${groupNumber}, part ${partNumber}`)}PRAGMA defer_foreign_keys = ON;\n${cyclic ? "-- This file contains a foreign-key cycle and must be applied as one unit.\n" : ""}\n`;
}

function renderCreateTable(table) {
  const definitions = [];
  for (const column of table.columns) definitions.push(`  ${renderColumn(column)}`);

  if (table.primaryKey && !table.columns.some((column) => column.inlineIntegerPrimaryKey)) {
    definitions.push(
      `  CONSTRAINT ${quoteIdentifier(table.primaryKey.name)} PRIMARY KEY (${table.primaryKey.columns.map(quoteIdentifier).join(", ")})`,
    );
  }

  for (const unique of table.uniqueConstraints) {
    definitions.push(
      `  CONSTRAINT ${quoteIdentifier(unique.name)} UNIQUE (${unique.columns.map(quoteIdentifier).join(", ")})`,
    );
  }

  for (const foreignKey of table.foreignKeys) {
    let definition = `  CONSTRAINT ${quoteIdentifier(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(quoteIdentifier).join(", ")}) REFERENCES ${quoteIdentifier(foreignKey.referencedTargetName)} (${foreignKey.referencedColumns.map(quoteIdentifier).join(", ")})`;
    if (foreignKey.updateAction !== "NO ACTION") definition += ` ON UPDATE ${foreignKey.updateAction}`;
    if (foreignKey.deleteAction !== "NO ACTION") definition += ` ON DELETE ${foreignKey.deleteAction}`;
    if (foreignKey.deferrable) {
      definition += ` DEFERRABLE${foreignKey.initiallyDeferred ? " INITIALLY DEFERRED" : " INITIALLY IMMEDIATE"}`;
    }
    definitions.push(definition);
  }

  return `CREATE TABLE ${quoteIdentifier(table.targetName)} (\n${definitions.join(",\n")}\n);`;
}

function renderColumn(column) {
  const constraints = [quoteIdentifier(column.name), column.mapping.sqliteType];
  if (column.inlineIntegerPrimaryKey) {
    constraints.push("PRIMARY KEY");
    if (column.autoIncrement) constraints.push("AUTOINCREMENT");
  } else if (column.notNull) {
    constraints.push("NOT NULL");
  }
  if (column.defaultSql !== null) constraints.push(`DEFAULT ${column.defaultSql}`);
  if (column.mapping.storage === "boolean") {
    constraints.push(`CHECK (${quoteIdentifier(column.name)} IN (0, 1))`);
  }
  if (column.mapping.enumLabels.length > 0) {
    constraints.push(
      `CHECK (${quoteIdentifier(column.name)} IN (${column.mapping.enumLabels.map(quoteSqlString).join(", ")}))`,
    );
  }
  return constraints.join(" ");
}

function tableByKey(plan, key) {
  const table = plan.tables.find((entry) => entry.sourceKey === key);
  if (!table) throw new CliError(`Internal plan error: table ${key} was not found.`);
  return table;
}

function assertStatementSize(statement, label, limit = SAFE_STATEMENT_BYTES) {
  const bytes = Buffer.byteLength(statement, "utf8");
  if (bytes > limit) {
    throw new CliError(`${label} is ${bytes} bytes, above the safe D1 statement limit of ${limit} bytes.`);
  }
}

function header(subject) {
  return `-- Generated by supabase-to-d1.\n-- ${subject}; review before applying to a remote database.\n\n`;
}
