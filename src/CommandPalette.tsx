import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Link } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { Keys } from "./components/ui/key-hint";
import { activeCommands, commandGroups, keysFor, type Command } from "./keys";

export type PalettePage = "commands" | "url";

const pullUrl = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

export function CommandPalette({ page, onClose, onOpenUrl }: {
  page: PalettePage | null;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const t = useTranslations("keys");
  const [query, setQuery] = useState("");
  const [commands, setCommands] = useState<Command[]>([]);
  useEffect(() => {
    if (!page) return;
    setQuery("");
    setCommands(activeCommands().filter((command) => !command.hidden));
  }, [page]);
  function run(action: () => void) {
    onClose();
    // Let the dialog return focus before a command opens another surface.
    setTimeout(action, 60);
  }
  const url = query.trim();
  return (
    <CommandDialog
      open={page !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t("palette")}
      description={t("paletteDescription")}
      showCloseButton={false}
      className="top-[18%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t(page === "url" ? "urlPlaceholder" : "palettePlaceholder")}
        spellCheck={false}
      />
      <CommandList className="max-h-[min(420px,55vh)]">
        {page !== "url" && <CommandEmpty>{t("noCommands")}</CommandEmpty>}
        {(page === "url" ? url : pullUrl.test(url)) && (
          <CommandGroup>
            <CommandItem value={url} onSelect={() => run(() => onOpenUrl(url))}>
              <Link />
              <span className="truncate">{t("openUrl", { url })}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {page === "commands" && commandGroups.map((group) => {
          const items = commands.filter((command) => command.group === group);
          if (!items.length) return null;
          return (
            <CommandGroup key={group} heading={t(`group.${group}`)}>
              {items.map((command) => (
                <CommandItem
                  key={command.id}
                  value={`${t(`cmd.${command.id}`)} ${command.id}`}
                  disabled={command.enabled ? !command.enabled() : false}
                  onSelect={() => run(() => command.run())}
                >
                  {t(`cmd.${command.id}`)}
                  {keysFor(command)[0] && <Keys value={keysFor(command)[0]} className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

export function KeyboardHelp({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("keys");
  const content = useRef<HTMLDivElement>(null);
  const commands = open ? activeCommands() : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={content}
        tabIndex={-1}
        aria-describedby={undefined}
        className="block max-h-[88vh] overflow-auto p-5 sm:max-w-5xl"
        onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus(); }}
        onKeyDown={(event) => {
          if (event.key === "?") onOpenChange(false);
          const step = ["t", "j"].includes(event.key) ? 1 : ["n", "k"].includes(event.key) ? -1 : 0;
          if (step) content.current?.scrollBy({ top: step * 120 });
        }}
      >
        <DialogTitle className="mb-4 text-base">{t("help")}</DialogTitle>
        <div className="columns-1 gap-8 sm:columns-2 lg:columns-3">
          {commandGroups.map((group) => {
            const items = commands.filter((command) => command.group === group);
            if (!items.length) return null;
            return (
              <section key={group} className="mb-5 break-inside-avoid">
                <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">{t(`group.${group}`)}</h3>
                {items.map((command) => (
                  <div key={command.id} className="flex min-h-7 items-center gap-3 border-b border-border/60 py-1 text-[13px]">
                    <span className="min-w-0 flex-1">{t(`cmd.${command.id}`)}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {keysFor(command).slice(0, 2).map((keys) => <Keys key={keys} value={keys} />)}
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
