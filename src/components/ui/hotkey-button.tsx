import type { ComponentProps } from "react";
import { Button } from "./button";
import { KeyHint } from "./key-hint";

export function HotkeyButton({ hotkey, showHotkey = true, children, className = "", ...props }: ComponentProps<typeof Button> & {
  hotkey: string;
  showHotkey?: boolean;
}) {
  return <Button variant="ghost" size="sm" {...props} className={`reply-action ${className}`} aria-keyshortcuts={showHotkey ? hotkey : undefined}>
    {children}
    <KeyHint overlay visible={showHotkey}>{hotkey}</KeyHint>
  </Button>;
}
