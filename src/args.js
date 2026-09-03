import {
  DEFAULT_MAX_FILE_MB,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_SCHEMA,
  DEFAULT_URL_ENV,
} from "./constants.js";
import { CliError } from "./errors.js";

const VALUE_FLAGS = new Set([
  "url-env",
  "schema",
  "include",
  "exclude",
  "namespace",
  "numeric",
  "external-fks",
  "unknown-types",
  "psql",
  "out",
  "max-file-mb",
  "bundle",
  "database",
  "target",
  "wrangler",
  "config",
  "cwd",
]);

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "strict",
  "json",
  "force",
  "yes",
  "dry-run",
  "skip-verify",
]);

const SHORT_FLAGS = new Map([
  ["h", "help"],
  ["v", "version"],
]);

function appendOption(options, key, value) {
  if (key === "schema") {
    options.schemas.push(value);
    return;
  }
  if (key === "include" || key === "exclude") {
    const values = value.split(",").map((item) => item.trim()).filter(Boolean);
    options[key].push(...values);
    return;
  }
  options[toCamelCase(key)] = value;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

export function parseArgs(argv) {
  const options = {
    schemas: [],
    include: [],
    exclude: [],
    urlEnv: DEFAULT_URL_ENV,
    namespace: "auto",
    numeric: "text",
    externalFks: "drop",
    unknownTypes: "error",
    psql: "psql",
    out: DEFAULT_OUTPUT_DIR,
    maxFileMb: DEFAULT_MAX_FILE_MB,
    target: "local",
    wrangler: "wrangler",
    strict: false,
    json: false,
    force: false,
    yes: false,
    dryRun: false,
    skipVerify: false,
    help: false,
    version: false,
  };

  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("-")) {
      if (command) {
        throw new CliError(`Unexpected positional argument: ${token}`);
      }
      command = token;
      continue;
    }

    if (token.startsWith("--")) {
      const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
      if (!VALUE_FLAGS.has(rawName) && !BOOLEAN_FLAGS.has(rawName)) {
        throw new CliError(`Unknown option: --${rawName}`);
      }
      if (BOOLEAN_FLAGS.has(rawName)) {
        if (inlineValue !== undefined) {
          throw new CliError(`Option --${rawName} does not accept a value.`);
        }
        options[toCamelCase(rawName)] = true;
        continue;
      }
      const value = inlineValue !== undefined ? inlineValue : argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`Option --${rawName} requires a value.`);
      }
      appendOption(options, rawName, value);
      continue;
    }

    if (token.length === 2 && SHORT_FLAGS.has(token[1])) {
      options[SHORT_FLAGS.get(token[1])] = true;
      continue;
    }

    throw new CliError(`Unknown option: ${token}`);
  }

  if (options.schemas.length === 0) {
    options.schemas.push(DEFAULT_SCHEMA);
  }

  options.schemas = uniqueNonEmpty(options.schemas, "schema");
  options.include = uniqueNonEmpty(options.include);
  options.exclude = uniqueNonEmpty(options.exclude);
  options.maxFileMb = parseNumber(options.maxFileMb, "--max-file-mb", 1, 5000);

  assertOneOf(options.namespace, ["auto", "prefix", "flat"], "--namespace");
  assertOneOf(options.numeric, ["text", "real"], "--numeric");
  assertOneOf(options.externalFks, ["drop", "error"], "--external-fks");
  assertOneOf(options.unknownTypes, ["error", "text"], "--unknown-types");
  assertOneOf(options.target, ["local", "preview", "remote"], "--target");

  const allowedCommands = new Set(["plan", "export", "apply", "verify"]);
  if (command && !allowedCommands.has(command)) {
    throw new CliError(`Unknown command: ${command}`);
  }

  return { command, options };
}

function uniqueNonEmpty(values, label = "value") {
  const cleaned = values.map((value) => String(value).trim());
  if (cleaned.some((value) => value.length === 0)) {
    throw new CliError(`Empty ${label} is not allowed.`);
  }
  return [...new Set(cleaned)];
}

function parseNumber(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new CliError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new CliError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
}
