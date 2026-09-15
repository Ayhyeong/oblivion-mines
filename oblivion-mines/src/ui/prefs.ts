import { DEFAULT_RULESET } from '../rules';
import type { Ruleset, Side } from '../rules';

export interface Prefs {
  ruleset: Ruleset;
  /** 방을 열 때 내가 잡을 색 */
  hostSide: Side;
  /** 탭 → 확인 2단계 입력 (§9.4) */
  confirmMoves: boolean;
}

const KEY = 'oblivion-mines/prefs/v2';

const coarsePointer = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function defaultPrefs(): Prefs {
  return { ruleset: { ...DEFAULT_RULESET }, hostSide: 'W', confirmMoves: coarsePointer() };
}

export function loadPrefs(): Prefs {
  const base = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Prefs>;
    return { ...base, ...saved, ruleset: { ...base.ruleset, ...(saved.ruleset ?? {}) } };
  } catch {
    return base;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 프라이빗 모드 등에서는 조용히 넘어간다 */
  }
}
