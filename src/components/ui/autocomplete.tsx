import { useEffect, useId, useRef, useState } from "react";
import { Input } from "./input";

export function Autocomplete({ id, value, options, disabled, placeholder, emptyLabel, onChange }: {
  id: string;
  value: string;
  options: string[];
  disabled?: boolean;
  placeholder: string;
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const matches = options.filter((option) => option.toLowerCase().includes(query.toLowerCase()));
  const index = Math.min(active, Math.max(0, matches.length - 1));
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, open, query]);
  function choose(option: string) {
    onChange(option);
    setOpen(false);
    setQuery("");
  }
  return <div className="relative">
    <Input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
      aria-activedescendant={open && matches.length ? `${listId}-${index}` : undefined}
      autoComplete="off" spellCheck={false} disabled={disabled} placeholder={placeholder}
      value={open ? query : value} title={value}
      onFocus={() => { setQuery(""); setActive(0); setOpen(true); }}
      onClick={() => { if (!open) { setQuery(""); setActive(0); setOpen(true); } }}
      onBlur={() => { setOpen(false); setQuery(""); }}
      onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) { setQuery(""); setActive(0); setOpen(true); }
          else setActive(Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
        } else if (event.key === "Enter" && open) {
          event.preventDefault();
          if (matches[index]) choose(matches[index]);
        } else if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery("");
        }
      }} />
    {open && <div ref={list} id={listId} role="listbox" aria-labelledby={id}
      className="absolute left-0 top-full z-40 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background py-1 shadow-sm">
      {matches.map((option, i) => <div key={option} id={`${listId}-${i}`} role="option" aria-selected={option === value} data-active={i === index}
        className="cursor-pointer break-all px-3 py-2 text-sm leading-5 data-[active=true]:bg-secondary"
        onPointerMove={() => setActive(i)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>{option}</div>)}
      {!matches.length && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{emptyLabel}</p>}
    </div>}
  </div>;
}
