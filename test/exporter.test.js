import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportBundle } from "../src/exporter.js";
import { loadAndVerifyBundle } from "../src/manifest.js";
import { createMigrationPlan } from "../src/model.js";
import { cleanMetadata, defaultOptions } from "./fixtures/metadata.js";

test("exports a complete bundle from a locked synthetic stream", async () => {
  const temp = await mkdtemp(join(tmpdir(), "d1porter-test-"));
  const output = join(temp, "bundle");
  const plan = createMigrationPlan(cleanMetadata, defaultOptions);
  const fakeStream = async ({ script, onLine }) => {
    const marker = script.match(/__D1PORTER_[A-F0-9]+/)?.[0];
    assert.ok(marker);
    await onLine(`${marker}_META_BEGIN`);
    await onLine(JSON.stringify(cleanMetadata));
    await onLine(`${marker}_META_END`);
    await onLine(`${marker}_TABLE_BEGIN_0`);
    await onLine("1\tAlice");
    await onLine("2\tBob\\nBuilder");
    await onLine(`${marker}_TABLE_END_0`);
    await onLine(`${marker}_TABLE_BEGIN_1`);
    await onLine('10\t1\t{"kind":"sample"}\tt');
    await onLine(`${marker}_TABLE_END_1`);
  };

  try {
    const result = await exportBundle({
      plan,
      options: { ...defaultOptions, out: output, force: false, maxFileMb: 10 },
      psqlPath: "unused",
      pgEnvironment: { env: {}, secrets: [] },
      stream: fakeStream,
    });
    assert.equal(result.manifest.tables.find((table) => table.target === "accounts").rows, 2);
    assert.equal(result.manifest.tables.find((table) => table.target === "items").rows, 1);
    const verified = await loadAndVerifyBundle(output);
    assert.equal(verified.applyFiles.length, 4);
    const data = await readFile(join(output, result.manifest.applyOrder[1]), "utf8");
    assert.match(data, /Bob\nBuilder/);
    assert.doesNotMatch(await readFile(join(output, "manifest.json"), "utf8"), /postgresql:\/\//);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
