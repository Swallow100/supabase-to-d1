import assert from "node:assert/strict";
import test from "node:test";
import { mapColumnType, serializeValue } from "../src/type-mapping.js";

const base = { typeKind: "b", typeCategory: "N", typeSchema: "pg_catalog", domainBaseUdt: null, formattedType: "integer" };

test("maps bigint to SQLite INTEGER and reports the D1 JavaScript precision risk", () => {
  const mapping = mapColumnType({ ...base, udtName: "int8", formattedType: "bigint" }, { numericMode: "text", unknownTypes: "error", enumLabels: [] });
  assert.equal(mapping.sqliteType, "INTEGER");
  assert.equal(mapping.javascriptPrecisionRisk, true);
});

test("preserves NUMERIC exactly as TEXT by default", () => {
  const mapping = mapColumnType({ ...base, udtName: "numeric", formattedType: "numeric(30,10)" }, { numericMode: "text", unknownTypes: "error", enumLabels: [] });
  assert.equal(mapping.storage, "numeric-text");
  assert.equal(serializeValue("12345678901234567890.123", { mapping, objectName: "public.t.n" }), "'12345678901234567890.123'");
});

test("serialization failures do not print row values", () => {
  const column = { mapping: { storage: "json" }, objectName: "public.t.payload" };
  assert.throws(
    () => serializeValue("super-secret-invalid-json", column),
    (error) => !error.message.includes("super-secret-invalid-json") && /Invalid JSON/.test(error.message),
  );
});
