import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// A minimal T3 Code client: list the threads working in a checkout and send
// one of them a message. It speaks T3's websocket RPC (protocol 2) with a
// session token from `t3 auth session issue` in T3CODE_TOKEN (see README).

export type ShellThread = {
  id: string;
  projectId: string;
  title: string;
  worktreePath: string | null;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt?: string | null;
  latestUserMessageAt?: string | null;
  latestRunRequestedAt?: string | null;
  latestRunStartedAt?: string | null;
  latestRunCompletedAt?: string | null;
  /** Set while a run is going. */
  activeRunId?: string | null;
};
export type Shell = { threads: ShellThread[]; projects: Array<{ id: string; workspaceRoot: string }> };
export type AgentThread = { id: string; title: string; updatedAt: string };

/**
 * Threads working in one of `directories` (a thread without a worktree works
 * in its project's root), most recently active first.
 */
export function matchThreads(shell: Shell, directories: string[]): AgentThread[] {
  const trim = (path: string) => path.replace(/\/+$/, "");
  const wanted = new Set(directories.map(trim));
  const roots = new Map(shell.projects.map((project) => [project.id, project.workspaceRoot]));
  return shell.threads
    .filter((thread) => !thread.archivedAt && !thread.deletedAt)
    .filter((thread) => {
      const directory = thread.worktreePath ?? roots.get(thread.projectId);
      return directory !== undefined && wanted.has(trim(directory));
    })
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      // The last message or run, as T3's own sidebar orders threads;
      // updatedAt also moves on renames and pins.
      updatedAt: [thread.latestUserMessageAt, thread.latestRunRequestedAt, thread.latestRunStartedAt, thread.latestRunCompletedAt]
        .filter((time): time is string => Boolean(time))
        .sort()
        .at(-1) ?? thread.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function serverUrl() {
  if (process.env.T3CODE_URL) return process.env.T3CODE_URL.replace(/\/+$/, "");
  try {
    return JSON.parse(await readFile(join(homedir(), ".t3/userdata/server-runtime.json"), "utf8")).origin as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "http://127.0.0.1:3773";
  }
}

/** One RPC over a fresh socket: a unary call's result, or a stream's first value. */
async function call<T>(tag: string, payload: unknown): Promise<T> {
  const token = process.env.T3CODE_TOKEN;
  if (!token) throw new Error("Set T3CODE_TOKEN to reach T3 Code (see README).");
  const base = await serverUrl();
  let response: Response;
  try {
    response = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new Error(`Cannot reach T3 Code at ${base}.`);
  }
  if (!response.ok) throw new Error(`T3 Code refused T3CODE_TOKEN (HTTP ${response.status}).`);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2`);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("T3 Code did not answer in time.")), 20_000);
    function finish(error: Error | null, value?: T) {
      clearTimeout(timer);
      socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      if (error) reject(error);
      else resolve(value as T);
    }
    socket.onerror = () => finish(new Error(`Cannot reach T3 Code at ${base}.`));
    socket.onclose = () => finish(new Error("T3 Code closed the connection."));
    socket.onopen = () => socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
    socket.onmessage = (event) => {
      const data = JSON.parse(String(event.data));
      for (const message of Array.isArray(data) ? data : [data]) {
        if (message.requestId !== "1") continue;
        if (message._tag === "Chunk") finish(null, message.values[0]);
        else if (message._tag === "Exit")
          message.exit._tag === "Success"
            ? finish(null, message.exit.value)
            : finish(new Error(`T3 Code: ${failure(message.exit.cause)}`));
      }
    };
  });
}

function failure(cause: unknown): string {
  const text = JSON.stringify(cause);
  return /"message":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text.slice(0, 500);
}

export async function readShell(): Promise<Shell> {
  const value = await call<{ kind: string; snapshot: Shell }>("orchestration.subscribeShell", {});
  if (value?.kind !== "snapshot") throw new Error("T3 Code sent no thread list.");
  return value.snapshot;
}

export async function listThreads(directory: string): Promise<AgentThread[]> {
  return matchThreads(await readShell(), [directory, await realpath(directory)]);
}

/**
 * Where a thread is with a message sent to it at `since`: not picked up yet,
 * running (a busy thread was steered, or queued it), or done. A thread that
 * no longer exists counts as done: nothing will answer.
 */
export function runState(thread: ShellThread | undefined, since: string): "requested" | "working" | "finished" {
  if (thread?.activeRunId) return "working";
  if (!thread || Date.parse(thread.latestRunCompletedAt ?? "") > Date.parse(since)) return "finished";
  return "requested";
}

/** Sends `text` as a user message: an idle thread starts a turn, a busy one is steered or queues it. */
export async function sendToThread(threadId: string, text: string) {
  await call("orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: randomUUID(),
    threadId,
    messageId: randomUUID(),
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  });
}
