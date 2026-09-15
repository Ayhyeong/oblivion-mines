import { parseMessage } from './protocol';
import type { Message } from './protocol';

/**
 * WebRTC DataChannel 래퍼. 시그널링 서버가 없으므로 ICE 후보를 전부 모은 뒤
 * SDP 한 덩어리를 통째로 넘긴다(non-trickle).
 *
 * STUN 은 공개 서버를 쓴다. TURN 이 없으므로 대칭형 NAT 뒤에서는 연결이
 * 실패할 수 있다 — 그 경우 같은 네트워크에서 다시 시도해야 한다.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const GATHER_TIMEOUT_MS = 4000;

export type ConnState = 'idle' | 'signaling' | 'connecting' | 'open' | 'closed' | 'failed';

export interface PeerHandlers {
  onMessage?: (msg: Message) => void;
  onState?: (state: ConnState) => void;
  /** 스키마를 통과하지 못한 메시지 — 버려지지만 알려는 준다 */
  onBadMessage?: (raw: string) => void;
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      pc.removeEventListener('icegatheringstatechange', check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = window.setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class Peer {
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private handlers: PeerHandlers = {};
  private state: ConnState = 'idle';

  private constructor() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.setState('failed');
      else if (s === 'disconnected' || s === 'closed') this.setState('closed');
      else if (s === 'connecting') this.setState('connecting');
    });
  }

  on(handlers: PeerHandlers): void {
    this.handlers = handlers;
  }

  get connState(): ConnState {
    return this.state;
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.handlers.onState?.(s);
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.addEventListener('open', () => this.setState('open'));
    channel.addEventListener('close', () => this.setState('closed'));
    channel.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        this.handlers.onBadMessage?.(text.slice(0, 200));
        return;
      }
      const msg = parseMessage(raw);
      if (!msg) {
        this.handlers.onBadMessage?.(text.slice(0, 200));
        return;
      }
      this.handlers.onMessage?.(msg);
    });
  }

  /** 방을 여는 쪽: offer SDP 를 만든다. */
  static async host(): Promise<{ peer: Peer; sdp: string }> {
    const peer = new Peer();
    peer.setState('signaling');
    peer.attach(peer.pc.createDataChannel('game', { ordered: true }));
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    await waitForIce(peer.pc);
    return { peer, sdp: peer.pc.localDescription?.sdp ?? offer.sdp ?? '' };
  }

  /** 참가하는 쪽: offer 를 받아 answer SDP 를 만든다. */
  static async guest(offerSdp: string): Promise<{ peer: Peer; sdp: string }> {
    const peer = new Peer();
    peer.setState('signaling');
    peer.pc.addEventListener('datachannel', (ev) => peer.attach(ev.channel));
    await peer.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    await waitForIce(peer.pc);
    return { peer, sdp: peer.pc.localDescription?.sdp ?? answer.sdp ?? '' };
  }

  /** 방을 연 쪽이 상대의 answer 를 받아 연결을 마무리한다. */
  async acceptAnswer(answerSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.setState('connecting');
  }

  send(msg: Message): boolean {
    if (this.channel?.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    try {
      this.channel?.close();
    } catch {
      /* 이미 닫힘 */
    }
    try {
      this.pc.close();
    } catch {
      /* 이미 닫힘 */
    }
    this.setState('closed');
  }
}

export const isWebRtcSupported = (): boolean =>
  typeof RTCPeerConnection === 'function' && typeof RTCPeerConnection.prototype.createDataChannel === 'function';
