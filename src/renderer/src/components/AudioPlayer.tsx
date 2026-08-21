// 音声プレビュー用のDJプレイヤー風コンポーネント。
//  - 波形ストリップ: WebAudio で全体をデコードしてピークを算出、にじんだ
//    カラーストリーク（振幅→色相）で描画。クリック/ドラッグでシーク、白い再生線。
//  - LCDパネル: 7セグ風デジタル時計 (HH:MM:SS.mmm)、残り/総時間、ブロック式
//    プログレスバー、REPEAT インジケータ。
//  - 光沢のある円形ボタン（先頭へ/−10秒/再生/＋10秒/リピート）と音量スライダー。
// ダークな筐体は意図した固定配色なので、ダークテーマ変換に拾われないよう
// 色はインラインスタイルで持つ。
import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react'
import { Play, Pause, SkipBack, Rewind, FastForward, Repeat, Volume2, VolumeX } from 'lucide-react'

/* ── 7セグメント数字 ──
   セグメント: a=上 b=右上 c=右下 d=下 e=左下 f=左上 g=中央 */
const SEG_MAP: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd', '-': 'g',
}
// 各セグメントの六角形ポリゴン（viewBox 0 0 10 18）
const SEG_POLY: Record<string, string> = {
  a: '1.4,0.6 8.6,0.6 7.4,2.0 2.6,2.0',
  b: '9.0,1.0 9.0,8.6 7.8,7.6 7.8,2.2',
  c: '9.0,9.4 9.0,17.0 7.8,15.8 7.8,10.4',
  d: '1.4,17.4 8.6,17.4 7.4,16.0 2.6,16.0',
  e: '1.0,9.4 1.0,17.0 2.2,15.8 2.2,10.4',
  f: '1.0,1.0 1.0,8.6 2.2,7.6 2.2,2.2',
  g: '1.6,9.0 2.6,8.2 7.4,8.2 8.4,9.0 7.4,9.8 2.6,9.8',
}
const LCD_INK = 'rgba(28,32,16,0.88)'
const LCD_GHOST = 'rgba(28,32,16,0.07)'

const SegChar = memo(function SegChar({ ch, h }: { ch: string; h: number }) {
  const w = h * (10 / 18)
  if (ch === ':' || ch === '.') {
    return (
      <svg width={w * 0.42} height={h} viewBox="0 0 4 18" style={{ display: 'block' }}>
        {ch === ':' ? (
          <>
            <rect x="1.2" y="5.2" width="1.9" height="2.2" fill={LCD_INK} />
            <rect x="1.2" y="10.8" width="1.9" height="2.2" fill={LCD_INK} />
          </>
        ) : (
          <rect x="1.2" y="15.2" width="1.9" height="2.2" fill={LCD_INK} />
        )}
      </svg>
    )
  }
  const on = new Set((SEG_MAP[ch] ?? '').split(''))
  return (
    <svg width={w} height={h} viewBox="0 0 10 18" style={{ display: 'block', transform: 'skewX(-5deg)' }}>
      {Object.entries(SEG_POLY).map(([k, pts]) => (
        <polygon key={k} points={pts} fill={on.has(k) ? LCD_INK : LCD_GHOST} />
      ))}
    </svg>
  )
})

function SegText({ text, h }: { text: string; h: number }) {
  return (
    <div style={{ display: 'flex', gap: h * 0.09 }}>
      {text.split('').map((c, i) => <SegChar key={i} ch={c} h={h} />)}
    </div>
  )
}

function fmtLcd(sec: number, withMs: boolean): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const ms = Math.floor((sec % 1) * 1000)
  const s = Math.floor(sec)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return withMs ? `${hh}:${mm}:${ss}.${String(ms).padStart(3, '0')}` : `${hh}:${mm}:${ss}`
}

/* ── 波形ピークの算出（デコード失敗/大きすぎるファイルは null → プレースホルダー描画） ── */
const N_BARS = 160
// 圧縮バイトでの上限。これ以上はデコードせず擬似波形にフォールバック（長尺の
// フルデコードはPCM展開で数百MBに膨らみ、レンダラを固める/OOMの恐れがある）。
const PEAKS_MAX_BYTES = 64 * 1024 * 1024
// 同じ src（object URL は ref 単位でアプリ生存中キャッシュされる）を開き直す度の
// 再デコードを避ける。値は小さい（160 float）ので無制限でよい。
const peaksCache = new Map<string, Float32Array | null>()

async function computePeaks(src: string): Promise<Float32Array | null> {
  if (peaksCache.has(src)) return peaksCache.get(src)!
  const peaks = await computePeaksUncached(src)
  peaksCache.set(src, peaks)
  return peaks
}

async function computePeaksUncached(src: string): Promise<Float32Array | null> {
  try {
    // サイズ判定は ArrayBuffer 実体化の前に行う — blob URL への fetch では
    // res.blob() が元 Blob を参照するだけでコピーしないので、巨大ファイルでも
    // ここまではメモリを食わない。
    const blob = await (await fetch(src)).blob()
    if (blob.size > PEAKS_MAX_BYTES) return null
    const buf = await blob.arrayBuffer()
    // OfflineAudioContext(=8kHz) でデコードすると PCM がその場で 8kHz にリサンプル
    // され、44.1kHz フルデコード比 ~1/5 のメモリで済む（ピーク抽出には十分な解像度）。
    let audio: AudioBuffer
    try {
      const ctx = new OfflineAudioContext(1, 1, 8000)
      audio = await ctx.decodeAudioData(buf.slice(0))
    } catch {
      // 一部コーデックが OfflineAudioContext で失敗する環境向けのフォールバック
      const AC: typeof AudioContext = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
      const ctx = new AC()
      try { audio = await ctx.decodeAudioData(buf) } finally { ctx.close().catch(() => { /* ignore */ }) }
    }
    const ch0 = audio.getChannelData(0)
    const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null
    const peaks = new Float32Array(N_BARS)
    const per = Math.max(1, Math.floor(ch0.length / N_BARS))
    for (let i = 0; i < N_BARS; i++) {
      let max = 0
      const start = i * per
      const end = Math.min(start + per, ch0.length)
      // 全サンプル走査は長尺で重いのでバケット内を間引いて見る
      const step = Math.max(1, Math.floor((end - start) / 500))
      for (let j = start; j < end; j += step) {
        const v = Math.abs(ch1 ? (ch0[j] + ch1[j]) / 2 : ch0[j])
        if (v > max) max = v
      }
      peaks[i] = max
    }
    // 正規化（無音ファイルはゼロ割回避）
    const top = Math.max(0.001, ...peaks)
    for (let i = 0; i < N_BARS; i++) peaks[i] = peaks[i] / top
    return peaks
  } catch {
    return null
  }
}

/* ── 波形キャンバス（にじんだカラーストリーク + 再生済み/未再生の明暗） ── */
function drawWave(canvas: HTMLCanvasElement, peaks: Float32Array | null, progress: number) {
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth, H = canvas.clientHeight
  if (W <= 0 || H <= 0) return
  canvas.width = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.fillStyle = '#0c0a08'
  ctx.fillRect(0, 0, W, H)
  const n = peaks ? peaks.length : N_BARS
  const bw = W / n
  const playedBars = progress * n
  for (let i = 0; i < n; i++) {
    // ピーク未取得（デコード不能/読込中）は控えめな擬似波形を出す
    const amp = peaks ? peaks[i] : 0.25 + 0.2 * Math.abs(Math.sin(i * 0.7)) * Math.abs(Math.cos(i * 0.23))
    const h = Math.max(2, amp * (H - 8))
    // 振幅→色相: 低=深緑(100) → 中=黄(55) → 高=橙赤(18)
    const hue = amp < 0.55 ? 100 - (amp / 0.55) * 45 : 55 - ((amp - 0.55) / 0.45) * 37
    const played = i < playedBars
    const light = played ? 45 + amp * 20 : 22 + amp * 10
    const alpha = played ? 0.95 : 0.55
    const color = `hsla(${hue}, ${played ? 85 : 45}%, ${light}%, ${alpha})`
    ctx.shadowColor = color
    ctx.shadowBlur = played ? 7 : 4
    ctx.fillStyle = color
    const x = i * bw + bw * 0.18
    ctx.fillRect(x, (H - h) / 2, Math.max(1, bw * 0.64), h)
  }
  ctx.shadowBlur = 0
}

/* ── 光沢ボタン ── */
function GlossButton({ onClick, title, size, active, children }: {
  onClick: () => void
  title: string
  size: number
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: size, height: size, borderRadius: '50%',
        background: 'radial-gradient(circle at 32% 26%, #3a3a3e 0%, #1b1b1f 45%, #0a0a0c 100%)',
        border: '1px solid #35353a',
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.14), inset 0 -2px 4px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.5)',
        color: active ? '#a3e635' : 'rgba(255,255,255,0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
      className="transition-transform hover:scale-105 active:scale-95"
    >
      {children}
    </button>
  )
}

/* ── 本体 ── */

export function AudioPlayer({ src, autoPlay = false }: { src: string; autoPlay?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0) // rAF で更新（ms表示のため）
  const [loop, setLoop] = useState(true)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)

  // 波形ピーク算出
  useEffect(() => {
    let alive = true
    setPeaks(null)
    computePeaks(src).then(p => { if (alive) setPeaks(p) })
    return () => { alive = false }
  }, [src])

  // 再生中は rAF で時刻を追う（LCD の ms 表示）
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const a = audioRef.current
      if (a) setTime(a.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const progress = duration > 0 ? Math.min(1, time / duration) : 0

  // 波形再描画: 再生済みバー数が変わったときだけ
  const playedBarCount = Math.floor(progress * N_BARS)
  useEffect(() => {
    const c = canvasRef.current
    if (c) drawWave(c, peaks, progress)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, playedBarCount])
  // リサイズ追従
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ro = new ResizeObserver(() => drawWave(c, peaks, duration > 0 ? Math.min(1, (audioRef.current?.currentTime ?? 0) / duration) : 0))
    ro.observe(c)
    return () => ro.disconnect()
  }, [peaks, duration])

  const seekTo = useCallback((clientX: number, el: HTMLElement) => {
    const a = audioRef.current
    if (!a || !duration) return
    const r = el.getBoundingClientRect()
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    a.currentTime = p * duration
    setTime(a.currentTime)
  }, [duration])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => { /* ignore */ })
    else a.pause()
  }
  const skip = (d: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + d))
    setTime(a.currentTime)
  }

  // ブロック式プログレスバー
  const N_BLOCKS = 26
  const filledBlocks = Math.round(progress * N_BLOCKS)

  return (
    <div
      style={{
        background: 'linear-gradient(180deg, #17151a 0%, #0d0c0f 100%)',
        border: '1px solid #2a282e',
        borderRadius: 14,
        padding: '14px 16px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
        userSelect: 'none',
        width: '100%',
      }}
    >
      <audio
        ref={audioRef}
        src={src}
        autoPlay={autoPlay}
        loop={loop}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={e => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={e => { if (!playing) setTime(e.currentTarget.currentTime) }}
        onEnded={() => setPlaying(false)}
      />
      {/* 波形ストリップ */}
      <div
        style={{ position: 'relative', height: 96, borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#0c0a08', touchAction: 'none' }}
        // pointer イベントでマウスとタッチ（iPadのLANアクセス）両対応のドラッグシーク
        onPointerDown={e => {
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          seekTo(e.clientX, el)
          const onMove = (ev: PointerEvent) => seekTo(ev.clientX, el)
          const onUp = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp) }
          el.addEventListener('pointermove', onMove)
          el.addEventListener('pointerup', onUp)
          el.addEventListener('pointercancel', onUp)
        }}
        title="クリック/ドラッグでシーク"
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        {/* 再生ヘッド */}
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${progress * 100}%`, width: 2, background: 'rgba(255,255,255,0.92)', boxShadow: '0 0 6px rgba(255,255,255,0.8)' }} />
      </div>

      {/* LCD パネル */}
      <div
        style={{
          marginTop: 12,
          background: 'linear-gradient(180deg, #d6dcae 0%, #c2c896 60%, #b8bf8c 100%)',
          borderRadius: 10,
          border: '1px solid #8f9668',
          boxShadow: 'inset 0 2px 8px rgba(60,66,30,0.45), inset 0 -1px 2px rgba(255,255,255,0.4)',
          padding: '10px 14px 12px',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 12 }}>
          <span style={{ fontSize: 9, letterSpacing: 2, fontWeight: 700, color: loop ? LCD_INK : LCD_GHOST }}>REPEAT ALL 1</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 2 }}>
          <SegText text={fmtLcd(time, true)} h={40} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 5 }}>
          <SegText text={`-${fmtLcd(Math.max(0, duration - time), true)}/${fmtLcd(duration, true)}`} h={13} />
        </div>
        {/* ブロック式プログレス */}
        <div
          style={{ display: 'flex', gap: 3, marginTop: 10, cursor: 'pointer', touchAction: 'none' }}
          onPointerDown={e => seekTo(e.clientX, e.currentTarget)}
          title="クリックでシーク"
        >
          {Array.from({ length: N_BLOCKS }, (_, i) => (
            <span key={i} style={{ flex: 1, height: 7, borderRadius: 1.5, background: i < filledBlocks ? LCD_INK : LCD_GHOST }} />
          ))}
        </div>
      </div>

      {/* コントロール */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 14 }}>
        <GlossButton onClick={() => { skip(-1e9); }} title="先頭へ" size={44}><SkipBack size={16} /></GlossButton>
        <GlossButton onClick={() => skip(-10)} title="10秒戻る" size={44}><Rewind size={16} /></GlossButton>
        <GlossButton onClick={toggle} title={playing ? '一時停止' : '再生'} size={64}>
          {playing ? <Pause size={24} /> : <Play size={24} style={{ marginLeft: 3 }} />}
        </GlossButton>
        <GlossButton onClick={() => skip(10)} title="10秒進む" size={44}><FastForward size={16} /></GlossButton>
        <GlossButton onClick={() => setLoop(l => !l)} title={loop ? 'リピート解除' : 'リピート再生'} size={44} active={loop}><Repeat size={15} /></GlossButton>
      </div>

      {/* 音量 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => {
            const a = audioRef.current
            const next = !muted
            setMuted(next)
            if (a) a.muted = next
          }}
          title={muted ? 'ミュート解除' : 'ミュート'}
          style={{ color: 'rgba(255,255,255,0.65)' }}
          className="hover:opacity-80"
        >
          {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={e => {
            const v = Number(e.target.value)
            setVolume(v)
            setMuted(false)
            const a = audioRef.current
            if (a) { a.volume = v; a.muted = false }
          }}
          style={{ width: 180, accentColor: '#d6dcae' }}
          title="音量"
        />
      </div>
    </div>
  )
}
