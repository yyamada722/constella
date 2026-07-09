export const GRID_SIZE = 40;
export const GRID_OFFSET = 20;

export function snapToGrid(value: number): number {
  return Math.round((value - GRID_OFFSET) / GRID_SIZE) * GRID_SIZE + GRID_OFFSET;
}

export function snapPoint(x: number, y: number): { x: number; y: number } {
  return { x: snapToGrid(x), y: snapToGrid(y) };
}
