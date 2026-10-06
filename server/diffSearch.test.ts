import test from "node:test";
import assert from "node:assert/strict";
import { searchDiffs } from "../src/diffSearch";
import { parseFiles } from "../shared/diff";

test("search uses source coordinates on both sides and treats patterns literally", () => {
  const files = parseFiles("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +20,2 @@\n-old .*\n+new .* .*\n context\n");
  assert.deepEqual(searchDiffs(files, ".*"), [
    { id: "a.ts", side: "deletions", line: 10, column: 4 },
    { id: "a.ts", side: "additions", line: 20, column: 4 },
    { id: "a.ts", side: "additions", line: 20, column: 7 },
  ]);
  assert.deepEqual(searchDiffs(files, ""), []);
  assert.deepEqual(searchDiffs(files, "absent"), []);
});
