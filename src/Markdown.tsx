import { memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { getSharedHighlighter, type SupportedLanguages } from "@pierre/diffs";
import { cn } from "@/lib/utils";

// The same shiki highlighter @pierre/diffs uses, with both themes so a theme
// switch is only CSS (see .markdown .shiki in ui.css).
const themes = { light: "github-light", dark: "github-dark" } as const;

async function highlight(code: string, language: string) {
  try {
    const highlighter = await getSharedHighlighter({ themes: [themes.light, themes.dark], langs: [language as SupportedLanguages], preferredHighlighter: "shiki-wasm" });
    return highlighter.codeToHtml(code, { lang: language, themes, defaultColor: "light" });
  } catch {
    return null;
  }
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void highlight(code, language).then((value) => { if (current) setHtml(value); });
    return () => { current = false; };
  }, [code, language]);
  // Shiki escapes the code; the markup is its own.
  if (html) return <div className="markdown-code" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre><code>{code}</code></pre>;
}

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  pre: ({ node }) => {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return null;
    const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("").replace(/\n$/, "");
    const language = (code.properties.className as string[] | undefined)?.find((name) => name.startsWith("language-"))?.slice(9);
    return language ? <CodeBlock code={text} language={language} /> : <pre><code>{text}</code></pre>;
  },
};

/** User and agent text: GitHub-flavoured Markdown, no raw HTML, links in a new tab. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
