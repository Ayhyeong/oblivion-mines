import {
  TREASURES,
  applyReturn,
  combineFacts,
  commitPlacement,
  createPeerGame,
  factsFromRecord,
  labelOf,
  other,
  ownContribution,
  publicHash,
  resign,
  resolveMove,
  verifyRecordFull,
} from '../rules';
import type {
  Cell,
  Commitment,
  Contribution,
  GameRecord,
  MoveRecord,
  MoveResult,
  Ruleset,
  ServerState,
  Side,
  VerifyResult,
} from '../rules';
import { PROTOCOL_VERSION } from './protocol';
import type { Message } from './protocol';
import type { ConnState, Peer } from './peer';

export type SessionPhase = 'placement' | 'play' | 'finished' | 'desync';

export interface FullVerify extends VerifyResult {
  commitOk: { W: boolean; B: boolean };
}

export interface SessionHandlers {
  onChange: () => void;
  onNotice: (text: string, tone: 'info' | 'good' | 'bad') => void;
}

interface PendingOut {
  ply: number;
  to: Cell;
  mine: Contribution;
}

interface PendingIn {
  ply: number;
  to: Cell;
  mine: Contribution;
}

/**
 * 한 대국의 진행 전체를 맡는다.
 *
 * 핵심 규칙: **상대 지뢰 집합은 이 프로세스 어디에도 존재하지 않는다.**
 * 판정에 필요한 상대 몫은 매 수 두 숫자(`mine`, `adj`)로만 들어오고,
 * 그 값이 거짓이면 종료 시 리빌·리플레이 검증에서 드러난다(§7.3).
 */
export class Session {
  phase: SessionPhase = 'placement';
  state: ServerState | null = null;
  myCommit: Commitment | null = null;
  oppDigest: string | null = null;
  oppReveal: { cells: Cell[]; salt: string } | null = null;
  record: GameRecord | null = null;
  verify: FullVerify | null = null;
  conn: ConnState = 'idle';
  /** 내 수가 상대 응답을 기다리는 중 */
  pendingOut: PendingOut | null = null;
  /** 상대 수가 내 응답 이후 상대의 몫을 기다리는 중 */
  pendingIn: PendingIn | null = null;
  desyncReason: string | null = null;
  lastResult: { side: Side; to: Cell; res: MoveResult } | null = null;

  constructor(
    readonly ruleset: Ruleset,
    readonly mySide: Side,
    private peer: Peer,
    private handlers: SessionHandlers,
  ) {
    this.peer.on({
      onMessage: (m) => this.receive(m),
      onState: (s) => {
        this.conn = s;
        if (s === 'open') this.peer.send({ t: 'hello', v: PROTOCOL_VERSION });
        this.handlers.onChange();
      },
      onBadMessage: () => {
        this.handlers.onNotice('상대가 보낸 메시지를 해석할 수 없어 무시했습니다.', 'bad');
        this.handlers.onChange();
      },
    });
  }

  get oppSide(): Side {
    return other(this.mySide);
  }

  get myTurn(): boolean {
    const s = this.state;
    if (!s || s.phase === 'finished') return false;
    if (s.phase === 'awaitReturn') return s.awaitReturnBy === this.mySide;
    return s.turn === this.mySide && !this.pendingOut;
  }

  get waitingForOpponent(): boolean {
    return this.pendingOut !== null;
  }

  // ------------------------------------------------------------- 배치

  async submitPlacement(cells: Cell[]): Promise<void> {
    if (this.myCommit) return;
    this.myCommit = await commitPlacement(cells);
    this.peer.send({ t: 'commit', digest: this.myCommit.digest });
    this.tryStart();
    this.handlers.onChange();
  }

  private tryStart(): void {
    if (this.state || !this.myCommit || !this.oppDigest) return;
    this.state = createPeerGame(this.ruleset, this.mySide, this.myCommit.cells);
    this.phase = 'play';
    this.handlers.onNotice('양측 배치가 봉인되었습니다. 白 선공입니다.', 'info');
  }

  // ------------------------------------------------------------- 내 행동

  /** 이 칸으로 가려면 상대의 몫이 필요한가 */
  private needsExchange(s: ServerState, to: Cell): boolean {
    const unclaimedTreasure = TREASURES.includes(to) && !s.treasureOrder.includes(to);
    // 방문한 칸에는 살아 있는 지뢰가 존재할 수 없고, 보물 칸은 애초에 배치 금지다.
    return !unclaimedTreasure && !s.visited.has(to);
  }

  move(to: Cell): void {
    const s = this.state;
    if (!s || this.phase !== 'play' || !this.myTurn || s.phase !== 'play') return;
    const h = publicHash(s);
    const ply = s.log.length;

    if (!this.needsExchange(s, to)) {
      const res = resolveMove(s, this.mySide, to, { minesAt: 0, adjacent: 0 });
      this.peer.send({ t: 'move', ply, to, h });
      this.afterResolve(this.mySide, to, res);
      return;
    }

    const mine = ownContribution(s, this.mySide, to);
    this.pendingOut = { ply, to, mine };
    this.peer.send({ t: 'move', ply, to, mine: mine.mine, h });
    this.handlers.onChange();
  }

  chooseReturn(cell: Cell): void {
    const s = this.state;
    if (!s || s.phase !== 'awaitReturn' || s.awaitReturnBy !== this.mySide) return;
    const h = publicHash(s);
    const ply = s.log.length - 1;
    try {
      applyReturn(s, this.mySide, cell);
    } catch (e) {
      this.handlers.onNotice((e as Error).message, 'bad');
      this.handlers.onChange();
      return;
    }
    this.peer.send({ t: 'return', ply, cell, h });
    this.handlers.onNotice(`${labelOf(cell)} 로 복귀했습니다 (점수 변동 없음).`, 'info');
    this.checkFinished();
    this.handlers.onChange();
  }

  resign(): void {
    const s = this.state;
    if (!s || s.phase === 'finished') return;
    resign(s, this.mySide);
    this.peer.send({ t: 'resign' });
    this.handlers.onNotice('기권했습니다.', 'bad');
    this.checkFinished();
    this.handlers.onChange();
  }

  // ------------------------------------------------------------- 수신

  private receive(msg: Message): void {
    if (this.phase === 'desync') return;
    try {
      switch (msg.t) {
        case 'hello':
          if (msg.v !== PROTOCOL_VERSION) {
            this.fail(`프로토콜 버전이 다릅니다 (상대 ${msg.v}, 나 ${PROTOCOL_VERSION}).`);
          }
          break;
        case 'commit':
          if (this.oppDigest) break;
          this.oppDigest = msg.digest;
          this.tryStart();
          break;
        case 'move':
          this.onOppMove(msg);
          break;
        case 'moveAck':
          this.onMoveAck(msg);
          break;
        case 'moveAdj':
          this.onMoveAdj(msg);
          break;
        case 'return':
          this.onOppReturn(msg);
          break;
        case 'resign':
          this.onOppResign();
          break;
        case 'reveal':
          this.oppReveal = { cells: [...msg.cells], salt: msg.salt };
          void this.buildRecord();
          break;
        case 'resume':
          this.onResume(msg);
          break;
        case 'bye':
          this.handlers.onNotice(msg.reason ?? '상대가 대국을 떠났습니다.', 'bad');
          break;
      }
    } catch (e) {
      this.fail((e as Error).message);
    }
    this.handlers.onChange();
  }

  private expect(cond: unknown, why: string): asserts cond {
    if (!cond) throw new Error(why);
  }

  private onOppMove(msg: Extract<Message, { t: 'move' }>): void {
    const s = this.state;
    this.expect(s && s.phase === 'play', '상대가 둘 수 없는 국면에서 수를 보냈습니다.');
    this.expect(s!.turn === this.oppSide, '상대 차례가 아닌데 수가 들어왔습니다.');
    this.expect(msg.ply === s!.log.length, `수 번호가 어긋납니다 (기대 ${s!.log.length}, 수신 ${msg.ply}).`);
    this.expect(msg.h === publicHash(s!), '양측이 보는 판이 다릅니다.');
    const st = s!;

    if (!this.needsExchange(st, msg.to)) {
      const res = resolveMove(st, this.oppSide, msg.to, { minesAt: 0, adjacent: 0 });
      this.afterResolve(this.oppSide, msg.to, res);
      return;
    }

    this.expect(msg.mine !== undefined, '이동 메시지에 필요한 값이 빠졌습니다.');
    const mine = ownContribution(st, this.mySide, msg.to);
    const minesAt = (msg.mine ?? 0) + mine.mine;

    if (minesAt > 0) {
      // 폭발이면 인접 정보는 규칙상 쓰이지 않으므로 보내지 않는다.
      this.peer.send({ t: 'moveAck', ply: msg.ply, mine: mine.mine });
      const res = resolveMove(st, this.oppSide, msg.to, { minesAt, adjacent: 0 });
      this.afterResolve(this.oppSide, msg.to, res);
      return;
    }

    this.peer.send({ t: 'moveAck', ply: msg.ply, mine: 0, adj: mine.adjacent });
    this.pendingIn = { ply: msg.ply, to: msg.to, mine };
  }

  private onMoveAck(msg: Extract<Message, { t: 'moveAck' }>): void {
    const p = this.pendingOut;
    const s = this.state;
    this.expect(p && s, '기다리던 수가 없는데 응답이 왔습니다.');
    this.expect(p!.ply === msg.ply, '응답의 수 번호가 어긋납니다.');
    const minesAt = p!.mine.mine + msg.mine;

    if (minesAt > 0) {
      const res = resolveMove(s!, this.mySide, p!.to, { minesAt, adjacent: 0 });
      this.pendingOut = null;
      this.afterResolve(this.mySide, p!.to, res);
      return;
    }

    this.expect(msg.adj !== undefined, '인접 지뢰 수가 빠진 응답입니다.');
    const facts = combineFacts(this.ruleset, p!.mine, { mine: 0, adjacent: msg.adj ?? 0 });
    const res = resolveMove(s!, this.mySide, p!.to, facts);
    this.peer.send({ t: 'moveAdj', ply: p!.ply, adj: p!.mine.adjacent });
    this.pendingOut = null;
    this.afterResolve(this.mySide, p!.to, res);
  }

  private onMoveAdj(msg: Extract<Message, { t: 'moveAdj' }>): void {
    const p = this.pendingIn;
    const s = this.state;
    this.expect(p && s, '기다리던 상대 수가 없습니다.');
    this.expect(p!.ply === msg.ply, '응답의 수 번호가 어긋납니다.');
    const facts = combineFacts(this.ruleset, { mine: 0, adjacent: msg.adj }, p!.mine);
    const res = resolveMove(s!, this.oppSide, p!.to, facts);
    this.pendingIn = null;
    this.afterResolve(this.oppSide, p!.to, res);
  }

  private onOppReturn(msg: Extract<Message, { t: 'return' }>): void {
    const s = this.state;
    this.expect(s && s.phase === 'awaitReturn', '복귀할 국면이 아닙니다.');
    this.expect(s!.awaitReturnBy === this.oppSide, '상대가 복귀할 차례가 아닙니다.');
    this.expect(msg.h === publicHash(s!), '양측이 보는 판이 다릅니다.');
    applyReturn(s!, this.oppSide, msg.cell);
    this.checkFinished();
  }

  private onOppResign(): void {
    const s = this.state;
    if (!s || s.phase === 'finished') return;
    resign(s, this.oppSide);
    this.handlers.onNotice('상대가 기권했습니다.', 'good');
    this.checkFinished();
  }

  private onResume(msg: Extract<Message, { t: 'resume' }>): void {
    const s = this.state;
    if (!s) return;
    if (msg.log.length <= s.log.length) {
      if (msg.h !== publicHash(s) && msg.log.length === s.log.length) {
        this.fail('재연결했지만 양측 기록이 다릅니다.');
      }
      return;
    }
    // 내 쪽이 뒤처졌다 — 기록된 판정을 그대로 적용해 따라잡는다.
    for (let i = 0; i < s.log.length; i++) {
      const mine = s.log[i];
      const theirs = msg.log[i];
      if (mine.to !== theirs.to || mine.side !== theirs.side || mine.delta !== theirs.delta) {
        this.fail('재연결했지만 기보가 갈라져 있습니다.');
        return;
      }
    }
    for (let i = s.log.length; i < msg.log.length; i++) {
      const rec = msg.log[i] as MoveRecord;
      resolveMove(s, rec.side, rec.to, factsFromRecord(rec));
      if (rec.kind === 'mine' && rec.returnTo !== undefined) applyReturn(s, rec.side, rec.returnTo);
    }
    this.pendingOut = null;
    this.pendingIn = null;
    this.handlers.onNotice(`재연결해 ${msg.log.length}수까지 따라잡았습니다.`, 'good');
    this.checkFinished();
  }

  /** 재연결 직후 양쪽이 서로에게 보낸다. */
  sendResume(): void {
    const s = this.state;
    if (!s) return;
    this.peer.send({
      t: 'resume',
      log: s.log.map((r) => ({ ...r, scoreAfter: { ...r.scoreAfter } })),
      h: publicHash(s),
      finished: s.phase === 'finished',
    });
  }

  /** 재연결로 새 채널이 생겼을 때 갈아 끼운다. */
  rebind(peer: Peer): void {
    this.peer = peer;
    peer.on({
      onMessage: (m) => this.receive(m),
      onState: (st) => {
        this.conn = st;
        if (st === 'open') {
          this.peer.send({ t: 'hello', v: PROTOCOL_VERSION });
          if (this.myCommit) this.peer.send({ t: 'commit', digest: this.myCommit.digest });
          this.sendResume();
        }
        this.handlers.onChange();
      },
      onBadMessage: () => this.handlers.onNotice('해석할 수 없는 메시지를 무시했습니다.', 'bad'),
    });
  }

  // ------------------------------------------------------------- 마무리

  private afterResolve(side: Side, to: Cell, res: MoveResult): void {
    this.lastResult = { side, to, res };
    this.checkFinished();
  }

  private checkFinished(): void {
    const s = this.state;
    if (!s || s.phase !== 'finished' || this.phase === 'finished') return;
    this.phase = 'finished';
    if (this.myCommit) {
      this.peer.send({ t: 'reveal', cells: this.myCommit.cells, salt: this.myCommit.salt });
    }
    void this.buildRecord();
  }

  private async buildRecord(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== 'finished' || !s.result) return;
    if (!this.myCommit || !this.oppReveal || !this.oppDigest) return;
    if (this.record) return;

    const oppCommit: Commitment = {
      digest: this.oppDigest,
      salt: this.oppReveal.salt,
      cells: this.oppReveal.cells,
    };
    this.record = {
      version: 1,
      ruleset: this.ruleset,
      commitments:
        this.mySide === 'W'
          ? { W: this.myCommit, B: oppCommit }
          : { W: oppCommit, B: this.myCommit },
      log: s.log,
      result: s.result,
      playedAt: new Date().toISOString(),
    };
    this.verify = await verifyRecordFull(this.record);
    this.handlers.onChange();
  }

  private fail(reason: string): void {
    this.phase = 'desync';
    this.desyncReason = reason;
    this.handlers.onNotice(reason, 'bad');
  }

  leave(reason?: string): void {
    this.peer.send({ t: 'bye', reason });
    this.peer.close();
  }
}
