import { BoardColor, Project } from '../types'

// Default palette rotation so boards have a recognisable colour even before the user picks one.
const FALLBACK_PALETTE: BoardColor[] = ['emerald', 'indigo', 'rose', 'amber', 'sky', 'violet', 'fuchsia', 'slate']

export function boardColorFor(project: Project, indexInList: number): BoardColor {
  return project.color ?? FALLBACK_PALETTE[indexInList % FALLBACK_PALETTE.length]
}

// Pre-built Tailwind class strings so the JIT detects them.
// (Building them via template literals would be invisible to the purge step.)
export const BOARD_COLOR_CLASSES: Record<BoardColor, {
  dot: string         // small swatch / sidebar dot
  bg: string          // chip / pill background
  bgSoft: string      // very pale row tint
  text: string        // chip text
  border: string      // chip border
  ring: string        // hover/selected ring
  stripe: string      // 3-4px accent stripe on bars
}> = {
  slate:   { dot: 'bg-slate-500',   bg: 'bg-slate-100',    bgSoft: 'bg-slate-50/60',    text: 'text-slate-700',   border: 'border-slate-300',   ring: 'ring-slate-400',   stripe: 'bg-slate-500' },
  emerald: { dot: 'bg-emerald-500', bg: 'bg-emerald-100',  bgSoft: 'bg-emerald-50/60',  text: 'text-emerald-700', border: 'border-emerald-300', ring: 'ring-emerald-400', stripe: 'bg-emerald-500' },
  indigo:  { dot: 'bg-indigo-500',  bg: 'bg-indigo-100',   bgSoft: 'bg-indigo-50/60',   text: 'text-indigo-700',  border: 'border-indigo-300',  ring: 'ring-indigo-400',  stripe: 'bg-indigo-500' },
  rose:    { dot: 'bg-rose-500',    bg: 'bg-rose-100',     bgSoft: 'bg-rose-50/60',     text: 'text-rose-700',    border: 'border-rose-300',    ring: 'ring-rose-400',    stripe: 'bg-rose-500' },
  amber:   { dot: 'bg-amber-500',   bg: 'bg-amber-100',    bgSoft: 'bg-amber-50/60',    text: 'text-amber-700',   border: 'border-amber-300',   ring: 'ring-amber-400',   stripe: 'bg-amber-500' },
  sky:     { dot: 'bg-sky-500',     bg: 'bg-sky-100',      bgSoft: 'bg-sky-50/60',      text: 'text-sky-700',     border: 'border-sky-300',     ring: 'ring-sky-400',     stripe: 'bg-sky-500' },
  violet:  { dot: 'bg-violet-500',  bg: 'bg-violet-100',   bgSoft: 'bg-violet-50/60',   text: 'text-violet-700',  border: 'border-violet-300',  ring: 'ring-violet-400',  stripe: 'bg-violet-500' },
  fuchsia: { dot: 'bg-fuchsia-500', bg: 'bg-fuchsia-100',  bgSoft: 'bg-fuchsia-50/60',  text: 'text-fuchsia-700', border: 'border-fuchsia-300', ring: 'ring-fuchsia-400', stripe: 'bg-fuchsia-500' },
}

export const ALL_BOARD_COLORS: BoardColor[] = ['emerald', 'indigo', 'rose', 'amber', 'sky', 'violet', 'fuchsia', 'slate']
