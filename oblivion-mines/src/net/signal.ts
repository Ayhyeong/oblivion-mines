import { z } from 'zod';
import { RulesetSchema, SideSchema } from './protocol';

/**
 * 시그널링 코드. 서버가 없으므로 SDP 를 사람이 한 번 복사해 전달한다.
 * JSON → deflate-raw → base64url 로 줄이고, 앞 한 글자로 압축 여부를 표시한다.
 */

export const OfferSchema = z.object({
  v: z.literal(1),
  t: z.literal('offer'),
  sdp: z.string().min(1).max(20000),
  ruleset: RulesetSchema,
  hostSide: SideSchema,
});

export const AnswerSchema = z.object({
  v: z.literal(1),
  t: z.literal('answer'),
  sdp: z.string().min(1).max(20000),
});

export type OfferPayload = z.infer<typeof OfferSchema>;
export type AnswerPayload = z.infer<typeof AnswerSchema>;
export type SignalPayload = OfferPayload | AnswerPayload;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64URL[c & 63];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64URL.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

const hasCompression = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function streamBytes(input: Uint8Array, stream: ReadableWritablePair): Promise<Uint8Array> {
  const blob = new Blob([input as BlobPart]);
  const out = blob.stream().pipeThrough(stream);
  const buf = await new Response(out).arrayBuffer();
  return new Uint8Array(buf);
}

export async function encodeSignal(payload: SignalPayload): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  if (!hasCompression()) return `r${toBase64Url(raw)}`;
  try {
    const packed = await streamBytes(raw, new CompressionStream('deflate-raw'));
    return `z${toBase64Url(packed)}`;
  } catch {
    return `r${toBase64Url(raw)}`;
  }
}

async function decodeToJson(code: string): Promise<unknown> {
  const trimmed = code.trim().replace(/\s+/g, '');
  const mode = trimmed[0];
  const body = fromBase64Url(trimmed.slice(1));
  if (!body.length) throw new Error('코드가 비어 있습니다.');
  let raw = body;
  if (mode === 'z') {
    if (!hasCompression()) throw new Error('이 브라우저에서는 압축된 코드를 풀 수 없습니다.');
    raw = await streamBytes(body, new DecompressionStream('deflate-raw'));
  } else if (mode !== 'r') {
    throw new Error('알 수 없는 코드 형식입니다.');
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

export async function decodeOffer(code: string): Promise<OfferPayload> {
  const parsed = OfferSchema.safeParse(await decodeToJson(code));
  if (!parsed.success) throw new Error('초대 코드를 읽을 수 없습니다. 전체를 붙여넣었는지 확인하세요.');
  return parsed.data;
}

export async function decodeAnswer(code: string): Promise<AnswerPayload> {
  const parsed = AnswerSchema.safeParse(await decodeToJson(code));
  if (!parsed.success) throw new Error('응답 코드를 읽을 수 없습니다. 전체를 붙여넣었는지 확인하세요.');
  return parsed.data;
}

/** 초대 코드는 링크 해시로도 전달할 수 있다. */
export function inviteLink(code: string): string {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#join=${code}`;
}

export function readInviteFromLocation(): string | null {
  const m = /#join=([A-Za-z0-9\-_]+)/.exec(location.hash);
  return m ? m[1] : null;
}

export function clearInviteFromLocation(): void {
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
}
