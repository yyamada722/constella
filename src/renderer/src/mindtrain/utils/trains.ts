import type { StationStatus } from '../types';

// 自動電車の「連続して開業している区間」検出。路線図ページ（Canvas.tsx）と
// キャンバスの線路レイヤーで共有 — run 境界の扱い（末尾フラッシュ・2駅最小）を
// 二重実装しないこと。
export interface DoneRun {
  from: number;
  to: number;
}

export function computeDoneRuns(stations: { status: StationStatus }[]): DoneRun[] {
  const runs: DoneRun[] = [];
  let curStart = -1;
  for (let i = 0; i <= stations.length; i++) {
    const done = i < stations.length && stations[i].status === 'done';
    if (done) {
      if (curStart === -1) curStart = i;
    } else {
      if (curStart !== -1 && i - curStart >= 2) runs.push({ from: curStart, to: i - 1 });
      curStart = -1;
    }
  }
  return runs;
}

// 周回時間（秒）: 駅数に比例、下限3秒。
export const autoTrainDuration = (stationCount: number): number =>
  Math.max(3, stationCount * 1.6);
