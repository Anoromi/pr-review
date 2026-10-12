import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { useTranslations } from "use-intl";
import type { FileFilter } from "../shared/filters";
import { filteredFiles } from "../shared/filters";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";

type Draft = { name: string; patterns: string; enabled: boolean };

/** Edit the repository's file filters; the count previews this review. */
export function FiltersDialog({ open, onOpenChange, filters, files, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: FileFilter[];
  files: string[];
  onSave: (filters: FileFilter[]) => Promise<void>;
}) {
  const t = useTranslations("app");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setError("");
    setDrafts(filters.length
      ? filters.map((filter) => ({ ...filter, patterns: filter.patterns.join("\n") }))
      : [{ name: "", patterns: "", enabled: true }]);
  }, [open]);
  const parsed = (draft: Draft): FileFilter => ({
    name: draft.name.trim(),
    enabled: draft.enabled,
    patterns: draft.patterns.split("\n").map((line) => line.trim()).filter(Boolean),
  });
  const update = (index: number, change: Partial<Draft>) =>
    setDrafts((previous) => previous.map((draft, position) => position === index ? { ...draft, ...change } : draft));
  async function save() {
    // An untouched empty row is not a filter; a named or patterned one needs both.
    const next = drafts.map(parsed).filter((filter) => filter.name || filter.patterns.length);
    if (next.some((filter) => !filter.name || !filter.patterns.length)) { setError(t("filterIncomplete")); return; }
    setSaving(true); setError("");
    try { await onSave(next); onOpenChange(false); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(640px,95vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-background p-5 shadow-lg">
        <div className="flex items-center justify-between gap-3"><Dialog.Title className="font-semibold">{t("fileFilters")}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="sm">{t("close")}</Button></Dialog.Close></div>
        <Dialog.Description className="my-3 text-sm text-muted-foreground">{t("fileFiltersDescription")}</Dialog.Description>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {drafts.map((draft, index) => {
            const hidden = filteredFiles(files, [{ ...parsed(draft), enabled: true }]).size;
            return <fieldset key={index} className="space-y-2 rounded border p-3">
              <div className="flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={draft.enabled} aria-label={t("filterEnabled")} onChange={(e) => update(index, { enabled: e.target.checked })} />
                <Input autoFocus={index === 0 && !draft.name} value={draft.name} placeholder={t("filterName")} aria-label={t("filterName")} onChange={(e) => update(index, { name: e.target.value })} />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("filterMatches", { count: hidden })}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts((previous) => previous.filter((_, position) => position !== index))}>{t("filterRemove")}</Button>
              </div>
              <Textarea className="font-mono text-xs" rows={Math.min(8, Math.max(3, draft.patterns.split("\n").length))} value={draft.patterns} placeholder={"tests/\n*.test.ts\n**/__snapshots__/"} aria-label={t("filterPatterns")}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                onChange={(e) => update(index, { patterns: e.target.value })} />
            </fieldset>;
          })}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setDrafts((previous) => [...previous, { name: "", patterns: "", enabled: true }])}>{t("filterAdd")}</Button>
            <Button type="submit" className="ml-auto" disabled={saving}>{t("filterSave")}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
