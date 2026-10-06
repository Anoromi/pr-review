import { retryLink } from "@trpc/client";
import type { AppRouter } from "../server/router";

export const queryRetry = () => retryLink<AppRouter>({
  retry: ({ op, error, attempts }) => {
    if (op.type !== "query" || op.signal?.aborted || attempts >= 5) return false;
    const status = error.data?.httpStatus ?? (error.meta?.response as Response | undefined)?.status;
    return status === undefined || status >= 500;
  },
  retryDelayMs: (attempt) => Math.min(250 * 2 ** (attempt - 1), 2000),
});
