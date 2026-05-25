import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ breaks: true, gfm: true });

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text ?? "") as string, [text]);
  return (
    <div
      className="md"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest(
          "a",
        ) as HTMLAnchorElement | null;
        if (a?.href) {
          e.preventDefault();
          // New tab in browser; system browser in Capacitor — either way the
          // chat tab is preserved so the MCP session ID survives.
          window.open(a.href, "_blank", "noopener,noreferrer");
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
