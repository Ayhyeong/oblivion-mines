import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULESET,
  FORBIDDEN,
  HOME,
  PLACEABLE,
  START,
  TREASURES,
  applyMove,
  applyReturn,
  canonicalCells,
  combineFacts,
  createPeerGame,
  factsFromRecord,
  ownContribution,
  publicHash,
  resolveMove,
  colOf,
  commitPlacement,
  createGame,
  digestPlacement,
  labelOf,
  legalMoves,
  neighbors,
  parseCell,
  resign,
  returnOptions,
  rowOf,
  toClientView,
  validatePlacement,
  verifyCommitment,
  verifyRecord,
} from '../src/rules';
import type { Cell, GameRecord, Ruleset, ServerState, Side } from '../src/rules';

const R = DEFAULT_RULESET;

const at = (label: string): Cell => {
  const c = parseCell(label);
  if (c < 0) throw new Error(`bad label ${label}`);
  return c;
};

/** 기본 청정 구역: 양측 시작 구역과 세 보물. 여기 인접해서는 더미 지뢰가 깔리지 않는다. */
const BASE_CLEAN = [...HOME.W, ...HOME.B, ...TREASURES];

/**
 * 테스트용 판 구성.
 * 명시한 지뢰 외의 나머지는 "청정 구역과 그 인접"을 피해서 채우므로,
 * 테스트가 검사하는 칸의 점수에 더미 지뢰가 끼어들지 않는다.
 */
function mk(
  wLabels: string[],
  bLabels: string[],
  extraClean: string[] = [],
  ruleset: Ruleset = R,
): ServerState {
  const clean = new Set<Cell>([...BASE_CLEAN, ...extraClean.map(at)]);
  const pool = PLACEABLE.filter(
    (c) => !clean.has(c) && !neighbors(c).some((n) => clean.has(n)),
  );
  const fill = (explicit: Cell[]): Cell[] => {
    const out = [...explicit];
    for (const c of pool) {
      if (out.length >= ruleset.mineCount) break;
      if (!out.includes(c)) out.push(c);
    }
    if (out.length < ruleset.mineCount) throw new Error('테스트 풀이 부족합니다.');
    return out;
  };
  return createGame(ruleset, { W: fill(wLabels.map(at)), B: fill(bLabels.map(at)) });
}

/** 무작위 합법 배치 */
function randomPlacement(count = R.mineCount): Cell[] {
  const pool = [...PLACEABLE];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

describe('보드 기하 (§2.1, §2.2)', () => {
  it('좌표 변환이 왕복한다', () => {
    expect(labelOf(0)).toBe('a1');
    expect(labelOf(120)).toBe('k11');
    expect(labelOf(60)).toBe('f6');
    for (let c = 0; c < 121; c++) expect(at(labelOf(c))).toBe(c);
  });

  it('금지 칸은 11개, 배치 가능 칸은 110개', () => {
    expect(FORBIDDEN.size).toBe(11);
    expect(PLACEABLE.length).toBe(110);
  });

  it('세 보물은 col+row=10 안티대각선 위에 있다', () => {
    for (const t of TREASURES) expect(colOf(t) + rowOf(t)).toBe(10);
  });

  it('인접은 8방향이며 경계에서 잘린다', () => {
    expect(neighbors(at('f6')).length).toBe(8);
    expect(neighbors(at('a1')).length).toBe(3);
    expect(neighbors(at('k11')).length).toBe(3);
    expect(neighbors(at('a6')).length).toBe(5);
  });

  it('시작 구역·보물 좌표가 기획안과 일치한다', () => {
    expect([...HOME.W].map(labelOf).sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect([...HOME.B].map(labelOf).sort()).toEqual(['j10', 'j11', 'k10', 'k11']);
    expect(TREASURES.map(labelOf)).toEqual(['a11', 'f6', 'k1']);
    expect(labelOf(START.W)).toBe('a1');
    expect(labelOf(START.B)).toBe('k11');
  });
});

describe('배치 검증 (§2.3)', () => {
  it('정확히 15개여야 한다', () => {
    expect(validatePlacement(PLACEABLE.slice(0, 15), R)).toEqual([]);
    expect(validatePlacement(PLACEABLE.slice(0, 14), R).length).toBe(1);
  });

  it('금지 칸과 중복을 거른다', () => {
    expect(validatePlacement([...PLACEABLE.slice(0, 14), at('f6')], R).length).toBeGreaterThan(0);
    const dup = PLACEABLE.slice(0, 14);
    expect(validatePlacement([...dup, dup[0]], R).length).toBeGreaterThan(0);
  });

  it('양측이 같은 칸을 고르는 것은 허용된다', () => {
    const same = PLACEABLE.slice(0, 15);
    expect(() => createGame(R, { W: same, B: same })).not.toThrow();
  });
});

describe('E1 — 시작 칸은 이미 밟은 칸으로 초기화', () => {
  it('a1 / k11 만 visited 로 시작한다', () => {
    const s = mk([], []);
    expect(s.visited.has(START.W)).toBe(true);
    expect(s.visited.has(START.B)).toBe(true);
    expect(s.visited.size).toBe(2);
  });

  it('시작 칸으로 되돌아가도 0점', () => {
    const s = mk([], []);
    applyMove(s, 'W', at('b2'));
    applyMove(s, 'B', at('j10'));
    const r = applyMove(s, 'W', at('a1'));
    expect(r).toEqual({ kind: 'visited', delta: 0 });
  });
});

describe('E2 — 한 칸에 지뢰 2개', () => {
  it('-5 한 번, 두 개 모두 소멸', () => {
    const s = mk(['c3'], ['c3'], ['c3']);
    s.pos.W = at('b2');
    const r = applyMove(s, 'W', at('c3'));
    expect(r.kind).toBe('mine');
    expect(r.delta).toBe(-5);
    expect(r.minesHit).toBe(2);
    expect(s.score.W).toBe(-5);
    expect(s.mines.W.has(at('c3'))).toBe(false);
    expect(s.mines.B.has(at('c3'))).toBe(false);
  });
});

describe('E3 — 자기 지뢰도 -5', () => {
  it('자기 지뢰를 밟아도 동일하다', () => {
    const s = mk(['c3'], [], ['c3']);
    s.pos.W = at('b2');
    expect(applyMove(s, 'W', at('c3')).delta).toBe(-5);
    expect(s.score.W).toBe(-5);
  });
});

describe('E4 / E5 — 복귀', () => {
  it('복귀 칸은 0점이고 방문 처리되며, 복귀 후 상대 차례가 된다', () => {
    const s = mk(['c3'], [], ['c3']);
    s.pos.W = at('b2');
    applyMove(s, 'W', at('c3'));
    expect(s.phase).toBe('awaitReturn');
    expect(s.turn).toBe('W'); // 복귀 전까지 턴은 넘어가지 않는다
    applyReturn(s, 'W', at('a2'));
    expect(s.score.W).toBe(-5); // 복귀로 인한 가감 없음
    expect(s.visited.has(at('a2'))).toBe(true);
    expect(s.pos.W).toBe(at('a2'));
    expect(s.phase).toBe('play');
    expect(s.turn).toBe('B');
  });

  it('복귀는 수로 세지 않는다', () => {
    const s = mk(['c3'], [], ['c3']);
    s.pos.W = at('b2');
    applyMove(s, 'W', at('c3'));
    applyReturn(s, 'W', at('a2'));
    expect(s.plies.W).toBe(1);
  });

  it('상대 말이 있는 시작 구역 칸은 선택할 수 없다', () => {
    const s = mk([], []);
    s.pos.B = at('b2');
    s.awaitReturnBy = 'W';
    s.phase = 'awaitReturn';
    expect(returnOptions(s, 'W')).not.toContain(at('b2'));
    expect(returnOptions(s, 'W').length).toBe(3);
    expect(() => applyReturn(s, 'W', at('b2'))).toThrow();
  });

  it('복귀 선택지는 최소 3칸이 남는다', () => {
    const s = mk([], []);
    expect(returnOptions(s, 'W').length).toBeGreaterThanOrEqual(3);
    expect(returnOptions(s, 'B').length).toBeGreaterThanOrEqual(3);
  });
});

describe('E6 / E7 — 보물', () => {
  it('보물 칸에서는 인접 지뢰를 계산하지 않는다', () => {
    const ring = ['e5', 'e6', 'e7', 'f5', 'f7', 'g5', 'g6', 'g7'];
    const s = mk(ring, [], ring);
    s.pos.W = at('e6');
    const r = applyMove(s, 'W', at('f6'));
    expect(r).toEqual({ kind: 'treasure', delta: 10 });
    expect(s.score.W).toBe(10);
  });

  it('보물 점수는 10 / 15 / 20 순서로 나가고 3개째에 종료된다', () => {
    const s = mk([], []);
    s.pos.W = at('e6');
    expect(applyMove(s, 'W', at('f6')).delta).toBe(10);
    s.turn = 'B';
    s.pos.B = at('k2');
    expect(applyMove(s, 'B', at('k1')).delta).toBe(15);
    s.turn = 'W';
    s.pos.W = at('a10');
    expect(applyMove(s, 'W', at('a11')).delta).toBe(20);
    expect(s.phase).toBe('finished');
    expect(s.result?.reason).toBe('treasures');
    expect(s.result?.winner).toBe('W');
  });

  it('회수된 보물 칸을 다시 밟으면 0점', () => {
    const s = mk([], []);
    s.pos.W = at('e6');
    applyMove(s, 'W', at('f6'));
    s.turn = 'W';
    s.pos.W = at('e6');
    expect(applyMove(s, 'W', at('f6'))).toEqual({ kind: 'visited', delta: 0 });
  });
});

describe('E8 — 폭발로 소멸한 지뢰는 이후 인접 계산에서 빠진다', () => {
  it('착지 시점 기준으로 점수가 고정되고 소급되지 않는다', () => {
    const s = mk(['c3'], [], ['c3', 'd2', 'c1']);

    // b2 는 c3 에 인접 → 신규 칸 +1
    expect(applyMove(s, 'W', at('b2'))).toEqual({ kind: 'fresh', delta: 1 });
    applyMove(s, 'B', at('j10'));

    // c3 을 밟아 폭발
    expect(applyMove(s, 'W', at('c3')).kind).toBe('mine');
    applyReturn(s, 'W', at('a2'));

    // 과거 점수는 소급 변경되지 않는다
    expect(s.log[0].delta).toBe(1);

    // 소멸한 뒤에는 c3 인접이 0으로 계산된다
    applyMove(s, 'B', at('j11'));
    s.turn = 'W';
    s.pos.W = at('c1');
    expect(applyMove(s, 'W', at('d2'))).toEqual({ kind: 'fresh', delta: 0 });
  });
});

describe('E9 — 합법 수 부재는 발생하지 않는다', () => {
  it('가장 좁은 코너에서도 최소 2수가 남는다', () => {
    const s = mk([], []);
    s.pos.B = at('b2');
    expect(legalMoves(s, 'W').length).toBeGreaterThanOrEqual(2);
  });

  it('모든 칸의 인접 칸은 3개 이상', () => {
    for (let c = 0; c < 121; c++) expect(neighbors(c).length).toBeGreaterThanOrEqual(3);
  });
});

describe('E10 / §2.6 — 수 상한', () => {
  it('각자 plyLimit 에 도달하면 종료된다', () => {
    const s = mk([], [], [], { ...R, plyLimit: 2 });
    applyMove(s, 'W', at('b2'));
    applyMove(s, 'B', at('j10'));
    applyMove(s, 'W', at('a1'));
    expect(s.phase).toBe('play');
    applyMove(s, 'B', at('k11'));
    expect(s.phase).toBe('finished');
    expect(s.result?.reason).toBe('plyLimit');
    expect(s.plies).toEqual({ W: 2, B: 2 });
  });

  it('동점이면 무승부', () => {
    const s = mk([], [], [], { ...R, plyLimit: 1 });
    applyMove(s, 'W', at('a2'));
    applyMove(s, 'B', at('k10'));
    expect(s.result?.score).toEqual({ W: 0, B: 0 });
    expect(s.result?.winner).toBe(null);
  });
});

describe('§2.4 — 이동 제약', () => {
  it('白이 선공이다', () => {
    expect(mk([], []).turn).toBe('W');
  });

  it('인접하지 않은 칸으로는 갈 수 없다', () => {
    expect(() => applyMove(mk([], []), 'W', at('c3'))).toThrow();
  });

  it('상대 말이 있는 칸으로는 갈 수 없다', () => {
    const s = mk([], []);
    s.pos.B = at('b2');
    expect(() => applyMove(s, 'W', at('b2'))).toThrow();
    expect(legalMoves(s, 'W')).not.toContain(at('b2'));
  });

  it('상대 차례에는 둘 수 없다', () => {
    expect(() => applyMove(mk([], []), 'B', at('j10'))).toThrow();
  });
});

describe('§2.5-4 — 신규 칸 인접 점수', () => {
  it('양측 지뢰를 합산하며 한 칸 2개는 2로 센다', () => {
    // b2 인접(a1 a2 a3 b1 b3 c1 c2 c3)에 지뢰 총 4개: c1 에 2개, c2 에 1개, c3 에 1개
    const s = mk(['c1', 'c2'], ['c1', 'c3'], ['c1', 'c2', 'c3']);
    expect(applyMove(s, 'W', at('b2'))).toEqual({ kind: 'fresh', delta: 4 });
  });

  it('countOwnMines=false 면 자기 지뢰는 세지 않는다', () => {
    const ruleset: Ruleset = { ...R, countOwnMines: false };
    const s = mk(['c1', 'c2'], ['c3'], ['c1', 'c2', 'c3'], ruleset);
    expect(applyMove(s, 'W', at('b2')).delta).toBe(1);
  });
});

describe('§10.4 — 룰셋 파라미터', () => {
  it('komi 는 후공에게 선적용된다', () => {
    const s = mk([], [], [], { ...R, komi: 5 });
    expect(s.score).toEqual({ W: 0, B: 5 });
  });

  it('minePenalty / mineCount 가 반영된다', () => {
    const ruleset: Ruleset = { ...R, minePenalty: -3, mineCount: 4 };
    const s = mk(['c3'], [], ['c3'], ruleset);
    expect(s.mines.W.size).toBe(4);
    s.pos.W = at('b2');
    expect(applyMove(s, 'W', at('c3')).delta).toBe(-3);
  });
});

describe('§4.2 / §4.3 — 정보 격벽', () => {
  // 판정에 쓰이는 상수(0,1,10,11,12,15,20,60,110,120)와 겹치지 않는 인덱스를 골라
  // 문자열 누출 검사의 오탐을 없앤다.
  const W_MINES = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 61, 62, 63, 64, 65];
  const B_MINES = [34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48];

  it('ClientView 직렬화 결과에 상대 지뢰 좌표가 나타나지 않는다', () => {
    const s = createGame(R, { W: W_MINES, B: B_MINES });
    for (const side of ['W', 'B'] as const) {
      const view = toClientView(s, side);
      const json = JSON.stringify(view);
      expect(view.reveal).toBe(null);
      expect(view.ownMines).toBe(null); // showOwnMines 기본 false = 망각 모드
      const oppMines = side === 'W' ? B_MINES : W_MINES;
      const leaked = oppMines.filter((c) =>
        new RegExp(`(^|[^0-9])${c}([^0-9]|$)`).test(json),
      );
      expect(leaked).toEqual([]);
    }
  });

  it('showOwnMines=true 여도 자기 것만 들어간다', () => {
    const s = createGame({ ...R, showOwnMines: true }, { W: W_MINES, B: B_MINES });
    const view = toClientView(s, 'W');
    expect(view.ownMines).toEqual(expect.arrayContaining(W_MINES));
    for (const b of B_MINES) expect(view.ownMines).not.toContain(b);
  });

  it('종료 후에만 reveal 이 채워진다', () => {
    const s = mk([], []);
    expect(toClientView(s, 'W').reveal).toBe(null);
    resign(s, 'W');
    const view = toClientView(s, 'W');
    expect(view.reveal?.W.length).toBe(15);
    expect(view.reveal?.B.length).toBe(15);
    expect(s.result?.winner).toBe('B');
  });
});

describe('§7.2 — 커밋-리빌', () => {
  it('정규화가 순서에 무관하다', () => {
    expect(canonicalCells([3, 1, 2])).toBe(canonicalCells([2, 3, 1]));
  });

  it('리빌이 커밋과 맞는지 검증된다', async () => {
    const c = await commitPlacement(PLACEABLE.slice(0, 15));
    expect(await verifyCommitment(c)).toBe(true);
    expect(await verifyCommitment({ ...c, cells: PLACEABLE.slice(1, 16) })).toBe(false);
  });

  it('salt 가 다르면 digest 도 다르다', async () => {
    const cells = PLACEABLE.slice(0, 15);
    expect(await digestPlacement(cells, '00'.repeat(32))).not.toBe(
      await digestPlacement(cells, '01'.repeat(32)),
    );
  });
});

describe('§7.3 — 리플레이 재현 검증', () => {
  function toRecord(s: ServerState): GameRecord {
    return {
      version: 1,
      ruleset: s.ruleset,
      commitments: {
        W: { digest: '', salt: '', cells: s.placements.W },
        B: { digest: '', salt: '', cells: s.placements.B },
      },
      log: s.log,
      result: s.result ?? { reason: 'resign', winner: null, score: s.score },
      playedAt: new Date(0).toISOString(),
    };
  }

  /** c3 에 양측 지뢰가 겹쳐 있는 실제 진행 */
  function doubleMineGame(): ServerState {
    const s = mk(['c3'], ['c3'], ['c3']);
    applyMove(s, 'W', at('b2')); // c3 의 지뢰 2개에 인접 → +2
    applyMove(s, 'B', at('j10'));
    applyMove(s, 'W', at('c3')); // 폭발 -5
    applyReturn(s, 'W', at('a2'));
    applyMove(s, 'B', at('j9'));
    resign(s, 'B');
    return s;
  }

  it('정상 기보는 검증을 통과한다', () => {
    const s = doubleMineGame();
    const v = verifyRecord(toRecord(s));
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.recomputed).toEqual(s.score);
  });

  it('한 칸의 지뢰 2개를 1개로 세면(페널티 누락) 잡아낸다', () => {
    const s = doubleMineGame();
    const rec = toRecord(s);
    rec.log = rec.log.map((r) => ({ ...r, scoreAfter: { ...r.scoreAfter } }));
    rec.log[2] = { ...rec.log[2], delta: 0 };
    const v = verifyRecord(rec);
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/점수 불일치/);
  });

  it('조작된 인접 점수를 잡아낸다', () => {
    const rec = toRecord(doubleMineGame());
    rec.log = rec.log.map((r, i) => (i === 0 ? { ...r, delta: 99 } : r));
    expect(verifyRecord(rec).ok).toBe(false);
  });

  it('불법 수가 섞이면 잡아낸다', () => {
    const rec = toRecord(doubleMineGame());
    rec.log = rec.log.map((r, i) => (i === 1 ? { ...r, to: at('a1') } : r));
    expect(verifyRecord(rec).ok).toBe(false);
  });

  it('배치를 사후에 바꾸면 잡아낸다', () => {
    const rec = toRecord(doubleMineGame());
    // 무작위 배치로 바꾸면 우연히 같은 기보가 나올 수 있다(짧은 대국이라 확률이 낮지 않다).
    // b2 의 인접 지뢰 하나를 확실히 없애 판정이 반드시 달라지게 만든다.
    const w = rec.commitments.W.cells;
    const b2Neighbors = neighbors(at('b2'));
    const swapIn = PLACEABLE.find((c) => !w.includes(c) && !b2Neighbors.includes(c));
    expect(swapIn).toBeDefined();
    rec.commitments = {
      ...rec.commitments,
      W: { ...rec.commitments.W, cells: [...w.filter((c) => c !== at('c3')), swapIn!] },
    };
    const v = verifyRecord(rec);
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/점수 불일치/);
  });
});

describe('전체 대국 시뮬레이션', () => {
  it('무작위 대국 200판이 예외 없이 끝나고 모두 검증을 통과한다', () => {
    for (let g = 0; g < 200; g++) {
      const s = createGame(R, {
        W: randomPlacement(),
        B: randomPlacement(),
      });
      let guard = 0;
      while (s.phase !== 'finished' && guard++ < 400) {
        if (s.phase === 'awaitReturn') {
          const opts = returnOptions(s, s.awaitReturnBy!);
          expect(opts.length).toBeGreaterThanOrEqual(3);
          applyReturn(s, s.awaitReturnBy!, opts[Math.floor(Math.random() * opts.length)]);
          continue;
        }
        const moves = legalMoves(s, s.turn);
        expect(moves.length).toBeGreaterThanOrEqual(2); // E9
        applyMove(s, s.turn, moves[Math.floor(Math.random() * moves.length)]);
      }
      expect(s.phase).toBe('finished');
      expect(['treasures', 'plyLimit']).toContain(s.result!.reason);

      const v = verifyRecord({
        version: 1,
        ruleset: R,
        commitments: {
          W: { digest: '', salt: '', cells: s.placements.W },
          B: { digest: '', salt: '', cells: s.placements.B },
        },
        log: s.log,
        result: s.result!,
        playedAt: new Date(0).toISOString(),
      });
      expect(v.issues).toEqual([]);
    }
  });
});


// ---------------------------------------------------------------- P2P

/**
 * 두 피어가 서로의 지뢰를 모르는 채 교환하는 절차를 그대로 흉내 낸다.
 * 오가는 값은 `mine`(0/1) 과 `adj`(0~8) 뿐이고, adj 는 판정이 '신규 칸'으로
 * 확정된 뒤에만 건넨다.
 */
function needsExchange(s: ServerState, to: Cell): boolean {
  const unclaimedTreasure = TREASURES.includes(to) && !s.treasureOrder.includes(to);
  return !unclaimedTreasure && !s.visited.has(to);
}

interface Wire {
  mine: number;
  adj: number | null;
}

function p2pStep(mover: ServerState, watcher: ServerState, side: Side, to: Cell): Wire {
  // mover = 두는 쪽 피어의 상태, watcher = 상대 피어의 상태
  if (!needsExchange(mover, to)) {
    const facts = { minesAt: 0, adjacent: 0 };
    resolveMove(mover, side, to, facts);
    resolveMove(watcher, side, to, facts);
    return { mine: 0, adj: null };
  }
  const moverOwn = ownContribution(mover, side, to);
  const watcherOwn = ownContribution(watcher, other(side), to);
  const minesAt = moverOwn.mine + watcherOwn.mine;

  // 폭발이면 인접 정보는 어느 방향으로도 전송되지 않는다.
  const facts =
    minesAt > 0
      ? { minesAt, adjacent: 0 }
      : combineFacts(mover.ruleset, moverOwn, watcherOwn);
  resolveMove(mover, side, to, facts);
  resolveMove(watcher, side, to, facts);
  return { mine: watcherOwn.mine, adj: minesAt > 0 ? null : watcherOwn.adjacent };
}

const other = (s: Side): Side => (s === 'W' ? 'B' : 'W');

describe('P2P — 상대 지뢰 없이 판정하기', () => {
  it('createPeerGame 은 내 지뢰만 담는다', () => {
    const mine = randomPlacement();
    const s = createPeerGame(R, 'W', mine);
    expect(s.mines.W.size).toBe(15);
    expect(s.mines.B.size).toBe(0);
    expect(s.placements.B).toEqual([]);
    expect(s.visited.size).toBe(2);
  });

  it('두 몫을 합치면 전지적 계산과 같은 값이 나온다', () => {
    const s = mk(['c1', 'c2'], ['c1', 'c3'], ['c1', 'c2', 'c3']);
    const w = ownContribution(s, 'W', at('b2'));
    const b = ownContribution(s, 'B', at('b2'));
    expect(combineFacts(R, w, b)).toEqual({ minesAt: 0, adjacent: 4 });
    expect(combineFacts({ ...R, countOwnMines: false }, w, b)).toEqual({ minesAt: 0, adjacent: 2 });
  });

  it('무작위 대국 100판에서 두 피어와 전지적 판이 끝까지 일치한다', () => {
    for (let g = 0; g < 100; g++) {
      const wCells = randomPlacement();
      const bCells = randomPlacement();
      const ref = createGame(R, { W: wCells, B: bCells });
      const pw = createPeerGame(R, 'W', wCells);
      const pb = createPeerGame(R, 'B', bCells);

      let guard = 0;
      while (ref.phase !== 'finished' && guard++ < 400) {
        if (ref.phase === 'awaitReturn') {
          const side = ref.awaitReturnBy!;
          const cell = returnOptions(ref, side)[0];
          applyReturn(ref, side, cell);
          applyReturn(pw, side, cell);
          applyReturn(pb, side, cell);
          continue;
        }
        const side = ref.turn;
        const moves = legalMoves(ref, side);
        const to = moves[Math.floor(Math.random() * moves.length)];
        applyMove(ref, side, to);
        if (side === 'W') p2pStep(pw, pb, 'W', to);
        else p2pStep(pb, pw, 'B', to);

        // 두 피어는 매 수 같은 판을 본다
        expect(publicHash(pw)).toBe(publicHash(pb));
        expect(publicHash(pw)).toBe(publicHash(ref));
      }

      expect(ref.phase).toBe('finished');
      expect(pw.result).toEqual(ref.result);
      expect(pb.result).toEqual(ref.result);

      // 어느 피어도 상대 지뢰를 담은 적이 없다
      for (const c of bCells) if (!ref.detonated.has(c)) expect(pw.mines.B.has(c)).toBe(false);
      for (const c of wCells) if (!ref.detonated.has(c)) expect(pb.mines.W.has(c)).toBe(false);
      expect(pw.mines.B.size).toBe(0);
      expect(pb.mines.W.size).toBe(0);
    }
  });

  it('폭발한 수에서는 인접 정보가 오가지 않는다', () => {
    const wCells = [at('c3'), ...PLACEABLE.filter((c) => c > 80).slice(0, 14)];
    const bCells = PLACEABLE.filter((c) => c > 80).slice(0, 15);
    const pw = createPeerGame(R, 'W', wCells);
    const pb = createPeerGame(R, 'B', bCells);
    pw.pos.W = at('b2');
    pb.pos.W = at('b2');
    const wire = p2pStep(pw, pb, 'W', at('c3'));
    expect(pw.log[0].kind).toBe('mine');
    expect(wire.adj).toBe(null); // 인접 수는 전송 대상이 아니다
    expect(publicHash(pw)).toBe(publicHash(pb));
  });

  it('기록된 수로부터 판정 입력을 복원할 수 있다 (재연결 따라잡기)', () => {
    const wCells = randomPlacement();
    const bCells = randomPlacement();
    const ref = createGame(R, { W: wCells, B: bCells });
    let guard = 0;
    while (ref.phase !== 'finished' && guard++ < 60) {
      if (ref.phase === 'awaitReturn') {
        applyReturn(ref, ref.awaitReturnBy!, returnOptions(ref, ref.awaitReturnBy!)[0]);
        continue;
      }
      const moves = legalMoves(ref, ref.turn);
      applyMove(ref, ref.turn, moves[Math.floor(Math.random() * moves.length)]);
    }

    // 기보만 보고 따라잡은 피어가 같은 판에 도달한다
    const caught = createPeerGame(R, 'W', wCells);
    for (const rec of ref.log) {
      resolveMove(caught, rec.side, rec.to, factsFromRecord(rec));
      if (rec.kind === 'mine' && rec.returnTo !== undefined) applyReturn(caught, rec.side, rec.returnTo);
    }
    expect(publicHash(caught)).toBe(publicHash(ref));
    expect(caught.score).toEqual(ref.score);
  });

  it('상대가 인접 지뢰 수를 줄여 보내면 종료 후 검증에서 잡힌다', () => {
    const wCells = randomPlacement();
    const bCells = randomPlacement();
    const s = createGame(R, { W: wCells, B: bCells });

    // 첫 신규 칸에서 黑이 자기 몫을 0으로 속였다고 가정한다
    let tampered = false;
    let guard = 0;
    while (s.phase !== 'finished' && guard++ < 40) {
      if (s.phase === 'awaitReturn') {
        applyReturn(s, s.awaitReturnBy!, returnOptions(s, s.awaitReturnBy!)[0]);
        continue;
      }
      const side = s.turn;
      const moves = legalMoves(s, side);
      const to = moves[Math.floor(Math.random() * moves.length)];
      if (!tampered && side === 'W' && needsExchange(s, to)) {
        const w = ownContribution(s, 'W', to);
        const b = ownContribution(s, 'B', to);
        if (b.mine === 0 && w.mine === 0 && b.adjacent > 0) {
          // 黑이 adj 를 0으로 축소해 보낸 상황
          resolveMove(s, side, to, combineFacts(R, w, { mine: 0, adjacent: 0 }));
          tampered = true;
          continue;
        }
      }
      applyMove(s, side, to);
    }
    if (!tampered) return; // 이번 판에서는 조건이 안 나왔다 — 검증할 것이 없다

    const v = verifyRecord({
      version: 1,
      ruleset: R,
      commitments: {
        W: { digest: '', salt: '', cells: wCells },
        B: { digest: '', salt: '', cells: bCells },
      },
      log: s.log,
      result: s.result ?? { reason: 'resign', winner: null, score: s.score },
      playedAt: new Date(0).toISOString(),
    });
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/점수 불일치/);
  });
});
