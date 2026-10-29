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
  /** `run:thread:<id>:ordinal:<n>`. */
  latestRunId?: string | null;
  lineage?: { relationshipToParent: "fork" | "subagent" | null };
  creationSource?: string;
};
export type Shell = { threads: ShellThread[]; projects: Array<{ id: string; workspaceRoot: string }> };
export type AgentThread = { id: string; title: string; updatedAt: string; latestTurn: number };

/**
 * A subagent its provider runs (e.g. Claude's Agent tool): it shares the
 * parent's checkout but cannot take messages. T3's delegate_task children can.
 */
export const providerSubagent = (thread: ShellThread) =>
  thread.lineage?.relationshipToParent === "subagent" && thread.creationSource === "provider";

/** The thread's latest turn (its runs' ordinal), 0 before the first: for counting turns since one. */
export const latestTurn = (thread: ShellThread) => Number(/:ordinal:(\d+)$/.exec(thread.latestRunId ?? "")?.[1] ?? 0);

/**
 * Threads working in one of `directories` (a thread without a worktree works
 * in its project's root), most recently active first.
 */
export function matchThreads(shell: Shell, directories: string[]): AgentThread[] {
  const trim = (path: string) => path.replace(/\/+$/, "");
  const wanted = new Set(directories.map(trim));
  const roots = new Map(shell.projects.map((project) => [project.id, project.workspaceRoot]));
  return shell.threads
    .filter((thread) => !thread.archivedAt && !thread.deletedAt && !providerSubagent(thread))
    .filter((thread) => {
      const directory = thread.worktreePath ?? roots.get(thread.projectId);
      return directory !== undefined && wanted.has(trim(directory));
    })
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      latestTurn: latestTurn(thread),
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

function token() {
  const token = process.env.T3CODE_TOKEN;
  if (!token) throw new Error("Set T3CODE_TOKEN to reach T3 Code (see README).");
  return token;
}

/** One RPC over a fresh socket: a unary call's result, or a stream's first value. */
async function call<T>(tag: string, payload: unknown): Promise<T> {
  const auth = token();
  const base = await serverUrl();
  let response: Response;
  try {
    response = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${auth}` } });
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

/** The parts of a T3 Code thread's projection that tell its turns apart. */
export type ThreadProjection = {
  runs: Array<{ id: string; ordinal: number; status: string; checkpointId: string | null; completedAt: string | null; requestedAt: string }>;
  messages: Array<{ runId: string | null; role: string; text: string; createdAt: string }>;
  checkpoints: Array<{ id: string; scopeId: string; ordinalWithinScope: number; ref: string; status: string }>;
  checkpointScopes: Array<{ id: string; kind: string }>;
};

/** A thread's whole projection (the websocket's is cut to recent history). */
export async function readThread(threadId: string): Promise<ThreadProjection> {
  const auth = token();
  const base = await serverUrl();
  let response: Response;
  try {
    response = await fetch(`${base}/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
      headers: { authorization: `Bearer ${auth}`, "x-t3-orchestration-protocol": "2" },
    });
  } catch {
    throw new Error(`Cannot reach T3 Code at ${base}.`);
  }
  if (!response.ok) throw new Error(`T3 Code did not return thread ${threadId} (HTTP ${response.status}).`);
  return ((await response.json()) as { projection: ThreadProjection }).projection;
}

export type Turn = {
  ordinal: number;
  status: string;
  at: string;
  /** What the user wrote in this turn (the message that started it and any sent while it ran). */
  messages: string[];
  /** The checkpoint refs before and after the turn; null where T3 Code has none ready. */
  start: string | null;
  end: string | null;
};

/**
 * The thread's turns after turn `after`, oldest first. T3 Code snapshots the
 * checkout per turn in its root checkpoint scope: ordinal n after turn n,
 * n - 1 (or a baseline taken when it was missing) before it.
 */
export function threadTurns(thread: ThreadProjection, after: number): Turn[] {
  const root = thread.checkpointScopes.find((scope) => scope.kind === "root_run");
  const ready = new Map(thread.checkpoints.filter((checkpoint) => checkpoint.scopeId === root?.id && checkpoint.status === "ready")
    .map((checkpoint) => [checkpoint.ordinalWithinScope, checkpoint]));
  return thread.runs.filter((run) => run.ordinal > after).sort((a, b) => a.ordinal - b.ordinal).map((run) => ({
    ordinal: run.ordinal,
    status: run.status,
    at: run.completedAt ?? run.requestedAt,
    messages: thread.messages.filter((message) => message.runId === run.id && message.role === "user")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((message) => message.text),
    start: ready.get(run.ordinal - 1)?.ref ?? null,
    end: run.checkpointId && ready.get(run.ordinal)?.id === run.checkpointId ? ready.get(run.ordinal)!.ref : null,
  }));
}
