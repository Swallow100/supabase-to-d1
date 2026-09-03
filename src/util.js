import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";

export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlQualifiedName(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function sourceKey(schema, table) {
  return `${schema}.${table}`;
}

export function safeFilePart(value) {
  const normalized = String(value)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "table";
}

export function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^.]*";
      }
    } else if (character === "?") {
      pattern += "[^.]";
    } else {
      pattern += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

export function matchesAny(value, patterns) {
  return patterns.length === 0 || patterns.some((pattern) => globToRegExp(pattern).test(value));
}

export function excludedBy(value, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

export function randomMarker() {
  return randomBytes(24).toString("hex");
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function prepareEmptyDirectory(path, { force = false } = {}) {
  const absolute = resolve(path);
  assertSafeRemovalPath(absolute);
  if (await pathExists(absolute)) {
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CliError(`Output path exists and is not a regular directory: ${absolute}`);
    }
    if (!force) {
      throw new CliError(`Output directory already exists: ${absolute}. Use --force to replace it.`);
    }
    const entries = await readdir(absolute);
    if (entries.length > 0 && !(await hasOutputMarker(absolute))) {
      throw new CliError(
        `Refusing to replace a non-empty directory that was not created by supabase-to-d1: ${absolute}`,
      );
    }
    await rm(absolute, { recursive: true, force: true });
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await writeFile(join(absolute, OUTPUT_MARKER_NAME), OUTPUT_MARKER_CONTENT, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return absolute;
}

const OUTPUT_MARKER_NAME = ".d1porter-output";
const OUTPUT_MARKER_CONTENT = "supabase-to-d1 generated output directory\n";

async function hasOutputMarker(directory) {
  const marker = join(directory, OUTPUT_MARKER_NAME);
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return await readFile(marker, "utf8") === OUTPUT_MARKER_CONTENT;
  } catch {
    return false;
  }
}

function assertSafeRemovalPath(path) {
  const normalized = resolve(path);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (normalized === resolve("/") || segments.length < 2) {
    throw new CliError(`Refusing to remove unsafe path: ${normalized}`);
  }
}

export async function writeText(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf8", mode });
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`Could not read JSON file ${path}: ${error.message}`, { cause: error });
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function redactSecrets(text, secrets = []) {
  let result = String(text ?? "");
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join("[REDACTED]");
  }
  result = result
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, "postgresql://[REDACTED]")
    .replace(/(password\s*=\s*)[^\s'";]+/gi, "$1[REDACTED]")
    .replace(/(token\s*=\s*)[^\s'";]+/gi, "$1[REDACTED]");
  return result;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function stableStringify(value, space = 2) {
  return `${JSON.stringify(sortRecursively(value), null, space)}\n`;
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortRecursively(nested)]),
    );
  }
  return value;
}

export function invariant(condition, message) {
  if (!condition) throw new CliError(message);
}
