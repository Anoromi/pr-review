import test from "node:test";
import assert from "node:assert/strict";
import { selectedCharacters, wordColumn } from "../src/vimText";

test("word motions distinguish identifiers, punctuation, and WORDs", () => {
  const text = "foo.bar  baz_qux";
  assert.equal(wordColumn(text, 0, 1, false), 3);
  assert.equal(wordColumn(text, 3, 1, false), 4);
  assert.equal(wordColumn(text, 0, 1, true), 9);
  assert.equal(wordColumn(text, 9, -1, false), 4);
  assert.equal(wordColumn(text, 9, -1, true), 0);
  assert.equal(wordColumn(text, 12, -1, false), 9);
  assert.equal(wordColumn(text, 0, -1, false), null);
  assert.equal(wordColumn(text, 9, 1, true), null);
  assert.equal(wordColumn("  foo", 0, 1, false), 2);
  assert.equal(wordColumn("", 0, 1, false), null);
});

test("character yank includes only the inclusive selected range in either direction", () => {
  assert.equal(selectedCharacters("hello world", { line: 2, column: 1 }, { line: 2, column: 3 }), "ell");
  assert.equal(selectedCharacters("hello world", { line: 2, column: 3 }, { line: 2, column: 1 }), "ell");
  assert.equal(selectedCharacters("hello\n  world\nlast", { line: 2, column: 2 }, { line: 4, column: 1 }), "llo\n  world\nla");
  assert.equal(selectedCharacters("hello\n  world\nlast", { line: 4, column: 1 }, { line: 2, column: 2 }), "llo\n  world\nla");
  assert.equal(selectedCharacters("", { line: 2, column: 0 }, { line: 2, column: 0 }), "");
});
