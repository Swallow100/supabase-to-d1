import { D1_MAX_COLUMNS } from "./constants.js";
import { dependencyGroups } from "./graph.js";
import { convertDefaultExpression, mapColumnType } from "./type-mapping.js";
import { excludedBy, matchesAny, safeFilePart, sha256Text, sourceKey } from "./util.js";

export function createMigrationPlan(metadata, options) {
  const issues = [];
  const enumMap = new Map(
    (metadata.enums ?? []).map((entry) => [`${entry.schema}.${entry.name}`, entry.labels ?? []]),
  );

  const selected = (metadata.tables ?? []).filter((table) => {
    const key = sourceKey(table.schema, table.name);
    return matchesAny(key, options.include) && !excludedBy(key, options.exclude);
  });

  if (selected.length === 0) {
    addIssue(issues, "error", "NO_TABLES", "database", "No tables matched the requested schemas and filters.");
  }

  const selectedKeys = new Set(selected.map((table) => sourceKey(table.schema, table.name)));
  const targetNames = chooseTargetNames(selected, options.namespace);
  validateTargetTableNames(targetNames, issues);

  const tables = selected.map((sourceTable) => {
    const key = sourceKey(sourceTable.schema, sourceTable.name);
    const targetName = targetNames.get(key);
    const constraints = sourceTable.constraints ?? [];
    const primaryConstraint = constraints.find((constraint) => constraint.type === "p");
    const primaryColumns = primaryConstraint?.columns ?? [];
    const policyCount = Number(sourceTable.policyCount ?? 0);
    const triggerCount = Number(sourceTable.triggerCount ?? 0);

    validateIdentifier(sourceTable.schema, `${key} schema`, issues);
    validateIdentifier(sourceTable.name, key, issues);
    for (const constraint of constraints) {
      validateIdentifier(constraint.name, `${key} constraint`, issues);
    }
    for (const index of sourceTable.indexes ?? []) {
      validateIdentifier(index.name, `${key} index`, issues);
    }

    if ((sourceTable.columns ?? []).length > D1_MAX_COLUMNS) {
      addIssue(
        issues,
        "error",
        "COLUMN_LIMIT",
        key,
        `${key} has ${sourceTable.columns.length} columns; D1 supports at most ${D1_MAX_COLUMNS}.`,
      );
    }
    if (sourceTable.relationKind === "p" || sourceTable.isPartition || sourceTable.hasPartitions) {
      addIssue(
        issues,
        "error",
        "PARTITIONED_TABLE",
        key,
        "Partitioned tables and table partitions must be flattened deliberately before migration.",
      );
    }
    if (sourceTable.persistence !== "p") {
      addIssue(issues, "warning", "NON_PERMANENT_TABLE", key, "The source table is not a normal permanent PostgreSQL table.");
    }
    if (sourceTable.rlsEnabled || sourceTable.rlsForced || policyCount > 0) {
      addIssue(
        issues,
        "warning",
        "RLS_NOT_MIGRATED",
        key,
        `RLS and ${policyCount} polic${policyCount === 1 ? "y" : "ies"} are not migrated. Rebuild authorization in the Worker or application layer.`,
      );
    }
    if (triggerCount > 0) {
      addIssue(
        issues,
        "warning",
        "TRIGGERS_NOT_MIGRATED",
        key,
        `${triggerCount} PostgreSQL trigger(s) are not migrated.`,
      );
    }
    if (!primaryConstraint) {
      addIssue(
        issues,
        "warning",
        "NO_PRIMARY_KEY",
        key,
        "The table has no primary key. Export order is not deterministic and application updates may be difficult.",
      );
    }

    validateCaseInsensitiveColumnCollisions(sourceTable, key, issues);

    const columns = (sourceTable.columns ?? []).map((column) => {
      const objectName = `${key}.${column.name}`;
      validateIdentifier(column.name, objectName, issues);
      const labels = enumMap.get(`${column.typeSchema}.${column.udtName}`) ?? [];
      const mapping = mapColumnType(column, {
        numericMode: options.numeric,
        unknownTypes: options.unknownTypes,
        enumLabels: labels,
      });

      if (!mapping.sqliteType) {
        addIssue(issues, "error", "UNSUPPORTED_TYPE", objectName, mapping.note);
      } else if (mapping.lossy) {
        addIssue(issues, "warning", "TYPE_SEMANTICS_DIFFER", objectName, mapping.note);
      }
      if (mapping.javascriptPrecisionRisk) {
        addIssue(
          issues,
          "warning",
          "JAVASCRIPT_INTEGER_PRECISION",
          objectName,
          "Values outside JavaScript's exact integer range can lose precision when read through D1 APIs.",
        );
      }
      if (column.typeKind === "d") {
        addIssue(
          issues,
          "warning",
          "DOMAIN_CONSTRAINTS_NOT_MIGRATED",
          objectName,
          "A PostgreSQL domain is mapped using its base type; domain constraints are not migrated.",
        );
      }
      if (column.generated) {
        addIssue(
          issues,
          "error",
          "GENERATED_COLUMN",
          objectName,
          "Generated column expressions are not converted automatically.",
        );
      }
      if (column.collation && !["default", "C", "POSIX"].includes(column.collation)) {
        addIssue(
          issues,
          "warning",
          "COLLATION_DIFFERENCE",
          objectName,
          "A non-default PostgreSQL collation is not reproduced in D1.",
        );
      }

      const integerPrimaryKey =
        primaryColumns.length === 1 &&
        primaryColumns[0] === column.name &&
        mapping.sqliteType === "INTEGER";
      const convertedDefault = convertDefaultExpression(column.defaultExpression, mapping, { integerPrimaryKey });
      if (convertedDefault.dropped) {
        addIssue(issues, "warning", "DEFAULT_NOT_MIGRATED", objectName, convertedDefault.reason);
      }
      if (column.identity && !integerPrimaryKey) {
        addIssue(
          issues,
          "warning",
          "IDENTITY_NOT_MIGRATED",
          objectName,
          "Identity generation is only reproduced automatically for a single INTEGER PRIMARY KEY.",
        );
      }

      let enumLabels = mapping.enumLabels;
      if (enumLabels.length > 50 || Buffer.byteLength(enumLabels.join(""), "utf8") > 10_000) {
        addIssue(
          issues,
          "warning",
          "ENUM_CHECK_OMITTED",
          objectName,
          "The enum has too many or too-large labels for a compact D1 CHECK constraint; values remain TEXT.",
        );
        enumLabels = [];
      }

      return {
        position: column.position,
        name: column.name,
        formattedType: column.formattedType,
        udtName: column.udtName,
        typeSchema: column.typeSchema,
        typeKind: column.typeKind,
        typeCategory: column.typeCategory,
        domainBaseUdt: column.domainBaseUdt,
        domainBaseSchema: column.domainBaseSchema,
        elementUdt: column.elementUdt,
        elementSchema: column.elementSchema,
        notNull: Boolean(column.notNull),
        identity: column.identity,
        generated: column.generated,
        collation: column.collation,
        objectName,
        mapping: { ...mapping, enumLabels },
        defaultSql: convertedDefault.sql,
        inlineIntegerPrimaryKey: integerPrimaryKey,
        autoIncrement: integerPrimaryKey && (Boolean(column.identity) || /^nextval\s*\(/i.test(String(column.defaultExpression ?? ""))),
      };
    });

    const uniqueConstraints = constraints
      .filter((constraint) => constraint.type === "u")
      .map((constraint) => ({ name: constraint.name, columns: constraint.columns }));

    for (const constraint of constraints.filter((entry) => entry.type === "c")) {
      addIssue(
        issues,
        "warning",
        "CHECK_NOT_MIGRATED",
        `${key}.${constraint.name}`,
        "A PostgreSQL CHECK constraint is not migrated automatically; recreate it manually if required.",
      );
    }
    for (const constraint of constraints.filter((entry) => entry.type === "x")) {
      addIssue(
        issues,
        "error",
        "EXCLUSION_CONSTRAINT",
        `${key}.${constraint.name}`,
        "PostgreSQL exclusion constraints have no direct D1 equivalent.",
      );
    }

    const foreignKeys = [];
    for (const constraint of constraints.filter((entry) => entry.type === "f")) {
      const referencedKey = sourceKey(constraint.referencedSchema, constraint.referencedTable);
      if (!selectedKeys.has(referencedKey)) {
        const level = options.externalFks === "error" ? "error" : "warning";
        addIssue(
          issues,
          level,
          "EXTERNAL_FOREIGN_KEY",
          `${key}.${constraint.name}`,
          `A foreign key references an excluded table; the constraint ${level === "warning" ? "will be omitted" : "blocks export"}.`,
        );
        continue;
      }
      if (constraint.matchType && constraint.matchType !== "s") {
        addIssue(
          issues,
          "warning",
          "FOREIGN_KEY_MATCH_MODE",
          `${key}.${constraint.name}`,
          "MATCH FULL/PARTIAL semantics are not reproduced; D1 uses standard SQLite foreign-key behavior.",
        );
      }
      if (!constraint.validated) {
        addIssue(
          issues,
          "warning",
          "UNVALIDATED_FOREIGN_KEY",
          `${key}.${constraint.name}`,
          "The PostgreSQL foreign key is not validated; D1 import may reject existing rows.",
        );
      }
      foreignKeys.push({
        name: constraint.name,
        columns: constraint.columns,
        referencedSourceKey: referencedKey,
        referencedTargetName: targetNames.get(referencedKey),
        referencedColumns: constraint.referencedColumns,
        updateAction: mapForeignKeyAction(constraint.updateAction),
        deleteAction: mapForeignKeyAction(constraint.deleteAction),
        deferrable: Boolean(constraint.deferrable),
        initiallyDeferred: Boolean(constraint.initiallyDeferred),
      });
    }

    const indexes = [];
    for (const index of sourceTable.indexes ?? []) {
      if (index.primary || index.backsConstraint) continue;
      const objectName = `${key}.${index.name}`;
      const simple =
        index.method === "btree" &&
        index.valid &&
        index.ready &&
        !index.hasPredicate &&
        !index.hasExpressions &&
        index.keys.length > 0 &&
        index.keys.every((entry) => entry.name);
      if (!simple) {
        addIssue(
          issues,
          "warning",
          "INDEX_NOT_MIGRATED",
          objectName,
          "Only valid, non-partial btree indexes on ordinary columns are migrated automatically.",
        );
        continue;
      }
      if (index.totalColumnCount > index.keyCount) {
        addIssue(
          issues,
          "warning",
          "INDEX_INCLUDE_OMITTED",
          objectName,
          "PostgreSQL INCLUDE columns are omitted from the D1 index.",
        );
      }
      indexes.push({
        sourceName: index.name,
        targetName: makeTargetIndexName(sourceTable.schema, index.name, key),
        unique: Boolean(index.unique),
        columns: index.keys.map((entry) => entry.name),
      });
    }

    return {
      sourceKey: key,
      sourceSchema: sourceTable.schema,
      sourceName: sourceTable.name,
      targetName,
      estimatedRows: sourceTable.estimatedRows,
      columns,
      primaryKey: primaryConstraint
        ? { name: primaryConstraint.name, columns: primaryConstraint.columns }
        : null,
      uniqueConstraints,
      foreignKeys,
      indexes,
    };
  });

  const viewCount = Number(metadata.viewCount ?? 0);
  const functionCount = Number(metadata.functionCount ?? 0);
  if (viewCount > 0) {
    addIssue(issues, "warning", "VIEWS_NOT_MIGRATED", "database", `${viewCount} view(s) or materialized view(s) are not migrated.`);
  }
  if (functionCount > 0) {
    addIssue(issues, "warning", "FUNCTIONS_NOT_MIGRATED", "database", `${functionCount} PostgreSQL function(s) in selected schemas are not migrated.`);
  }

  const groups = dependencyGroups(tables);
  flagCycles(tables, groups, issues);

  if (options.strict) {
    for (const issue of issues) {
      if (issue.level === "warning") issue.level = "error";
    }
  }

  return {
    source: {
      kind: "postgresql",
      serverVersion: metadata.serverVersion,
      serverVersionNum: metadata.serverVersionNum,
      schemas: options.schemas,
    },
    options: {
      namespace: options.namespace,
      numeric: options.numeric,
      externalFks: options.externalFks,
      unknownTypes: options.unknownTypes,
      strict: options.strict,
      include: options.include,
      exclude: options.exclude,
    },
    tables,
    groups,
    issues,
    globalObjects: { viewCount, functionCount },
    extensionCount: Number(metadata.extensionCount ?? 0),
  };
}

export function planHasErrors(plan) {
  return plan.issues.some((issue) => issue.level === "error");
}

export function migrationPlanFingerprint(plan) {
  return sha256Text(JSON.stringify({
    options: plan.options,
    tables: plan.tables.map((table) => ({
      sourceKey: table.sourceKey,
      targetName: table.targetName,
      columns: table.columns.map((column) => ({
        name: column.name,
        formattedType: column.formattedType,
        udtName: column.udtName,
        typeSchema: column.typeSchema,
        notNull: column.notNull,
        identity: column.identity,
        generated: column.generated,
        defaultSql: column.defaultSql,
        inlineIntegerPrimaryKey: column.inlineIntegerPrimaryKey,
        autoIncrement: column.autoIncrement,
        mapping: column.mapping,
      })),
      primaryKey: table.primaryKey,
      uniqueConstraints: table.uniqueConstraints,
      foreignKeys: table.foreignKeys,
      indexes: table.indexes,
    })),
    issues: plan.issues.map(({ level, code, object, message }) => ({ level, code, object, message })),
    groups: plan.groups,
  }));
}

function chooseTargetNames(tables, namespaceMode) {
  const schemas = new Set(tables.map((table) => table.schema));
  const usePrefix = namespaceMode === "prefix" || (namespaceMode === "auto" && (schemas.size > 1 || !schemas.has("public")));
  return new Map(
    tables.map((table) => {
      const key = sourceKey(table.schema, table.name);
      const name = usePrefix ? `${table.schema}__${table.name}` : table.name;
      return [key, name];
    }),
  );
}

function validateTargetTableNames(targetNames, issues) {
  const owners = new Map();
  for (const [key, targetName] of targetNames) {
    const normalized = targetName.toLocaleLowerCase("en-US");
    const existing = owners.get(normalized);
    if (existing && existing !== key) {
      addIssue(
        issues,
        "error",
        "TABLE_NAME_COLLISION",
        key,
        "Multiple PostgreSQL tables map to the same case-insensitive D1 table name. Use --namespace prefix or rename a table.",
      );
    }
    owners.set(normalized, key);
    if (normalized === "_cf_kv" || normalized.startsWith("sqlite_")) {
      addIssue(issues, "error", "RESERVED_TABLE_NAME", key, "The mapped D1 table name is reserved by SQLite or Cloudflare D1.");
    }
  }
}

function validateCaseInsensitiveColumnCollisions(sourceTable, key, issues) {
  const seen = new Map();
  for (const column of sourceTable.columns ?? []) {
    const normalized = column.name.toLocaleLowerCase("en-US");
    const existing = seen.get(normalized);
    if (existing && existing !== column.name) {
      addIssue(
        issues,
        "error",
        "COLUMN_NAME_COLLISION",
        key,
        "Two PostgreSQL columns differ only by case and cannot be represented safely in D1.",
      );
    }
    seen.set(normalized, column.name);
  }
}

function validateIdentifier(value, object, issues) {
  if (/[\p{Cc}\p{Cf}]/u.test(String(value))) {
    addIssue(issues, "error", "UNSAFE_CHARACTER_IN_IDENTIFIER", object, "An identifier contains a control or formatting character and is not exported.");
  }
}

function flagCycles(tables, groups, issues) {
  const tableByKey = new Map(tables.map((table) => [table.sourceKey, table]));
  for (const group of groups) {
    const selfReference = group.length === 1 && tableByKey.get(group[0])?.foreignKeys.some((fk) => fk.referencedSourceKey === group[0]);
    if (group.length > 1 || selfReference) {
      addIssue(
        issues,
        "warning",
        "FOREIGN_KEY_CYCLE",
        group.join(", "),
        "A foreign-key cycle was detected. The related tables are emitted together with deferred foreign-key checks.",
      );
    }
  }
}

function makeTargetIndexName(schema, indexName, tableKey) {
  const stem = safeFilePart(`${schema}__${indexName}`).slice(0, 88);
  return `${stem}_${sha256Text(`${tableKey}:${indexName}`).slice(0, 10)}`;
}

function mapForeignKeyAction(value) {
  return ({ a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" })[value] ?? "NO ACTION";
}

function addIssue(issues, level, code, object, message) {
  issues.push({ level, code, object, message });
}
