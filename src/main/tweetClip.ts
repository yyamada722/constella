// X (Twitter) のツイート取り込み。
//
// 本文・メディア・リンクは X の公開埋め込み API (cdn.syndication.twimg.com — 公式の
// 埋め込みウィジェットが使うもの。ログイン不要) から取得し、画像・動画(mp4)を
// ダウンロードしてレンダラーへ渡す。レンダラーが IndexedDB (idb:) に保存するので、
// 元ツイートが消えても見直せ、同期・バックアップの対象にもなる。
//
// 鍵アカウント等で API が使えないときは、Chrome 拡張がページから読んだ内容 (page)
// で代用する。どちらの経路でも、ダウンロードは https の *.twimg.com に限る
// (拡張から渡る URL で任意のホスト・LAN へアクセスさせないため)。
import { ipcMain, net } from 'electron'

export interface TweetMediaOut {
  kind: 'image' | 'video' | 'gif'
  file?: string // 一時キー (レンダラーが idb: に差し替える)
  poster?: string
  remoteUrl?: string
  width?: number
  height?: number
  durationMs?: number
  alt?: string
}

export interface TweetOut {
  id: string
  url: string
  authorName: string
  authorHandle: string
  avatar?: string
  text: string
  createdAt?: string
  links: { url: string; display: string }[]
  media: TweetMediaOut[]
  card?: { url: string; title?: string; description?: string; domain?: string; image?: string }
  quoted?: Omit<TweetOut, 'quoted' | 'capturedAt' | 'source'>
  likes?: number
  replies?: number
  capturedAt: string
  source: 'api' | 'page'
}

export interface TweetBlob { key: string; bytes: Buffer; mime: string }
export interface TweetResult { tweet: TweetOut; media: TweetBlob[]; warnings: string[] }

// 拡張がページから読んだ内容 (browser-extension/popup.js の readTweetFromPage と揃える)。
export interface PageTweet {
  text?: string
  authorName?: string
  authorHandle?: string
  avatarUrl?: string
  createdAt?: string
  images?: string[]
  videos?: { poster?: string }[]
  links?: { url: string; display?: string }[]
}

const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_TOTAL_BYTES = 600 * 1024 * 1024

// x.com / twitter.com / mobile.* / vxtwitter 等の /<user>/status/<id> と /i/status/<id>。
const STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,30}|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})/i

export function parseTweetUrl(raw: string): { id: string; handle?: string } | null {
  const m = STATUS_RE.exec(String(raw || '').trim())
  if (!m) return null
  const handle = /^i(\/web)?$/i.test(m[1]) ? undefined : m[1]
  return { id: m[2], handle }
}

export const canonicalTweetUrl = (id: string, handle?: string): string =>
  `https://x.com/${handle || 'i'}/status/${id}`

const allowedMediaUrl = (u: string | undefined): u is string => {
  if (!u) return false
  try {
    const p = new URL(u)
    return p.protocol === 'https:' && /(^|\.)twimg\.com$/i.test(p.hostname)
  } catch { return false }
}

// 埋め込みウィジェットと同じトークン計算 (id から決まる値。認証情報ではない)。
const syndicationToken = (id: string): string =>
  ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')

const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

async function fetchSyndication(id: string): Promise<Json | null> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=ja&token=${syndicationToken(id)}`
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' })
    if (!res.ok) return null
    const json = await res.json()
    if (!json || json.__typename === 'TweetTombstone' || !json.id_str) return null
    return json
  } catch { return null }
}

async function download(url: string, limit: number, timeoutMs: number): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!allowedMediaUrl(url)) return null
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    if (!res.ok || !res.body) return null
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > limit) { void res.body.cancel(); return null }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { void reader.cancel(); return null }
      chunks.push(value)
    }
    return { bytes: Buffer.concat(chunks), mime: (res.headers.get('content-type') || '').split(';')[0].trim() }
  } catch { return null }
}

// pbs の画像は ?name=orig で原寸。付かないもの (ext_tw_video_thumb 等も可) はそのまま。
const origImage = (u: string): string => {
  try {
    const p = new URL(u)
    if (!/pbs\.twimg\.com$/i.test(p.hostname)) return u
    if (p.pathname.startsWith('/media/')) {
      const m = /^(\/media\/[^.?/]+)(?:\.(\w+))?$/.exec(p.pathname)
      const fmt = p.searchParams.get('format') || m?.[2] || 'jpg'
      if (m) return `https://pbs.twimg.com${m[1]}?format=${fmt}&name=orig`
    }
    return u
  } catch { return u }
}
const largeAvatar = (u: string): string => u.replace(/_(normal|bigger|mini|200x200)(\.\w+)$/, '_400x400$2')

// ── 正規化 (API) ──

function apiText(t: Json): { text: string; links: { url: string; display: string }[] } {
  const chars = Array.from(String(t.text ?? ''))
  const range: [number, number] = Array.isArray(t.display_text_range) ? t.display_text_range : [0, chars.length]
  const visible = chars.slice(range[0], range[1]).join('')
  let text = decodeEntities(visible)
  const links: { url: string; display: string }[] = []
  for (const u of (t.entities?.urls ?? []) as Json[]) {
    if (!u?.url) continue
    const expanded = String(u.expanded_url || u.url)
    text = text.split(u.url).join(expanded)
    // 引用ツイート自身の URL は「引用」として別に出すのでリンク一覧には載せない
    if (t.quoted_tweet && parseTweetUrl(expanded)?.id === t.quoted_tweet.id_str) {
      text = text.split(expanded).join('').trim()
      continue
    }
    links.push({ url: expanded, display: String(u.display_url || expanded) })
  }
  for (const m of (t.entities?.media ?? []) as Json[]) if (m?.url) text = text.split(m.url).join('').trim()
  // display_text_range の外にある t.co (メディア) も念のため除去
  text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, '').trim()
  return { text, links }
}

function bestMp4(variants: Json[]): string[] {
  return (variants ?? [])
    .filter(v => v && (v.content_type === 'video/mp4' || v.type === 'video/mp4'))
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .map(v => String(v.url || v.src))
    .filter(Boolean)
}

interface Pending {
  tweet: Omit<TweetOut, 'quoted' | 'capturedAt' | 'source'>
  jobs: Job[]
}
// メディア取得の予約。key の場所に、取得できたら一時キーを書き込む。
interface Job { urls: string[]; limit: number; timeoutMs: number; assign: (key: string) => void }

function fromApi(t: Json): Pending {
  const user = t.user ?? {}
  const handle = String(user.screen_name || '')
  const { text, links } = apiText(t)
  const jobs: Job[] = []
  const tweet: Pending['tweet'] = {
    id: String(t.id_str),
    url: canonicalTweetUrl(String(t.id_str), handle),
    authorName: String(user.name || handle),
    authorHandle: handle,
    text,
    createdAt: t.created_at ? new Date(t.created_at).toISOString() : undefined,
    links,
    media: [],
    likes: typeof t.favorite_count === 'number' ? t.favorite_count : undefined,
    replies: typeof t.conversation_count === 'number' ? t.conversation_count : undefined,
  }
  if (user.profile_image_url_https) {
    jobs.push({ urls: [largeAvatar(user.profile_image_url_https), user.profile_image_url_https], limit: MAX_IMAGE_BYTES, timeoutMs: 30000, assign: k => { tweet.avatar = k } })
  }
  for (const m of (t.mediaDetails ?? []) as Json[]) {
    const w = m.original_info?.width, h = m.original_info?.height
    if (m.type === 'photo') {
      const item: TweetMediaOut = { kind: 'image', remoteUrl: origImage(m.media_url_https), width: w, height: h, alt: m.ext_alt_text || undefined }
      tweet.media.push(item)
      jobs.push({ urls: [origImage(m.media_url_https), m.media_url_https], limit: MAX_IMAGE_BYTES, timeoutMs: 60000, assign: k => { item.file = k } })
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const mp4s = bestMp4(m.video_info?.variants)
      const item: TweetMediaOut = {
        kind: m.type === 'animated_gif' ? 'gif' : 'video',
        remoteUrl: mp4s[0], width: w, height: h,
        durationMs: m.video_info?.duration_millis || undefined,
        alt: m.ext_alt_text || undefined,
      }
      tweet.media.push(item)
      if (m.media_url_https) jobs.push({ urls: [m.media_url_https], limit: MAX_IMAGE_BYTES, timeoutMs: 30000, assign: k => { item.poster = k } })
      if (mp4s.length) jobs.push({ urls: mp4s, limit: MAX_VIDEO_BYTES, timeoutMs: 300000, assign: k => { item.file = k } })
    }
  }
  const bv = t.card?.binding_values
  if (bv) {
    const s = (k: string): string | undefined => bv[k]?.string_value || undefined
    const img = bv.thumbnail_image_original?.image_value?.url || bv.summary_photo_image_original?.image_value?.url || bv.photo_image_full_size_original?.image_value?.url
    const cardTco = s('card_url') || t.card?.url
    const expanded = (t.entities?.urls ?? []).find((u: Json) => u.url === cardTco)?.expanded_url
    const url = expanded || links[links.length - 1]?.url || cardTco
    if (url && (s('title') || s('description'))) {
      const card: NonNullable<TweetOut['card']> = { url, title: s('title'), description: s('description'), domain: s('vanity_url') || s('domain') }
      tweet.card = card
      if (img) jobs.push({ urls: [img], limit: MAX_IMAGE_BYTES, timeoutMs: 30000, assign: k => { card.image = k } })
    }
  }
  return { tweet, jobs }
}

function fromPage(id: string, handleFromUrl: string | undefined, p: PageTweet): Pending {
  const handle = String(p.authorHandle || handleFromUrl || '').replace(/^@/, '').slice(0, 30)
  const jobs: Job[] = []
  const tweet: Pending['tweet'] = {
    id,
    url: canonicalTweetUrl(id, handle || undefined),
    authorName: String(p.authorName || handle || '').slice(0, 100),
    authorHandle: handle,
    text: String(p.text || '').slice(0, 30000),
    createdAt: p.createdAt && !Number.isNaN(Date.parse(p.createdAt)) ? new Date(p.createdAt).toISOString() : undefined,
    links: (Array.isArray(p.links) ? p.links : [])
      .filter(l => l && /^https?:\/\//i.test(String(l.url)))
      .slice(0, 50)
      .map(l => ({ url: String(l.url).slice(0, 4000), display: String(l.display || l.url).slice(0, 200) })),
    media: [],
  }
  if (allowedMediaUrl(p.avatarUrl)) jobs.push({ urls: [largeAvatar(p.avatarUrl), p.avatarUrl], limit: MAX_IMAGE_BYTES, timeoutMs: 30000, assign: k => { tweet.avatar = k } })
  for (const u of (Array.isArray(p.images) ? p.images : []).slice(0, 8)) {
    if (!allowedMediaUrl(u)) continue
    const item: TweetMediaOut = { kind: 'image', remoteUrl: origImage(u) }
    tweet.media.push(item)
    jobs.push({ urls: [origImage(u), u], limit: MAX_IMAGE_BYTES, timeoutMs: 60000, assign: k => { item.file = k } })
  }
  // ページ上の動画は MSE ストリームで実体 URL が取れないので、サムネイルのみ。
  for (const v of (Array.isArray(p.videos) ? p.videos : []).slice(0, 4)) {
    const item: TweetMediaOut = { kind: 'video' }
    tweet.media.push(item)
    if (allowedMediaUrl(v?.poster)) jobs.push({ urls: [v.poster], limit: MAX_IMAGE_BYTES, timeoutMs: 30000, assign: k => { item.poster = k } })
  }
  return { tweet, jobs }
}

async function runJobs(jobs: Job[], warnings: string[]): Promise<TweetBlob[]> {
  const out: TweetBlob[] = []
  let total = 0
  let n = 0
  let failed = 0
  // 小さいもの (画像) から並列で、動画は 1 本ずつ (帯域とメモリを食い合わないように)
  const small = jobs.filter(j => j.limit <= MAX_IMAGE_BYTES)
  const big = jobs.filter(j => j.limit > MAX_IMAGE_BYTES)
  const runOne = async (j: Job): Promise<void> => {
    for (const u of j.urls) {
      const room = Math.min(j.limit, MAX_TOTAL_BYTES - total)
      if (room <= 0) break
      const got = await download(u, room, j.timeoutMs)
      if (got && got.bytes.length) {
        total += got.bytes.length
        const key = `@tw${n++}`
        out.push({ key, bytes: got.bytes, mime: got.mime })
        j.assign(key)
        return
      }
    }
    failed++
  }
  await Promise.all(small.map(runOne))
  for (const j of big) await runOne(j)
  if (failed) warnings.push(`メディア ${failed} 件を保存できませんでした（元の URL で表示します）`)
  return out
}

/**
 * ツイート URL から取り込み内容を作る。API が使えなければ page (拡張が読んだ内容) で代用。
 * どちらも無ければ null。
 */
export async function clipTweet(rawUrl: string, page?: PageTweet | null): Promise<TweetResult | null> {
  const parsed = parseTweetUrl(rawUrl)
  if (!parsed) return null
  const warnings: string[] = []
  const api = await fetchSyndication(parsed.id)
  let main: Pending
  let quoted: Pending | null = null
  let source: TweetOut['source']
  if (api) {
    main = fromApi(api)
    if (api.quoted_tweet?.id_str) quoted = fromApi(api.quoted_tweet)
    source = 'api'
    // 長文ツイート (note tweet) は API が先頭しか返さないので、ページで読めた全文を優先
    const pageText = String(page?.text || '')
    if (pageText.length > main.tweet.text.length + 10) main.tweet.text = pageText.slice(0, 30000)
  } else if (page && (page.text || page.images?.length)) {
    main = fromPage(parsed.id, parsed.handle, page)
    source = 'page'
    warnings.push('公開APIで取得できなかったため、ページの表示内容から保存しました（動画はサムネイルのみ）')
  } else {
    return null
  }
  const media = await runJobs([...main.jobs, ...(quoted?.jobs ?? [])], warnings)
  const tweet: TweetOut = { ...main.tweet, ...(quoted ? { quoted: quoted.tweet } : {}), capturedAt: new Date().toISOString(), source }
  return { tweet, media, warnings }
}

export const tweetTitle = (t: TweetOut): string => {
  const body = t.text.replace(/\s+/g, ' ').trim()
  const head = `${t.authorName}${t.authorHandle ? ` (@${t.authorHandle})` : ''}`
  return body ? `${head}: ${body.length > 80 ? body.slice(0, 80) + '…' : body}` : head
}

// アプリ内 (リサーチ画面の URL 入力) からの取り込み。
export function registerTweetIpc(): void {
  ipcMain.handle('tweet:clip', async (_e, url: string) => {
    const r = await clipTweet(String(url || ''))
    if (!r) return null
    return { tweet: r.tweet, title: tweetTitle(r.tweet), warnings: r.warnings, media: r.media.map(m => ({ key: m.key, bytes: new Uint8Array(m.bytes.buffer, m.bytes.byteOffset, m.bytes.length), mime: m.mime })) }
  })
}
