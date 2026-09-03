import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { SAFE_STATEMENT_BYTES } from "./constants.js";
import { CliError } from "./errors.js";
import { loadAndVerifyBundle } from "./manifest.js";
import { quoteIdentifier, quoteSqlString, redactSecrets } from "./util.js";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SAFE_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CI", "NO_COLOR", "FORCE_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

export async function applyBundle(options, io = consoleIo()) {
  requireApplyOptions(options);
  if (options.target === "remote" && !options.yes) {
    throw new CliError("Remote D1 writes require --target remote --yes.");
  }
  const bundle = await loadAndVerifyBundle(options.bundle);

  if (options.dryRun) {
    for (const file of bundle.applyFiles) io.log(formatCommand(options, [`--file=${file.absolutePath}`, "--yes"]));
    if (!options.skipVerify) io.log(formatCommand(options, ["--command=<verification-query>", "--json"]));
    return { appliedFiles: 0, dryRun: true, verified: false };
  }

  await checkWrangler(options.wrangler, options, io);
  await ensureTargetTablesAbsent(bundle, options);
  let appliedFiles = 0;
  for (const file of bundle.applyFiles) {
    io.log(`Applying ${file.path}...`);
    await runWrangler(options, [`--file=${file.absolutePath}`, "--yes"], { capture: false });
    appliedFiles += 1;
  }

  const verification = options.skipVerify ? null : await verifyLoadedBundle(bundle, options);
  return { appliedFiles, dryRun: false, verified: Boolean(verification), verification };
}

export async function verifyBundleOnD1(options) {
  requireApplyOptions(options);
  const bundle = await loadAndVerifyBundle(options.bundle);
  if (options.dryRun) return { dryRun: true, tables: [], foreignKeyViolations: [] };
  await checkWrangler(options.wrangler, options, consoleIo());
  return await verifyLoadedBundle(bundle, options);
}

async function ensureTargetTablesAbsent(bundle, options) {
  const names = bundle.manifest.tables.map((table) => table.target);
  for (const query of buildExistingTableQueries(names)) {
    const output = await runWrangler(options, [`--command=${query}`, "--json"], { capture: true });
    const rows = extractRows(parseWranglerJson(output.stdout));
    if (rows.length > 0) {
      throw new CliError(
        "One or more destination tables already exist. Use a fresh D1 database or remove the conflicting tables deliberately before applying.",
      );
    }
  }
}

async function verifyLoadedBundle(bundle, options) {
  const actualCounts = new Map();
  for (const query of buildCountQueries(bundle.manifest.tables)) {
    const output = await runWrangler(options, [`--command=${query}`, "--json"], { capture: true });
    for (const row of extractRows(parseWranglerJson(output.stdout))) {
      if (typeof row.table_name === "string") actualCounts.set(row.table_name, Number(row.row_count));
    }
  }

  const tables = bundle.manifest.tables.map((table) => {
    const actual = actualCounts.get(table.target);
    return { table: table.target, expected: Number(table.rows), actual, ok: actual === Number(table.rows) };
  });

  const fkOutput = await runWrangler(options, ["--command=PRAGMA foreign_key_check;", "--json"], { capture: true });
  const foreignKeyViolations = extractRows(parseWranglerJson(fkOutput.stdout));
  const missingCounts = tables.filter((table) => !table.ok);
  if (missingCounts.length > 0 || foreignKeyViolations.length > 0) {
    throw new CliError(
      `D1 verification failed: ${missingCounts.length} row-count mismatch(es), ${foreignKeyViolations.length} foreign-key violation(s).`,
      { exitCode: 3 },
    );
  }
  return { dryRun: false, tables, foreignKeyViolations };
}

function buildExistingTableQueries(names) {
  const queries = [];
  let values = [];
  for (const name of names) {
    const candidate = [...values, quoteSqlString(name)];
    const sql = `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${candidate.join(", ")});`;
    if (Buffer.byteLength(sql, "utf8") > SAFE_STATEMENT_BYTES && values.length > 0) {
      queries.push(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${values.join(", ")});`);
      values = [quoteSqlString(name)];
    } else {
      values = candidate;
    }
  }
  if (values.length > 0) queries.push(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${values.join(", ")});`);
  return queries;
}

function buildCountQueries(tables) {
  const queries = [];
  let selects = [];
  for (const table of tables) {
    const select = `SELECT ${quoteSqlString(table.target)} AS table_name, COUNT(*) AS row_count FROM ${quoteIdentifier(table.target)}`;
    const candidate = [...selects, select].join(" UNION ALL ") + ";";
    if (Buffer.byteLength(candidate, "utf8") > SAFE_STATEMENT_BYTES && selects.length > 0) {
      queries.push(`${selects.join(" UNION ALL ")};`);
      selects = [select];
    } else {
      selects.push(select);
    }
  }
  if (selects.length > 0) queries.push(`${selects.join(" UNION ALL ")};`);
  return queries;
}

async function checkWrangler(command, options, io) {
  const result = await runRaw(command, ["--version"], {
    cwd: options.cwd ? resolve(options.cwd) : process.cwd(),
    env: wranglerEnvironment(),
    capture: true,
  });
  if (result.code !== 0) throw new CliError(`Could not run Wrangler: ${result.stderr.trim() || `exit ${result.code}`}`);
  if (result.stdout.trim()) io.debug?.(result.stdout.trim());
}

async function runWrangler(options, operationArgs, { capture }) {
  const args = ["d1", "execute", options.database, ...operationArgs, targetFlag(options.target)];
  if (options.config) args.push(`--config=${resolve(options.config)}`);
  if (options.cwd) args.push(`--cwd=${resolve(options.cwd)}`);
  const result = await runRaw(options.wrangler, args, {
    cwd: options.cwd ? resolve(options.cwd) : process.cwd(),
    env: wranglerEnvironment(),
    capture,
  });
  if (result.code !== 0) {
    throw new CliError(`Wrangler failed while accessing D1:\n${redactSecrets(result.stderr.trim()) || `exit ${result.code}`}`);
  }
  return result;
}

function runRaw(command, args, { cwd, env, capture }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES && !settled) {
          settled = true;
          child.kill("SIGTERM");
          reject(new CliError("Wrangler output exceeded the safety limit."));
        }
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new CliError(`Could not start ${command}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function parseWranglerJson(output) {
  const clean = String(output).replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "").trim();
  const starts = [];
  for (let index = 0; index < clean.length; index += 1) {
    if (clean[index] !== "[" && clean[index] !== "{") continue;
    const lineStart = clean.lastIndexOf("\n", index - 1) + 1;
    if (clean.slice(lineStart, index).trim() === "") starts.push(index);
  }
  for (const start of starts) {
    const candidate = balancedJsonValue(clean, start);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // A warning line can begin with '['; continue to the next line-level value.
    }
  }
  throw new CliError("Wrangler did not return parseable JSON.");
}

function balancedJsonValue(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") stack.push(character);
    else if (character === "]" || character === "}") {
      const opener = stack.pop();
      if ((opener === "[" && character !== "]") || (opener === "{" && character !== "}")) return null;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function extractRows(value) {
  if (Array.isArray(value)) return value.flatMap(extractRows);
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.result)) return value.result.flatMap(extractRows);
  return [];
}

function requireApplyOptions(options) {
  if (!options.bundle) throw new CliError("--bundle is required.");
  if (!options.database) throw new CliError("--database is required.");
  if (String(options.database).startsWith("-")) throw new CliError("--database may not start with a hyphen.");
  if (!["local", "preview", "remote"].includes(options.target)) {
    throw new CliError("--target must be local, preview, or remote.");
  }
}

function targetFlag(target) {
  return ({ local: "--local", preview: "--preview", remote: "--remote" })[target];
}

function wranglerEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      SAFE_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("CLOUDFLARE_") ||
      key.startsWith("CF_") || key.startsWith("WRANGLER_")
    ) env[key] = value;
  }
  return env;
}

function formatCommand(options, operationArgs) {
  const args = [options.wrangler, "d1", "execute", options.database, ...operationArgs, targetFlag(options.target)];
  if (options.config) args.push(`--config=${resolve(options.config)}`);
  if (options.cwd) args.push(`--cwd=${resolve(options.cwd)}`);
  return args.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=<>-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

function consoleIo() {
  return { log: (message) => process.stdout.write(`${message}\n`), debug: () => {} };
}
