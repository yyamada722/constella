import { marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import katex from "katex";
import DOMPurify from "dompurify";
import { normalizeTasks } from "../../utils/mdTask";

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang === "mermaid") return code; // handled by custom renderer
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      try {
        return hljs.highlight(code, { language }).value;
      } catch {
        return code;
      }
    },
  })
);

marked.use({
  renderer: {
    code(token: Tokens.Code): string | false {
      const lang = (token.lang || "").trim().split(/\s+/)[0];
      if (lang === "mermaid") {
        return `<div class="mermaid-block" data-source="${encodeURIComponent(token.text)}"></div>`;
      }
      return false;
    },
    // GitHub 風コールアウト: 引用の先頭が [!NOTE] 等なら色付きボックスにする。
    // クラス名は remark 側 (utils/mdSyntax.ts) と共通 — index.css の .md-callout が両方に効く。
    blockquote(token: Tokens.Blockquote): string | false {
      const html = this.parser.parse(token.tokens);
      const m = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>\s*)?/i.exec(html);
      if (!m) return false;
      const kind = m[1].toLowerCase();
      let rest = html.slice(m[0].length);
      if (rest.startsWith("</p>")) rest = rest.slice(4); // タイトル行だけの <p> は畳む
      else rest = "<p>" + rest;
      return `<div class="md-callout md-callout-${kind}"><div class="md-callout-title">${m[1].toUpperCase()}</div>${rest}</div>`;
    },
  },
});

// ==ハイライト== → <mark>
marked.use({
  extensions: [
    {
      name: "highlightMark",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("==");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^==([^=\n]+?)==/.exec(src);
        if (!m) return undefined;
        return {
          type: "highlightMark",
          raw: m[0],
          text: m[1],
          tokens: this.lexer.inlineTokens(m[1]),
        } as Tokens.Generic;
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
      },
    },
  ],
});

interface MathToken extends Tokens.Generic {
  type: "mathInline" | "mathBlock";
  raw: string;
  text: string;
}

marked.use({
  gfm: true,
  breaks: false,
  extensions: [
    {
      name: "mathInline",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("$");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): MathToken | undefined {
        const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/.exec(src);
        if (m) return { type: "mathInline", raw: m[0], text: m[1] };
        return undefined;
      },
      renderer(t) {
        const token = t as MathToken;
        try {
          return katex.renderToString(token.text, { throwOnError: false });
        } catch {
          return `<code>${token.text}</code>`;
        }
      },
    },
    {
      name: "mathBlock",
      level: "block",
      start(src: string) {
        const i = src.indexOf("$$");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): MathToken | undefined {
        const m = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
        if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
        return undefined;
      },
      renderer(t) {
        const token = t as MathToken;
        try {
          const html = katex.renderToString(token.text, {
            throwOnError: false,
            displayMode: true,
          });
          return `<div class="math-block">${html}</div>`;
        } catch {
          return `<pre><code>${token.text}</code></pre>`;
        }
      },
    },
  ],
});

export interface RenderResult {
  html: string;
  /** Source line numbers (1-based) for each top-level non-space block, in render order. */
  blockLines: number[];
}

// Preprocess [[Card Title]] wiki links → markdown link with the wiki: scheme.
// Constella-specific: the wrapper intercepts clicks on these to jump to canvas cards.
function preprocessWikiLinks(md: string): string {
  return md.replace(/\[\[([^[\]\n]+)\]\]/g, (_, t: string) => {
    const name = t.trim();
    return `[${name}](wiki:${encodeURIComponent(name)})`;
  });
}

export function renderMarkdown(md: string): RenderResult {
  // normalizeTasks: bare "[ ] foo" lines render as checkboxes too. Both
  // preprocessors preserve line count, so blockLines stays accurate.
  const tokens = marked.lexer(preprocessWikiLinks(normalizeTasks(md)));
  const blockLines: number[] = [];
  let line = 1;
  for (const t of tokens) {
    if (t.type !== "space") blockLines.push(line);
    const lf = t.raw ? (t.raw.match(/\n/g) || []).length : 0;
    line += lf;
  }
  const html = marked.parser(tokens) as string;
  return {
    html: DOMPurify.sanitize(html, {
      ADD_ATTR: ["target"],
      // Extend DOMPurify's allowed-URI regex so Constella's idb: image refs,
      // local: file refs and wiki: hyperlinks survive sanitization. The default
      // blocks any non-http(s)/mailto/tel/sms scheme, which would strip
      // <img src="idb:…"> entirely.
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|idb|local|wiki):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    }),
    blockLines,
  };
}
