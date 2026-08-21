// Constella 拡張 Markdown 記法の remark プラグイン（MarkdownText / react-markdown 用）。
// Typol 側（marked）は components/typol/markdown.ts の拡張が同じ記法を同じクラス名で描画する。
//
//   ==ハイライト==            → <mark>ハイライト</mark>
//   > [!NOTE] / [!TIP] /      → <div class="md-callout md-callout-note">
//     [!IMPORTANT] /              <div class="md-callout-title">NOTE</div> …本文… </div>
//     [!WARNING] / [!CAUTION]
//
// ハイライトは既存 mdast ノード型 (emphasis) を data.hName='mark' で上書きする。
// mdast-util-to-hast は data.hName / data.hProperties をタグ・属性の上書きとして
// 必ず尊重するので、未知ノード型のハンドラ有無に依存しない。

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i
const MARK_RE = /==([^=\n]+?)==/

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function highlightInChildren(parent: MdNode): void {
  if (!parent.children) return
  for (let i = 0; i < parent.children.length; i++) {
    const node = parent.children[i]
    if (node.type === 'text' && node.value) {
      const m = MARK_RE.exec(node.value)
      if (m && m.index !== undefined) {
        const before = node.value.slice(0, m.index)
        const after = node.value.slice(m.index + m[0].length)
        const markNode: MdNode = {
          type: 'emphasis',
          data: { hName: 'mark' },
          children: [{ type: 'text', value: m[1] }],
        }
        const repl: MdNode[] = []
        if (before) repl.push({ type: 'text', value: before })
        repl.push(markNode)
        if (after) repl.push({ type: 'text', value: after }) // 残りは次周回で再走査
        parent.children.splice(i, 1, ...repl)
        i += repl.length - 2 // markNode の位置まで進め、after を次のループで見る
        continue
      }
    }
    // code / inlineCode / math は type が違うので自然に素通りする。
    // 子孫への降下は walk 側が担う（ここで再帰すると部分木を深さぶん再走査する）。
  }
}

function toCallout(node: MdNode): void {
  const para = node.children?.[0]
  if (!para || para.type !== 'paragraph') return
  const first = para.children?.[0]
  if (!first || first.type !== 'text' || !first.value) return
  const m = CALLOUT_RE.exec(first.value)
  if (!m) return
  const kind = m[1].toLowerCase() as CalloutKind
  first.value = first.value.slice(m[0].length)
  // マーカー直後に改行だけが続くケース: 空 text を残さない
  if (!first.value && para.children!.length > 1) para.children!.shift()
  if (para.children!.length === 0 || (para.children!.length === 1 && para.children![0].type === 'text' && !para.children![0].value)) {
    node.children!.shift()
  }
  node.data = { hName: 'div', hProperties: { className: ['md-callout', `md-callout-${kind}`] } }
  node.children!.unshift({
    type: 'paragraph',
    data: { hName: 'div', hProperties: { className: ['md-callout-title'] } },
    children: [{ type: 'text', value: m[1].toUpperCase() }],
  })
}

export function remarkConstellaSyntax() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (node.type === 'blockquote') toCallout(node)
      // コードブロック等 value 系はそのまま。children を持つものだけ降りる。
      if (node.children) {
        highlightInChildren(node)
        for (const c of node.children) walk(c)
      }
    }
    walk(tree)
  }
}
