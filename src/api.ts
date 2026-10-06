import { queryRetry } from "./queryRetry";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "../server/router";

export const api = createTRPCClient<AppRouter>({
  links: [queryRetry(), httpLink({ url: "/trpc" })],
});

// The checkout this tab reviews, set from `?checkout=` (a T3 thread's
// worktree via hyprnav) and kept for the tab's session. Unset = the server's
// default checkout.
const CHECKOUT_KEY = "pr-review:checkout";
export function setCheckout(path: string | undefined) {
  try {
    if (path) sessionStorage.setItem(CHECKOUT_KEY, path);
    else sessionStorage.removeItem(CHECKOUT_KEY);
  } catch {}
}
export function scope(): { checkout?: string } {
  try {
    const checkout = sessionStorage.getItem(CHECKOUT_KEY);
    return checkout ? { checkout } : {};
  } catch {
    return {};
  }
}
