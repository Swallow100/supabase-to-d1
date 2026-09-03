import assert from "node:assert/strict";
import test from "node:test";
import { dependencyGroups } from "../src/graph.js";

test("orders referenced tables before dependents", () => {
  const tables = [
    { sourceKey: "public.child", foreignKeys: [{ referencedSourceKey: "public.parent" }] },
    { sourceKey: "public.parent", foreignKeys: [] },
  ];
  assert.deepEqual(dependencyGroups(tables), [["public.parent"], ["public.child"]]);
});

test("keeps a foreign-key cycle in one component", () => {
  const tables = [
    { sourceKey: "public.a", foreignKeys: [{ referencedSourceKey: "public.b" }] },
    { sourceKey: "public.b", foreignKeys: [{ referencedSourceKey: "public.a" }] },
  ];
  assert.deepEqual(dependencyGroups(tables), [["public.a", "public.b"]]);
});
