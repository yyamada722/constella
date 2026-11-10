// X (Twitter) ツイート取り込みのレンダラー側ヘルパー。
// 取得とダウンロードは main (src/main/tweetClip.ts)。ここは受け取ったメディアを
// IndexedDB に保存し、一時キーを idb: 参照へ差し替える。
import type { TweetClip, TweetMedia } from '../types'
import { putMedia } from '../persistence/media'

// src/main/tweetClip.ts の STATUS_RE と揃える。
const STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,30}|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})/i

export function tweetIdFromUrl(raw: string | undefined | null): string | null {
  return STATUS_RE.exec(String(raw || '').trim())?.[2] ?? null
}

// main の一時ファイルに置かれたメディア (中身は tweet:media で 1 件ずつ受け取る)
export interface TweetMediaEntry { key: string; mime: string; size: number }

type TweetIpc = { media: (key: string) => Promise<Uint8Array | null>; release: (keys: string[]) => Promise<void> }
function tweetIpc(): TweetIpc | null {
  return (window as unknown as { api?: { tweet?: TweetIpc } }).api?.tweet ?? null
}

/** 使わなくなったメディアの一時ファイルを main に消させる。 */
export function releaseTweetMedia(entries: TweetMediaEntry[] | undefined): void {
  const keys = (entries ?? []).map(e => e.key)
  if (keys.length) void tweetIpc()?.release(keys).catch(() => { /* main 側も期限で消す */ })
}

const isKey = (v: unknown): v is string => typeof v === 'string' && v.startsWith('@tw')

/**
 * main から届いたメディアを保存して、tweet 内の一時キー (@tw…) を idb: に置き換える。
 * メモリを食わないよう 1 件ずつ受け取って保存する。保存できなかったキーは消し
 * (表示側は remoteUrl にフォールバック)、その件数を failed で返す。
 */
export async function storeTweetMedia(tweet: TweetClip, entries: TweetMediaEntry[]): Promise<{ tweet: TweetClip; failed: number }> {
  const refs = new Map<string, string>()
  const ipc = tweetIpc()
  let failed = 0
  for (const e of entries ?? []) {
    try {
      const bytes = ipc ? await ipc.media(e.key) : null
      if (!bytes) { failed++; continue }
      refs.set(e.key, await putMedia(new Blob([bytes as BlobPart], { type: e.mime || 'application/octet-stream' })))
    } catch {
      failed++ // 容量不足など。1 件の失敗で全体を止めない
    }
  }
  const bind = (v: string | undefined): string | undefined => (isKey(v) ? refs.get(v) : v)
  const bindOne = <T extends Omit<TweetClip, 'quoted' | 'capturedAt' | 'source'>>(t: T): T => ({
    ...t,
    avatar: bind(t.avatar),
    card: t.card ? { ...t.card, image: bind(t.card.image) } : undefined,
    media: (t.media ?? []).map((m: TweetMedia) => ({ ...m, file: bind(m.file), poster: bind(m.poster) })),
  })
  return { tweet: { ...bindOne(tweet), quoted: tweet.quoted ? bindOne(tweet.quoted) : undefined }, failed }
}

/** ツイートが参照している保存済みメディア (idb:) — 引用ツイート分も。 */
export function tweetMediaRefs(t: TweetClip): string[] {
  const out: string[] = []
  for (const tw of [t, t.quoted]) {
    if (!tw) continue
    if (tw.avatar) out.push(tw.avatar)
    if (tw.card?.image) out.push(tw.card.image)
    for (const m of tw.media ?? []) { if (m.file) out.push(m.file); if (m.poster) out.push(m.poster) }
  }
  return out.filter(r => r.startsWith('idb:'))
}

export const mediaFailedWarning = (n: number): string =>
  `画像・動画 ${n} 件をこの PC に保存できませんでした（空き容量を確認してください）。元の URL で表示します`

/** レンダラーで受け付ける形かの最低限の検査 (main 由来だが DB に入るので)。 */
// 表示・メディア収集が読むフィールド (入れ子の引用ツイートも) を検査する。
function isTweetBody(v: unknown): boolean {
  const t = v as TweetClip
  return !!t && typeof t === 'object' && typeof t.id === 'string' && /^\d{1,25}$/.test(t.id)
    && typeof t.url === 'string' && typeof t.text === 'string'
    && typeof t.authorName === 'string' && typeof t.authorHandle === 'string'
    && Array.isArray(t.media) && t.media.every(m => !!m && typeof m === 'object' && typeof (m as { kind?: unknown }).kind === 'string')
    && Array.isArray(t.links) && t.links.every(l => !!l && typeof l === 'object' && typeof l.url === 'string')
    && (t.card == null || (typeof t.card === 'object' && typeof t.card.url === 'string'))
}

export function isTweetClip(v: unknown): v is TweetClip {
  const t = v as TweetClip
  return isTweetBody(t) && typeof t.capturedAt === 'string' && (t.quoted == null || isTweetBody(t.quoted))
}

/** ツイート全体をノート向け Markdown に。 */
export function tweetToMarkdown(t: TweetClip): string {
  const lines: string[] = []
  const when = t.createdAt ? new Date(t.createdAt).toLocaleString() : ''
  lines.push(`> **${t.authorName}** @${t.authorHandle}${when ? ` · ${when}` : ''}`)
  lines.push('>')
  for (const l of t.text.split('\n')) lines.push(`> ${l}`)
  const imgs = t.media.filter(m => m.kind === 'image' && (m.file || m.remoteUrl))
  if (imgs.length) {
    lines.push('')
    for (const m of imgs) lines.push(`![${m.alt ?? ''}](${m.file ?? m.remoteUrl})`)
  }
  if (t.links.length) {
    lines.push('', ...t.links.map(l => `- [${l.display}](${l.url})`))
  }
  if (t.quoted) {
    lines.push('', `> 引用: **${t.quoted.authorName}** @${t.quoted.authorHandle}`, ...t.quoted.text.split('\n').map(l => `> ${l}`), `> ${t.quoted.url}`)
  }
  lines.push('', `出典: ${t.url}`)
  return lines.join('\n')
}
