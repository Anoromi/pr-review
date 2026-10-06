import { keyLabels } from "@/keys";

export function KeyHint({ children, overlay = false, visible = true }: {
  children: React.ReactNode;
  overlay?: boolean;
  visible?: boolean;
}) {
  return <kbd className={`key-hint${overlay ? " key-hint-overlay" : ""}`} data-visible={visible} aria-hidden="true">{children}</kbd>;
}

/** Renders a key sequence such as "g g" as one cap per key. */
export function Keys({ value, className = "" }: { value: string; className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-0.5 ${className}`} aria-hidden="true">
    {keyLabels(value).map((key, index) => <kbd key={index} className="key-hint">{key}</kbd>)}
  </span>;
}
