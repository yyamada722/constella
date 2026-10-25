// Office 文書（Word / Excel / PowerPoint）の読み取り専用プレビュー。
// すべてアプリ内（オフライン）で描画する — 外部サービスへは一切送らない。
//   .docx       → docx-preview（ページ単位の HTML）
//   .xlsx/.xls/.ods → SheetJS で読み、シートタブ付きの表として自前描画
//   .pptx       → pptx-preview（スライドを縦に並べた一覧）
// レンダラはどれも重いので、該当形式を開いたときだけ動的 import する。
// 忠実度は本家 Office に及ばない（フォント/図形/グラフの一部が崩れる）ため、
// 正確に見たいときの「OSのアプリで開く」導線は呼び出し側に残す。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { WorkBook, WorkSheet } from 'xlsx'
import { officeFormat } from '../utils/fileKind'

const FORMAT_LABEL = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' } as const

export default function OfficeViewer({ url, name, mime, fixedHeight }: {
  url: string // 解決済みの blob:/http URL（useMediaState の結果）
  name: string
  mime: string
  /** 指定時はその高さで固定（ノート添付など）。未指定は親の高さいっぱい。 */
  fixedHeight?: number
}) {
  const format = officeFormat(mime, name)
  const [buf, setBuf] = useState<ArrayBuffer | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (format === 'unsupported') return
    let alive = true
    setBuf(null); setError(null)
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
      .then(b => { if (alive) setBuf(b) })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [url, format])

  const style = fixedHeight ? { height: fixedHeight } : undefined
  const shell = (child: React.ReactNode) => (
    <div className={`office-viewer flex flex-col min-h-0 bg-slate-100 ${fixedHeight ? '' : 'h-full w-full'}`} style={style}>{child}</div>
  )

  if (format === 'unsupported') {
    return shell(<Notice text="この形式（旧 .doc / .ppt や ODT/ODP）はアプリ内プレビュー非対応です。OSのアプリで開いてください。" />)
  }
  if (error) return shell(<Notice text={`読み込みに失敗しました: ${error}`} />)
  if (!buf) return shell(<Loading label={FORMAT_LABEL[format]} />)
  if (format === 'docx') return shell(<DocxView buf={buf} />)
  if (format === 'xlsx') return shell(<SheetView buf={buf} />)
  return shell(<PptxView buf={buf} />)
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center gap-2 text-xs text-slate-400 py-8">
      <Loader2 size={14} className="animate-spin" /> {label} 文書を読み込み中…
    </div>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex-1 flex items-center justify-center gap-2 text-xs text-slate-500 p-6 text-center">
      <AlertTriangle size={14} className="text-amber-500 shrink-0" /> {text}
    </div>
  )
}

/* ── Word ── */

function DocxView({ buf }: { buf: ArrayBuffer }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let alive = true
    host.replaceChildren()
    import('docx-preview')
      // チャンク読込中に閉じられたら描画しない（切り離された host に大きな文書を描き続けないよう）
      .then(({ renderAsync }) => alive ? renderAsync(buf, host, undefined, {
        inWrapper: true,
        // 文書に埋め込まれた HTML 部品 (altChunk) は sandbox 無しの iframe srcdoc で描かれる
        // — 文書由来のスクリプトをアプリと同一オリジンで動かさないよう無効化する
        renderAltChunks: false,
        ignoreLastRenderedPageBreak: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        breakPages: true,
        experimental: true,
      }) : undefined)
      .then(() => { if (alive) fit() })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    // ページは実寸（A4 等の固定 px 幅）で描かれる — 狭いペインでは横幅に合わせて縮小。
    // 拡大はしない（広いライトボックスで文字が間延びしないよう等倍が上限）。
    function fit() {
      const wrapper = host?.querySelector<HTMLElement>('.docx-wrapper')
      const page = wrapper?.querySelector<HTMLElement>('section.docx')
      if (!host || !wrapper || !page) return
      const need = page.offsetWidth + 32 // .docx-wrapper の左右 padding
      wrapper.style.zoom = String(Math.min(1, host.clientWidth / need))
    }
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    return () => { alive = false; ro.disconnect(); host.replaceChildren() }
  }, [buf])
  if (error) return <Notice text={`Word 文書を表示できませんでした: ${error}`} />
  return <div ref={hostRef} className="office-docx flex-1 min-h-0 overflow-auto" style={{ scrollbarGutter: 'stable' }} />
}

/* ── Excel ── */

// 巨大シートを丸ごと DOM にすると固まるので表示範囲を打ち切る（通知を出す）。
const MAX_ROWS = 1000
const MAX_COLS = 100

function SheetView({ buf }: { buf: ArrayBuffer }) {
  const [wb, setWb] = useState<WorkBook | null>(null)
  const [xlsx, setXlsx] = useState<typeof import('xlsx') | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheetIdx, setSheetIdx] = useState(0)
  useEffect(() => {
    let alive = true
    import('xlsx')
      .then(X => {
        if (!alive) return
        setXlsx(X)
        setWb(X.read(new Uint8Array(buf), { type: 'array', cellStyles: true, dense: false }))
        setSheetIdx(0)
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [buf])

  if (error) return <Notice text={`Excel 文書を表示できませんでした: ${error}`} />
  if (!wb || !xlsx) return <Loading label="Excel" />
  const names = wb.SheetNames
  const ws = wb.Sheets[names[sheetIdx]]
  return (
    <>
      {/* 灰色の地の中央にシートを置く。flex の auto margin なので、はみ出す大きなシートは
          上端・左端から表示されてスクロールでき、切れない */}
      <div className="flex-1 min-h-0 overflow-auto bg-slate-100 p-4 flex flex-col" style={{ scrollbarGutter: 'stable' }}>
        {ws ? <SheetTable key={sheetIdx} ws={ws} X={xlsx} /> : <Notice text="シートが空です" />}
      </div>
      {names.length > 1 && (
        <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-t border-slate-200 bg-slate-50 overflow-x-auto">
          {names.map((n, i) => (
            <button
              key={n + i}
              onClick={() => setSheetIdx(i)}
              className={`px-2.5 py-0.5 text-[11px] rounded whitespace-nowrap transition-colors ${i === sheetIdx ? 'bg-white text-emerald-700 font-medium shadow-sm border border-slate-200' : 'text-slate-500 hover:bg-slate-200/60'}`}
            >{n}</button>
          ))}
        </div>
      )}
    </>
  )
}

function SheetTable({ ws, X }: { ws: WorkSheet; X: typeof import('xlsx') }) {
  const model = useMemo(() => {
    const ref = ws['!ref']
    if (!ref) return null
    const full = X.utils.decode_range(ref)
    const r0 = full.s.r, c0 = full.s.c
    const r1 = Math.min(full.e.r, r0 + MAX_ROWS - 1)
    const c1 = Math.min(full.e.c, c0 + MAX_COLS - 1)
    // 非表示の行/列はモデルから除く（幅0では padding 分の細い列が残り中身も見える）
    const rows: number[] = []
    for (let r = r0; r <= r1; r++) if (!ws['!rows']?.[r]?.hidden) rows.push(r)
    const cols: number[] = []
    for (let c = c0; c <= c1; c++) if (!ws['!cols']?.[c]?.hidden) cols.push(c)
    // 結合セル: 表示窓と交差する部分だけを扱う（A1:XFD1048576 のような巨大結合でも
    // 窓の外まで列挙しない）。左上（＝窓内で最初に見える行/列）に span、残りは描画しない。
    const span = new Map<string, { rs: number; cs: number; src: { r: number; c: number } }>()
    const covered = new Set<string>()
    for (const m of ws['!merges'] ?? []) {
      const mr = rows.filter(r => r >= m.s.r && r <= m.e.r)
      const mc = cols.filter(c => c >= m.s.c && c <= m.e.c)
      if (!mr.length || !mc.length) continue
      // 値は結合の左上 (m.s) にある — 先頭の行/列が非表示でもそこから読む
      span.set(`${mr[0]},${mc[0]}`, { rs: mr.length, cs: mc.length, src: m.s })
      for (const r of mr) for (const c of mc) {
        if (r !== mr[0] || c !== mc[0]) covered.add(`${r},${c}`)
      }
    }
    const widths = cols.map(c => {
      const col = ws['!cols']?.[c]
      const px = col?.wpx ?? (col?.wch ? col.wch * 7 + 5 : undefined) ?? 72
      return Math.max(24, Math.min(480, Math.round(px)))
    })
    return { rows, cols, span, covered, widths, truncated: full.e.r > r1 || full.e.c > c1, fullRows: full.e.r - r0 + 1, fullCols: full.e.c - c0 + 1 }
  }, [ws, X])

  if (!model) return <Notice text="シートが空です" />
  const { span, covered, widths, truncated } = model
  const rows: React.ReactNode[] = []
  for (const r of model.rows) {
    const cells: React.ReactNode[] = [<th key="h" className="xl-rowhead">{r + 1}</th>]
    for (const c of model.cols) {
      const key = `${r},${c}`
      if (covered.has(key)) continue
      const sp = span.get(key)
      const cell = ws[X.utils.encode_cell(sp ? sp.src : { r, c })]
      const text = cell ? (cell.w ?? (cell.v == null ? '' : String(cell.v))) : ''
      const numeric = cell?.t === 'n' || cell?.t === 'd'
      cells.push(
        <td key={c} rowSpan={sp?.rs} colSpan={sp?.cs} className={numeric ? 'text-right' : undefined} title={cell?.f ? `=${cell.f}` : undefined}>
          {text}
        </td>
      )
    }
    rows.push(<tr key={r}>{cells}</tr>)
  }
  const colHeads: React.ReactNode[] = [<th key="corner" className="xl-corner" />]
  for (const c of model.cols) colHeads.push(<th key={c} className="xl-colhead">{X.utils.encode_col(c)}</th>)

  return (
    <div className="m-auto">
      {truncated && (
        <div className="sticky left-0 mx-auto mb-2 w-fit max-w-full px-3 py-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded">
          大きなシートのため先頭 {Math.min(model.fullRows, MAX_ROWS)} 行 × {Math.min(model.fullCols, MAX_COLS)} 列のみ表示しています（全体: {model.fullRows} 行 × {model.fullCols} 列）
        </div>
      )}
      <table className="xl-table">
        <colgroup>
          <col style={{ width: 40 }} />
          {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <thead><tr>{colHeads}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}

/* ── PowerPoint ── */

// スライドは固定幅で一度だけ描き、ペイン幅への追従は CSS zoom で行う。
// 幅が変わるたびに描き直すと「描画→縦スクロールバー出現→幅が縮む→描き直し
// （中身が消えてバーも消える）→幅が戻る→…」の無限ループになる（Windows の
// 非オーバーレイ型スクロールバーで発生）。scrollbar-gutter: stable でも幅を固定する。
const PPTX_BASE_W = 960

function PptxView({ buf }: { buf: ArrayBuffer }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => {
      const z = Math.min(2, Math.max(0.2, (el.clientWidth - 32) / PPTX_BASE_W))
      // 端数の揺れで再レンダーし続けないよう、変化が小さければ据え置き
      setZoom(prev => (Math.abs(prev - z) < 0.005 ? prev : z))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let alive = true
    let previewer: { destroy: () => void } | null = null
    host.replaceChildren()
    import('pptx-preview')
      .then(({ init }) => {
        if (!alive) return
        const p = init(host, { width: PPTX_BASE_W, mode: 'list' })
        previewer = p
        return p.preview(buf.slice(0))
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => {
      alive = false
      try { previewer?.destroy() } catch { /* ignore */ }
      host.replaceChildren()
    }
  }, [buf])

  if (error) return <Notice text={`PowerPoint 文書を表示できませんでした: ${error}`} />
  return (
    <div ref={boxRef} className="flex-1 min-h-0 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
      <div ref={hostRef} className="office-pptx mx-auto py-4" style={{ width: PPTX_BASE_W, zoom: zoom || undefined, visibility: zoom ? undefined : 'hidden' }} />
    </div>
  )
}
