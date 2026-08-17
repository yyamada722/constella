import type { LabelDir } from '../types';

// 駅名ラベルの8方向レイアウト。路線図ページ（Canvas.tsx）とキャンバスの
// 線路レイヤー / 路線図参照カードで共有 — 片方だけ調整して見た目が
// 食い違わないよう、必ずここを経由すること。
export interface LabelLayout {
  dx: number;
  dy: number;
  anchor: 'start' | 'middle' | 'end';
  baseline: 'auto' | 'middle' | 'hanging';
}

export function getLabelLayout(
  dir: LabelDir,
  halfSize: number,
  strokeW: number
): LabelLayout {
  const corner = halfSize + strokeW / 2;
  const pad = 6;
  const diag = corner + 1;
  switch (dir) {
    case 'n':
      return { dx: 0, dy: -corner - pad, anchor: 'middle', baseline: 'auto' };
    case 'ne':
      return { dx: diag, dy: -diag, anchor: 'start', baseline: 'auto' };
    case 'e':
      return { dx: corner + pad, dy: 0, anchor: 'start', baseline: 'middle' };
    case 'se':
      return { dx: diag, dy: diag, anchor: 'start', baseline: 'hanging' };
    case 's':
      return { dx: 0, dy: corner + pad, anchor: 'middle', baseline: 'hanging' };
    case 'sw':
      return { dx: -diag, dy: diag, anchor: 'end', baseline: 'hanging' };
    case 'w':
      return { dx: -(corner + pad), dy: 0, anchor: 'end', baseline: 'middle' };
    case 'nw':
      return { dx: -diag, dy: -diag, anchor: 'end', baseline: 'auto' };
  }
}
