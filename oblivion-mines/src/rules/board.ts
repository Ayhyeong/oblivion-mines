import type { Cell, Side } from './types';

export const SIZE = 11;
export const CELL_COUNT = SIZE * SIZE; // 121
export const COL_LETTERS = 'abcdefghijk';

export const colOf = (c: Cell): number => c % SIZE;
export const rowOf = (c: Cell): number => Math.floor(c / SIZE);
export const cellAt = (col: number, row: number): Cell => row * SIZE + col;
export const inBoard = (col: number, row: number): boolean =>
  col >= 0 && col < SIZE && row >= 0 && row < SIZE;

/** 0 → "a1", 120 → "k11" */
export const labelOf = (c: Cell): string => `${COL_LETTERS[colOf(c)]}${rowOf(c) + 1}`;

/** "f6" → 60. 잘못된 입력은 -1 */
export function parseCell(label: string): Cell {
  const m = /^([a-k])(\d{1,2})$/.exec(label.trim().toLowerCase());
  if (!m) return -1;
  const col = COL_LETTERS.indexOf(m[1]);
  const row = Number(m[2]) - 1;
  return inBoard(col, row) ? cellAt(col, row) : -1;
}

/** 8방향 인접. 기동 시 한 번 전개해 캐싱한다(§6.1). */
export const NEIGHBORS: readonly (readonly Cell[])[] = (() => {
  const table: Cell[][] = [];
  for (let c = 0; c < CELL_COUNT; c++) {
    const col = colOf(c);
    const row = rowOf(c);
    const list: Cell[] = [];
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const nc = col + dc;
        const nr = row + dr;
        if (inBoard(nc, nr)) list.push(cellAt(nc, nr));
      }
    }
    table.push(list);
  }
  return table;
})();

export const neighbors = (c: Cell): readonly Cell[] => NEIGHBORS[c];

/** 킹 이동 기준 거리 */
export const kingDistance = (a: Cell, b: Cell): number =>
  Math.max(Math.abs(colOf(a) - colOf(b)), Math.abs(rowOf(a) - rowOf(b)));

export const HOME: Readonly<Record<Side, readonly Cell[]>> = {
  // a1 a2 b1 b2
  W: [cellAt(0, 0), cellAt(0, 1), cellAt(1, 0), cellAt(1, 1)],
  // k11 k10 j11 j10
  B: [cellAt(10, 10), cellAt(10, 9), cellAt(9, 10), cellAt(9, 9)],
};

/** 대국 시작 칸 */
export const START: Readonly<Record<Side, Cell>> = {
  W: cellAt(0, 0), // a1
  B: cellAt(10, 10), // k11
};

/** a11, f6, k1 — 모두 col + row === 10 안티대각선 위에 있다(§2.2). */
export const TREASURES: readonly Cell[] = [cellAt(0, 10), cellAt(5, 5), cellAt(10, 0)];

/** 양측 모두 지뢰를 놓을 수 없는 11칸 */
export const FORBIDDEN: ReadonlySet<Cell> = new Set<Cell>([
  ...HOME.W,
  ...HOME.B,
  ...TREASURES,
]);

export const PLACEABLE: readonly Cell[] = Array.from(
  { length: CELL_COUNT },
  (_, i) => i,
).filter((c) => !FORBIDDEN.has(c));

export const other = (s: Side): Side => (s === 'W' ? 'B' : 'W');

export const SIDE_NAME: Readonly<Record<Side, string>> = { W: '白', B: '黑' };

/** 금지 칸의 사유 (배치 화면 호버 표시용, §9.1) */
export function forbiddenReason(c: Cell): string | null {
  if (TREASURES.includes(c)) return '보물 칸';
  if (HOME.W.includes(c)) return '白 시작 구역';
  if (HOME.B.includes(c)) return '黑 시작 구역';
  return null;
}
