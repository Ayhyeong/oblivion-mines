import { COL_LETTERS, SIZE, cellAt, colOf, forbiddenReason, labelOf, rowOf } from '../rules';
import type { Cell, Side } from '../rules';
import { el, clear } from './dom';

export type CellEvent = 'primary' | 'secondary';

export interface BoardOpts {
  /** 상호작용 가능한 칸. 비어 있으면 보드 전체가 읽기 전용이 된다. */
  actionable: ReadonlySet<Cell>;
  visited: ReadonlySet<Cell>;
  detonated: ReadonlySet<Cell>;
  treasures: { cell: Cell; order: number | null; takenBy: Side | null }[];
  pos: { W: Cell; B: Cell } | null;
  /** 배치 화면의 내 지뢰 초안, 또는 showOwnMines 모드의 내 지뢰 */
  myMines: ReadonlySet<Cell>;
  /** 종료 후 리빌 */
  revealW: ReadonlySet<Cell>;
  revealB: ReadonlySet<Cell>;
  flags: ReadonlySet<Cell>;
  selected: Cell | null;
  cursor: Cell | null;
  /** 배치 화면에서는 금지 칸을 비활성 표시한다 */
  showForbidden: boolean;
  /** 마지막 수 강조 */
  lastMove: { from: Cell; to: Cell } | null;
}

export function emptyOpts(): BoardOpts {
  const none = new Set<Cell>();
  return {
    actionable: none,
    visited: none,
    detonated: none,
    treasures: [],
    pos: null,
    myMines: none,
    revealW: none,
    revealB: none,
    flags: none,
    selected: null,
    cursor: null,
    showForbidden: false,
    lastMove: null,
  };
}

export interface BoardView {
  root: HTMLElement;
  update(opts: BoardOpts): void;
  focusCell(c: Cell): void;
}

export function createBoard(onCell: (c: Cell, kind: CellEvent) => void): BoardView {
  const root = el('div', { class: 'board', role: 'grid', 'aria-label': '11x11 보드' });
  const cells: HTMLButtonElement[] = new Array(SIZE * SIZE);

  // 위에서 아래로 11행 → 1행
  for (let row = SIZE - 1; row >= 0; row--) {
    const rowEl = el('div', { class: 'board-row', role: 'row' });
    rowEl.append(el('div', { class: 'coord coord-row', 'aria-hidden': 'true', text: String(row + 1) }));
    for (let col = 0; col < SIZE; col++) {
      const c = cellAt(col, row);
      const btn = el('button', {
        type: 'button',
        class: 'cell',
        role: 'gridcell',
        'data-cell': c,
        tabindex: -1,
      });
      btn.append(
        el('span', { class: 'glyph' }),
        el('span', { class: 'badge' }),
      );
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        onCell(c, 'primary');
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onCell(c, 'secondary');
      });
      // 터치 길게 누르기 = 플래그
      let timer: number | undefined;
      btn.addEventListener(
        'touchstart',
        () => {
          timer = window.setTimeout(() => {
            timer = undefined;
            onCell(c, 'secondary');
          }, 450);
        },
        { passive: true },
      );
      const cancel = () => {
        if (timer) window.clearTimeout(timer);
        timer = undefined;
      };
      btn.addEventListener('touchend', cancel);
      btn.addEventListener('touchmove', cancel);
      btn.addEventListener('touchcancel', cancel);

      cells[c] = btn;
      rowEl.append(btn);
    }
    root.append(rowEl);
  }

  const footer = el('div', { class: 'board-row board-footer', 'aria-hidden': 'true' });
  footer.append(el('div', { class: 'coord coord-row' }));
  for (let col = 0; col < SIZE; col++) {
    footer.append(el('div', { class: 'coord coord-col', text: COL_LETTERS[col] }));
  }
  root.append(footer);

  function update(o: BoardOpts): void {
    const treasureByCell = new Map(o.treasures.map((t) => [t.cell, t]));
    for (let c = 0; c < cells.length; c++) {
      const btn = cells[c];
      const cl = btn.classList;
      const t = treasureByCell.get(c);
      const forbidden = o.showForbidden && forbiddenReason(c) !== null;
      const actionable = o.actionable.has(c);

      cl.toggle('is-visited', o.visited.has(c) && !(t && t.order === null));
      cl.toggle('is-detonated', o.detonated.has(c));
      cl.toggle('is-treasure', !!t && t.order === null);
      cl.toggle('is-treasure-taken', !!t && t.order !== null);
      cl.toggle('is-actionable', actionable);
      cl.toggle('is-forbidden', forbidden);
      cl.toggle('is-flag', o.flags.has(c));
      cl.toggle('is-selected', o.selected === c);
      cl.toggle('is-cursor', o.cursor === c);
      cl.toggle('is-last-from', o.lastMove?.from === c);
      cl.toggle('is-last-to', o.lastMove?.to === c);

      const mineW = o.revealW.has(c);
      const mineB = o.revealB.has(c);
      const mineMine = o.myMines.has(c);
      cl.toggle('has-mine', mineW || mineB || mineMine);
      cl.toggle('mine-w', mineW && !mineB);
      cl.toggle('mine-b', mineB && !mineW);
      cl.toggle('mine-both', mineW && mineB);

      const pieceW = o.pos?.W === c;
      const pieceB = o.pos?.B === c;
      cl.toggle('piece-w', pieceW);
      cl.toggle('piece-b', pieceB);

      btn.disabled = !actionable;

      const glyph = btn.firstElementChild as HTMLElement;
      const badge = btn.lastElementChild as HTMLElement;
      clear(glyph);
      clear(badge);

      const parts: string[] = [labelOf(c)];
      if (pieceW) {
        glyph.textContent = '●';
        parts.push('白 말');
      } else if (pieceB) {
        glyph.textContent = '●';
        parts.push('黑 말');
      } else if (o.detonated.has(c)) {
        // 리빌 화면에서는 원래 배치까지 함께 보여주므로 폭발 표시가 지뢰 표시보다 우선한다
        glyph.textContent = '✕';
        parts.push('폭발한 칸');
      } else if (mineW || mineB || mineMine) {
        glyph.textContent = '✹';
        parts.push(mineW && mineB ? '지뢰 2개' : '지뢰');
      } else if (t && t.order === null) {
        glyph.textContent = '◆';
        parts.push('보물');
      } else if (o.flags.has(c)) {
        glyph.textContent = '⚑';
        parts.push('지뢰 의심 표시');
      } else {
        glyph.textContent = '';
      }

      if (t && t.order !== null) {
        badge.textContent = String(t.order + 1);
        parts.push(`${t.order + 1}번째로 회수된 보물`);
      } else if (mineW && mineB) {
        // 보물 순서 배지와 헷갈리지 않도록 개수 배지는 ×2 로 쓴다
        badge.textContent = '×2';
      }

      if (forbidden) parts.push(forbiddenReason(c) ?? '금지 칸');
      else if (o.visited.has(c)) parts.push('방문한 칸');
      if (actionable) parts.push('선택 가능');

      btn.setAttribute('aria-label', parts.join(', '));
      btn.title = forbidden ? `${labelOf(c)} — ${forbiddenReason(c)}에는 지뢰를 놓을 수 없습니다` : labelOf(c);
      btn.tabIndex = o.cursor === c ? 0 : -1;
    }
  }

  function focusCell(c: Cell): void {
    cells[c]?.focus({ preventScroll: true });
  }

  return { root, update, focusCell };
}

/** 방향키 이동 */
export function moveCursor(cur: Cell, dx: number, dy: number): Cell {
  const col = Math.min(SIZE - 1, Math.max(0, colOf(cur) + dx));
  const row = Math.min(SIZE - 1, Math.max(0, rowOf(cur) + dy));
  return cellAt(col, row);
}
