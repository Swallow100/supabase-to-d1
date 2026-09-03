import assert from "node:assert/strict";
import test from "node:test";
import { decodeCopyText, parseCopyTextRow } from "../src/copy-text.js";

test("parses COPY text nulls, empty strings, and escapes", () => {
  assert.deepEqual(
    parseCopyTextRow("\\N\t\tline\\nnext\ttab\\tvalue\tslash\\\\value", 5),
    [null, "", "line\nnext", "tab\tvalue", "slash\\value"],
  );
});

test("decodes hexadecimal and octal escapes", () => {
  assert.equal(decodeCopyText("A\\x42\\103"), "ABC");
});

test("rejects a row with the wrong width without echoing values", () => {
  assert.throws(() => parseCopyTextRow("private-value", 2), /expected 2/);
});
