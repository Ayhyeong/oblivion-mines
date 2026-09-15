import { z } from 'zod';
import { CELL_COUNT } from '../rules';

/**
 * 피어 간 메시지 스키마(§8).
 *
 * P2P 대국에서 상대는 곧 잠재적 공격자다. 들어오는 모든 메시지는 예외 없이
 * 여기를 통과시킨 뒤에만 다룬다. 스키마는 양쪽이 같은 파일을 쓴다.
 *
 * 지뢰 위치는 어떤 메시지에도 들어가지 않는다. 오가는 것은
 *   - `mine`: 목적지 칸에 내 지뢰가 있는가 (0/1)
 *   - `adj` : 목적지 칸에 인접한 내 지뢰 개수 (0~8)
 * 두 숫자뿐이고, 둘 다 규칙상 어차피 공개되는 판정 결과로부터 역산되는 값이다.
 * `adj` 는 판정이 '신규 칸'으로 확정된 뒤에만 보낸다 — 폭발·보물·기방문 칸에서는
 * 규칙이 인접 정보를 주지 않으므로 전송도 하지 않는다.
 */

export const PROTOCOL_VERSION = 1;

export const CellSchema = z.number().int().min(0).max(CELL_COUNT - 1);
export const SideSchema = z.enum(['W', 'B']);
export const HashSchema = z.string().regex(/^[0-9a-f]{8}$/);
export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const SaltSchema = z.string().regex(/^[0-9a-f]{16,256}$/);
const Bit = z.union([z.literal(0), z.literal(1)]);

export const RulesetSchema = z.object({
  id: z.string().min(1).max(64),
  mineCount: z.number().int().min(1).max(40),
  treasureAwards: z.array(z.number().int().min(-99).max(999)).length(3),
  countOwnMines: z.boolean(),
  minePenalty: z.number().int().min(-99).max(0),
  plyLimit: z.number().int().min(5).max(300),
  komi: z.number().int().min(-99).max(99),
  showOwnMines: z.boolean(),
});

export const MoveRecordSchema = z.object({
  ply: z.number().int().min(0).max(999),
  side: SideSchema,
  from: CellSchema,
  to: CellSchema,
  kind: z.enum(['mine', 'treasure', 'visited', 'fresh']),
  delta: z.number().int().min(-99).max(999),
  minesHit: z.number().int().min(0).max(2).optional(),
  returnTo: CellSchema.optional(),
  scoreAfter: z.object({ W: z.number().int(), B: z.number().int() }),
});

export const MessageSchema = z.discriminatedUnion('t', [
  /** 연결 직후 서로 확인 */
  z.object({
    t: z.literal('hello'),
    v: z.number().int(),
    name: z.string().max(24).optional(),
  }),
  /** 배치 봉인 공개 — digest 만 (§7.2) */
  z.object({ t: z.literal('commit'), digest: DigestSchema }),
  /**
   * 이동 선언. `mine` 은 목적지가 미방문·비보물 칸일 때만 포함한다
   * (방문 칸과 보물 칸에는 살아 있는 지뢰가 존재할 수 없다).
   */
  z.object({
    t: z.literal('move'),
    ply: z.number().int().min(0).max(999),
    to: CellSchema,
    mine: Bit.optional(),
    h: HashSchema,
  }),
  /** 이동에 대한 상대 몫 응답. `adj` 는 판정이 '신규 칸'으로 확정된 경우에만. */
  z.object({
    t: z.literal('moveAck'),
    ply: z.number().int().min(0).max(999),
    mine: Bit,
    adj: z.number().int().min(0).max(8).optional(),
  }),
  /** 신규 칸 확정 후 두는 쪽이 자기 몫을 보낸다. */
  z.object({
    t: z.literal('moveAdj'),
    ply: z.number().int().min(0).max(999),
    adj: z.number().int().min(0).max(8),
  }),
  /** 폭발 후 복귀 칸 선택 */
  z.object({
    t: z.literal('return'),
    ply: z.number().int().min(0).max(999),
    cell: CellSchema,
    h: HashSchema,
  }),
  z.object({ t: z.literal('resign') }),
  /** 종료 후 배치 공개 (§7.2 리빌) */
  z.object({
    t: z.literal('reveal'),
    cells: z.array(CellSchema).min(1).max(40),
    salt: SaltSchema,
  }),
  /** 재연결 후 상태 맞추기 */
  z.object({
    t: z.literal('resume'),
    log: z.array(MoveRecordSchema).max(999),
    h: HashSchema,
    finished: z.boolean(),
  }),
  z.object({ t: z.literal('bye'), reason: z.string().max(140).optional() }),
]);

export type Message = z.infer<typeof MessageSchema>;
export type MessageOf<T extends Message['t']> = Extract<Message, { t: T }>;

export function parseMessage(raw: unknown): Message | null {
  const res = MessageSchema.safeParse(raw);
  return res.success ? res.data : null;
}
