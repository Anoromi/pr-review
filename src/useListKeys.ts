import { useEffect, type RefObject } from "react";
import { useCommands, type Command } from "./keys";

/** Row selection for full-page lists: move, jump to either end, open. */
export function useListKeys({ active, count, index, setIndex, onOpen, container, extra = [] }: {
  active: boolean;
  count: number;
  index: number;
  setIndex: (index: number) => void;
  onOpen: () => void;
  container: RefObject<HTMLElement | null>;
  extra?: Command[];
}) {
  const move = (delta: number) =>
    setIndex(Math.max(0, Math.min(count - 1, index + delta)));
  useEffect(() => {
    if (active)
      container.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [active, index, count]);
  useCommands(
    [
      { id: "listDown", group: "list", keys: ["t", "j", "ArrowDown"], hidden: true, run: (times) => move(times ?? 1) },
      { id: "listUp", group: "list", keys: ["n", "k", "ArrowUp"], hidden: true, run: (times) => move(-(times ?? 1)) },
      { id: "listTop", group: "list", keys: ["g g"], hidden: true, run: () => setIndex(0) },
      { id: "listBottom", group: "list", keys: ["G"], hidden: true, run: () => setIndex(count - 1) },
      { id: "listOpen", group: "list", keys: ["Enter"], hidden: true, enabled: () => count > 0, run: onOpen },
      ...extra,
    ],
    active,
  );
}
