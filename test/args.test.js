import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";

test("parses repeated schemas and comma-separated filters", () => {
  const parsed = parseArgs(["export", "--schema", "public", "--schema=app", "--include", "public.* , app.tasks"]);
  assert.equal(parsed.command, "export");
  assert.deepEqual(parsed.options.schemas, ["public", "app"]);
  assert.deepEqual(parsed.options.include, ["public.*", "app.tasks"]);
});

test("remote is an explicit target", () => {
  const parsed = parseArgs(["apply", "--target", "remote", "--yes"]);
  assert.equal(parsed.options.target, "remote");
  assert.equal(parsed.options.yes, true);
});
