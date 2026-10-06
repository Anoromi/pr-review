import test from "node:test";
import assert from "node:assert/strict";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "./router";
import { queryRetry } from "../src/queryRetry";

process.env.GITHUB_REPO = "acme/widgets";

test("read requests recover from a proxy restart without retrying writes", async () => {
  let requests = 0;
  const client = createTRPCClient<AppRouter>({ links: [queryRetry(), httpLink({ url: "http://localhost/trpc", fetch: async () => {
    requests++;
    return requests === 1 ? new Response("", { status: 500 }) : Response.json({ result: { data: ["feature"] } });
  } })] });
  assert.deepEqual(await client.branches.query(), ["feature"]);
  assert.equal(requests, 2);
  requests = 0;
  await assert.rejects(client.open.mutate({ url: "https://github.com/acme/widgets/pull/1" }));
  assert.equal(requests, 1);
});
