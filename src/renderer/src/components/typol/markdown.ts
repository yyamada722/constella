import { marked, type Tokens } from "marked";
import hljs from "highlight.js";
import katex from "katex";
import DOMPurify from "dompurify";
import { normalizeTasks } from "../../utils/mdTask";
import { escapeHtml } from "./mermaid";

marked.use({
  renderer: {
    // シンタックスハイライトはここで直接 hljs を呼ぶ。marked-highlight は
    // walkTokens フックで動くため、renderMarkdown のように lexer()/parser() を
    // 手で呼ぶ経路では一切適用されない（= ハイライトが効かない）罠がある。
    code(token: Tokens.Code): string | false {
      const lang = (token.lang || "").trim().split(/\s+/)[0];
      if (lang === "mermaid") {
        return `<div class="mermaid-block" data-source="${encodeURIComponent(token.text)}"></div>`;
      }
      // 言語指定なしは既定レンダラーへ（code.hljs を付けないことで
      // --hljs-bg ではなく --tp-code-bg の面になる — 執筆テーマ側の前提）。
      if (!lang) return false;
      // クラスには著者の書いた言語名を残す（hljs 未登録言語でも
      // language-vue 等が消えないように）。ハイライト自体は plaintext に落とす。
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      let body: string;
      try {
        body = hljs.highlight(token.text, { language }).value;
      } catch {
        body = escapeHtml(token.text);
      }
      return `<pre><code class="hljs language-${escapeHtml(lang)}">${body}\n</code></pre>`;
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

// ── GFM 脚注 ([^1] / [^1]: 内容) ──
// marked 本体に footnote 対応はなく、renderMarkdown は lexer()/parser() を手で
// 呼ぶため hooks 依存の marked-footnote も適用されない（marked-highlight と同じ
// 罠）。トークナイザ+レンダラの自前拡張でパースし、収集した定義は
// renderMarkdown が末尾に <section class="footnotes"> として追記する。
// remark 側（旧 MarkdownText）は remark-gfm が footnote 対応済みなので不要。
interface FootnoteDefToken extends Tokens.Generic {
  type: "footnoteDef";
  raw: string;
  id: string;
}
interface FootnoteRefToken extends Tokens.Generic {
  type: "footnoteRef";
  raw: string;
  id: string;
}
const fnState = {
  nums: new Map<string, number>(), // 参照の出現順で採番
  defs: new Map<string, string>(), // id → 定義のインライン HTML
  known: new Set<string>(), // レンダー前に判明している定義 id（未定義参照はリテラル表示）
};

marked.use({
  extensions: [
    {
      name: "footnoteDef",
      level: "block",
      start(src: string) {
        const m = /(^|\n)\[\^/.exec(src);
        return m ? m.index + m[1].length : undefined;
      },
      tokenizer(src: string) {
        // 1行目 + インデントされた非空行だけを継続行として取り込む（GFM 準拠。
        // 直後の見出し・リスト等の通常ブロックを飲み込まないこと）
        const m = /^\[\^([^\]\s]+)\]:[ \t]?(.*(?:\n[ \t]+(?!\[\^)\S.*)*)/.exec(src);
        if (!m) return undefined;
        const text = m[2].replace(/\n[ \t]*/g, " ").trim();
        // 定義 id はレンダー前（lexer 段階）にここで登録される。renderer が
        // 「未定義参照はリテラル表示」を判定できるのはこのため（ネストした
        // blockquote / リスト内の定義もトークナイザは必ず通る）。
        fnState.known.add(m[1]);
        return {
          type: "footnoteDef",
          raw: m[0],
          id: m[1],
          tokens: this.lexer.inlineTokens(text),
        } as FootnoteDefToken;
      },
      renderer(t) {
        const token = t as FootnoteDefToken;
        fnState.defs.set(token.id, this.parser.parseInline(token.tokens ?? []));
        return ""; // 本文中には出さない（末尾の .footnotes にまとめる）
      },
    },
    {
      name: "footnoteRef",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("[^");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
        if (!m) return undefined;
        return { type: "footnoteRef", raw: m[0], id: m[1] } as FootnoteRefToken;
      },
      renderer(t) {
        const token = t as FootnoteRefToken;
        // 定義が存在しない参照は GFM と同じくリテラルのまま表示する
        if (!fnState.known.has(token.id)) return escapeHtml(token.raw);
        let n = fnState.nums.get(token.id);
        const first = n === undefined;
        if (n === undefined) {
          n = fnState.nums.size + 1;
          fnState.nums.set(token.id, n);
        }
        // id は最初の参照だけに付ける（2回目以降にも付けると DOM id が重複し、
        // 脚注側の ↩ が常に最初の引用へ戻ってしまう）
        const idAttr = first ? ` id="fnref-${n}"` : "";
        return `<sup class="footnote-ref"><a href="#fn-${n}"${idAttr}>[${n}]</a></sup>`;
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
  // 脚注の状態はレンダー単位（モジュールシングルトンなので毎回リセット）
  fnState.nums.clear();
  fnState.defs.clear();
  fnState.known.clear();
  // normalizeTasks: bare "[ ] foo" lines render as checkboxes too. Both
  // preprocessors preserve line count, so blockLines stays accurate.
  // 定義 id (fnState.known) は footnoteDef トークナイザがこの lexer 呼び出しの
  // 中で登録する — リスト項目や blockquote にネストした定義も漏れない。
  const tokens = marked.lexer(preprocessWikiLinks(normalizeTasks(md)));
  const blockLines: number[] = [];
  let line = 1;
  for (const t of tokens) {
    // footnoteDef は本文中に何も描画しないので blockLines からも除外する
    if (t.type !== "space" && t.type !== "footnoteDef") blockLines.push(line);
    const lf = t.raw ? (t.raw.match(/\n/g) || []).length : 0;
    line += lf;
  }
  let html = marked.parser(tokens) as string;
  // 脚注リスト: 参照された定義を参照順で並べ、未参照の定義も末尾に続ける
  // （ハイブリッド表示では定義だけのブロックが単体レンダーされるため、
  //  未参照でも描画しないと「見えないブロック」になってしまう）。
  if (fnState.defs.size > 0) {
    const order = [...fnState.nums.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    for (const id of fnState.defs.keys()) if (!fnState.nums.has(id)) order.push(id);
    const items = order
      .map((id, i) => {
        const n = i + 1;
        const back = fnState.nums.has(id)
          ? ` <a href="#fnref-${n}" class="footnote-backref" title="本文へ戻る">↩</a>`
          : "";
        return `<li id="fn-${n}">${fnState.defs.get(id) ?? ""}${back}</li>`;
      })
      .join("");
    html += `<section class="footnotes"><ol>${items}</ol></section>`;
  }
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
