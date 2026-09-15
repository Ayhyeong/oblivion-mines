/**
 * 망각의 지뢰 — 규칙 코어 타입.
 * 이 패키지는 외부 의존성이 없다(§3.1). 서버 권위 판정 / 클라이언트 하이라이트 /
 * 종료 후 리플레이 검증이 모두 같은 코드를 쓴다.
 */

export type Side = 'W' | 'B';

/** 0..120. idx = row * 11 + col */
export type Cell = number;

export interface Ruleset {
  id: string;
  /** 한 명이 까는 지뢰 수. 기본 15 */
  mineCount: number;
  /** 보물 획득 순서별 점수. 기본 [10, 15, 20] */
  treasureAwards: number[];
  /** 인접 점수에 자기 지뢰를 포함할지. 기본 true (false = 추론 모드) */
  countOwnMines: boolean;
  /** 지뢰를 밟았을 때의 점수. 기본 -5 */
  minePenalty: number;
  /** 각자 둘 수 있는 최대 수. 기본 60 */
  plyLimit: number;
  /** 후공(黑) 보정. 기본 0 */
  komi: number;
  /**
   * 플레이 중 자기 지뢰를 화면에 보여줄지.
   * 기본 false = 망각 모드(§4.2). true면 자기 지뢰만 표시되는 완화 룰.
   */
  showOwnMines: boolean;
}

export type Phase = 'placement' | 'play' | 'awaitReturn' | 'finished';

export type MoveKind = 'mine' | 'treasure' | 'visited' | 'fresh';

export type EndReason = 'treasures' | 'plyLimit' | 'resign';

export interface MoveRecord {
  /** 대국 전체 기준 0부터 증가하는 수 번호 */
  ply: number;
  side: Side;
  from: Cell;
  to: Cell;
  kind: MoveKind;
  delta: number;
  /** kind === 'mine' 인 경우, 그 칸에서 터진 지뢰 개수(1 또는 2) */
  minesHit?: number;
  /** kind === 'mine' 인 경우 복귀한 칸 */
  returnTo?: Cell;
  scoreAfter: { W: number; B: number };
}

export interface GameResult {
  reason: EndReason;
  /** 무승부면 null */
  winner: Side | null;
  score: { W: number; B: number };
}

export interface Placements {
  W: Cell[];
  B: Cell[];
}

/** 커밋-리빌(§7.2)용 봉인 정보. 종료 시 공개된다. */
export interface Commitment {
  digest: string;
  salt: string;
  cells: Cell[];
}

export interface ServerState {
  ruleset: Ruleset;
  phase: Phase;
  mines: { W: Set<Cell>; B: Set<Cell> };
  pos: { W: Cell; B: Cell };
  /** 양측 통합 방문 칸(§2.5-3) */
  visited: Set<Cell>;
  /** 폭발이 일어난 칸 (표시용) */
  detonated: Set<Cell>;
  /** 회수된 보물을 회수 순서대로 */
  treasureOrder: Cell[];
  /** 보물을 누가 가져갔는지 */
  treasureTakenBy: Partial<Record<Cell, Side>>;
  score: { W: number; B: number };
  turn: Side;
  awaitReturnBy: Side | null;
  /** 각자 둔 수 (복귀는 수로 세지 않는다, E4) */
  plies: { W: number; B: number };
  log: MoveRecord[];
  result: GameResult | null;
  /** 리빌 전까지는 UI에 노출되지 않는다. 검증용 원본 배치 */
  placements: Placements;
}

export interface MoveResult {
  kind: MoveKind;
  delta: number;
  minesHit?: number;
}

/**
 * 한쪽 플레이어가 자기 지뢰만 보고 계산할 수 있는 값.
 * P2P 대국에서 이 두 숫자만 주고받으면 판정이 완성된다 — 지뢰 위치는 오가지 않는다.
 */
export interface Contribution {
  /** to 칸에 내 지뢰가 있는가 (0 또는 1) */
  mine: 0 | 1;
  /** to 칸에 인접한 내 지뢰 개수 */
  adjacent: number;
}

/** 양측 몫을 합친, 판정에 실제로 쓰이는 값. */
export interface MoveFacts {
  /** to 칸의 지뢰 총 개수(양측 합산). 0보다 크면 폭발. */
  minesAt: number;
  /** to 칸 인접 지뢰 총 개수 — ruleset.countOwnMines 가 이미 적용된 값 */
  adjacent: number;
}

/**
 * 클라이언트에 내려보내도 되는 것 전부.
 * 상대 지뢰를 담을 필드가 타입 수준에서 존재하지 않는다(§4.2).
 * 유일한 예외는 `reveal`이며 phase === 'finished' 일 때만 채워진다.
 */
export interface ClientView {
  ruleset: Ruleset;
  phase: Phase;
  /** 이 뷰의 주인 */
  side: Side;
  turn: Side;
  score: { W: number; B: number };
  pos: { W: Cell; B: Cell };
  visited: Cell[];
  detonated: Cell[];
  treasures: { cell: Cell; order: number | null; takenBy: Side | null }[];
  /** 다음 보물의 점수 (§10.2 대응: 상시 표시) */
  nextAward: number | null;
  plies: { W: number; B: number };
  awaitReturnBy: Side | null;
  returnOptions: Cell[];
  legalMoves: Cell[];
  log: MoveRecord[];
  /** ruleset.showOwnMines 가 true일 때만 채워진다. 상대 것은 절대 들어가지 않는다. */
  ownMines: Cell[] | null;
  result: GameResult | null;
  /** phase === 'finished' 에서만 non-null */
  reveal: Placements | null;
}
