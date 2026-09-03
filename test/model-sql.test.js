import assert from "node:assert/strict";
import test from "node:test";
import { createMigrationPlan, migrationPlanFingerprint, planHasErrors } from "../src/model.js";
import { renderIndexesSql, renderSchemaSql } from "../src/sql.js";
import { cleanMetadata, defaultOptions } from "./fixtures/metadata.js";

test("creates a deterministic, exportable plan", () => {
  const plan = createMigrationPlan(cleanMetadata, defaultOptions);
  assert.equal(planHasErrors(plan), false);
  assert.deepEqual(plan.groups, [["public.accounts"], ["public.items"]]);
  assert.equal(migrationPlanFingerprint(plan), migrationPlanFingerprint(createMigrationPlan(structuredClone(cleanMetadata), defaultOptions)));
});

test("renders D1-compatible table and index SQL", () => {
  const plan = createMigrationPlan(cleanMetadata, defaultOptions);
  const schema = renderSchemaSql(plan);
  const indexes = renderIndexesSql(plan);
  assert.match(schema, /CREATE TABLE "accounts"/);
  assert.match(schema, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(schema, /FOREIGN KEY \("account_id"\) REFERENCES "accounts" \("id"\) ON DELETE CASCADE/);
  assert.match(schema, /CHECK \("active" IN \(0, 1\)\)/);
  assert.match(indexes, /CREATE INDEX/);
});

test("does not retain raw PostgreSQL default expressions in the public plan", () => {
  const plan = createMigrationPlan(cleanMetadata, defaultOptions);
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes("accounts_id_seq"), false);
});

test("blocks bidirectional formatting controls in identifiers", () => {
  const metadata = structuredClone(cleanMetadata);
  metadata.tables[0].columns[1].name = "display\u202ename";
  const plan = createMigrationPlan(metadata, defaultOptions);
  assert.equal(planHasErrors(plan), true);
  assert.ok(plan.issues.some((issue) => issue.code === "UNSAFE_CHARACTER_IN_IDENTIFIER"));
});
