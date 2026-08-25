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
import { useEffect, useRef, useState } from 'react'
import { TypolMarkdown } from './TypolMarkdown'
import { updateFence, type FenceState } from '../../utils/mdTask'

interface Block { text: string; sep: string }

function fenceOpenAtEnd(text: string): boolean {
  let fence: FenceState | null = null
  for (const l of text.split('\n')) fence = updateFence(fence, l)
  return fence !== null
}

/** 空行 (2連続以上の改行) でブロックへ分割。フェンス内の空行では割らない。 */
export function splitBlocks(src: string): Block[] {
  const parts = src.split(/(\n{2,})/)
  const blocks: Block[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i]
    const sep = parts[i + 1] ?? ''
    const prev = blocks[blocks.length - 1]
    // 先頭の空文字ブロック（文書が空行で始まる）と、フェンスが開いたままの
    // ブロックは前へマージして正規化する。
    if (prev && (prev.text === '' || fenceOpenAtEnd(prev.text))) {
      prev.text += prev.sep + text
      prev.sep = sep
    } else {
      blocks.push({ text, sep })
    }
  }
  if (blocks.length === 0) blocks.push({ text: '', sep: '' })
  return blocks
}

const join = (blocks: Block[]) => blocks.map(b => b.text + b.sep).join('')

export function HybridMarkdown({ value, onChange, placeholder }: {
  value: string
  onChange?: (next: string) => void
  placeholder?: string
}) {
  const [blocks, setBlocks] = useState<Block[]>(() => splitBlocks(value))
  // 空ノートはいきなり書き始められるよう先頭ブロックをアクティブにする。
  const [active, setActive] = useState<number | null>(() => (value.trim() === '' ? 0 : null))
  // 次のフォーカスでキャレットをどこへ置くか（ブロック間の矢印移動用）
  const caretRef = useRef<'start' | 'end'>('end')
  const lastEmitted = useRef(value)
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

  const emit = (next: Block[]) => {
    setBlocks(next)
    const joined = join(next)
    lastEmitted.current = joined
    onChangeRef.current?.(joined)
  }

  const updateBlockText = (i: number, text: string) => {
    const next = blocks.slice()
    next[i] = { ...next[i], text }
    emit(next)
  }

  // アクティブ解除 = ブロック構造の正規化タイミング（入力中に増えた空行で分割）
  const deactivate = () => {
    setActive(null)
    setBlocks(prev => splitBlocks(join(prev)))
  }

  const activate = (i: number, caret: 'start' | 'end') => {
    caretRef.current = caret
    setActive(i)
  }

  // アクティブ切替後に textarea へフォーカス。キャレット復元は rAF では間に
  // 合わないことがあるので setTimeout(0)（MarkdownText の既知の挙動と同じ）。
  useEffect(() => {
    if (active === null) return
    const t = setTimeout(() => {
      const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>(`[data-hybrid-block="${active}"] textarea`)
      if (!ta) return
      ta.focus()
      const pos = caretRef.current === 'start' ? 0 : ta.value.length
      ta.setSelectionRange(pos, pos)
    }, 0)
    return () => clearTimeout(t)
  }, [active])

  // 末尾の余白クリック → 最後に新しいブロックを作って書き始める
  const appendBlock = () => {
    const next = blocks.slice()
    const last = next[next.length - 1]
    if (last && last.text.trim() === '') {
      activate(next.length - 1, 'end')
      return
    }
    if (last) next[next.length - 1] = { ...last, sep: last.sep.includes('\n\n') ? last.sep : '\n\n' }
    next.push({ text: '', sep: '' })
    emit(next)
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
          <div
            key={`b${i}`}
            data-hybrid-block={i}
            className="typol-hybrid-block"
            onClick={() => activate(i, 'end')}
          >
            <TypolMarkdown
              value={b.text}
              onChange={t => updateBlockText(i, t)}
              editing={false}
            />
          </div>
        )
      ))}
      {/* 末尾の余白 — クリックで続きから書き始める */}
      <div className="flex-1 min-h-16 cursor-text" onClick={appendBlock} />
    </div>
  )
}
