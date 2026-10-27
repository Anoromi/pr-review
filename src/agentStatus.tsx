import { useTranslations } from "use-intl";
import type { api } from "./api";
import { Keys } from "./components/ui/key-hint";

export type Progress = Awaited<ReturnType<typeof api.progress.query>>;
export type Tone = "warn" | "new" | "ok" | "idle";

/** "1:42" since `iso`. */
export function elapsed(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Reply ids the reader has seen on review `url` (kept in localStorage by the review's panel); null before the first visit. */
export function seenReplies(url: string): Set<string> | null {
  try {
    const saved = localStorage.getItem(`pr-review:read:${url}`);
    return saved ? new Set(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

/**
 * The agent's state in a few words, never truncated: what the agent pill and
 * Home's rows show. Parts in order of urgency; the tone is the first part's.
 */
export function agentStatus(progress: Omit<Progress, "head"> | null | undefined, newReplies: number, now: number, mapReadySeen = true) {
  const parts: Array<{ tone: Tone; key: string; values?: Record<string, string | number> }> = [];
  if (progress?.error) parts.push({ tone: "warn", key: "unreachable" });
  const map = progress?.map;
  if (map && (map.state === "requested" || map.state === "working")) parts.push({ tone: "warn", key: "writingMap", values: { time: elapsed(map.requestedAt, now) } });
  if (map?.state === "finished") parts.push({ tone: "warn", key: "mapMissing" });
  const states = Object.values(progress?.replies ?? {});
  const answering = states.filter((state) => state === "working").length;
  const waiting = states.filter((state) => state === "requested").length;
  if (answering) parts.push({ tone: "warn", key: "answering", values: { count: answering } });
  if (waiting && !progress?.error) parts.push({ tone: "warn", key: "waiting", values: { count: waiting } });
  if (newReplies) parts.push({ tone: "new", key: "newReplies", values: { count: newReplies } });
  if (map?.state === "ready" && !mapReadySeen) parts.push({ tone: "ok", key: "mapReady" });
  return { tone: parts[0]?.tone ?? "idle", parts };
}

export function Dot({ tone, className = "" }: { tone: Tone; className?: string }) {
  return <span className={`dot ${className}`} data-tone={tone} aria-hidden="true" />;
}

/** The agent pill: a dot and the status in one line; `fallback` names the quiet state (idle, no thread). */
export function AgentPill({ status, fallback, hint, onClick }: {
  status: ReturnType<typeof agentStatus>;
  fallback: string;
  hint?: string;
  onClick?: () => void;
}) {
  const t = useTranslations("app.agent");
  const text = status.parts.length ? status.parts.map((part) => t(part.key, part.values)).join(" · ") : fallback;
  return (
    <button className="pill" data-tone={status.tone} onClick={onClick} role="status" aria-live="polite">
      <Dot tone={status.tone} />{text}{hint && <Keys value={hint} />}
    </button>
  );
}
