import type { Cell, Commitment } from './types';

/**
 * 커밋-리빌(§7.2).
 *
 *   salt   = 32 랜덤 바이트
 *   digest = SHA-256( salt ‖ utf8(cells.sort().join(',')) )
 *
 * 배치 시점에 digest 만 공개하고, 종료 시 {cells, salt} 를 공개하면
 * 상대가 해시를 직접 검증할 수 있다. 배치를 사후에 바꾸는 행위를 막는다.
 *
 * `cells` 는 0..120 숫자를 오름차순으로 정렬해 쉼표로 잇는다.
 * 이 정규화 규칙이 바뀌면 과거 기록의 검증이 깨지므로 고정한다.
 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function randomSalt(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function canonicalCells(cells: readonly Cell[]): string {
  return [...cells].sort((a, b) => a - b).join(',');
}

export async function digestPlacement(cells: readonly Cell[], saltHex: string): Promise<string> {
  const salt = hexToBytes(saltHex);
  const body = new TextEncoder().encode(canonicalCells(cells));
  const buf = new Uint8Array(salt.length + body.length);
  buf.set(salt, 0);
  buf.set(body, salt.length);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(hash));
}

export async function commitPlacement(cells: readonly Cell[]): Promise<Commitment> {
  const salt = randomSalt();
  const digest = await digestPlacement(cells, salt);
  return { digest, salt, cells: [...cells] };
}

/** 리빌 검증: 공개된 {cells, salt} 가 사전에 공개된 digest 와 맞는지. */
export async function verifyCommitment(c: Commitment): Promise<boolean> {
  return (await digestPlacement(c.cells, c.salt)) === c.digest;
}
