import { queryRetry } from "./queryRetry";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "../server/router";

export const api = createTRPCClient<AppRouter>({
  links: [queryRetry(), httpLink({ url: "/trpc" })],
});

// The checkout this tab reviews: the stable `?checkout=` parameter (a T3
// thread's worktree, set by a hyprnav browser slot). It stays in the URL, so
// jumping to the same checkout again leaves the URL unchanged and the browser
// only focuses the tab. Unset = the server's default checkout.
export function currentCheckout(): string | undefined {
  return new URLSearchParams(location.search).get("checkout") || undefined;
}
export function scope(): { checkout?: string } {
  const checkout = currentCheckout();
  return checkout ? { checkout } : {};
}
/** Set or clear the `review` parameter, keeping `checkout` and the rest. */
export function setReviewParam(id: string | undefined) {
  const params = new URLSearchParams(location.search);
  if (id) params.set("review", id);
  else params.delete("review");
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}
