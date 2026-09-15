import {
  DEFAULT_RULESET,
  FORBIDDEN,
  PLACEABLE,
  SIDE_NAME,
  START,
  TREASURES,
  labelOf,
  legalMoves,
  other,
  recordFromJson,
  recordToJson,
  returnOptions,
  validatePlacement,
  verifyRecordFull,
} from '../rules';
import type { Cell, GameRecord, Ruleset, ServerState, Side } from '../rules';
import { Peer, isWebRtcSupported } from '../net/peer';
import { Session } from '../net/session';
import type { FullVerify } from '../net/session';
import {
  clearInviteFromLocation,
  decodeAnswer,
  decodeOffer,
  encodeSignal,
  inviteLink,
  readInviteFromLocation,
} from '../net/signal';
import type { OfferPayload } from '../net/signal';
import { createBoard, emptyOpts, moveCursor } from './board';
import type { BoardOpts, BoardView, CellEvent } from './board';
import { clear, copyText, download, el } from './dom';
import { loadPrefs, savePrefs } from './prefs';
import type { Prefs } from './prefs';

type Screen = 'home' | 'host' | 'guest' | 'placement' | 'play' | 'finished';

interface State {
  screen: Screen;
  prefs: Prefs;
  /** 방 열기 */
  peer: Peer | null;
  session: Session | null;
  myOfferCode: string | null;
  myAnswerCode: string | null;
  incomingOffer: OfferPayload | null;
  /** 호스트가 상대 응답 코드를 실제로 받아들였는가 */
  answerAccepted: boolean;
  signalBusy: boolean;
  /** 배치 */
  draft: Set<Cell>;
  /** 플레이 */
  flags: Set<Cell>;
  selected: Cell | null;
  cursor: Cell;
  notice: { text: string; tone: 'info' | 'good' | 'bad' } | null;
  /** 종료 */
  replayIndex: number | null;
  modal: HTMLElement | null;
}

const state: State = {
  screen: 'home',
  prefs: loadPrefs(),
  peer: null,
  session: null,
  myOfferCode: null,
  myAnswerCode: null,
  incomingOffer: null,
  answerAccepted: false,
  signalBusy: false,
  draft: new Set(),
  flags: new Set(),
  selected: null,
  cursor: START.W,
  notice: null,
  replayIndex: null,
  modal: null,
};

let board: BoardView;
let sideEl: HTMLElement;
let topEl: HTMLElement;
let overlayEl: HTMLElement;

const fmt = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

function notify(text: string, tone: 'info' | 'good' | 'bad' = 'info'): void {
  state.notice = { text, tone };
}

const mySide = (): Side => state.session?.mySide ?? 'W';

/** 대국이 시작되면 방을 연 쪽이 정한 룰셋이 기준이다 — 내 로컬 설정이 아니라. */
const activeRuleset = (): Ruleset => state.session?.ruleset ?? state.prefs.ruleset;

// ---------------------------------------------------------------- 연결

function sessionHandlers(): { onChange: () => void; onNotice: typeof notify } {
  return {
    onChange: () => {
      const s = state.session;
      if (s) {
        // 연결이 실제로 열린 뒤에야 배치로 넘어간다 — 그 전에는 코드를 계속 보여줘야 한다.
        if (s.conn === 'open' && (state.screen === 'host' || state.screen === 'guest')) {
          goPlacement();
          return;
        }
        if (state.screen !== 'finished') {
          if (s.phase === 'play' && state.screen !== 'play') {
            state.screen = 'play';
            state.cursor = s.state?.pos[s.mySide] ?? START.W;
          } else if (s.phase === 'finished') {
            state.screen = 'finished';
            state.replayIndex = null;
          }
        }
      }
      render();
    },
    onNotice: notify,
  };
}

async function startHosting(): Promise<void> {
  if (!ensureWebRtc()) return;
  state.signalBusy = true;
  state.screen = 'host';
  state.myOfferCode = null;
  state.answerAccepted = false;
  render();
  try {
    const { peer, sdp } = await Peer.host();
    state.peer = peer;
    state.session = new Session(state.prefs.ruleset, state.prefs.hostSide, peer, sessionHandlers());
    state.myOfferCode = await encodeSignal({
      v: 1,
      t: 'offer',
      sdp,
      ruleset: state.prefs.ruleset,
      hostSide: state.prefs.hostSide,
    });
  } catch (e) {
    notify(`초대 코드를 만들지 못했습니다: ${(e as Error).message}`, 'bad');
    state.screen = 'home';
  } finally {
    state.signalBusy = false;
    render();
  }
}

async function acceptAnswerCode(code: string): Promise<void> {
  const peer = state.peer;
  if (!peer) return;
  state.signalBusy = true;
  render();
  try {
    const answer = await decodeAnswer(code);
    await peer.acceptAnswer(answer.sdp);
    state.answerAccepted = true;
    notify('연결 중입니다…', 'info');
  } catch (e) {
    notify((e as Error).message, 'bad');
  } finally {
    state.signalBusy = false;
    render();
  }
}

async function openInvite(code: string): Promise<void> {
  if (!ensureWebRtc()) return;
  state.signalBusy = true;
  state.screen = 'guest';
  render();
  try {
    state.incomingOffer = await decodeOffer(code);
  } catch (e) {
    notify((e as Error).message, 'bad');
    state.incomingOffer = null;
  } finally {
    state.signalBusy = false;
    render();
  }
}

async function acceptInvite(): Promise<void> {
  const offer = state.incomingOffer;
  if (!offer) return;
  state.signalBusy = true;
  render();
  try {
    const { peer, sdp } = await Peer.guest(offer.sdp);
    state.peer = peer;
    state.session = new Session(offer.ruleset, other(offer.hostSide), peer, sessionHandlers());
    state.myAnswerCode = await encodeSignal({ v: 1, t: 'answer', sdp });
  } catch (e) {
    notify(`응답 코드를 만들지 못했습니다: ${(e as Error).message}`, 'bad');
  } finally {
    state.signalBusy = false;
    render();
  }
}

function goPlacement(): void {
  state.draft = new Set();
  state.flags = new Set();
  state.selected = null;
  state.cursor = START[mySide()];
  state.screen = 'placement';
  render();
}

function ensureWebRtc(): boolean {
  if (isWebRtcSupported()) return true;
  notify('이 브라우저는 WebRTC 를 지원하지 않아 온라인 대국을 할 수 없습니다.', 'bad');
  render();
  return false;
}

function leaveGame(): void {
  state.session?.leave();
  state.peer?.close();
  state.peer = null;
  state.session = null;
  state.myOfferCode = null;
  state.myAnswerCode = null;
  state.incomingOffer = null;
  state.answerAccepted = false;
  state.screen = 'home';
  state.notice = null;
  state.replayIndex = null;
  render();
}

// ---------------------------------------------------------------- 입력

function onCell(c: Cell, kind: CellEvent): void {
  if (state.modal) return;
  state.cursor = c;

  if (state.screen === 'placement') {
    if (kind === 'secondary') return;
    if (state.session?.myCommit) return;
    if (FORBIDDEN.has(c)) {
      notify('시작 구역과 보물 칸에는 지뢰를 놓을 수 없습니다.', 'bad');
      render();
      return;
    }
    const cap = activeRuleset().mineCount;
    if (state.draft.has(c)) state.draft.delete(c);
    else if (state.draft.size >= cap) {
      notify(`지뢰는 ${cap}개까지입니다. 먼저 하나를 빼세요.`, 'bad');
    } else state.draft.add(c);
    state.notice = null;
    render();
    return;
  }

  if (state.screen !== 'play') return;
  const sess = state.session;
  const g = sess?.state;
  if (!sess || !g) return;

  if (kind === 'secondary') {
    if (state.flags.has(c)) state.flags.delete(c);
    else state.flags.add(c);
    render();
    return;
  }

  if (g.phase === 'awaitReturn') {
    if (sess.myTurn && returnOptions(g, sess.mySide).includes(c)) sess.chooseReturn(c);
    return;
  }

  if (!sess.myTurn || !legalMoves(g, sess.mySide).includes(c)) return;

  if (state.prefs.confirmMoves && state.selected !== c) {
    state.selected = c;
    state.notice = null;
    render();
    return;
  }
  state.selected = null;
  sess.move(c);
  render();
}

function onKey(e: KeyboardEvent): void {
  if (state.modal) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (state.screen !== 'placement' && state.screen !== 'play') return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

  const deltas: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };
  const d = deltas[e.key];
  if (d) {
    e.preventDefault();
    state.cursor = moveCursor(state.cursor, d[0], d[1]);
    render();
    board.focusCell(state.cursor);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onCell(state.cursor, 'primary');
    board.focusCell(state.cursor);
    return;
  }
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    onCell(state.cursor, 'secondary');
    board.focusCell(state.cursor);
    return;
  }
  if (e.key === 'Escape' && state.selected !== null) {
    state.selected = null;
    render();
  }
}

// ---------------------------------------------------------------- 렌더링

function render(): void {
  renderTop();
  renderBoard();
  renderSide();
  renderOverlay();
}

function renderBoard(): void {
  const o: BoardOpts = emptyOpts();
  const treasuresFresh = TREASURES.map((cell) => ({ cell, order: null, takenBy: null }));

  if (state.screen === 'placement') {
    const locked = !!state.session?.myCommit;
    o.showForbidden = true;
    o.myMines = state.draft;
    o.treasures = treasuresFresh;
    o.actionable = locked ? new Set() : new Set(PLACEABLE);
    o.cursor = state.cursor;
    board.update(o);
    return;
  }

  const sess = state.session;
  if (state.screen === 'play' && sess?.state) {
    const g = sess.state;
    o.visited = new Set(g.visited);
    o.detonated = new Set(g.detonated);
    o.treasures = treasureView(g);
    o.pos = { ...g.pos };
    o.myMines = g.ruleset.showOwnMines ? new Set(g.mines[sess.mySide]) : new Set();
    o.flags = state.flags;
    o.actionable = new Set(
      !sess.myTurn
        ? []
        : g.phase === 'awaitReturn'
          ? returnOptions(g, sess.mySide)
          : legalMoves(g, sess.mySide),
    );
    o.selected = state.selected;
    o.cursor = state.cursor;
    const last = g.log[g.log.length - 1];
    o.lastMove = last ? { from: last.from, to: last.to } : null;
    board.update(o);
    return;
  }

  if (state.screen === 'finished' && sess?.state) {
    const snap = replaySnapshot();
    o.visited = snap.visited;
    o.detonated = snap.detonated;
    o.treasures = snap.treasures;
    o.pos = snap.pos;
    o.revealW = snap.minesW;
    o.revealB = snap.minesB;
    o.lastMove = snap.lastMove;
    board.update(o);
    return;
  }

  o.showForbidden = true;
  o.treasures = treasuresFresh;
  o.pos = { W: START.W, B: START.B };
  board.update(o);
}

function treasureView(g: ServerState): { cell: Cell; order: number | null; takenBy: Side | null }[] {
  return TREASURES.map((cell) => {
    const order = g.treasureOrder.indexOf(cell);
    return { cell, order: order < 0 ? null : order, takenBy: g.treasureTakenBy[cell] ?? null };
  });
}

interface Snapshot {
  visited: Set<Cell>;
  detonated: Set<Cell>;
  treasures: { cell: Cell; order: number | null; takenBy: Side | null }[];
  pos: { W: Cell; B: Cell };
  minesW: Set<Cell>;
  minesB: Set<Cell>;
  lastMove: { from: Cell; to: Cell } | null;
  score: { W: number; B: number };
}

function replaySnapshot(): Snapshot {
  const sess = state.session!;
  const g = sess.state!;
  const rec = sess.record;
  const states = sess.verify?.states ?? [];
  const idx = state.replayIndex;

  if (idx === null || !states.length || !rec) {
    const last = g.log[g.log.length - 1];
    return {
      visited: new Set(g.visited),
      detonated: new Set(g.detonated),
      treasures: treasureView(g),
      pos: { ...g.pos },
      minesW: new Set(rec ? rec.commitments.W.cells : g.mines.W),
      minesB: new Set(rec ? rec.commitments.B.cells : g.mines.B),
      lastMove: last ? { from: last.from, to: last.to } : null,
      score: { ...g.score },
    };
  }

  const s = states[Math.min(idx, states.length - 1)];
  const last = idx > 0 ? rec.log[idx - 1] : null;
  return {
    visited: new Set(s.visited),
    detonated: new Set(s.detonated),
    treasures: treasureView(s),
    pos: { ...s.pos },
    minesW: new Set(s.mines.W),
    minesB: new Set(s.mines.B),
    lastMove: last ? { from: last.from, to: last.to } : null,
    score: { ...s.score },
  };
}

function chip(text: string, tone: string): HTMLElement {
  return el('span', { class: `chip chip-${tone}`, text });
}

function connChip(): HTMLElement | null {
  const sess = state.session;
  if (!sess) return null;
  const map: Record<string, [string, string]> = {
    idle: ['대기', 'plain'],
    signaling: ['코드 교환 중', 'warn'],
    connecting: ['연결 중', 'warn'],
    open: ['연결됨', 'good'],
    closed: ['연결 끊김', 'bad'],
    failed: ['연결 실패', 'bad'],
  };
  const [text, tone] = map[sess.conn] ?? ['—', 'plain'];
  return chip(text, tone);
}

function renderTop(): void {
  clear(topEl);
  topEl.append(
    el(
      'div',
      { class: 'brand' },
      el('span', { class: 'brand-mark', text: '✹' }),
      el(
        'div',
        {},
        el('h1', { text: '망각의 지뢰' }),
        el('p', { class: 'brand-sub', text: '온라인 1:1 · 서버 없는 P2P' }),
      ),
    ),
  );

  const chips = el('div', { class: 'chips' });
  const sess = state.session;

  if (state.screen === 'placement') {
    const cap = activeRuleset().mineCount;
    chips.append(chip(`${SIDE_NAME[mySide()]} (나)`, mySide() === 'W' ? 'w' : 'b'));
    chips.append(chip(`${state.draft.size} / ${cap}`, state.draft.size === cap ? 'good' : 'warn'));
  } else if ((state.screen === 'play' || state.screen === 'finished') && sess?.state) {
    const g = sess.state;
    const score = state.screen === 'finished' ? replaySnapshot().score : g.score;
    chips.append(chip(`白 ${score.W}`, 'w'));
    chips.append(chip(`黑 ${score.B}`, 'b'));
    if (state.screen === 'play') {
      chips.append(
        chip(
          g.phase === 'awaitReturn'
            ? `${SIDE_NAME[g.awaitReturnBy!]} 복귀`
            : sess.myTurn
              ? '내 차례'
              : '상대 차례',
          sess.myTurn ? 'gold' : 'plain',
        ),
      );
      const treasureIdx = g.treasureOrder.length;
      if (treasureIdx < g.ruleset.treasureAwards.length) {
        chips.append(chip(`다음 보물 +${g.ruleset.treasureAwards[treasureIdx]}`, 'gold'));
      }
      chips.append(chip(`${g.plies.W}·${g.plies.B} / ${g.ruleset.plyLimit}수`, 'plain'));
    }
  }

  const cc = connChip();
  if (cc) chips.append(cc);
  topEl.append(chips);
}

function renderSide(): void {
  clear(sideEl);
  if (state.notice) {
    sideEl.append(el('div', { class: `notice notice-${state.notice.tone}`, text: state.notice.text }));
  }
  const sess = state.session;
  if (sess?.phase === 'desync') {
    sideEl.append(
      el(
        'div',
        { class: 'panel' },
        el('h2', { text: '대국 중단' }),
        el('p', { class: 'muted', text: sess.desyncReason ?? '양측 상태가 어긋났습니다.' }),
        el('p', {
          class: 'muted small',
          text: '상대가 규칙과 다른 값을 보냈거나 연결이 꼬였습니다. 기보를 내보내 두면 나중에 검증할 수 있습니다.',
        }),
      ),
    );
  }

  switch (state.screen) {
    case 'home':
      renderHome();
      break;
    case 'host':
      renderHostPanel();
      break;
    case 'guest':
      renderGuestPanel();
      break;
    case 'placement':
      renderPlacementPanel();
      break;
    case 'play':
      renderPlayPanel();
      break;
    case 'finished':
      renderFinishedPanel();
      break;
  }
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `btn ${cls}`.trim(), text: label });
  b.addEventListener('click', onClick);
  return b;
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label', text: label }),
    input,
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  );
}

function numberInput(value: number, onChange: (n: number) => void, min: number, max: number): HTMLInputElement {
  const i = el('input', { type: 'number', class: 'input', value: String(value), min: String(min), max: String(max) });
  i.addEventListener('change', () => {
    const n = Number(i.value);
    if (Number.isFinite(n)) onChange(n);
  });
  return i;
}

function checkbox(label: string, checked: boolean, onChange: (b: boolean) => void, hint?: string): HTMLElement {
  const i = el('input', { type: 'checkbox', checked });
  i.addEventListener('change', () => onChange(i.checked));
  return el(
    'label',
    { class: 'check' },
    i,
    el('span', {}, el('span', { class: 'check-label', text: label }), hint ? el('span', { class: 'field-hint', text: hint }) : null),
  );
}

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));

function codeBox(label: string, code: string, hint: string): HTMLElement {
  const area = el('textarea', { class: 'input code', readonly: true, rows: 4, spellcheck: 'false' });
  area.value = code;
  area.addEventListener('focus', () => area.select());
  const row = el('div', { class: 'actions' });
  row.append(
    button('코드 복사', () => {
      void copyText(code).then((ok) => {
        notify(ok ? '복사했습니다. 상대에게 그대로 전달하세요.' : '복사에 실패했습니다. 직접 선택해 복사하세요.', ok ? 'good' : 'bad');
        render();
      });
    }, 'btn-primary'),
  );
  return el('div', {}, el('h3', { text: label }), el('p', { class: 'muted small', text: hint }), area, row);
}

function pasteBox(label: string, hint: string, cta: string, onSubmit: (v: string) => void): HTMLElement {
  const area = el('textarea', { class: 'input code', rows: 4, spellcheck: 'false', placeholder: '여기에 붙여넣기' });
  const row = el('div', { class: 'actions' });
  const go = button(cta, () => {
    const v = area.value.trim();
    if (!v) {
      notify('코드를 붙여넣어 주세요.', 'bad');
      render();
      return;
    }
    onSubmit(v);
  }, 'btn-primary');
  go.disabled = state.signalBusy;
  row.append(go);
  return el('div', {}, el('h3', { text: label }), el('p', { class: 'muted small', text: hint }), area, row);
}

// ------------------------------------------------------------ home

function renderHome(): void {
  const r = state.prefs.ruleset;
  const set = (patch: Partial<Ruleset>): void => {
    state.prefs.ruleset = { ...state.prefs.ruleset, ...patch };
    savePrefs(state.prefs);
    render();
  };

  const intro = el('div', { class: 'panel' });
  intro.append(el('h2', { text: '온라인 1:1' }));
  intro.append(
    el('p', {
      class: 'muted',
      text: '집·회사·모바일 데이터 등 서로 다른 인터넷이어도 됩니다. 두 브라우저가 직접 연결되고, 서버가 없으므로 상대 지뢰는 어떤 경로로도 내 브라우저에 오지 않습니다.',
    }),
  );
  intro.append(
    el('p', {
      class: 'muted small',
      text: '코드를 주고받는 것은 연결할 때 딱 한 번입니다. 연결된 뒤에는 수가 자동으로 오갑니다.',
    }),
  );
  const start = el('div', { class: 'actions' });
  start.append(button('방 만들기', () => void startHosting(), 'btn-primary'));
  start.append(button('초대 코드로 참가', () => { state.screen = 'guest'; state.incomingOffer = null; render(); }));
  start.append(button('규칙', showRules));
  intro.append(start);
  sideEl.append(intro);

  const panel = el('div', { class: 'panel' });
  panel.append(el('h3', { text: '방 설정 (방을 여는 쪽이 정합니다)' }));

  const sideSel = el('select', { class: 'input' });
  for (const [v, t] of [['W', '白 — 선공'], ['B', '黑 — 후공']] as const) {
    const opt = el('option', { value: v, text: t });
    if (state.prefs.hostSide === v) opt.selected = true;
    sideSel.append(opt);
  }
  sideSel.addEventListener('change', () => {
    state.prefs.hostSide = sideSel.value as Side;
    savePrefs(state.prefs);
    render();
  });
  panel.append(field('내 색', sideSel));

  const grid = el('div', { class: 'grid2' });
  grid.append(field('지뢰 수', numberInput(r.mineCount, (n) => set({ mineCount: clampInt(n, 1, 40) }), 1, 40)));
  grid.append(field('지뢰 점수', numberInput(r.minePenalty, (n) => set({ minePenalty: clampInt(n, -50, 0) }), -50, 0)));
  grid.append(field('수 상한(각자)', numberInput(r.plyLimit, (n) => set({ plyLimit: clampInt(n, 5, 300) }), 5, 300)));
  grid.append(field('덤 (黑 보정)', numberInput(r.komi, (n) => set({ komi: clampInt(n, -30, 30) }), -30, 30), '§10.1'));
  panel.append(grid);

  const awards = el('input', { type: 'text', class: 'input', value: r.treasureAwards.join(', ') });
  awards.addEventListener('change', () => {
    const parsed = awards.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
    if (parsed.length === 3) set({ treasureAwards: parsed });
    else {
      notify('보물 점수는 숫자 3개여야 합니다. 예: 10, 15, 20', 'bad');
      render();
    }
  });
  panel.append(field('보물 점수 (1·2·3번째)', awards, '뒤에 먹을수록 이득인 구조입니다 — §10.2'));

  panel.append(
    checkbox('자기 지뢰도 인접 점수에 포함', r.countOwnMines, (b) => set({ countOwnMines: b }), '끄면 추론 모드'),
    checkbox('플레이 중 내 지뢰 표시', r.showOwnMines, (b) => set({ showOwnMines: b }), '켜면 망각 모드가 해제됩니다'),
    checkbox('탭 → 확인 2단계 입력', state.prefs.confirmMoves, (b) => {
      state.prefs.confirmMoves = b;
      savePrefs(state.prefs);
      render();
    }, '모바일 오조작 방지 (§9.4)'),
  );

  panel.append(
    el('div', { class: 'actions' },
      button('기본값으로', () => {
        state.prefs.ruleset = { ...DEFAULT_RULESET };
        savePrefs(state.prefs);
        render();
      }),
    ),
  );
  sideEl.append(panel);
  sideEl.append(verifyToolPanel());
}

function verifyToolPanel(): HTMLElement {
  const p = el('div', { class: 'panel' });
  p.append(el('h3', { text: '기보 검증' }));
  p.append(
    el('p', {
      class: 'muted small',
      text: '내보낸 대국 기록(JSON)을 규칙 코어로 처음부터 재현해 점수와 배치 해시를 대조합니다. 누구든 다시 검증할 수 있습니다.',
    }),
  );
  const file = el('input', { type: 'file', class: 'input', accept: '.json,application/json' });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    void f.text().then(async (text) => {
      try {
        const rec = recordFromJson(text);
        showVerifyModal(rec, await verifyRecordFull(rec));
      } catch (e) {
        notify(`기록을 읽지 못했습니다: ${(e as Error).message}`, 'bad');
        render();
      }
    });
  });
  p.append(file);
  return p;
}

// ------------------------------------------------------------ 방 열기 / 참가

function renderHostPanel(): void {
  const panel = el('div', { class: 'panel' });
  panel.append(el('h2', { text: '방 만들기' }));
  panel.append(
    el('p', { class: 'muted', text: `내 색: ${SIDE_NAME[state.prefs.hostSide]} · 지뢰 ${state.prefs.ruleset.mineCount}개 · 수 상한 ${state.prefs.ruleset.plyLimit}` }),
  );

  if (!state.myOfferCode) {
    panel.append(el('p', { class: 'muted', text: '초대 코드를 만드는 중입니다…' }));
    sideEl.append(panel);
    return;
  }

  const link = inviteLink(state.myOfferCode);
  panel.append(el('h3', { text: '1. 초대 보내기' }));
  panel.append(
    el('p', {
      class: 'muted small',
      text: '아래 링크를 상대에게 보내세요. 링크가 너무 길면 그 아래 코드를 복사해 전달해도 됩니다. 상대가 다른 인터넷을 써도 됩니다.',
    }),
  );
  const linkRow = el('div', { class: 'actions' });
  linkRow.append(
    button('초대 링크 복사', () => {
      void copyText(link).then((ok) => {
        notify(ok ? '초대 링크를 복사했습니다.' : '복사에 실패했습니다.', ok ? 'good' : 'bad');
        render();
      });
    }, 'btn-primary'),
  );
  panel.append(linkRow);
  panel.append(codeBox('초대 코드', state.myOfferCode, '링크 대신 이 코드를 보내도 됩니다.'));
  sideEl.append(panel);

  // 입력란은 연결이 실제로 열릴 때까지 계속 보여준다 — 브라우저는 응답을 받기 전에도
  // connectionState 를 'connecting' 으로 올리는 경우가 있어서, 그것만 믿고 숨기면 막힌다.
  const step2 = el('div', { class: 'panel' });
  step2.append(
    pasteBox(
      '2. 상대의 응답 코드 붙여넣기',
      '상대가 초대를 열면 응답 코드가 나옵니다. 그것을 받아 여기에 넣으면 연결됩니다. 여기까지가 마지막 수동 단계이고, 이후 대국은 자동으로 진행됩니다.',
      '연결',
      (v) => void acceptAnswerCode(v),
    ),
  );
  if (state.answerAccepted) {
    step2.append(
      el('p', {
        class: state.session?.conn === 'failed' ? 'warn-text small' : 'muted small',
        text:
          state.session?.conn === 'failed'
            ? '경로를 찾지 못했습니다. 같은 네트워크에서 다시 시도하거나 방을 새로 여세요.'
            : '응답 코드를 받았습니다. 연결을 여는 중입니다…',
      }),
    );
  }
  step2.append(el('div', { class: 'actions' }, button('취소', leaveGame)));
  sideEl.append(step2);
}

function renderGuestPanel(): void {
  const panel = el('div', { class: 'panel' });
  panel.append(el('h2', { text: '초대로 참가' }));

  if (!state.incomingOffer) {
    panel.append(pasteBox('초대 코드', '상대에게 받은 초대 코드(또는 링크의 뒷부분)를 붙여넣으세요.', '열기', (v) => void openInvite(v)));
    panel.append(el('div', { class: 'actions' }, button('뒤로', leaveGame)));
    sideEl.append(panel);
    return;
  }

  const o = state.incomingOffer;
  const guestSide = other(o.hostSide);
  panel.append(
    el('div', { class: 'ruleset-summary' },
      el('p', { text: `내 색: ${SIDE_NAME[guestSide]} (${guestSide === 'W' ? '선공' : '후공'})` }),
      el('p', { class: 'muted small', text: `지뢰 ${o.ruleset.mineCount}개 · 지뢰 ${o.ruleset.minePenalty} · 보물 ${o.ruleset.treasureAwards.join('/')} · 수 상한 ${o.ruleset.plyLimit} · 덤 ${o.ruleset.komi}` }),
      el('p', { class: 'muted small', text: `자기 지뢰 인접 계산 ${o.ruleset.countOwnMines ? '포함' : '제외'} · 내 지뢰 표시 ${o.ruleset.showOwnMines ? '켜짐' : '꺼짐(망각 모드)'}` }),
    ),
  );

  if (!state.myAnswerCode) {
    const acts = el('div', { class: 'actions' });
    const go = button('이 설정으로 참가', () => void acceptInvite(), 'btn-primary');
    go.disabled = state.signalBusy;
    acts.append(go, button('뒤로', leaveGame));
    panel.append(acts);
    sideEl.append(panel);
    return;
  }

  panel.append(
    codeBox(
      '응답 코드',
      state.myAnswerCode,
      '이 코드를 방을 연 사람에게 보내면 연결됩니다. 코드 교환은 이번 한 번뿐이고, 이후 수는 자동으로 오갑니다.',
    ),
  );
  panel.append(
    el('p', {
      class: 'muted small',
      text:
        state.session?.conn === 'failed'
          ? '연결에 실패했습니다. 같은 네트워크에서 다시 시도해 보세요.'
          : '상대가 코드를 넣으면 자동으로 배치 화면이 열립니다.',
    }),
  );
  panel.append(el('div', { class: 'actions' }, button('나가기', leaveGame)));
  sideEl.append(panel);
}

// ------------------------------------------------------------ 배치

function renderPlacementPanel(): void {
  const sess = state.session;
  const ruleset = activeRuleset();
  const locked = !!sess?.myCommit;

  const panel = el('div', { class: 'panel' });
  panel.append(el('h2', { text: `${SIDE_NAME[mySide()]} 지뢰 배치` }));

  if (locked) {
    panel.append(el('p', { class: 'muted', text: '배치를 봉인했습니다. 상대가 제출하면 대국이 시작됩니다.' }));
    panel.append(el('p', { class: 'mono small', text: `커밋 ${sess!.myCommit!.digest.slice(0, 24)}…` }));
    if (sess?.oppDigest) {
      panel.append(el('p', { class: 'muted small', text: '상대 배치도 봉인되었습니다.' }));
    }
    panel.append(el('div', { class: 'actions' }, button('나가기', leaveGame, 'btn-danger')));
    sideEl.append(panel);
    return;
  }

  panel.append(
    el('p', {
      class: 'muted',
      text: `칸을 눌러 ${ruleset.mineCount}개를 고르세요. 회색 칸(시작 구역·보물 11칸)에는 놓을 수 없습니다. 상대와 같은 칸을 골라도 됩니다.`,
    }),
  );
  const counter = el('div', { class: 'counter' });
  counter.append(el('strong', { text: String(state.draft.size) }), el('span', { text: ` / ${ruleset.mineCount}` }));
  panel.append(counter);
  panel.append(
    el('p', {
      class: 'muted small',
      text: '제출하면 배치는 해시로 봉인되어 바꿀 수 없고, 대국 중에는 자기 지뢰도 화면에 표시되지 않습니다.',
    }),
  );

  const actions = el('div', { class: 'actions' });
  const submit = button('제출', () => {
    const errs = validatePlacement([...state.draft], ruleset);
    if (errs.length) {
      notify(errs[0], 'bad');
      render();
      return;
    }
    openModal(
      '배치 제출',
      el('p', { text: `지뢰 ${state.draft.size}개를 봉인합니다. 제출 후에는 되돌릴 수 없습니다.` }),
      [
        { label: '제출', primary: true, onClick: () => void sess?.submitPlacement([...state.draft]) },
        { label: '취소', onClick: () => undefined },
      ],
    );
  }, 'btn-primary');
  submit.disabled = state.draft.size !== ruleset.mineCount;
  actions.append(submit);
  actions.append(button('전부 지우기', () => { state.draft = new Set(); render(); }));
  actions.append(button('나가기', leaveGame, 'btn-danger'));
  panel.append(actions);
  sideEl.append(panel);
}

// ------------------------------------------------------------ 플레이

function renderPlayPanel(): void {
  const sess = state.session;
  const g = sess?.state;
  if (!sess || !g) return;

  const panel = el('div', { class: 'panel' });

  if (g.phase === 'awaitReturn' && g.awaitReturnBy === sess.mySide) {
    panel.append(el('h2', { text: '복귀할 칸 선택' }));
    panel.append(el('p', { class: 'muted', text: '시작 구역 4칸 중 하나를 고르세요. 상대 말이 있는 칸은 고를 수 없고, 복귀 칸에서는 점수가 오가지 않습니다.' }));
    const opts = el('div', { class: 'actions' });
    for (const c of returnOptions(g, sess.mySide)) opts.append(button(labelOf(c), () => sess.chooseReturn(c)));
    panel.append(opts);
  } else if (g.phase === 'awaitReturn') {
    panel.append(el('h2', { text: '상대 복귀 대기' }));
    panel.append(el('p', { class: 'muted', text: '상대가 지뢰를 밟았습니다. 복귀 칸을 고르는 중입니다.' }));
  } else if (sess.waitingForOpponent) {
    panel.append(el('h2', { text: '판정 대기' }));
    panel.append(el('p', { class: 'muted', text: '상대에게 이 칸의 지뢰 여부를 묻는 중입니다.' }));
  } else if (sess.myTurn) {
    panel.append(el('h2', { text: '내 차례' }));
    if (state.selected !== null) {
      const sel = state.selected;
      panel.append(el('p', { class: 'muted', text: `${labelOf(sel)} 선택됨 — 한 번 더 누르거나 확정을 누르세요.` }));
      const acts = el('div', { class: 'actions' });
      acts.append(button(`${labelOf(sel)} 확정`, () => { state.selected = null; sess.move(sel); render(); }, 'btn-primary'));
      acts.append(button('취소', () => { state.selected = null; render(); }));
      panel.append(acts);
    } else {
      panel.append(el('p', { class: 'muted', text: '테두리가 밝은 칸이 갈 수 있는 칸입니다. 우클릭(또는 길게 누르기)으로 지뢰 의심 표시를 답니다.' }));
    }
  } else {
    panel.append(el('h2', { text: '상대 차례' }));
    panel.append(el('p', { class: 'muted', text: '상대가 두기를 기다리는 중입니다.' }));
  }
  sideEl.append(panel);

  const tre = el('div', { class: 'panel' });
  tre.append(el('h3', { text: '보물' }));
  const list = el('ul', { class: 'treasure-list' });
  for (const t of treasureView(g)) {
    const text =
      t.order === null
        ? `${labelOf(t.cell)} — 미회수`
        : `${labelOf(t.cell)} — ${t.order + 1}번째 +${g.ruleset.treasureAwards[t.order]} (${SIDE_NAME[t.takenBy!]})`;
    list.append(el('li', { class: t.order === null ? '' : 'done', text }));
  }
  tre.append(list);
  const nextIdx = g.treasureOrder.length;
  if (nextIdx < g.ruleset.treasureAwards.length) {
    tre.append(el('p', { class: 'gold-text', text: `다음에 회수하는 보물: +${g.ruleset.treasureAwards[nextIdx]}` }));
    tre.append(
      el('p', { class: 'muted small', text: '뒤에 먹을수록 점수가 큽니다. 상대를 늦추면 내가 앞 순번을 먹게 되어 손해일 수 있습니다 (§10.2).' }),
    );
  }
  sideEl.append(tre);

  const flagPanel = el('div', { class: 'panel' });
  flagPanel.append(el('h3', { text: '추론 표시' }));
  flagPanel.append(
    el('p', { class: 'muted small', text: `내 기기에만 남는 표시 ${state.flags.size}개. 상대에게 전송되지 않으며, 자동 추론 보조는 제공하지 않습니다.` }),
  );
  flagPanel.append(
    el('div', { class: 'actions' }, button('표시 지우기', () => { state.flags = new Set(); render(); })),
  );
  sideEl.append(flagPanel);

  sideEl.append(renderLog(g));

  const foot = el('div', { class: 'panel' });
  const acts = el('div', { class: 'actions' });
  acts.append(button('규칙', showRules));
  acts.append(
    button('기권', () => {
      openModal('기권', el('p', { text: '기권하면 상대의 승리로 대국이 끝납니다.' }), [
        { label: '기권', primary: true, onClick: () => sess.resign() },
        { label: '취소', onClick: () => undefined },
      ]);
    }, 'btn-danger'),
  );
  foot.append(acts);
  sideEl.append(foot);
}

function renderLog(g: ServerState): HTMLElement {
  // 한 칸에 지뢰가 2개였다는 것은 "내 것 하나 + 상대 것 하나" 라는 뜻이라,
  // 잊었어야 할 내 지뢰 위치까지 알려준다. 배치가 전부 공개된 뒤에만 표시한다.
  const revealed = g.phase === 'finished';
  const panel = el('div', { class: 'panel panel-log' });
  panel.append(el('h3', { text: '기보' }));
  const box = el('ol', { class: 'log' });
  for (const rec of g.log) {
    const kind =
      rec.kind === 'mine'
        ? `지뢰${revealed && rec.minesHit === 2 ? '×2' : ''}`
        : rec.kind === 'treasure'
          ? '보물'
          : rec.kind === 'visited'
            ? '기방문'
            : '신규';
    const line = el(
      'li',
      { class: `log-item log-${rec.kind} log-side-${rec.side}` },
      el('span', { class: 'log-ply', text: String(rec.ply + 1) }),
      el('span', { class: 'log-side', text: SIDE_NAME[rec.side] }),
      el('span', { class: 'log-move', text: `${labelOf(rec.from)}→${labelOf(rec.to)}` }),
      el('span', { class: 'log-kind', text: kind }),
      el('span', { class: 'log-delta', text: fmt(rec.delta) }),
    );
    if (rec.returnTo !== undefined) {
      line.append(el('span', { class: 'log-return', text: `↵${labelOf(rec.returnTo)}` }));
    }
    box.append(line);
  }
  if (!g.log.length) box.append(el('li', { class: 'muted', text: '아직 둔 수가 없습니다.' }));
  panel.append(box);
  queueMicrotask(() => {
    box.scrollTop = box.scrollHeight;
  });
  return panel;
}

// ------------------------------------------------------------ 종료

function renderFinishedPanel(): void {
  const sess = state.session;
  const g = sess?.state;
  if (!sess || !g || !g.result) return;
  const res = g.result;

  const panel = el('div', { class: 'panel' });
  const title = res.winner === null ? '무승부' : res.winner === sess.mySide ? '승리' : '패배';
  const reason = { treasures: '보물 3개 회수', plyLimit: '수 상한 도달', resign: '기권' }[res.reason];
  panel.append(el('h2', { class: 'result-title', text: title }));
  panel.append(
    el('p', { class: 'muted', text: `${reason} · 최종 白 ${res.score.W} : 黑 ${res.score.B} (나는 ${SIDE_NAME[sess.mySide]})` }),
  );
  sideEl.append(panel);

  const vp = el('div', { class: 'panel' });
  vp.append(el('h3', { text: '판정 검증' }));
  if (!sess.record) {
    vp.append(el('p', { class: 'muted', text: '상대의 배치 공개를 기다리는 중입니다…' }));
  } else if (!sess.verify) {
    vp.append(el('p', { class: 'muted', text: '검증 중…' }));
  } else if (sess.verify.ok) {
    vp.append(
      el('div', { class: 'verify verify-ok' },
        el('strong', { text: '✓ 검증 통과' }),
        el('p', { text: '매 수의 점수와 최종 점수가 규칙 코어 재현과 일치하고, 양측 배치가 대국 전 커밋 해시와 맞습니다. 상대가 인접 지뢰 수를 속이지 않았다는 뜻입니다.' }),
      ),
    );
  } else {
    const box = el('div', { class: 'verify verify-bad' }, el('strong', { text: '⚠ 불일치 발견' }));
    const ul = el('ul', {});
    for (const i of sess.verify.issues) ul.append(el('li', { text: i }));
    box.append(ul);
    vp.append(box);
  }
  sideEl.append(vp);

  if (sess.record) {
    const rec = sess.record;
    const rp = el('div', { class: 'panel' });
    rp.append(el('h3', { text: '배치 공개' }));
    rp.append(
      el('div', { class: 'reveal-row' }, el('span', { class: 'swatch swatch-w' }), el('span', { class: 'mono', text: sortLabels(rec.commitments.W.cells) })),
    );
    rp.append(
      el('div', { class: 'reveal-row' }, el('span', { class: 'swatch swatch-b' }), el('span', { class: 'mono', text: sortLabels(rec.commitments.B.cells) })),
    );
    rp.append(el('p', { class: 'muted small mono', text: `白 commit ${rec.commitments.W.digest.slice(0, 16)}…` }));
    rp.append(el('p', { class: 'muted small mono', text: `黑 commit ${rec.commitments.B.digest.slice(0, 16)}…` }));
    sideEl.append(rp);

    const pp = el('div', { class: 'panel' });
    pp.append(el('h3', { text: '리플레이' }));
    const total = rec.log.length;
    const idx = state.replayIndex === null ? total : state.replayIndex;
    const slider = el('input', { type: 'range', class: 'slider', min: '0', max: String(total), value: String(idx) });
    slider.addEventListener('input', () => {
      const n = Number(slider.value);
      state.replayIndex = n >= total ? null : n;
      render();
    });
    pp.append(slider);
    pp.append(
      el('p', {
        class: 'muted small',
        text:
          state.replayIndex === null
            ? '최종 상태 — 폭발하지 않은 지뢰까지 원래 배치 전부를 보여줍니다.'
            : `${state.replayIndex}수 시점 — 그 시점에 살아 있던 지뢰만 표시됩니다.`,
      }),
    );
    const nav = el('div', { class: 'actions' });
    nav.append(button('⏮ 처음', () => { state.replayIndex = 0; render(); }));
    nav.append(button('◀', () => { state.replayIndex = Math.max(0, idx - 1); render(); }));
    nav.append(button('▶', () => { const n = Math.min(total, idx + 1); state.replayIndex = n >= total ? null : n; render(); }));
    nav.append(button('⏭ 끝', () => { state.replayIndex = null; render(); }));
    pp.append(nav);
    sideEl.append(pp);
  }

  sideEl.append(renderLog(g));

  const foot = el('div', { class: 'panel' });
  const acts = el('div', { class: 'actions' });
  acts.append(button('홈으로', leaveGame, 'btn-primary'));
  if (sess.record) {
    const rec = sess.record;
    acts.append(
      button('기보 내보내기', () => {
        const json = recordToJson(rec);
        const name = `oblivion-mines-${rec.playedAt.replace(/[:.]/g, '-')}.json`;
        if (!download(name, json)) {
          void copyText(json).then((ok) => {
            notify(ok ? '다운로드가 막혀 클립보드에 복사했습니다.' : '내보내기에 실패했습니다.', ok ? 'info' : 'bad');
            render();
          });
        }
      }),
    );
    acts.append(
      button('기보 복사', () => {
        void copyText(recordToJson(rec)).then((ok) => {
          notify(ok ? '기보를 클립보드에 복사했습니다.' : '복사에 실패했습니다.', ok ? 'good' : 'bad');
          render();
        });
      }),
    );
  }
  foot.append(acts);
  sideEl.append(foot);
}

const sortLabels = (cells: readonly Cell[]): string =>
  [...cells].sort((a, b) => a - b).map(labelOf).join(' ');

// ------------------------------------------------------------ 오버레이

function renderOverlay(): void {
  clear(overlayEl);
  if (state.modal) {
    overlayEl.classList.add('is-open');
    overlayEl.append(state.modal);
    return;
  }
  overlayEl.classList.remove('is-open');
}

interface ModalAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

function openModal(title: string, body: HTMLElement, actions: ModalAction[]): void {
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  card.append(el('h2', { text: title }), body);
  const row = el('div', { class: 'actions' });
  for (const a of actions) {
    row.append(button(a.label, () => { closeModal(); a.onClick(); }, a.primary ? 'btn-primary' : ''));
  }
  card.append(row);
  state.modal = card;
  renderOverlay();
}

function closeModal(): void {
  state.modal = null;
  renderOverlay();
}

function showRules(): void {
  const body = el('div', { class: 'rules' });
  body.innerHTML = `
    <h3>목표</h3>
    <p>11×11 보드에서 서로 <b>15개</b>의 지뢰를 비밀리에 깔고, 걸어 다니며 점수를 모읍니다.
       보물 3개가 모두 회수되면 즉시 끝납니다.</p>
    <h3>판정 우선순위</h3>
    <ol>
      <li><b>지뢰</b> −5. 그 칸의 지뢰는 양측 것 모두 소멸하고, 시작 구역으로 복귀합니다.</li>
      <li><b>미획득 보물</b> 회수 순서대로 +10 / +15 / +20. 인접 지뢰는 세지 않습니다.</li>
      <li><b>이미 밟은 칸</b> (양측 통합) 0점.</li>
      <li><b>신규 칸</b> 인접 8칸의 지뢰 총 개수만큼 획득. 한 칸에 2개면 2로 셉니다.</li>
    </ol>
    <h3>기억해야 할 두 가지</h3>
    <p><b>자기 지뢰도 −5</b>이고, <b>자기 지뢰도 인접 점수에 들어갑니다.</b>
       그리고 대국이 시작되면 자기 지뢰조차 화면에 표시되지 않습니다. 오직 기억에 의존해야 합니다.</p>
    <h3>보물 순서의 역설</h3>
    <p>보물 점수는 뒤로 갈수록 큽니다. 상대의 진입로를 막아 늦추면, 내가 앞 순번(작은 점수)을 먹고
       상대가 뒷 순번(큰 점수)을 먹게 될 수 있습니다. 차단이 오히려 손해가 되는 구간이 있습니다.</p>
    <h3>연결과 검증</h3>
    <p>두 브라우저가 직접 연결되고 서버는 없습니다. 매 수 오가는 것은 "그 칸에 내 지뢰가 있는가"와
       "그 칸에 인접한 내 지뢰 수" 두 숫자뿐이며, 인접 수는 판정이 신규 칸으로 확정된 뒤에만 보냅니다.
       배치는 대국 전에 해시로 봉인되고 종료 시 공개되므로, 상대가 중간에 거짓말을 했다면 끝나고 드러납니다.</p>
    <h3>조작</h3>
    <p>클릭/탭으로 이동, 우클릭 또는 길게 누르기로 지뢰 의심 표시. 방향키로 커서 이동, Enter 확정, F 표시 토글.</p>
  `;
  openModal('규칙', body, [{ label: '닫기', primary: true, onClick: () => undefined }]);
}

function showVerifyModal(rec: GameRecord, v: FullVerify): void {
  const body = el('div', {});
  body.append(
    el('p', { class: 'muted', text: `${rec.playedAt.slice(0, 19).replace('T', ' ')} · ${rec.log.length}수 · 룰셋 ${rec.ruleset.id}` }),
  );
  body.append(el('p', { text: `기록된 최종 점수 ${rec.result.score.W} : ${rec.result.score.B} / 재현 ${v.recomputed.W} : ${v.recomputed.B}` }));
  body.append(el('p', { text: `배치 해시 — 白 ${v.commitOk.W ? '일치' : '불일치'} / 黑 ${v.commitOk.B ? '일치' : '불일치'}` }));
  if (v.ok) {
    body.append(el('div', { class: 'verify verify-ok' }, el('strong', { text: '✓ 검증 통과' })));
  } else {
    const box = el('div', { class: 'verify verify-bad' }, el('strong', { text: '⚠ 불일치' }));
    const ul = el('ul', {});
    for (const i of v.issues) ul.append(el('li', { text: i }));
    box.append(ul);
    body.append(box);
  }
  openModal('기보 검증 결과', body, [{ label: '닫기', primary: true, onClick: () => undefined }]);
}

// ---------------------------------------------------------------- 부트스트랩

export function mount(root: HTMLElement): void {
  clear(root);
  topEl = el('header', { class: 'topbar' });
  sideEl = el('aside', { class: 'side' });
  overlayEl = el('div', { class: 'overlay' });
  board = createBoard(onCell);

  root.append(topEl, el('main', { class: 'layout' }, el('div', { class: 'board-wrap' }, board.root), sideEl), overlayEl);
  window.addEventListener('keydown', onKey);

  const invite = readInviteFromLocation();
  if (invite) {
    clearInviteFromLocation();
    void openInvite(invite);
  } else {
    render();
  }
}
