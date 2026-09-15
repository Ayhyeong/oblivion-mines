import {
  FORBIDDEN,
  HOME,
  START,
  TREASURES,
  CELL_COUNT,
  neighbors,
  other,
} from './board';
import type {
  Cell,
  ClientView,
  Contribution,
  EndReason,
  GameResult,
  MoveFacts,
  MoveRecord,
  MoveResult,
  Placements,
  Ruleset,
  ServerState,
  Side,
} from './types';

export const DEFAULT_RULESET: Ruleset = {
  id: 'oblivion-1',
  mineCount: 15,
  treasureAwards: [10, 15, 20],
  countOwnMines: true,
  minePenalty: -5,
  plyLimit: 60,
  komi: 0,
  showOwnMines: false,
};

export class RuleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuleError';
  }
}

function assert(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw new RuleError(code, message);
}

/** 배치 유효성 검사(§2.3). 오류 메시지 배열을 돌려주며, 빈 배열이면 합법. */
export function validatePlacement(cells: readonly Cell[], ruleset: Ruleset): string[] {
  const errs: string[] = [];
  if (cells.length !== ruleset.mineCount) {
    errs.push(`지뢰는 정확히 ${ruleset.mineCount}개여야 합니다 (현재 ${cells.length}개).`);
  }
  const seen = new Set<Cell>();
  for (const c of cells) {
    if (!Number.isInteger(c) || c < 0 || c >= CELL_COUNT) {
      errs.push('보드 밖의 칸이 포함되어 있습니다.');
      continue;
    }
    if (FORBIDDEN.has(c)) errs.push('금지 칸(시작 구역·보물)에는 지뢰를 놓을 수 없습니다.');
    if (seen.has(c)) errs.push('같은 칸을 중복해서 고를 수 없습니다.');
    seen.add(c);
  }
  return [...new Set(errs)];
}

function blankState(ruleset: Ruleset): ServerState {
  return {
    ruleset,
    phase: 'play',
    mines: { W: new Set<Cell>(), B: new Set<Cell>() },
    pos: { W: START.W, B: START.B },
    // E1: 시작 칸은 이미 밟은 칸으로 초기화 — 첫 복귀 시 점수 획득 방지
    visited: new Set<Cell>([START.W, START.B]),
    detonated: new Set<Cell>(),
    treasureOrder: [],
    treasureTakenBy: {},
    score: { W: 0, B: ruleset.komi },
    turn: 'W', // 白 선공(§2.4)
    awaitReturnBy: null,
    plies: { W: 0, B: 0 },
    log: [],
    result: null,
    placements: { W: [], B: [] },
  };
}

export function createGame(ruleset: Ruleset, placements: Placements): ServerState {
  for (const side of ['W', 'B'] as const) {
    const errs = validatePlacement(placements[side], ruleset);
    assert(errs.length === 0, 'BAD_PLACEMENT', `${side} 배치 오류: ${errs.join(' ')}`);
  }
  const s = blankState(ruleset);
  s.mines = { W: new Set(placements.W), B: new Set(placements.B) };
  s.placements = { W: [...placements.W], B: [...placements.B] };
  return s;
}

/**
 * P2P 피어용 상태. 내 지뢰만 채우고 상대 집합은 비워 둔다.
 * 판정에 필요한 상대 몫은 `resolveMove` 의 `facts` 로 주입된다.
 */
export function createPeerGame(ruleset: Ruleset, mySide: Side, myCells: readonly Cell[]): ServerState {
  const errs = validatePlacement(myCells, ruleset);
  assert(errs.length === 0, 'BAD_PLACEMENT', `배치 오류: ${errs.join(' ')}`);
  const s = blankState(ruleset);
  s.mines[mySide] = new Set(myCells);
  s.placements[mySide] = [...myCells];
  return s;
}

/**
 * 공개 상태의 지문. 두 피어가 같은 판을 보고 있는지 매 수 대조한다.
 * 지뢰는 들어가지 않으므로 이 값을 주고받아도 정보가 새지 않는다.
 */
export function publicHash(s: ServerState): string {
  const parts = [
    s.turn,
    s.phase,
    s.awaitReturnBy ?? '-',
    s.pos.W,
    s.pos.B,
    s.score.W,
    s.score.B,
    s.plies.W,
    s.plies.B,
    s.log.length,
    [...s.visited].sort((a, b) => a - b).join('.'),
    [...s.detonated].sort((a, b) => a - b).join('.'),
    s.treasureOrder.join('.'),
  ].join('|');
  // FNV-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 지금 side가 갈 수 있는 칸(§2.4). 지뢰 정보를 쓰지 않으므로 클라이언트에서도 계산 가능. */
export function legalMoves(s: ServerState, side: Side): Cell[] {
  if (s.phase !== 'play' || s.turn !== side) return [];
  const oppPos = s.pos[other(side)];
  return neighbors(s.pos[side]).filter((c) => c !== oppPos);
}

/** 복귀 가능한 시작 구역 칸(§2.4, E5). */
export function returnOptions(s: ServerState, side: Side): Cell[] {
  const oppPos = s.pos[other(side)];
  return HOME[side].filter((c) => c !== oppPos);
}

/** 한쪽이 자기 지뢰만으로 계산할 수 있는 몫(§P2P). 상대 것은 알 수 없다. */
export function ownContribution(s: ServerState, side: Side, to: Cell): Contribution {
  const own = s.mines[side];
  let adjacent = 0;
  for (const c of neighbors(to)) if (own.has(c)) adjacent++;
  return { mine: own.has(to) ? 1 : 0, adjacent };
}

/**
 * 양측 몫을 룰셋에 따라 합산한다. mover 기준이며, 양쪽 피어가 같은 식을 쓰므로
 * 같은 결과에 도달한다.
 */
export function combineFacts(
  ruleset: Ruleset,
  mover: Contribution,
  opponent: Contribution,
): MoveFacts {
  return {
    minesAt: mover.mine + opponent.mine,
    adjacent: opponent.adjacent + (ruleset.countOwnMines ? mover.adjacent : 0),
  };
}

/** 전지적 계산 — 검증기와 단일 프로세스 테스트에서만 쓴다. */
export function localFacts(s: ServerState, side: Side, to: Cell): MoveFacts {
  return combineFacts(
    s.ruleset,
    ownContribution(s, side, to),
    ownContribution(s, other(side), to),
  );
}

function finish(s: ServerState, reason: EndReason, winner?: Side | null): GameResult {
  const w =
    winner !== undefined
      ? winner
      : s.score.W === s.score.B
        ? null
        : s.score.W > s.score.B
          ? 'W'
          : 'B';
  s.phase = 'finished';
  s.awaitReturnBy = null;
  s.result = { reason, winner: w, score: { ...s.score } };
  return s.result;
}

function checkPlyLimit(s: ServerState): void {
  if (s.phase !== 'play') return;
  // 각자 plyLimit 수에 도달하면 종료(§2.6). 白 선공이므로 양측이 같은 수를 둔 시점에 끝난다.
  if (s.plies.W >= s.ruleset.plyLimit && s.plies.B >= s.ruleset.plyLimit) {
    finish(s, 'plyLimit');
  }
}

function land(s: ServerState, side: Side, to: Cell): void {
  s.pos[side] = to;
  s.visited.add(to);
  s.turn = other(side);
}

/**
 * 이동 해결(§6.1). 점수 판정은 착지 시점의 상태 기준(E8).
 *
 * `facts` 는 "이 칸의 지뢰 총 개수"와 "인접 지뢰 총 개수"를 밖에서 받는다.
 * P2P 대국에서는 각 피어가 자기 몫만 계산해 주고받은 값을 합쳐 넣는다 —
 * 그래서 판정 코드가 상대 지뢰 집합을 아예 건드리지 않는다.
 * 주입된 값이 거짓이면 종료 후 리빌·리플레이 검증에서 잡힌다(§7.3).
 */
export function resolveMove(s: ServerState, side: Side, to: Cell, facts: MoveFacts): MoveResult {
  assert(s.phase === 'play', 'PHASE', '지금은 이동할 수 없습니다.');
  assert(s.turn === side, 'TURN', '상대 차례입니다.');
  const from = s.pos[side];
  assert(neighbors(from).includes(to), 'ADJACENCY', '인접한 8칸으로만 이동할 수 있습니다.');
  assert(to !== s.pos[other(side)], 'OCCUPIED', '상대 말이 있는 칸에는 갈 수 없습니다.');

  const ply = s.log.length;
  s.plies[side] += 1;

  const minesHit = facts.minesAt;

  // --- 1. 지뢰 (E2: 2개여도 -5 1회 / E3: 자기 지뢰도 동일) ---
  if (minesHit > 0) {
    s.score[side] += s.ruleset.minePenalty;
    // 각 피어는 자기 지뢰만 지운다. 상대 집합은 비어 있어도 결과가 같다.
    s.mines.W.delete(to);
    s.mines.B.delete(to);
    s.detonated.add(to);
    s.visited.add(to);
    s.phase = 'awaitReturn';
    s.awaitReturnBy = side;
    s.log.push({
      ply,
      side,
      from,
      to,
      kind: 'mine',
      delta: s.ruleset.minePenalty,
      minesHit,
      scoreAfter: { ...s.score },
    });
    return { kind: 'mine', delta: s.ruleset.minePenalty, minesHit };
  }

  // --- 2. 미획득 보물 (E6: 인접 지뢰는 계산하지 않음) ---
  if (TREASURES.includes(to) && !s.treasureOrder.includes(to)) {
    const idx = s.treasureOrder.length;
    const award = s.ruleset.treasureAwards[idx] ?? 0;
    s.score[side] += award;
    s.treasureOrder.push(to);
    s.treasureTakenBy[to] = side;
    land(s, side, to);
    s.log.push({ ply, side, from, to, kind: 'treasure', delta: award, scoreAfter: { ...s.score } });
    if (s.treasureOrder.length >= TREASURES.length) finish(s, 'treasures');
    else checkPlyLimit(s);
    return { kind: 'treasure', delta: award };
  }

  // --- 3. 이미 밟은 칸 (E7 포함) ---
  if (s.visited.has(to)) {
    land(s, side, to);
    s.log.push({ ply, side, from, to, kind: 'visited', delta: 0, scoreAfter: { ...s.score } });
    checkPlyLimit(s);
    return { kind: 'visited', delta: 0 };
  }

  // --- 4. 신규 칸 ---
  const gain = facts.adjacent;
  s.score[side] += gain;
  land(s, side, to);
  s.log.push({ ply, side, from, to, kind: 'fresh', delta: gain, scoreAfter: { ...s.score } });
  checkPlyLimit(s);
  return { kind: 'fresh', delta: gain };
}

/**
 * 기록된 한 수로부터 판정 입력을 복원한다.
 * 재연결 후 따라잡기와 리플레이가 같은 경로를 쓰도록 한 곳에 둔다.
 */
export function factsFromRecord(rec: MoveRecord): MoveFacts {
  return {
    minesAt: rec.kind === 'mine' ? (rec.minesHit ?? 1) : 0,
    adjacent: rec.kind === 'fresh' ? rec.delta : 0,
  };
}

/** 전지적 이동 — 양측 지뢰를 모두 아는 문맥(검증기·테스트)에서만 쓴다. */
export function applyMove(s: ServerState, side: Side, to: Cell): MoveResult {
  return resolveMove(s, side, to, localFacts(s, side, to));
}

/** 폭발 후 복귀(§6.2). 복귀 칸은 점수 0이며 방문 처리된다(E4). */
export function applyReturn(s: ServerState, side: Side, cell: Cell): void {
  assert(s.phase === 'awaitReturn', 'PHASE', '지금은 복귀할 수 없습니다.');
  assert(s.awaitReturnBy === side, 'TURN', '복귀할 차례가 아닙니다.');
  assert(
    returnOptions(s, side).includes(cell),
    'RETURN_CELL',
    '복귀는 비어 있는 자기 시작 구역 칸으로만 가능합니다.',
  );

  s.pos[side] = cell;
  s.visited.add(cell); // 점수는 주지 않음
  s.phase = 'play';
  s.awaitReturnBy = null;
  s.turn = other(side);

  const last = s.log[s.log.length - 1];
  if (last && last.kind === 'mine' && last.side === side) last.returnTo = cell;

  checkPlyLimit(s);
}

export function resign(s: ServerState, side: Side): GameResult {
  assert(s.phase !== 'finished', 'PHASE', '이미 끝난 대국입니다.');
  return finish(s, 'resign', other(side));
}

/**
 * ServerState → ClientView 변환은 오직 이 함수로만 한다(§4.3).
 * 송신 레이어는 ClientView 타입만 받도록 제한한다.
 */
export function toClientView(s: ServerState, side: Side): ClientView {
  const finished = s.phase === 'finished';
  return {
    ruleset: s.ruleset,
    phase: s.phase,
    side,
    turn: s.turn,
    score: { ...s.score },
    pos: { ...s.pos },
    visited: [...s.visited],
    detonated: [...s.detonated],
    treasures: TREASURES.map((cell) => {
      const order = s.treasureOrder.indexOf(cell);
      return {
        cell,
        order: order < 0 ? null : order,
        takenBy: s.treasureTakenBy[cell] ?? null,
      };
    }),
    nextAward:
      s.treasureOrder.length < s.ruleset.treasureAwards.length
        ? s.ruleset.treasureAwards[s.treasureOrder.length]
        : null,
    plies: { ...s.plies },
    awaitReturnBy: s.awaitReturnBy,
    returnOptions: s.awaitReturnBy === side ? returnOptions(s, side) : [],
    legalMoves: legalMoves(s, side),
    log: s.log.map((r) => ({ ...r, scoreAfter: { ...r.scoreAfter } })),
    ownMines: s.ruleset.showOwnMines && !finished ? [...s.mines[side]] : null,
    result: s.result,
    reveal: finished ? { W: [...s.placements.W], B: [...s.placements.B] } : null,
  };
}
