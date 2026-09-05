import { tableKeydown } from "../../utils/mdTable";

export interface EditorRefs {
  textarea: HTMLTextAreaElement;
  onChange: () => void;
}

export type CommandName =
  | "bold" | "italic" | "strike" | "code" | "codeblock"
  | "h1" | "h2" | "h3" | "quote" | "ul" | "ol" | "task"
  | "link" | "image" | "table" | "hr";

export class Editor {
  private el: HTMLTextAreaElement;
  private notify: () => void;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(refs: EditorRefs) {
    this.el = refs.textarea;
    this.notify = refs.onChange;
    this.attachSmartInput();
  }

  /** Detach the keydown listener. The owning effect MUST call this on cleanup —
   *  a leaked listener means duplicated smart-input handling on the same
   *  textarea (StrictMode double-mount, HMR), where a toggle command like bold
   *  runs twice and cancels itself out. */
  destroy() {
    if (this.keydownHandler) this.el.removeEventListener("keydown", this.keydownHandler);
    this.keydownHandler = null;
  }

  get value() { return this.el.value; }
  set value(v: string) { this.el.value = v; this.notify(); }

  focus() { this.el.focus(); }

  private getSel() {
    return {
      start: this.el.selectionStart,
      end: this.el.selectionEnd,
      value: this.el.value,
    };
  }

  // 値全体の置き換えを最小 diff の replaceRange に落とす（native undo を保つ）
  private applyValue(next: string, selStart: number, selEnd: number) {
    const old = this.el.value;
    if (old === next) { this.el.setSelectionRange(selStart, selEnd); return; }
    let p = 0;
    const maxP = Math.min(old.length, next.length);
    while (p < maxP && old[p] === next[p]) p++;
    let s = 0;
    const maxS = Math.min(old.length, next.length) - p;
    while (s < maxS && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
    this.replaceRange(p, old.length - s, next.slice(p, next.length - s), selStart, selEnd);
  }

  private replaceRange(start: number, end: number, text: string, selStart?: number, selEnd?: number) {
    this.el.focus();
    this.el.setSelectionRange(start, end);
    const ok = document.execCommand && document.execCommand("insertText", false, text);
    if (!ok) {
      this.el.setRangeText(text, start, end, "end");
    }
    if (selStart != null) this.el.setSelectionRange(selStart, selEnd ?? selStart);
    this.notify();
  }

  private wrap(prefix: string, suffix = prefix, placeholder = "") {
    const { start, end, value } = this.getSel();
    const sel = value.slice(start, end);
    if (sel) {
      const before = value.slice(Math.max(0, start - prefix.length), start);
      const after = value.slice(end, end + suffix.length);
      // さらに外側にも同じデリミタ文字が続く場合はアンラップしない —
      // **bold** の内側で斜体(*)を実行したときに太字の * を剥がさない。
      const partOfLonger =
        value[start - prefix.length - 1] === prefix[0] &&
        value[end + suffix.length] === suffix[suffix.length - 1];
      if (before === prefix && after === suffix && !partOfLonger) {
        this.replaceRange(start - prefix.length, end + suffix.length, sel,
          start - prefix.length, end - prefix.length);
        return;
      }
      this.replaceRange(start, end, prefix + sel + suffix,
        start + prefix.length, start + prefix.length + sel.length);
    } else {
      const text = prefix + placeholder + suffix;
      this.replaceRange(start, end, text,
        start + prefix.length, start + prefix.length + placeholder.length);
    }
  }

  private lineRange() {
    const { start, end, value } = this.getSel();
    const ls = value.lastIndexOf("\n", start - 1) + 1;
    let le = value.indexOf("\n", end);
    if (le === -1) le = value.length;
    return { ls, le, lines: value.slice(ls, le).split("\n") };
  }

  private prefixLines(fn: (line: string, i: number) => string) {
    const { ls, le, lines } = this.lineRange();
    const out = lines.map(fn).join("\n");
    this.replaceRange(ls, le, out, ls, ls + out.length);
  }

  private setHeading(n: number) {
    this.prefixLines((line) => "#".repeat(n) + " " + line.replace(/^#{1,6}\s+/, ""));
  }

  private insertBlock(text: string, cursorOffset?: number) {
    const { start, end } = this.getSel();
    const v = this.el.value;
    const atLineStart = start === 0 || v[start - 1] === "\n";
    const before = atLineStart ? "" : "\n\n";
    const after = "\n";
    const inserted = before + text + after;
    this.replaceRange(start, end, inserted,
      start + before.length + (cursorOffset ?? text.length));
  }

  exec(name: CommandName) {
    switch (name) {
      case "bold":   return this.wrap("**", "**", "太字");
      case "italic": return this.wrap("*", "*", "斜体");
      case "strike": return this.wrap("~~", "~~", "取り消し線");
      case "code":   return this.wrap("`", "`", "code");
      case "h1":     return this.setHeading(1);
      case "h2":     return this.setHeading(2);
      case "h3":     return this.setHeading(3);
      case "quote":  return this.prefixLines((l) => l.startsWith("> ") ? l.slice(2) : "> " + l);
      case "ul":     return this.prefixLines((l) => /^- /.test(l) ? l.slice(2) : "- " + l);
      case "ol":     return this.prefixLines((l, i) => /^\d+\.\s/.test(l) ? l.replace(/^\d+\.\s/, "") : `${i + 1}. ${l}`);
      case "task":   return this.prefixLines((l) => /^- \[[ x]\]\s/.test(l) ? l.replace(/^- \[[ x]\]\s/, "") : "- [ ] " + l);
      case "codeblock": {
        const { start, end, value } = this.getSel();
        const sel = value.slice(start, end) || "code";
        return this.insertBlock("```\n" + sel + "\n```", 4);
      }
      case "link": {
        const { start, end, value } = this.getSel();
        const sel = value.slice(start, end) || "リンクテキスト";
        const url = "https://";
        const text = `[${sel}](${url})`;
        return this.replaceRange(start, end, text,
          start + sel.length + 3, start + sel.length + 3 + url.length);
      }
      case "image": {
        const { start, end, value } = this.getSel();
        const sel = value.slice(start, end) || "alt";
        const url = "https://";
        const text = `![${sel}](${url})`;
        return this.replaceRange(start, end, text,
          start + sel.length + 4, start + sel.length + 4 + url.length);
      }
      case "table":
        return this.insertBlock(
          "| 見出し 1 | 見出し 2 | 見出し 3 |\n" +
          "|---------|---------|---------|\n" +
          "| セル    | セル    | セル    |\n" +
          "| セル    | セル    | セル    |"
        );
      case "hr": return this.insertBlock("---");
    }
  }

  cursorPosition(): { line: number; col: number } {
    const v = this.el.value;
    const p = this.el.selectionStart;
    const before = v.slice(0, p);
    const line = before.split("\n").length;
    const col = p - (before.lastIndexOf("\n") + 1) + 1;
    return { line, col };
  }

  private attachSmartInput() {
    this.keydownHandler = (e: KeyboardEvent) => {
      // Skip everything while an IME is composing (Japanese/Chinese kana→kanji,
      // Korean jamo, etc.). Enter and Tab are used by IMEs to confirm candidates,
      // and intercepting them here mangles the composed text.
      if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
      // Formatting shortcuts (mirrors the canvas MarkdownText bindings).
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        const cmd: CommandName | undefined = e.shiftKey
          ? (k === "x" ? "strike" : undefined)
          : ({ b: "bold", i: "italic", e: "code", k: "link" } as Record<string, CommandName>)[k];
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          this.exec(cmd);
        }
        return;
      }
      // 表の中: Tab=セル移動 / Enter=行追加（表ブロック全体を桁揃え）
      if (!e.altKey && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
        const r = tableKeydown(this.el.value, this.el.selectionStart, e.key === "Enter" ? "Enter" : e.shiftKey ? "ShiftTab" : "Tab");
        if (r) {
          e.preventDefault();
          this.applyValue(r.value, r.selStart, r.selEnd);
          return;
        }
      }
      // Shift+Enter: Markdown の強制改行（行末に "\" を置いて改行）。素の Enter
      // 1 回は段落内の折り返し扱いでプレビューに改行が出ないため。
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const { start, end } = this.getSel();
        this.replaceRange(start, end, "\\\n", start + 2);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const { start, end } = this.getSel();
        if (start !== end || e.shiftKey) {
          const { ls, le, lines } = this.lineRange();
          const out = lines
            .map((l) => (e.shiftKey ? l.replace(/^(\s{1,2}|\t)/, "") : "  " + l))
            .join("\n");
          this.replaceRange(ls, le, out, ls, ls + out.length);
        } else {
          this.replaceRange(start, end, "  ", start + 2);
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const { start, value } = this.getSel();
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const line = value.slice(lineStart, start);
        const m =
          /^(\s*)([-*+]\s\[[ xX]\]\s)(.*)$/.exec(line) ||
          /^(\s*)(\[[ xX]?\]\s)(.*)$/.exec(line) ||   // bare-line task: "[ ] foo" / "[] foo"
          /^(\s*)([-*+]\s)(.*)$/.exec(line) ||
          /^(\s*)(\d+\.\s)(.*)$/.exec(line) ||
          /^(\s*)(>\s?)(.*)$/.exec(line);
        if (m) {
          const [, indent, marker, rest] = m;
          if (rest === "") {
            e.preventDefault();
            this.replaceRange(lineStart, start, indent, lineStart + indent.length);
            return;
          }
          e.preventDefault();
          let next = marker;
          const olm = /^(\d+)\.\s/.exec(marker);
          if (olm) next = (Number(olm[1]) + 1) + ". ";
          if (/\[[xX]\]/.test(marker)) next = marker.replace(/\[[xX]\]/, "[ ]");
          const insert = "\n" + indent + next;
          this.replaceRange(start, start, insert, start + insert.length);
        }
      }
    };
    this.el.addEventListener("keydown", this.keydownHandler);
  }
}
