import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { FALLBACK_URL_ENV } from "./constants.js";
import { CliError } from "./errors.js";
import { redactSecrets } from "./util.js";

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024 * 1024;
const SAFE_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const LIBPQ_ENV_KEYS = new Set([
  "PGHOST", "PGSSLNEGOTIATION", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER",
  "PGPASSWORD", "PGPASSFILE", "PGREQUIREAUTH", "PGCHANNELBINDING", "PGSERVICE",
  "PGSERVICEFILE", "PGOPTIONS", "PGAPPNAME", "PGSSLMODE", "PGREQUIRESSL",
  "PGSSLCOMPRESSION", "PGSSLCERT", "PGSSLKEY", "PGSSLCERTMODE", "PGSSLROOTCERT",
  "PGSSLCRL", "PGSSLCRLDIR", "PGSSLSNI", "PGREQUIREPEER",
  "PGSSLMINPROTOCOLVERSION", "PGSSLMAXPROTOCOLVERSION", "PGGSSENCMODE",
  "PGKRBSRVNAME", "PGGSSLIB", "PGGSSDELEGATION", "PGCONNECT_TIMEOUT",
  "PGCLIENTENCODING", "PGTARGETSESSIONATTRS", "PGLOADBALANCEHOSTS",
  "PGMINPROTOCOLVERSION", "PGMAXPROTOCOLVERSION", "PGDATESTYLE", "PGTZ",
  "PGGEQO", "PGSYSCONFDIR", "PGLOCALEDIR",
]);

export function resolvePgEnvironment(urlEnvName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnvName)) {
    throw new CliError(`Invalid environment variable name: ${urlEnvName}`);
  }

  const preferred = process.env[urlEnvName];
  const fallback = urlEnvName === FALLBACK_URL_ENV ? undefined : process.env[FALLBACK_URL_ENV];
  const connection = preferred || fallback;
  if (!connection && !process.env.PGDATABASE && !process.env.PGHOST) {
    throw new CliError(
      `No PostgreSQL connection was found. Set ${urlEnvName}, ${FALLBACK_URL_ENV}, or standard libpq PG* variables.`,
    );
  }

  const env = safeProcessEnvironment();
  const secrets = [];
  if (connection) {
    env.PGDATABASE = connection;
    secrets.push(connection);
  }
  if (env.PGPASSWORD) secrets.push(env.PGPASSWORD);

  env.PGAPPNAME = "d1porter";
  env.PGCLIENTENCODING = "UTF8";
  env.PGCONNECT_TIMEOUT ||= "15";
  const enforcedOptions = [
    "-c default_transaction_read_only=on",
    "-c timezone=UTC",
    "-c bytea_output=hex",
    "-c extra_float_digits=3",
  ].join(" ");
  env.PGOPTIONS = [env.PGOPTIONS, enforcedOptions].filter(Boolean).join(" ");
  return { env, secrets };
}

export async function checkPsql(psqlPath) {
  const result = await runProcess(psqlPath, ["--version"], {
    env: safeProcessEnvironment({ includePg: false }),
    captureLimit: 1024 * 1024,
  });
  if (result.code !== 0) {
    throw new CliError(`Could not run psql at ${psqlPath}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

export async function runPsqlJson({ psqlPath, sql, pgEnvironment }) {
  const result = await runProcess(
    psqlPath,
    ["-X", "-w", "-q", "-t", "-A", "--set", "ON_ERROR_STOP=1", "--command", sql],
    { env: pgEnvironment.env, captureLimit: MAX_CAPTURE_BYTES },
  );
  if (result.code !== 0) {
    throw new CliError(
      `PostgreSQL metadata query failed:\n${redactSecrets(result.stderr.trim(), pgEnvironment.secrets) || "psql exited unsuccessfully."}`,
    );
  }

  const output = result.stdout.trim();
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new CliError("PostgreSQL metadata query did not return JSON.");
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    throw new CliError("Could not parse PostgreSQL metadata JSON.", { cause: error });
  }
}

export async function streamPsqlScript({ psqlPath, script, pgEnvironment, onLine }) {
  const child = spawn(psqlPath, ["-X", "-w", "-q", "--set", "ON_ERROR_STOP=1"], {
    env: pgEnvironment.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderr, "utf8") < MAX_ERROR_BYTES) stderr += chunk;
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new CliError(`Could not start psql: ${error.message}`, { cause: error })));
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });

  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const readPromise = (async () => {
    try {
      for await (const line of lineReader) await onLine(line);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  })();

  child.stdin.on("error", () => {
    // The exit code and stderr carry the useful failure.
  });
  child.stdin.end(script, "utf8");

  const [exit] = await Promise.all([exitPromise, readPromise]);
  if (exit.code !== 0) {
    throw new CliError(
      `PostgreSQL export failed${exit.signal ? ` (${exit.signal})` : ""}:\n${redactSecrets(stderr.trim(), pgEnvironment.secrets) || "psql exited unsuccessfully."}`,
    );
  }
}

function safeProcessEnvironment({ includePg = true } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_KEYS.has(key) || key.startsWith("LC_") || (includePg && LIBPQ_ENV_KEYS.has(key))) env[key] = value;
  }
  return env;
}

async function runProcess(command, args, { env, captureLimit }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > captureLimit) {
        settled = true;
        child.kill("SIGTERM");
        reject(new CliError(`Output from ${command} exceeded the safety limit.`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_ERROR_BYTES) stderr = stderr.slice(-MAX_ERROR_BYTES);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new CliError(`Could not start ${command}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
