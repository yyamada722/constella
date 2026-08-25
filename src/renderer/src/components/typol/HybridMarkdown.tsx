// ハイブリッド表示 (Typora のライブプレビュー風) — ノートを空行区切りの
// 「ブロック」列として描画し、クリックしたブロックだけソース編集 (textarea)、
// それ以外は整形プレビューのまま表示する。
//
// 設計メモ:
//   - ブロック分割はコードフェンス (```) を跨がない。分割/結合の正規化は
//     「アクティブ解除時」だけ行う — 入力中に再分割するとキャレット管理が
//     壊れるため、編集中のブロックは一時的に複数段落を含んでよい。
//   - 復元は blocks.map(text + sep).join('') が常に元テキストと一致する
//     (バイト保存)。プレビュー専用の整形はしない。
//   - 中身は TypolMarkdown を流用: プレビューブロックはチェックボックス
//     トグル/wiki リンク/画像/mermaid がそのまま動き、編集ブロックは
//     スマート Enter/Tab・リッチペースト・右クリック挿入メニューが効く。
//   - プレビューブロックは memo 化し、タイピングでは編集中ブロック以外を
//     再レンダーしない（長文ノートの入力遅延対策）。
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { TypolMarkdown } from './TypolMarkdown'
import { updateFence, type FenceState } from '../../utils/mdTask'

export interface HybridMarkdownHandle {
  /** 全文の 0-based 行番号へジャンプ（アウトライン用）。表示中のブロック構造
   *  (blocksRef) から行→ブロックを引くので、編集中ブロック内の見出しでも
   *  同名見出しとズレない。 */
  jumpToLine: (line: number) => void
}

interface Block { text: string; sep: string }

/** 空行 (2連続以上の改行) でブロックへ分割。フェンス内の空行では割らない。
 *  フェンス状態は1本のステートを通しで更新する（全文1パスの線形時間）。 */
export function splitBlocks(src: string): Block[] {
  const parts = src.split(/(\n{2,})/)
  const blocks: Block[] = []
  // 直前までに積んだブロック末尾時点のフェンス状態
  let fence: FenceState | null = null
  const feed = (chunk: string) => {
    for (const l of chunk.split('\n')) fence = updateFence(fence, l)
  }
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i]
    const sep = parts[i + 1] ?? ''
    const prev = blocks[blocks.length - 1]
    // 先頭の空文字ブロック（文書が空行で始まる）と、フェンスが開いたままの
    // ブロックは前へマージして正規化する。
    if (prev && (prev.text === '' || fence !== null)) {
      feed(prev.sep + text)
      prev.text += prev.sep + text
      prev.sep = sep
    } else {
      feed(text)
      blocks.push({ text, sep })
    }
  }
  if (blocks.length === 0) blocks.push({ text: '', sep: '' })
  return blocks
}

const join = (blocks: Block[]) => blocks.map(b => b.text + b.sep).join('')

// プレビューブロック — memo で「テキストが変わったブロックだけ」再レンダー。
// onChange/onActivate は親側で useCallback した安定参照を渡すこと。
const PreviewBlock = memo(function PreviewBlock({ index, text, onBlockChange, onActivate }: {
  index: number
  text: string
  onBlockChange: (i: number, text: string) => void
  onActivate: (i: number) => void
}) {
  return (
    <div
      data-hybrid-block={index}
      className="typol-hybrid-block"
      onClick={e => {
        // リンク・チェックボックス等のインタラクティブ要素のクリックでは
        // ブロックを編集モードにしない（リンクを開いたら本文が開く、を防ぐ）
        const t = e.target as HTMLElement
        if (t.closest('a, input, button')) return
        onActivate(index)
      }}
    >
      <TypolMarkdown
        value={text}
        onChange={t => onBlockChange(index, t)}
        editing={false}
      />
    </div>
  )
})

export const HybridMarkdown = forwardRef<HybridMarkdownHandle, {
  value: string
  onChange?: (next: string) => void
  placeholder?: string
}>(function HybridMarkdown({ value, onChange, placeholder }, ref) {
  const [blocks, setBlocks] = useState<Block[]>(() => splitBlocks(value))
  // 空ノートはいきなり書き始められるよう先頭ブロックをアクティブにする。
  const [active, setActive] = useState<number | null>(() => (value.trim() === '' ? 0 : null))
  const activeRef = useRef(active)
  activeRef.current = active
  // 次のフォーカスでキャレットをどこへ置くか（'start'/'end' はブロック間の
  // 矢印移動用、数値は分割直後などの明示オフセット）
  const caretRef = useRef<'start' | 'end' | number>('end')
  // 同じ index を再アクティブ化してもフォーカス effect が走るようにするための連番
  const [focusTick, setFocusTick] = useState(0)
  const lastEmitted = useRef(value)
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const wrapRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // 外部からの変更（undo / 置換など）は再分割して追従する。自分の emit の
  // エコーは lastEmitted 一致でスキップ（再分割するとキャレットが飛ぶ）。
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setBlocks(splitBlocks(value))
    setActive(null)
  }, [value])

  const activate = useCallback((i: number, caret: 'start' | 'end' | number) => {
    caretRef.current = caret
    setActive(i)
    setFocusTick(t => t + 1)
  }, [])
  const activateFromClick = useCallback((i: number) => activate(i, 'end'), [activate])

  const updateBlockText = useCallback((i: number, text: string) => {
    // 編集中のブロック内に空行（= ブロック境界）ができたら、その場で再分割して
    // 手前の段落をプレビューへ戻す（Typora の挙動）。解除するまで1ブロックが
    // 延々と伸び続けないように。キャレットは分割後の該当サブブロックへ引き継ぐ。
    if (i === activeRef.current && /\n{2,}/.test(text)) {
      const parts = splitBlocks(text)
      if (parts.length > 1) {
        const cur = blocksRef.current
        const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>(`[data-hybrid-block="${i}"] textarea`)
        const caret = ta && document.activeElement === ta ? ta.selectionStart : text.length
        // join(parts) === text（バイト保存）なので、元ブロックの sep は最後の
        // サブブロックへ付け足せば全文が変わらない。
        const lastPart = parts[parts.length - 1]
        parts[parts.length - 1] = { ...lastPart, sep: lastPart.sep + cur[i].sep }
        const next = [...cur.slice(0, i), ...parts, ...cur.slice(i + 1)]
        // キャレットを含むサブブロックとブロック内オフセットを求める
        let acc = 0
        let sub = parts.length - 1
        let off = parts[parts.length - 1].text.length
        for (let k = 0; k < parts.length; k++) {
          const end = acc + parts[k].text.length
          if (caret <= end) { sub = k; off = caret - acc; break }
          acc = end + parts[k].sep.length
        }
        setBlocks(next)
        const joined = join(next)
        lastEmitted.current = joined
        onChangeRef.current?.(joined)
        activate(i + sub, off)
        return
      }
    }
    const next = blocksRef.current.slice()
    next[i] = { ...next[i], text }
    setBlocks(next)
    const joined = join(next)
    lastEmitted.current = joined
    onChangeRef.current?.(joined)
  }, [activate])

  // アクティブ解除 = ブロック構造の正規化タイミング。確定済みテキスト
  // (lastEmitted) から再分割するので、appendBlock で作った未入力の空ブロック
  // のような「まだ emit していない構造」はここで消える（本文は変わらない）。
  const deactivate = useCallback(() => {
    setActive(null)
    setBlocks(splitBlocks(lastEmitted.current))
  }, [])

  // アクティブ切替後に textarea へフォーカス。キャレット復元は rAF では間に
  // 合わないことがあるので setTimeout(0)（MarkdownText の既知の挙動と同じ）。
  useEffect(() => {
    if (active === null) return
    const t = setTimeout(() => {
      const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>(`[data-hybrid-block="${active}"] textarea`)
      if (!ta) return
      ta.focus()
      const c = caretRef.current
      const pos = typeof c === 'number' ? Math.min(c, ta.value.length) : c === 'start' ? 0 : ta.value.length
      ta.setSelectionRange(pos, pos)
    }, 0)
    return () => clearTimeout(t)
  }, [active, focusTick])

  // アウトラインからのジャンプ: 全文の行番号 → 表示中のブロック構造で解決する。
  // DOM の見出しテキスト一致に頼らないので、編集中ブロック（h要素が無い）や
  // 同名見出しが混ざっていてもズレない。
  useImperativeHandle(ref, () => ({
    jumpToLine: (line: number) => {
      const bs = blocksRef.current
      const nl = (s: string) => (s.match(/\n/g)?.length ?? 0)
      // ブロック k のテキストは行 [L, L+nl(text)] を占める（sep は改行のみ）
      let L = 0
      let bi = -1
      let local = 0
      for (let k = 0; k < bs.length; k++) {
        const tn = nl(bs[k].text)
        if (line <= L + tn) { bi = k; local = line - L; break }
        L += tn + nl(bs[k].sep)
      }
      if (bi === -1) { bi = bs.length - 1; local = nl(bs[bi].text) }
      const blockEl = wrapRef.current?.querySelector<HTMLElement>(`[data-hybrid-block="${bi}"]`)
      if (!blockEl) return
      const scroller = blockEl.closest<HTMLElement>('.typol-hybrid-scroll')
      if (bi === activeRef.current) {
        // 編集中ブロック: 見出し行を選択してスクローラをその行へ寄せる
        const ta = blockEl.querySelector('textarea')
        if (ta) {
          const lines = ta.value.split('\n')
          let pos = 0
          for (let k = 0; k < local && k < lines.length; k++) pos += lines[k].length + 1
          ta.focus({ preventScroll: true })
          ta.setSelectionRange(pos, pos + (lines[local]?.length ?? 0))
          if (scroller) {
            const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22
            const top = blockEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
            scroller.scrollTo({ top: Math.max(0, top + local * lh - 60), behavior: 'smooth' })
          }
          return
        }
      }
      // プレビューブロック: ブロック内で local 行より手前にある見出しの数 = n 番目の h 要素
      let fence: FenceState | null = null
      let nth = 0
      const tls = bs[bi].text.split('\n')
      for (let k = 0; k < local && k < tls.length; k++) {
        const nextF = updateFence(fence, tls[k])
        if (fence === null && nextF === fence && /^#{1,6}\s+\S/.test(tls[k])) nth++
        fence = nextF
      }
      const el = blockEl.querySelectorAll('h1,h2,h3,h4,h5,h6')[nth] ?? blockEl
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
  }), [])

  // 末尾の余白クリック → 最後に新しいブロックを開いて書き始める。
  // この時点では emit しない（クリックだけでノート本文や updatedAt を
  // 変えない）— 実際に入力された時に updateBlockText が sep ごと確定する。
  const appendBlock = () => {
    const next = blocksRef.current.slice()
    const last = next[next.length - 1]
    if (last && last.text.trim() === '') {
      activate(next.length - 1, 'end')
      return
    }
    if (last) next[next.length - 1] = { ...last, sep: last.sep.includes('\n\n') ? last.sep : '\n\n' }
    next.push({ text: '', sep: '' })
    setBlocks(next)
    activate(next.length - 1, 'end')
  }

  return (
    <div ref={wrapRef} className="flex-1 flex flex-col">
      {blocks.map((b, i) => (
        i === active ? (
          <div
            key={`b${i}`}
            data-hybrid-block={i}
            className="typol-hybrid-block typol-hybrid-active"
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
              const ta = e.target as HTMLTextAreaElement
              if (!(ta instanceof HTMLTextAreaElement)) return
              if (e.key === 'Escape') { e.preventDefault(); deactivate(); return }
              if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0 && i > 0) {
                e.preventDefault(); activate(i - 1, 'end')
              } else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length && i < blocks.length - 1) {
                e.preventDefault(); activate(i + 1, 'start')
              }
            }}
          >
            <TypolMarkdown
              value={b.text}
              onChange={t => updateBlockText(i, t)}
              editing
              hideToolbar
              autoGrow
              placeholder={blocks.length === 1 ? placeholder : undefined}
            />
          </div>
        ) : (
          <PreviewBlock
            key={`b${i}`}
            index={i}
            text={b.text}
            onBlockChange={updateBlockText}
            onActivate={activateFromClick}
          />
        )
      ))}
      {/* 末尾の余白 — クリックで続きから書き始める */}
      <div className="flex-1 min-h-16 cursor-text" onClick={appendBlock} />
    </div>
  )
})
