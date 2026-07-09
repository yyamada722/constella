interface Point {
  x: number;
  y: number;
}

export function metroPath(points: Point[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx === 0 || ady === 0 || adx === ady) {
      d += ` L ${b.x} ${b.y}`;
    } else {
      const minD = Math.min(adx, ady);
      const sx = Math.sign(dx);
      const sy = Math.sign(dy);
      const midX = a.x + sx * minD;
      const midY = a.y + sy * minD;
      d += ` L ${midX} ${midY} L ${b.x} ${b.y}`;
    }
  }
  return d;
}

function metroLegs(a: Point, b: Point): [Point, Point][] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx === 0 || ady === 0 || adx === ady) {
    return [[a, b]];
  }
  const minD = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const mid = { x: a.x + sx * minD, y: a.y + sy * minD };
  return [
    [a, mid],
    [mid, b],
  ];
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * クリック位置が路線の途中区間上に近い場合、挿入位置（stationIds 配列のインデックス）を返す。
 * 近い区間がなければ null。
 */
export function findInsertionIndex(
  stationsOnLine: Point[],
  click: Point,
  threshold: number
): number | null {
  let bestIndex: number | null = null;
  let bestDist = threshold;
  for (let i = 0; i < stationsOnLine.length - 1; i++) {
    const a = stationsOnLine[i];
    const b = stationsOnLine[i + 1];
    const legs = metroLegs(a, b);
    for (const [la, lb] of legs) {
      const d = distanceToSegment(click, la, lb);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i + 1;
      }
    }
  }
  return bestIndex;
}
