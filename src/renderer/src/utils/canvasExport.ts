// キャンバス書き出しヘルパー。
// - freezeVideosForExport: html-to-image は <video> をフレーム描画するとき要素ボックス
//   いっぱいに引き伸ばす（object-fit 無視）ため、縦動画が歪む。スナップショット前に
//   正しいレターボックス合成をした <canvas> を動画の上に重ね、動画自体は filter で除外する。
// - buildShareHtml: Constella を持たない相手にキャンバスを渡すための単一 HTML を組み立てる。
//   本体は toSvg スナップショット（ベクタなので拡大しても文字が滲まない）＋パン/ズームビューア。
//   動画/音声は base64 ブロックとして埋め込み、閲覧時に Blob URL へ変換して再生する
//   （巨大 data URI を src 属性に直書きするとブラウザのメディアローダが失敗しがち）。
//   YouTube/Vimeo/Web カードは file:// の埋め込み制限で iframe が開けないため、
//   サムネイル＋外部リンクのカードとして重ねる。

export function freezeVideosForExport(root: HTMLElement): () => void {
  const restores: Array<() => void> = []
  root.querySelectorAll('video').forEach(v => {
    const w = v.clientWidth
    const h = v.clientHeight
    if (!w || !h) return
    const scale = 2 // toPng の pixelRatio と揃えてフレームを鮮明に保つ
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const style = getComputedStyle(v)
    const bg = style.backgroundColor
    if (bg && bg !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    if (v.readyState >= 2 && v.videoWidth && v.videoHeight) {
      // フレームは一旦別 canvas に描き、taint（CORS なしの外部 https 動画）を検出
      // してからクリーンな場合だけ合成する。汚染 canvas を挿すと html-to-image の
      // toDataURL が SecurityError になり書き出し全体が失敗するため。
      const frame = document.createElement('canvas')
      frame.width = canvas.width
      frame.height = canvas.height
      const fctx = frame.getContext('2d')
      if (fctx) {
        const fit = style.objectFit === 'cover'
          ? Math.max(w / v.videoWidth, h / v.videoHeight)
          : style.objectFit === 'fill'
            ? 0 // fill は素直にボックス全面へ
            : Math.min(w / v.videoWidth, h / v.videoHeight) // contain（アプリの既定）
        if (fit === 0) {
          fctx.drawImage(v, 0, 0, frame.width, frame.height)
        } else {
          const dw = v.videoWidth * fit * scale
          const dh = v.videoHeight * fit * scale
          fctx.drawImage(v, (frame.width - dw) / 2, (frame.height - dh) / 2, dw, dh)
        }
        try {
          fctx.getImageData(0, 0, 1, 1) // taint なら throw
          ctx.drawImage(frame, 0, 0)
        } catch { /* クロスオリジン動画: フレームなし（背景のみ）にして書き出しを守る */ }
      }
    }
    canvas.style.position = 'absolute'
    canvas.style.left = `${v.offsetLeft}px`
    canvas.style.top = `${v.offsetTop}px`
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    v.insertAdjacentElement('afterend', canvas)
    const prev = v.dataset.exportIgnore
    v.dataset.exportIgnore = '1'
    restores.push(() => {
      canvas.remove()
      if (prev === undefined) delete v.dataset.exportIgnore
      else v.dataset.exportIgnore = prev
    })
  })
  return () => restores.forEach(f => f())
}

// IndexedDB / IPC 経由で type が落ちた Blob 用の拡張子ベース MIME 推定。
// メディア要素は MIME 不明だとフォーマット判定に失敗して読み込み中のまま止まることがある。
const EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
}

export function guessMediaMime(nameOrPath: string, fallback: 'video' | 'audio'): string {
  const name = nameOrPath.split(/[\\/]/).pop() || nameOrPath
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return EXT_MIME[ext] ?? (fallback === 'audio' ? 'audio/mpeg' : 'video/mp4')
}

// 書き出し画像の中では操作できない UI（フレーム画像化ボタン・ブックマーク追加行など、
// data-export-hide 付き要素）をスナップショット中だけ visibility:hidden にする。
// filter で DOM から除外するとフレックスレイアウトが詰まって座標がずれるため、
// レイアウトを保ったまま見えなくする。
export function hideExportOnlyUi(): () => void {
  const style = document.createElement('style')
  style.textContent = '[data-export-hide] { visibility: hidden !important }'
  document.head.appendChild(style)
  return () => style.remove()
}

/**
 * 動画 Blob を canvas + MediaRecorder で WebM に再エンコードして縮小する。
 * - 解像度は maxHeight（既定720p）まで落とし、ビットレートは targetBytes に収まるよう逆算
 * - 音声は WebAudio 経由で捕捉（スピーカーには出さない＝無音で変換）
 * - 実時間再生しながら録画するため、動画の長さぶん時間がかかる
 */
export async function transcodeVideoBlob(
  blob: Blob,
  opts: { targetBytes: number; maxHeight?: number; onProgress?: (ratio: number) => void }
): Promise<Blob | null> {
  const url = URL.createObjectURL(blob)
  let audioCtx: AudioContext | null = null
  try {
    const v = document.createElement('video')
    v.src = url
    v.playsInline = true
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res()
      v.onerror = () => rej(new Error('metadata load failed'))
    })
    const dur = v.duration
    if (!isFinite(dur) || dur <= 0) return null
    const maxH = opts.maxHeight ?? 720
    const scale = Math.min(1, maxH / (v.videoHeight || maxH))
    const w = Math.max(2, Math.round(((v.videoWidth || 640) * scale) / 2) * 2)
    const h = Math.max(2, Math.round(((v.videoHeight || 360) * scale) / 2) * 2)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const stream = canvas.captureStream(30)
    try {
      audioCtx = new AudioContext()
      const src = audioCtx.createMediaElementSource(v)
      const dest = audioCtx.createMediaStreamDestination()
      src.connect(dest)
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t))
      // 自動再生ポリシー下では suspended で生成されることがあり、そのままだと
      // 無音トラックを録音してしまう。録画開始前に明示的に resume する。
      await audioCtx.resume().catch(() => { /* ignore */ })
    } catch { /* 音声トラックなし等 */ }
    const audioBits = 96_000
    const videoBits = Math.min(2_500_000, Math.max(250_000, Math.floor((opts.targetBytes * 8 * 0.9) / dur) - audioBits))
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBits, audioBitsPerSecond: audioBits })
    const chunks: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    const done = new Promise<void>(res => { rec.onstop = () => res() })
    let stopped = false
    const stopAll = () => {
      if (stopped) return
      stopped = true
      try { rec.stop() } catch { /* ignore */ }
    }
    const rvfc = (v as unknown as { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback
    const paint = () => {
      if (stopped) return
      ctx.drawImage(v, 0, 0, w, h)
      opts.onProgress?.(Math.min(1, v.currentTime / dur))
      if (v.ended) { stopAll(); return }
      if (rvfc) rvfc.call(v, paint)
      else setTimeout(paint, 33)
    }
    v.onended = () => stopAll()
    // デコードエラーやストールでは ended も onstop も来ず await done が永久待ちに
    // なるため、エラーと経過時間の上限でも必ず録画を終了させる。
    v.onerror = () => stopAll()
    const deadline = setTimeout(stopAll, Math.ceil((dur + 15) * 1000))
    rec.start(1000)
    try {
      await v.play()
    } catch {
      // 自動再生ポリシーで音声付き再生が拒否された場合はミュートで再試行
      // （音声は失われるが変換自体は成立させる）
      v.muted = true
      await v.play()
    }
    paint()
    await done
    clearTimeout(deadline)
    v.pause()
    const out = new Blob(chunks, { type: 'video/webm' })
    return out.size > 0 ? out : null
  } catch {
    return null
  } finally {
    audioCtx?.close().catch(() => { /* ignore */ })
    URL.revokeObjectURL(url)
  }
}

export type ShareOverlay =
  | { kind: 'video' | 'audio'; x: number; y: number; w: number; h: number; base64: string; mime: string; cardId?: string }
  | { kind: 'link'; x: number; y: number; w: number; h: number; href: string; label: string; thumb?: string }
  // ブックマークチップ行 — スナップショット内のチップと同じ位置に重ね、クリックで
  // cardId の動画/音声をシークする
  | { kind: 'marks'; x: number; y: number; w: number; h: number; cardId: string; accent: string; marks: Array<{ t: number; time: string; label: string }> }

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function buildShareHtml(opts: {
  title: string
  width: number
  height: number
  /** toSvg の生 SVG マークアップ（背景透過）。<img> でなくインラインで埋め込むことで
   *  foreignObject 内のテキストが実 DOM になり、選択モードでコピーできる。 */
  snapshotSvg: string
  dark: boolean
  /** 20px スナップグリッドとドットを揃えるためのオフセット */
  gridOffsetX: number
  gridOffsetY: number
  overlays: ShareOverlay[]
}): string {
  const { title, width, height, snapshotSvg, dark, gridOffsetX, gridOffsetY, overlays } = opts
  const bg = dark ? '#171717' : '#ffffff'
  const outerBg = dark ? '#0c0c0d' : '#e2e8f0'
  const barBg = dark ? 'rgba(23,23,23,.88)' : 'rgba(255,255,255,.88)'
  const barFg = dark ? '#d4d4d4' : '#334155'
  const barBorder = dark ? '#333' : '#cbd5e1'

  const mediaBlocks: string[] = []
  const overlayHtml = overlays.map((o, i) => {
    const pos = `position:absolute;left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;`
    if (o.kind === 'link') {
      const thumb = o.thumb ? `background-image:url('${o.thumb}');background-size:cover;background-position:center;` : ''
      return `<a class="ext" href="${escapeHtml(o.href)}" target="_blank" rel="noopener noreferrer" style="${pos}${thumb}" title="${escapeHtml(o.href)}">
    <span class="ext-inner"><span class="ext-play">▶</span><span class="ext-label">${escapeHtml(o.label)}</span><span class="ext-hint">新しいタブで開く ↗</span></span>
  </a>`
    }
    if (o.kind === 'marks') {
      // time は数値へ強制してから埋め込む（インポートした不正データ経由の属性注入を防ぐ）
      const chips = o.marks.map(m => {
        const t = Number(m.t)
        if (!Number.isFinite(t) || t < 0) return ''
        return `<button data-seek="${t}" title="${escapeHtml(m.time)}${m.label ? ' ' + escapeHtml(m.label) : ''} へ移動"><b style="color:${escapeHtml(o.accent)}">${escapeHtml(m.time)}</b>${m.label ? `<span>${escapeHtml(m.label)}</span>` : ''}</button>`
      }).join('')
      if (!chips) return ''
      return `<div class="marks" data-for-card="${escapeHtml(o.cardId)}" style="${pos}">${chips}</div>`
    }
    // 巨大 base64 は src 属性でなく text/plain スクリプトブロックに持たせ、閲覧時に Blob URL 化する
    mediaBlocks.push(`<script type="text/plain" data-media-id="m${i}">${o.base64}</script>`)
    const tag = o.kind === 'audio' ? 'audio' : 'video'
    const extra = o.kind === 'audio' ? '' : 'background:#000;object-fit:contain;'
    const cardAttr = o.cardId ? ` data-card="${escapeHtml(o.cardId)}"` : ''
    return `<${tag} controls preload="metadata" data-media="m${i}" data-mime="${escapeHtml(o.mime)}"${cardAttr} style="${pos}${extra}"></${tag}>`
  }).join('\n  ')

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Constella</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: ${outerBg}; font-family: "IBM Plex Sans JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif; }
  #vp { position: fixed; inset: 0; overflow: hidden; touch-action: none; }
  #vp.panning { cursor: grabbing; }
  #world {
    position: absolute; left: 0; top: 0; transform-origin: 0 0;
    background-color: ${bg};
    background-image: radial-gradient(circle, rgba(100,116,139,0.35) 1px, transparent 1.6px);
    background-size: 20px 20px;
    background-position: ${gridOffsetX}px ${gridOffsetY}px;
    box-shadow: 0 4px 24px rgba(0,0,0,.25);
  }
  #world > svg { position: absolute; left: 0; top: 0; }
  /* 左ドラッグはテキスト選択に使う（パンは右ドラッグ）。パン中だけ選択を止める。 */
  #vp.panning { user-select: none; }
  /* ブックマークチップ行 — スナップショットのチップ列の真上に重なる */
  .marks { position: absolute; display: flex; align-items: center; gap: 4px; overflow: hidden; }
  .marks button {
    display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
    border: none; cursor: pointer; border-radius: 4px; padding: 2px 6px; font-size: 10px;
    background: ${dark ? 'rgba(148,163,184,.25)' : '#f1f5f9'}; color: ${dark ? '#cbd5e1' : '#475569'};
    max-width: 150px; white-space: nowrap;
  }
  .marks button span { overflow: hidden; text-overflow: ellipsis; }
  .marks button b { font-variant-numeric: tabular-nums; }
  .marks button:hover { background: ${dark ? 'rgba(148,163,184,.4)' : '#e2e8f0'}; }
  a.ext { display: block; background-color: #0f172a; border-radius: 0 0 10px 10px; overflow: hidden; text-decoration: none; }
  a.ext .ext-inner {
    position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    background: rgba(15,23,42,.45); color: #fff; text-align: center; padding: 8px; box-sizing: border-box;
    transition: background .15s;
  }
  a.ext:hover .ext-inner { background: rgba(15,23,42,.65); }
  a.ext .ext-play {
    width: 44px; height: 44px; border-radius: 999px; background: rgba(255,255,255,.92); color: #0f172a;
    display: flex; align-items: center; justify-content: center; font-size: 16px; padding-left: 3px; box-sizing: border-box;
  }
  a.ext .ext-label { font-size: 13px; font-weight: 600; max-width: 92%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 3px rgba(0,0,0,.6); }
  a.ext .ext-hint { font-size: 10px; opacity: .85; }
  #bar {
    position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 10px; padding: 6px 14px;
    background: ${barBg}; color: ${barFg}; border: 1px solid ${barBorder}; border-radius: 999px;
    font-size: 12px; backdrop-filter: blur(6px); user-select: none; white-space: nowrap;
  }
  #bar b { font-weight: 600; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
  #bar button {
    border: none; background: none; color: inherit; cursor: pointer; font-size: 14px;
    width: 26px; height: 26px; border-radius: 6px; line-height: 1;
  }
  #bar button:hover { background: rgba(100,116,139,.18); }
  #bar .fit { width: auto; padding: 0 8px; font-size: 11px; }
  #pct { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="vp"><div id="world" style="width:${width}px;height:${height}px">
  ${snapshotSvg}
  ${overlayHtml}
</div></div>
<div id="bar">
  <b>${escapeHtml(title)}</b>
  <span style="opacity:.5">Constella</span>
  <button id="zo" title="縮小">−</button>
  <span id="pct">100%</span>
  <button id="zi" title="拡大">＋</button>
  <button id="fit" class="fit" title="全体表示">全体</button>
  <button id="one" class="fit" title="等倍">100%</button>
  <span style="opacity:.45;font-size:10px">右ドラッグ: 移動 / ホイール: ズーム / 左: 選択</span>
</div>
${mediaBlocks.join('\n')}
<script>
(function () {
  var W = ${width}, H = ${height};
  var vp = document.getElementById('vp');
  var world = document.getElementById('world');
  var pct = document.getElementById('pct');
  var x = 0, y = 0, z = 1;
  function apply() {
    world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + z + ')';
    pct.textContent = Math.round(z * 100) + '%';
  }
  function fit() {
    var vw = vp.clientWidth, vh = vp.clientHeight;
    z = Math.min(vw / W, vh / H, 1) * 0.95;
    x = (vw - W * z) / 2;
    y = (vh - H * z) / 2;
    apply();
  }
  function zoomAt(cx, cy, factor) {
    var nz = Math.min(4, Math.max(0.05, z * factor));
    x = cx - (cx - x) * (nz / z);
    y = cy - (cy - y) * (nz / z);
    z = nz;
    apply();
  }
  vp.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
  }, { passive: false });
  // 右（または中）ボタンのドラッグでパン。左ドラッグはテキスト選択に使う。
  var panning = null;
  var panMoved = false;
  vp.addEventListener('pointerdown', function (e) {
    if (e.button !== 2 && e.button !== 1) return;
    e.preventDefault();
    panning = { px: e.clientX, py: e.clientY, ox: x, oy: y };
    panMoved = false;
    vp.classList.add('panning');
    vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', function (e) {
    if (!panning) return;
    if (Math.abs(e.clientX - panning.px) + Math.abs(e.clientY - panning.py) > 3) panMoved = true;
    x = panning.ox + (e.clientX - panning.px);
    y = panning.oy + (e.clientY - panning.py);
    apply();
  });
  function endPan() { panning = null; vp.classList.remove('panning'); }
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);
  // パン（＝ドラッグ）したときだけコンテキストメニューを抑止。
  // その場で右クリックしただけなら通常のメニュー（選択テキストのコピー等）を出す。
  vp.addEventListener('contextmenu', function (e) {
    if (panMoved) { e.preventDefault(); panMoved = false; }
  });
  document.getElementById('zi').addEventListener('click', function () { zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1.25); });
  document.getElementById('zo').addEventListener('click', function () { zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 0.8); });
  document.getElementById('fit').addEventListener('click', fit);
  document.getElementById('one').addEventListener('click', function () { var f = 1 / z; zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, f); });
  // スナップショット内の入力欄は「見える・選択できる・でも編集不可」にする。
  // テキスト系は readonly のみ（disabled にするとフォーカス・選択・コピーもできなくなる）。
  // readonly が効かない checkbox/radio 等と select は disabled で固定する。
  document.querySelectorAll('#world svg input, #world svg textarea').forEach(function (el) {
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    var textual = el.tagName.toLowerCase() === 'textarea' ||
      ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].indexOf(type) !== -1;
    if (textual) { el.setAttribute('readonly', ''); el.setAttribute('tabindex', '-1'); }
    else el.setAttribute('disabled', '');
  });
  document.querySelectorAll('#world svg select').forEach(function (el) {
    el.setAttribute('disabled', '');
  });
  document.querySelectorAll('#world svg [contenteditable]').forEach(function (el) {
    el.setAttribute('contenteditable', 'false');
  });
  // ブックマークチップ: クリックで同じカードの動画/音声をシークして再生
  document.querySelectorAll('.marks button').forEach(function (b) {
    b.addEventListener('click', function () {
      var cardId = b.closest('.marks').getAttribute('data-for-card');
      var m = document.querySelector('video[data-card="' + cardId + '"], audio[data-card="' + cardId + '"]');
      if (!m) return;
      m.currentTime = parseFloat(b.getAttribute('data-seek')) || 0;
      m.play().catch(function () {});
    });
  });
  window.addEventListener('resize', fit);
  fit();

  // 埋め込みメディア: base64 ブロック → Blob URL（data URI 直指定はブラウザ/サイズ依存で
  // メディアローダが読み込み中のまま止まることがあるため、必ず実バイト列に変換して渡す）
  document.querySelectorAll('[data-media]').forEach(function (el) {
    var blk = document.querySelector('script[data-media-id="' + el.getAttribute('data-media') + '"]');
    if (!blk) return;
    try {
      var b64 = blk.textContent.replace(/\\s+/g, '');
      var bin = atob(b64);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      el.src = URL.createObjectURL(new Blob([u8], { type: el.getAttribute('data-mime') || '' }));
    } catch (err) {
      el.setAttribute('title', 'メディアの読み込みに失敗しました');
    }
  });
})();
</script>
</body>
</html>
`
}
