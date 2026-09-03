import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAndVerifyBundle } from "../src/manifest.js";
import { sha256File } from "../src/util.js";
import { applyBundle, extractRows, parseWranglerJson } from "../src/wrangler.js";

test("parses Wrangler JSON after warning text without selecting nested objects", () => {
  const output = `wrangler 4\n[WARNING] a harmless warning\n[\n  {\n    "results": [{"table_name":"accounts","row_count":2}],\n    "success": true\n  }\n]\ncompleted`;
  const parsed = parseWranglerJson(output);
  assert.equal(Array.isArray(parsed), true);
  assert.deepEqual(extractRows(parsed), [{ table_name: "accounts", row_count: 2 }]);
});

test("rejects bundle files reached through a symbolic link", async (t) => {
  if (process.platform === "win32") return t.skip("symbolic-link permissions vary on Windows");
  const temp = await mkdtemp(join(tmpdir(), "d1porter-link-test-"));
  const bundle = join(temp, "bundle");
  const outside = join(temp, "outside.sql");
  const linked = join(bundle, "schema.sql");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bundle));
    await writeFile(outside, "SELECT 1;\n", "utf8");
    await symlink(outside, linked);
    const size = Buffer.byteLength("SELECT 1;\n");
    const hash = await sha256File(outside);
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({
      format: "supabase-to-d1-bundle",
      version: 1,
      complete: true,
      files: [{ path: "schema.sql", bytes: size, sha256: hash }],
      applyOrder: ["schema.sql"],
      tables: [],
    }), "utf8");
    await assert.rejects(loadAndVerifyBundle(bundle), /not a regular file/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("--force refuses to delete an unrelated non-empty directory", async () => {
  const { prepareEmptyDirectory } = await import("../src/util.js");
  const temp = await mkdtemp(join(tmpdir(), "d1porter-force-test-"));
  const unrelated = join(temp, "unrelated");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(unrelated));
    await writeFile(join(unrelated, "keep.txt"), "keep", "utf8");
    await assert.rejects(
      prepareEmptyDirectory(unrelated, { force: true }),
      /was not created by supabase-to-d1/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("--force can replace a directory previously created by the exporter", async () => {
  const { prepareEmptyDirectory } = await import("../src/util.js");
  const temp = await mkdtemp(join(tmpdir(), "d1porter-force-test-"));
  const output = join(temp, "bundle");
  try {
    await prepareEmptyDirectory(output);
    await writeFile(join(output, "old-data.txt"), "synthetic", "utf8");
    await prepareEmptyDirectory(output, { force: true });
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(output, "old-data.txt"))));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("remote apply requires an explicit confirmation before reading the bundle", async () => {
  await assert.rejects(
    applyBundle({ bundle: "/does-not-exist", database: "sample", target: "remote", yes: false }),
    /--target remote --yes/,
  );
});

test("apply dry-run validates a bundle without requiring Wrangler to be installed", async () => {
  const temp = await mkdtemp(join(tmpdir(), "d1porter-dry-run-test-"));
  const bundle = join(temp, "bundle");
  const schema = "SELECT 1;\n";
  const logs = [];
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bundle));
    await writeFile(join(bundle, "schema.sql"), schema, "utf8");
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({
      format: "supabase-to-d1-bundle",
      version: 1,
      complete: true,
      files: [{
        path: "schema.sql",
        bytes: Buffer.byteLength(schema),
        sha256: await sha256File(join(bundle, "schema.sql")),
      }],
      applyOrder: ["schema.sql"],
      tables: [],
    }), "utf8");

    const result = await applyBundle({
      bundle,
      database: "sample-db",
      target: "local",
      yes: false,
      dryRun: true,
      skipVerify: false,
      wrangler: "wrangler-that-does-not-exist",
      cwd: temp,
    }, { log: (line) => logs.push(line), debug: () => {} });

    assert.equal(result.dryRun, true);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /d1 execute sample-db/);
    assert.match(logs[1], /verification-query/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
