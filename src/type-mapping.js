import {
  MAX_SAFE_JS_INTEGER,
  MAX_SQLITE_INTEGER,
  MIN_SQLITE_INTEGER,
} from "./constants.js";
import { CliError } from "./errors.js";
import { quoteSqlString } from "./util.js";

const INTEGER_TYPES = new Set([
  "int2", "int4", "int8", "smallint", "integer", "bigint",
  "oid", "xid", "xid8", "cid",
]);
const REAL_TYPES = new Set([
  "float4", "float8", "real", "double precision",
]);
const NUMERIC_TYPES = new Set(["numeric", "decimal"]);
const BOOLEAN_TYPES = new Set(["bool", "boolean"]);
const BLOB_TYPES = new Set(["bytea"]);
const JSON_TYPES = new Set(["json", "jsonb"]);
const TEXT_TYPES = new Set([
  "text", "varchar", "character varying", "bpchar", "character", "char", "name",
  "uuid", "citext", "xml", "inet", "cidr", "macaddr", "macaddr8",
  "date", "time", "timetz", "timestamp", "timestamptz", "interval",
  "time without time zone", "time with time zone",
  "timestamp without time zone", "timestamp with time zone",
  "bit", "varbit", "bit varying", "tsvector", "tsquery", "money",
  "pg_lsn", "txid_snapshot",
]);

export function mapColumnType(column, { numericMode, unknownTypes, enumLabels }) {
  const originalUdt = String(column.udtName ?? "").toLowerCase();
  const formatted = normalizeFormattedType(column.formattedType);
  const domainBase = String(column.domainBaseUdt ?? "").toLowerCase();
  const effective = column.typeKind === "d" && domainBase ? domainBase : originalUdt;

  if (column.typeKind === "e") {
    return {
      sqliteType: "TEXT",
      storage: "enum",
      enumLabels: enumLabels ?? [],
      lossy: false,
      note: null,
    };
  }

  if (column.typeCategory === "A" || formatted.endsWith("[]")) {
    return {
      sqliteType: "TEXT",
      storage: "array-text",
      enumLabels: [],
      lossy: true,
      note: "PostgreSQL array syntax is preserved as TEXT; application queries must be rewritten.",
    };
  }

  if (INTEGER_TYPES.has(effective) || INTEGER_TYPES.has(formatted)) {
    return {
      sqliteType: "INTEGER",
      storage: "integer",
      enumLabels: [],
      lossy: false,
      note: null,
      javascriptPrecisionRisk: effective === "int8" || effective === "bigint" || effective === "xid8",
    };
  }
  if (REAL_TYPES.has(effective) || REAL_TYPES.has(formatted)) {
    return { sqliteType: "REAL", storage: "real", enumLabels: [], lossy: false, note: null };
  }
  if (NUMERIC_TYPES.has(effective) || formatted.startsWith("numeric") || formatted.startsWith("decimal")) {
    return numericMode === "real"
      ? {
          sqliteType: "REAL",
          storage: "numeric-real",
          enumLabels: [],
          lossy: true,
          note: "NUMERIC values are converted to REAL and may lose decimal precision.",
        }
      : {
          sqliteType: "TEXT",
          storage: "numeric-text",
          enumLabels: [],
          lossy: true,
          note: "NUMERIC values are preserved exactly as TEXT; arithmetic queries must cast or be rewritten.",
        };
  }
  if (BOOLEAN_TYPES.has(effective) || BOOLEAN_TYPES.has(formatted)) {
    return { sqliteType: "INTEGER", storage: "boolean", enumLabels: [], lossy: false, note: null };
  }
  if (BLOB_TYPES.has(effective)) {
    return { sqliteType: "BLOB", storage: "blob", enumLabels: [], lossy: false, note: null };
  }
  if (JSON_TYPES.has(effective)) {
    return { sqliteType: "TEXT", storage: "json", enumLabels: [], lossy: false, note: null };
  }
  if (TEXT_TYPES.has(effective) || TEXT_TYPES.has(formatted) || formatted.startsWith("character varying")) {
    return { sqliteType: "TEXT", storage: "text", enumLabels: [], lossy: false, note: null };
  }

  if (unknownTypes === "text") {
    return {
      sqliteType: "TEXT",
      storage: "unknown-text",
      enumLabels: [],
      lossy: true,
      note: `Unknown PostgreSQL type ${column.typeSchema}.${column.udtName} is exported using its text representation.`,
    };
  }

  return {
    sqliteType: null,
    storage: "unsupported",
    enumLabels: [],
    lossy: true,
    note: `Unsupported PostgreSQL type ${column.typeSchema}.${column.udtName}. Use --unknown-types text only after reviewing its textual representation.`,
  };
}

export function convertDefaultExpression(expression, mapping, { integerPrimaryKey = false } = {}) {
  if (!expression) return { sql: null, dropped: false, reason: null };
  const value = String(expression).trim().replace(/^\((.*)\)$/s, "$1").trim();

  if (/^nextval\s*\(/i.test(value)) {
    return {
      sql: null,
      dropped: !integerPrimaryKey,
      reason: integerPrimaryKey
        ? null
        : "PostgreSQL sequence defaults are not available in D1.",
    };
  }
  if (/^(now\(\)|CURRENT_TIMESTAMP(?:\(\d+\))?)$/i.test(value)) {
    return { sql: "CURRENT_TIMESTAMP", dropped: false, reason: null };
  }
  if (/^CURRENT_DATE$/i.test(value)) {
    return { sql: "CURRENT_DATE", dropped: false, reason: null };
  }
  if (/^CURRENT_TIME(?:\(\d+\))?$/i.test(value)) {
    return { sql: "CURRENT_TIME", dropped: false, reason: null };
  }
  if (/^(true|false)(?:::[\w." ]+)?$/i.test(value)) {
    return { sql: /^true/i.test(value) ? "1" : "0", dropped: false, reason: null };
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:::[\w." ]+)?$/.test(value)) {
    return { sql: value.replace(/::[\w." ]+$/, ""), dropped: false, reason: null };
  }

  const stringMatch = value.match(/^'((?:''|[^'])*)'(?:::[\w." \[\]]+)?$/s);
  if (stringMatch) {
    return { sql: `'${stringMatch[1]}'`, dropped: false, reason: null };
  }

  if (/^(gen_random_uuid|uuid_generate_v[147])\s*\(/i.test(value)) {
    return {
      sql: null,
      dropped: true,
      reason: "UUID-generating PostgreSQL functions are not available in D1; generate IDs in the application.",
    };
  }

  if (mapping.storage === "integer" && /^-?\d+$/.test(value)) {
    return { sql: value, dropped: false, reason: null };
  }

  return {
    sql: null,
    dropped: true,
    reason: "A PostgreSQL-specific default expression was omitted. Review the source default manually.",
  };
}

export function serializeValue(value, column) {
  if (value === null) return "NULL";

  switch (column.mapping.storage) {
    case "integer":
      return serializeInteger(value, column);
    case "boolean":
      if (value === "t" || value === "true" || value === "1") return "1";
      if (value === "f" || value === "false" || value === "0") return "0";
      throw new CliError(`Invalid boolean value encountered in ${column.objectName}.`);
    case "real":
    case "numeric-real":
      return serializeReal(value, column);
    case "blob":
      return serializeBytea(value, column);
    case "json":
      try {
        JSON.parse(value);
      } catch (error) {
        throw new CliError(`Invalid JSON encountered in ${column.objectName}.`);
      }
      return quoteSqlString(value);
    case "numeric-text":
    case "array-text":
    case "enum":
    case "text":
    case "unknown-text":
      return quoteSqlString(value);
    default:
      throw new CliError(`Cannot serialize unsupported type for ${column.objectName}.`);
  }
}

function serializeInteger(value, column) {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new CliError(`Invalid integer value encountered in ${column.objectName}.`);
  }
  const integer = BigInt(value);
  if (integer < MIN_SQLITE_INTEGER || integer > MAX_SQLITE_INTEGER) {
    throw new CliError(
      `Integer in ${column.objectName} is outside SQLite's signed 64-bit range.`,
    );
  }
  return integer.toString();
}

function serializeReal(value, column) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new CliError(
      `Non-finite or invalid real value encountered in ${column.objectName}. D1 cannot preserve PostgreSQL NaN or infinity safely.`,
    );
  }
  return value;
}

function serializeBytea(value, column) {
  if (!/^\\x[0-9A-Fa-f]*$/.test(value)) {
    throw new CliError(`Unexpected bytea representation in ${column.objectName}. Expected PostgreSQL hex output.`);
  }
  return `X'${value.slice(2)}'`;
}

export function integerMayLoseInJavascript(value) {
  if (!/^[+-]?\d+$/.test(value)) return false;
  const integer = BigInt(value);
  return integer > MAX_SAFE_JS_INTEGER || integer < -MAX_SAFE_JS_INTEGER;
}

function normalizeFormattedType(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(\d+(?:,\d+)?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
