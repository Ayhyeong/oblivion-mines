import { applyMove, applyReturn, createGame, resign } from './engine';
import { verifyCommitment } from './commit';
import { labelOf } from './board';
import type { Cell, Commitment, GameResult, MoveRecord, Placements, Ruleset, ServerState } from './types';

/** 대국 종료 시 양측에 내려가는 기록 전체. 이것만으로 처음부터 재현이 가능해야 한다. */
export interface GameRecord {
  version: 1;
  ruleset: Ruleset;
  /** 배치 리빌 — 종료 후에만 존재 */
  commitments: { W: Commitment; B: Commitment };
  log: MoveRecord[];
  result: GameResult;
  playedAt: string;
}

export interface VerifyResult {
  ok: boolean;
  issues: string[];
  /** 재현으로 계산한 최종 점수 */
  recomputed: { W: number; B: number };
  /** 재현된 최종 상태 — 리플레이 뷰어가 쓴다 */
  states: ServerState[];
}

function clonePlacements(c: { W: Commitment; B: Commitment }): Placements {
  return { W: [...c.W.cells], B: [...c.B.cells] };
}

/**
 * 리플레이 재현 검증(§7.3).
 * 기록된 모든 수의 delta 와 최종 점수가 규칙 코어의 재계산과 일치하는지 확인한다.
 * 한 칸에 지뢰 2개를 1개로 세는 종류의 오심을 100% 검출한다.
 */
export function verifyRecord(record: GameRecord): VerifyResult {
  const issues: string[] = [];
  const states: ServerState[] = [];
  const s = createGame(record.ruleset, clonePlacements(record.commitments));
  states.push(snapshot(s));

  for (const rec of record.log) {
    if (s.phase !== 'play') {
      issues.push(`#${rec.ply}: 둘 수 없는 국면에서 수가 기록되어 있습니다.`);
      break;
    }
    if (s.turn !== rec.side) {
      issues.push(`#${rec.ply}: 차례가 어긋납니다 (기대 ${s.turn}, 기록 ${rec.side}).`);
      break;
    }
    if (s.pos[rec.side] !== rec.from) {
      issues.push(
        `#${rec.ply}: 출발 칸 불일치 (기대 ${labelOf(s.pos[rec.side])}, 기록 ${labelOf(rec.from)}).`,
      );
      break;
    }

    let res;
    try {
      res = applyMove(s, rec.side, rec.to);
    } catch (e) {
      issues.push(`#${rec.ply}: 불법 수 — ${(e as Error).message}`);
      break;
    }

    if (res.kind !== rec.kind) {
      issues.push(`#${rec.ply}: 판정 종류 불일치 (재계산 ${res.kind}, 기록 ${rec.kind}).`);
    }
    if (res.delta !== rec.delta) {
      issues.push(
        `#${rec.ply} ${labelOf(rec.to)}: 점수 불일치 (재계산 ${res.delta}, 기록 ${rec.delta}).`,
      );
    }
    if (res.kind === 'mine') {
      if (rec.returnTo === undefined) {
        // 복귀 전에 대국이 끝난 경우(기권)가 아니면 기록 누락
        if (record.result.reason !== 'resign') {
          issues.push(`#${rec.ply}: 폭발 후 복귀 칸이 기록되지 않았습니다.`);
        }
        break;
      }
      try {
        applyReturn(s, rec.side, rec.returnTo);
      } catch (e) {
        issues.push(`#${rec.ply}: 불법 복귀 — ${(e as Error).message}`);
        break;
      }
    }

    if (s.score.W !== rec.scoreAfter.W || s.score.B !== rec.scoreAfter.B) {
      issues.push(
        `#${rec.ply}: 누적 점수 불일치 (재계산 ${s.score.W}:${s.score.B}, 기록 ${rec.scoreAfter.W}:${rec.scoreAfter.B}).`,
      );
    }
    states.push(snapshot(s));
  }

  if (record.result.reason === 'resign' && s.phase !== 'finished') {
    resign(s, record.result.winner === 'W' ? 'B' : 'W');
  }

  if (s.score.W !== record.result.score.W || s.score.B !== record.result.score.B) {
    issues.push(
      `최종 점수 불일치 (재계산 ${s.score.W}:${s.score.B}, 기록 ${record.result.score.W}:${record.result.score.B}).`,
    );
  }

  return { ok: issues.length === 0, issues, recomputed: { ...s.score }, states };
}

/** 커밋-리빌 해시 검증까지 포함한 전체 검증. */
export async function verifyRecordFull(
  record: GameRecord,
): Promise<VerifyResult & { commitOk: { W: boolean; B: boolean } }> {
  const base = verifyRecord(record);
  const commitOk = {
    W: await verifyCommitment(record.commitments.W),
    B: await verifyCommitment(record.commitments.B),
  };
  const issues = [...base.issues];
  if (!commitOk.W) issues.push('白 배치 해시가 사전 공개된 커밋과 일치하지 않습니다.');
  if (!commitOk.B) issues.push('黑 배치 해시가 사전 공개된 커밋과 일치하지 않습니다.');
  return { ...base, issues, ok: issues.length === 0, commitOk };
}

/** 리플레이 뷰어용 얕은 스냅샷 (Set 은 복사한다) */
function snapshot(s: ServerState): ServerState {
  return {
    ...s,
    mines: { W: new Set(s.mines.W), B: new Set(s.mines.B) },
    pos: { ...s.pos },
    visited: new Set(s.visited),
    detonated: new Set(s.detonated),
    treasureOrder: [...s.treasureOrder],
    treasureTakenBy: { ...s.treasureTakenBy },
    score: { ...s.score },
    plies: { ...s.plies },
    log: s.log.map((r) => ({ ...r })),
    placements: { W: [...s.placements.W], B: [...s.placements.B] },
  };
}

export function recordToJson(record: GameRecord): string {
  return JSON.stringify(record, null, 2);
}

export function recordFromJson(text: string): GameRecord {
  const parsed = JSON.parse(text) as GameRecord;
  if (parsed.version !== 1) throw new Error('지원하지 않는 기록 버전입니다.');
  if (!parsed.commitments?.W || !parsed.commitments?.B) throw new Error('배치 리빌이 없습니다.');
  if (!Array.isArray(parsed.log)) throw new Error('기보가 없습니다.');
  return parsed;
}

export function describeCells(cells: readonly Cell[]): string {
  return [...cells]
    .sort((a, b) => a - b)
    .map(labelOf)
    .join(' ');
}
