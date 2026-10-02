import type { CustomStatus, Task } from '../types'
import type { CSSProperties } from 'react'

// カスタムステータス = ボードに「状態」として登録されたタグ。
// タスク側はただのタグ (task.tags に name が入る) なので、同期/受け渡し/スクリプト/
// エクスポートの既存経路にスキーマ変更なしで乗る。定義 (name → 基本状態 + 色) は
// Project.customStatuses が持つ。基本状態 (todo/進行中/完了) の細分化であり、
// カンバンの列は従来どおり基本状態の3列。

export type BaseStatus = Task['status']

/** 基本状態の巡回順 (ステータスピルのクリック循環の骨格)。 */
export const BASE_STATUS_ORDER: BaseStatus[] = ['todo', 'in-progress', 'done']

/** ピル循環の1ステップ: 基本状態そのもの (customId=null) か、その細分化。 */
export interface StatusStep { status: BaseStatus; customId: string | null }

export const stepKey = (s: StatusStep) => `${s.status}|${s.customId ?? ''}`

/** 未着手 → [未着手の細分] → 進行中 → [進行中の細分] → 完了 → [完了の細分] → … */
export function statusCycle(defs: CustomStatus[] | undefined): StatusStep[] {
  const out: StatusStep[] = []
  for (const base of BASE_STATUS_ORDER) {
    out.push({ status: base, customId: null })
    for (const d of defs ?? []) if (d.base === base) out.push({ status: base, customId: d.id })
  }
  return out
}

/** タスクの現在のカスタムステータス。基本状態と一致するものだけ有効。 */
export function customStatusOf(task: Pick<Task, 'status' | 'tags'>, defs: CustomStatus[] | undefined): CustomStatus | undefined {
  if (!defs?.length) return undefined
  return defs.find(d => d.base === task.status && task.tags.includes(d.name))
}

export function currentStep(task: Pick<Task, 'status' | 'tags'>, defs: CustomStatus[] | undefined): StatusStep {
  return { status: task.status, customId: customStatusOf(task, defs)?.id ?? null }
}

/** ステップを適用: 遷移元・遷移先の基本状態に属する状態タグを外してから選んだものだけ
 *  付ける。無関係な基本状態の同名タグは普通のタグなので残す。 */
export function applyStep(task: Task, defs: CustomStatus[] | undefined, step: StatusStep): Task {
  const names = new Set((defs ?? []).filter(d => d.base === task.status || d.base === step.status).map(d => d.name))
  const def = step.customId ? defs?.find(d => d.id === step.customId) : undefined
  const tags = task.tags.filter(t => !names.has(t))
  if (def && def.base === step.status) tags.push(def.name)
  return { ...task, status: step.status, tags }
}

/** 不変条件の正規化。登録名と同じタグでも、基本状態が違うタスクでは「普通のタグ」として扱う
 *  (ユーザーが元々付けていたタグを黙って消さないため)。消すのは次の2つだけ:
 *  - 状態遷移 (prevStatus → task.status) 時の、旧基本状態に属する状態タグ
 *  - 現在の基本状態に属する状態タグが複数あるとき、customStatusOf が選ぶもの (定義順で先)
 *    以外 — 表示と正規化の結果を一致させる
 *  reducer (ADD_TASK / UPDATE_TASK / SET_PROJECT_TASKS) がどの経路でもこれを通す。 */
export function normalizeCustomStatus(task: Task, defs: CustomStatus[] | undefined, prevStatus?: Task['status']): Task {
  if (!defs?.length || task.tags.length === 0) return task
  const byName = new Map(defs.map(d => [d.name, d]))
  const chosen = customStatusOf(task, defs)
  const transitioned = prevStatus !== undefined && prevStatus !== task.status
  const tags = task.tags.filter(t => {
    const d = byName.get(t)
    if (!d) return true
    if (d.base === task.status) return d === chosen
    return !(transitioned && d.base === prevStatus)
  })
  return tags.length === task.tags.length ? task : { ...task, tags }
}

/** 表示用: 状態タグ以外のタグ (現在の基本状態に属する登録タグだけを除く)。 */
export function plainTags(task: Pick<Task, 'status' | 'tags'>, defs: CustomStatus[] | undefined): string[] {
  if (!defs?.length) return task.tags
  const names = new Set(defs.filter(d => d.base === task.status).map(d => d.name))
  return task.tags.filter(t => !names.has(t))
}

// ── 色 ────────────────────────────────────────────────────────────────
// 任意色 (#rrggbb)。パレット名で保存された旧値も hex に読み替える。
const NAMED_HEX: Record<string, string> = {
  slate: '#64748b', emerald: '#10b981', indigo: '#6366f1', rose: '#f43f5e',
  amber: '#f59e0b', sky: '#0ea5e9', violet: '#8b5cf6', fuchsia: '#d946ef',
}
export const DEFAULT_STATUS_HEX: Record<BaseStatus, string> = { 'todo': '#0ea5e9', 'in-progress': '#8b5cf6', 'done': '#10b981' }
/** 新規作成時の候補色 (使用中を避けて順に)。 */
export const STATUS_HEX_PRESETS = ['#8b5cf6', '#0ea5e9', '#f59e0b', '#f43f5e', '#10b981', '#d946ef', '#6366f1', '#14b8a6', '#f97316', '#64748b']

export function statusHex(c: string | undefined): string {
  if (!c) return '#64748b'
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase()
  return NAMED_HEX[c] ?? '#64748b'
}

type RGB = [number, number, number]
const hexToRgb = (hex: string): RGB => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as RGB
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: RGB, b: RGB) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t)) as RGB

// 文字色: 指定色を黒 (ライト) / 白 (ダーク) へ少しずつ寄せ、チップ背景
// (指定色16% + 地色) に対してコントラスト 4.5 以上になる最初の色を採用する。
// 白や黒のような極端な色でも 9px のラベルが読めるように。
function readableOn(hex: string, page: RGB, toward: RGB): string {
  const base = hexToRgb(hex)
  const bg = mix(page, base, 0.16)
  for (let t = 0.35; t <= 1.0001; t += 0.05) {
    const fg = mix(base, toward, t)
    if (contrast(fg, bg) >= 4.5) return `rgb(${fg.join(',')})`
  }
  return `rgb(${toward.join(',')})`
}
const fgCache = new Map<string, { l: string; d: string }>()

/** ピル/チップ用のインラインスタイル。要素には data-cs 属性も付けること —
 *  文字色はライト/ダーク別に計算した --cs-fg-l / --cs-fg-d を index.css が
 *  テーマに応じて選ぶ。 */
export function statusChipStyle(c: string | undefined): CSSProperties {
  const hex = statusHex(c)
  let fg = fgCache.get(hex)
  if (!fg) {
    fg = { l: readableOn(hex, [255, 255, 255], [0, 0, 0]), d: readableOn(hex, [38, 38, 38], [255, 255, 255]) }
    fgCache.set(hex, fg)
  }
  return {
    backgroundColor: `color-mix(in srgb, ${hex} 16%, transparent)`,
    borderColor: `color-mix(in srgb, ${hex} 55%, transparent)`,
    ['--cs-fg-l' as string]: fg.l,
    ['--cs-fg-d' as string]: fg.d,
  } as CSSProperties
}
export const statusDotStyle = (c: string | undefined): CSSProperties => ({ backgroundColor: statusHex(c) })
