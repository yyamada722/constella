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

export interface TweetMediaBlob { key: string; bytes: Uint8Array; mime: string }

const isKey = (v: unknown): v is string => typeof v === 'string' && v.startsWith('@tw')

/**
 * main から届いたメディアを保存して、tweet 内の一時キー (@tw0…) を idb: に置き換える。
 * 保存できなかった / 届かなかったキーは消す (表示側は remoteUrl にフォールバック)。
 */
export async function storeTweetMedia(tweet: TweetClip, blobs: TweetMediaBlob[]): Promise<TweetClip> {
  const refs = new Map<string, string>()
  await Promise.all((blobs ?? []).map(async b => {
    try {
      const ref = await putMedia(new Blob([b.bytes as BlobPart], { type: b.mime || 'application/octet-stream' }))
      refs.set(b.key, ref)
    } catch { /* 1 件の失敗で全体を止めない */ }
  }))
  const bind = (v: string | undefined): string | undefined => (isKey(v) ? refs.get(v) : v)
  const bindOne = <T extends Omit<TweetClip, 'quoted' | 'capturedAt' | 'source'>>(t: T): T => ({
    ...t,
    avatar: bind(t.avatar),
    card: t.card ? { ...t.card, image: bind(t.card.image) } : undefined,
    media: (t.media ?? []).map((m: TweetMedia) => ({ ...m, file: bind(m.file), poster: bind(m.poster) })),
  })
  return { ...bindOne(tweet), quoted: tweet.quoted ? bindOne(tweet.quoted) : undefined }
}

/** レンダラーで受け付ける形かの最低限の検査 (main 由来だが DB に入るので)。 */
export function isTweetClip(v: unknown): v is TweetClip {
  const t = v as TweetClip
  return !!t && typeof t === 'object' && typeof t.id === 'string' && /^\d{1,25}$/.test(t.id)
    && typeof t.url === 'string' && typeof t.text === 'string' && Array.isArray(t.media) && Array.isArray(t.links)
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
