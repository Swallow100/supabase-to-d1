import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MANIFEST_VERSION } from "./constants.js";
import { CliError } from "./errors.js";
import { sha256File } from "./util.js";

export async function loadAndVerifyBundle(bundlePath) {
  const root = await resolveBundleRoot(bundlePath);
  const manifestPath = resolveInside(root, "manifest.json");
  await secureRegularFile(root, manifestPath, "manifest.json");
  const manifest = await readManifest(manifestPath);
  if (manifest.format !== "supabase-to-d1-bundle" || manifest.version !== MANIFEST_VERSION || manifest.complete !== true) {
    throw new CliError("The bundle manifest is missing, incomplete, or uses an unsupported format version.");
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.applyOrder) || !Array.isArray(manifest.tables)) {
    throw new CliError("The bundle manifest has an invalid structure.");
  }

  const fileByPath = new Map();
  for (const entry of manifest.files) {
    validateRelativePath(entry.path);
    if (fileByPath.has(entry.path)) throw new CliError(`The bundle manifest contains a duplicate file: ${entry.path}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new CliError(`The bundle manifest has an invalid hash for ${entry.path}.`);
    }
    const absolutePath = resolveInside(root, entry.path);
    const fileStat = await secureRegularFile(root, absolutePath, entry.path);
    if (Number(entry.bytes) !== fileStat.size) throw new CliError(`Bundle file size changed: ${entry.path}`);
    const actualHash = await sha256File(absolutePath);
    if (actualHash !== entry.sha256) throw new CliError(`Bundle integrity check failed for ${entry.path}.`);
    fileByPath.set(entry.path, { ...entry, absolutePath });
  }

  const seenApplyPaths = new Set();
  const applyFiles = manifest.applyOrder.map((path) => {
    validateRelativePath(path);
    if (seenApplyPaths.has(path)) throw new CliError(`Apply-order file is duplicated: ${path}`);
    seenApplyPaths.add(path);
    const entry = fileByPath.get(path);
    if (!entry) throw new CliError(`Apply-order file is not covered by the manifest: ${path}`);
    if (!path.endsWith(".sql")) throw new CliError(`Refusing to apply a non-SQL bundle file: ${path}`);
    return entry;
  });

  return { root, manifest, applyFiles };
}

export async function readManifestText(bundlePath) {
  const root = await resolveBundleRoot(bundlePath);
  const manifestPath = resolveInside(root, "manifest.json");
  await secureRegularFile(root, manifestPath, "manifest.json");
  return await readFile(manifestPath, "utf8");
}

export function resolveInside(root, candidate) {
  validateRelativePath(candidate);
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return absolute;
  throw new CliError(`Unsafe path in bundle manifest: ${candidate}`);
}

async function resolveBundleRoot(bundlePath) {
  const requested = resolve(bundlePath);
  let root;
  try {
    root = await realpath(requested);
  } catch (error) {
    throw new CliError(`Could not open bundle directory: ${requested}`, { cause: error });
  }
  const info = await lstat(root);
  if (!info.isDirectory()) throw new CliError(`Bundle path is not a directory: ${requested}`);
  return root;
}

async function secureRegularFile(root, absolutePath, displayPath) {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    throw new CliError(`Bundle file is missing: ${displayPath}`, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new CliError(`Bundle entry is not a regular file: ${displayPath}`);
  }
  const canonical = await realpath(absolutePath);
  const rel = relative(root, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CliError(`Bundle file resolves outside the bundle directory: ${displayPath}`);
  }
  return info;
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`Could not read bundle manifest: ${error.message}`, { cause: error });
  }
}

function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    throw new CliError("The bundle manifest contains an unsafe file path.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    throw new CliError(`Unsafe path in bundle manifest: ${value}`);
  }
}
