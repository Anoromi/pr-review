import test from "node:test";
import assert from "node:assert/strict";
import { localPullMetadata } from "./github";

process.env.GITHUB_REPO = "acme/widgets";

test("looks up PRs directly when they are not in the personal list", async () => {
  const pull = { number: 5138, title: "Another author's PR" };
  const result = await localPullMetadata("https://github.com/acme/widgets/pull/5138", async (args) => {
    assert.deepEqual(args.slice(0, 5), ["pr", "view", "5138", "--repo", "acme/widgets"]);
    assert.ok(!args.includes("--author"));
    return JSON.stringify(pull);
  });
  assert.deepEqual(result, pull);
});
