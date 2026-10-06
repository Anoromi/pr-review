import { useEffect, useRef, useSyncExternalStore } from "react";

export type CommandGroup =
  | "app"
  | "list"
  | "move"
  | "jump"
  | "files"
  | "comments"
  | "select"
  | "view"
  | "review";

export const commandGroups: CommandGroup[] = [
  "move",
  "jump",
  "files",
  "comments",
  "select",
  "view",
  "review",
  "list",
  "app",
];

export type Command = {
  /** Also the i18n key under `keys.cmd`. */
  id: string;
  group: CommandGroup;
  /** Space-separated sequences such as "g g", "Ctrl+d" or "Alt+t". */
  keys: string[];
  run: (count?: number) => void;
  enabled?: () => boolean;
  /** Motions that only make sense from the keyboard stay out of the palette. */
  hidden?: boolean;
};

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T>(store: ReturnType<typeof createStore<T>>) {
  return useSyncExternalStore(store.subscribe, store.get);
}

function readKeymap(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem("pr-review:keymap") ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const keymap = readKeymap();

export function keysFor(command: Command) {
  const custom = keymap[command.id];
  return Array.isArray(custom) ? custom : command.keys;
}

type Entry = { current: Command[] };
const entries: Entry[] = [];

/** Registers commands while the component is mounted. Later registrations win. */
export function useCommands(commands: Command[], active = true) {
  const entry = useRef<Entry>({ current: [] }).current;
  entry.current = active ? commands : [];
  useEffect(() => {
    entries.push(entry);
    return () => {
      entries.splice(entries.indexOf(entry), 1);
    };
  }, [entry]);
}

export function activeCommands() {
  const seen = new Set<string>();
  return entries
    .flatMap((entry) => entry.current)
    .reverse()
    .filter((command) => !seen.has(command.id) && seen.add(command.id))
    .reverse();
}

/** Count and partial sequence typed so far, for the status line. */
export const pendingKeys = createStore("");

let sequence: string[] = [];
let count = "";
let timer: ReturnType<typeof setTimeout> | undefined;

function reset() {
  sequence = [];
  count = "";
  clearTimeout(timer);
  pendingKeys.set("");
}

function token(event: KeyboardEvent) {
  const key = event.key === " " ? "Space" : event.key;
  return (
    (event.ctrlKey ? "Ctrl+" : "") +
    (event.altKey ? "Alt+" : "") +
    (event.metaKey ? "Meta+" : "") +
    (event.shiftKey && key.length > 1 ? "Shift+" : "") +
    key
  );
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
  const target = event.composedPath()[0];
  const element = target instanceof Element ? target : null;
  if (
    document.querySelector(
      '[role="dialog"]:not([data-state="closed"]), [role="menu"], [role="listbox"]',
    ) ||
    element?.closest(
      'input, textarea, select, [role="textbox"], [role="combobox"], [contenteditable]:not([contenteditable="false"])',
    )
  ) {
    reset();
    return;
  }
  const pressed = token(event);
  if (
    (pressed === "Enter" || pressed === "Space") &&
    element?.closest("button, a, summary")
  )
    return;
  const commands = activeCommands()
    .reverse()
    .filter((command) => command.enabled?.() ?? true);
  if (
    !sequence.length &&
    /^[0-9]$/.test(pressed) &&
    (count || pressed !== "0") &&
    !commands.some((command) => keysFor(command).includes(pressed))
  ) {
    event.preventDefault();
    count += pressed;
    pendingKeys.set(count);
    return;
  }
  const typed = [...sequence, pressed].join(" ");
  const exact = commands.find((command) => keysFor(command).includes(typed));
  if (exact) {
    event.preventDefault();
    const times = count ? Number(count) : undefined;
    reset();
    exact.run(times);
    return;
  }
  if (
    commands.some((command) =>
      keysFor(command).some((keys) => keys.startsWith(`${typed} `)),
    )
  ) {
    event.preventDefault();
    if (event.repeat) return;
    sequence.push(pressed);
    pendingKeys.set(`${count}${typed}`);
    clearTimeout(timer);
    timer = setTimeout(reset, 1500);
    return;
  }
  if (sequence.length || count) {
    event.preventDefault();
    reset();
  }
}

export function installKeys() {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", reset);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", reset);
  };
}

const symbols: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
};

export function keyLabels(keys: string) {
  return keys.split(" ").map((key) =>
    key.length > 1
      ? key.split("+").map((part) => symbols[part] ?? part).join("+")
      : key,
  );
}
