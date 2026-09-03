import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set([".git", "node_modules", "coverage"]);
const files = await walk(root);
let failures = 0;

for (const file of files) {
  const extension = extname(file);
  if (extension === ".js" || extension === ".mjs") {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      failures += 1;
      process.stderr.write(result.stderr);
    }
  } else if (extension === ".json") {
    try {
      JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      failures += 1;
      process.stderr.write(`${relative(root, file)}: invalid JSON: ${error.message}\n`);
    }
  }
}

if (failures > 0) process.exitCode = 1;
else process.stdout.write(`checked ${files.length} source files\n`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(child));
    else output.push(child);
  }
  return output;
}
