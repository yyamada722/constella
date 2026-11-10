// 取り込んだ X (Twitter) ツイートの表示。メディアは保存済み (idb:) を優先し、
// 保存できなかったものだけ元の URL で表示する。
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Link2, MessageCircle, Play, Plus, X as XIcon } from 'lucide-react'
import type { TweetClip, TweetMedia } from '../types'
import { useMediaState, useMediaUrl } from '../persistence/media'
import { ZoomableImage } from './ZoomableImage'

type TweetBody = Omit<TweetClip, 'quoted' | 'capturedAt' | 'source'>

export interface TweetViewProps {
  tweet: TweetClip
  onOpenLink: (url: string) => void // アプリ内ブラウザで開く
  onSaveLink?: (url: string, title: string) => void // リンク先をリサーチに追加
}

const URL_SPLIT = /(https?:\/\/[^\s<>"'）」』】]+)/g

function TweetText({ text, onOpenLink }: { text: string; onOpenLink: (u: string) => void }) {
  const parts = text.split(URL_SPLIT)
  return (
    <p className="text-[15px] leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
      {parts.map((p, i) => i % 2 === 1 ? (
        <button key={i} onClick={() => onOpenLink(p)} className="text-sky-600 hover:underline break-all text-left" title={p}>
          {p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}{p.replace(/^https?:\/\/(www\.)?/, '').length > 60 ? '…' : ''}
        </button>
      ) : p.split(/((?:^|(?<=\s))[#＃@][\p{L}\p{N}_]+)/u).map((q, j) => (
        j % 2 === 1 // split のキャプチャ (= ハッシュタグ/メンション) は奇数番目だけ
          ? <button key={`${i}-${j}`} onClick={() => onOpenLink(q.startsWith('@') ? `https://x.com/${q.slice(1)}` : `https://x.com/hashtag/${encodeURIComponent(q.slice(1))}`)} className="text-sky-600 hover:underline">{q}</button>
          : <span key={`${i}-${j}`}>{q}</span>
      )))}
    </p>
  )
}

function Avatar({ tweet, size }: { tweet: TweetBody; size: number }) {
  const url = useMediaUrl(tweet.avatar)
  return url
    ? <img src={url} alt="" className="rounded-full shrink-0 object-cover bg-slate-200" style={{ width: size, height: size }} />
    : <div className="rounded-full shrink-0 bg-slate-200 flex items-center justify-center text-slate-500 font-semibold" style={{ width: size, height: size, fontSize: size * 0.4 }}>{(tweet.authorName || tweet.authorHandle || '?').slice(0, 1)}</div>
}

function MediaTile({ m, onZoom, tall }: { m: TweetMedia; onZoom: () => void; tall: boolean }) {
  const storedState = useMediaState(m.file)
  const poster = useMediaUrl(m.poster)
  // 保存データの読み出し中だけ待つ。見つからない (同期待ち・欠落) ときは元の URL で表示
  const loading = !!m.file && storedState.status === 'loading'
  const src = storedState.url ?? (loading ? undefined : m.remoteUrl)
  const box = `relative overflow-hidden bg-slate-900/5 ${tall ? 'h-full' : ''}`
  if (m.kind === 'image') {
    return (
      <button onClick={onZoom} className={`${box} block w-full`} title={m.alt || '拡大'}>
        {src ? <img src={src} alt={m.alt ?? ''} className={`w-full ${tall ? 'h-full' : 'max-h-[520px]'} object-cover`} /> : <div className="h-40 flex items-center justify-center text-xs text-slate-400">画像なし</div>}
      </button>
    )
  }
  if (!src && loading) {
    // 保存済み動画の読み出し中
    return <div className={`${box} min-h-40 bg-black`}>{poster && <img src={poster} alt="" className="w-full h-full object-cover" />}</div>
  }
  if (!src) {
    // 実体を取れなかった動画 (ページから取り込んだ等) — サムネイルだけ出し、元ツイートで再生
    return (
      <div className={`${box} flex items-center justify-center min-h-40`}>
        {poster && <img src={poster} alt="" className="w-full h-full object-cover opacity-80" />}
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white text-xs bg-black/30">
          <Play size={28} /> 動画は元ツイートで再生
        </span>
      </div>
    )
  }
  const gif = m.kind === 'gif'
  return (
    <div className={box}>
      <video
        src={src}
        poster={poster}
        controls={!gif}
        autoPlay={gif}
        loop={gif}
        muted={gif}
        playsInline
        preload="metadata"
        className={`w-full ${tall ? 'h-full object-cover' : 'max-h-[560px]'} bg-black`}
      />
      {gif && <span className="absolute left-2 bottom-2 text-[10px] font-bold px-1 rounded bg-black/70 text-white">GIF</span>}
    </div>
  )
}

function MediaGrid({ media, onZoom }: { media: TweetMedia[]; onZoom: (i: number) => void }) {
  if (!media.length) return null
  if (media.length === 1) {
    return <div className="mt-3 rounded-2xl overflow-hidden border border-slate-200"><MediaTile m={media[0]} onZoom={() => onZoom(0)} tall={false} /></div>
  }
  return (
    <div className={`mt-3 rounded-2xl overflow-hidden border border-slate-200 grid grid-cols-2 gap-0.5 ${media.length > 2 ? 'grid-rows-2 h-[360px]' : 'h-[280px]'}`}>
      {media.slice(0, 4).map((m, i) => (
        <div key={i} className={media.length === 3 && i === 0 ? 'row-span-2' : ''}>
          <MediaTile m={m} onZoom={() => onZoom(i)} tall />
        </div>
      ))}
    </div>
  )
}

function LinkCard({ card, onOpenLink }: { card: NonNullable<TweetClip['card']>; onOpenLink: (u: string) => void }) {
  const img = useMediaUrl(card.image)
  return (
    <button onClick={() => onOpenLink(card.url)} className="mt-3 w-full text-left rounded-2xl overflow-hidden border border-slate-200 hover:bg-slate-50 transition-colors flex">
      {img && <img src={img} alt="" className="w-32 h-32 object-cover shrink-0 bg-slate-100" />}
      <div className="p-3 min-w-0 flex flex-col justify-center gap-0.5">
        <span className="text-[11px] text-slate-500 truncate">{card.domain || hostOf(card.url)}</span>
        {card.title && <span className="text-sm font-medium text-slate-800 line-clamp-2">{card.title}</span>}
        {card.description && <span className="text-xs text-slate-500 line-clamp-2">{card.description}</span>}
      </div>
    </button>
  )
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

function Lightbox({ media, index, onClose }: { media: TweetMedia[]; index: number; onClose: () => void }) {
  const images = media.filter(m => m.kind === 'image')
  const [i, setI] = useState(() => Math.max(0, images.indexOf(media[index])))
  const cur = images[i]
  const stored = useMediaUrl(cur?.file)
  const src = stored ?? cur?.remoteUrl
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowRight') setI(v => Math.min(images.length - 1, v + 1))
      if (e.key === 'ArrowLeft') setI(v => Math.max(0, v - 1))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [images.length, onClose])
  if (!cur) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="absolute inset-10 flex items-center justify-center">{src && <ZoomableImage key={src} src={src} alt={cur.alt} />}</div>
      <button onClick={onClose} className="absolute right-4 top-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white" title="閉じる (Esc)"><XIcon size={18} /></button>
      {images.length > 1 && (
        <>
          <button disabled={i === 0} onClick={() => setI(i - 1)} className="absolute left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-30"><ChevronLeft size={22} /></button>
          <button disabled={i === images.length - 1} onClick={() => setI(i + 1)} className="absolute right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-30"><ChevronRight size={22} /></button>
          <span className="absolute bottom-4 text-xs text-white/70">{i + 1} / {images.length}</span>
        </>
      )}
      {cur.alt && <p className="absolute bottom-10 max-w-2xl text-center text-xs text-white/80 px-4">{cur.alt}</p>}
    </div>
  )
}

function Header({ tweet, small }: { tweet: TweetBody; small?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Avatar tweet={tweet} size={small ? 20 : 44} />
      <div className={`min-w-0 ${small ? 'flex items-center gap-1' : ''}`}>
        <p className={`font-bold text-slate-900 truncate ${small ? 'text-[13px]' : 'text-[15px]'}`}>{tweet.authorName}</p>
        <p className={`text-slate-500 truncate ${small ? 'text-[13px]' : 'text-[13px]'}`}>@{tweet.authorHandle}</p>
      </div>
    </div>
  )
}

export function TweetView({ tweet, onOpenLink, onSaveLink }: TweetViewProps) {
  const [zoom, setZoom] = useState<{ media: TweetMedia[]; index: number } | null>(null)
  const when = tweet.createdAt ? new Date(tweet.createdAt) : null
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
      <article className="max-w-[640px] mx-auto my-6 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
        <Header tweet={tweet} />
        <div className="mt-3"><TweetText text={tweet.text} onOpenLink={onOpenLink} /></div>
        <MediaGrid media={tweet.media} onZoom={i => setZoom({ media: tweet.media, index: i })} />
        {tweet.card && <LinkCard card={tweet.card} onOpenLink={onOpenLink} />}
        {tweet.quoted && (
          <div className="mt-3 rounded-2xl border border-slate-200 p-3 hover:bg-slate-50/60">
            <Header tweet={tweet.quoted} small />
            <div className="mt-1.5 text-sm"><TweetText text={tweet.quoted.text} onOpenLink={onOpenLink} /></div>
            <MediaGrid media={tweet.quoted.media} onZoom={i => setZoom({ media: tweet.quoted!.media, index: i })} />
            <button onClick={() => onOpenLink(tweet.quoted!.url)} className="mt-2 text-[11px] text-slate-400 hover:text-sky-600">引用元を開く</button>
          </div>
        )}
        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-4 text-[13px] text-slate-500 flex-wrap">
          {when && <span>{when.toLocaleString()}</span>}
          {tweet.replies != null && <span className="inline-flex items-center gap-1"><MessageCircle size={13} /> {tweet.replies.toLocaleString()}</span>}
          {tweet.likes != null && <span className="inline-flex items-center gap-1"><Heart size={13} /> {tweet.likes.toLocaleString()}</span>}
          <button onClick={() => onOpenLink(tweet.url)} className="ml-auto inline-flex items-center gap-1 text-sky-600 hover:underline">
            <ExternalLink size={12} /> 元ツイートを開く
          </button>
        </div>
        {tweet.links.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-medium text-slate-400 mb-1.5">ツイート内のリンク</p>
            <ul className="space-y-1">
              {tweet.links.map((l, i) => (
                <li key={i} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 bg-slate-50 hover:bg-sky-50">
                  <Link2 size={13} className="text-slate-400 shrink-0" />
                  <button onClick={() => onOpenLink(l.url)} title={l.url} className="flex-1 min-w-0 text-left text-xs text-sky-700 truncate">{l.url}</button>
                  {onSaveLink && (
                    <button
                      onClick={() => onSaveLink(l.url, l.display)}
                      title="このリンク先をリサーチに追加"
                      className="shrink-0 inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 hover:text-emerald-700 hover:border-emerald-300"
                    >
                      <Plus size={10} /> リサーチに追加
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 text-[10px] text-slate-400">
          {new Date(tweet.capturedAt).toLocaleString()} に取り込み{tweet.source === 'page' ? '（ページ表示から）' : ''} — 元ツイートが削除されても、この内容は残ります
        </p>
      </article>
      {zoom && <Lightbox media={zoom.media} index={zoom.index} onClose={() => setZoom(null)} />}
    </div>
  )
}
