import { queryRetry } from "./queryRetry";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "../server/router";

export const api = createTRPCClient<AppRouter>({
  links: [queryRetry(), httpLink({ url: "/trpc" })],
});
