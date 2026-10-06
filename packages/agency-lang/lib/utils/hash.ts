// SHA-256 and HMAC-SHA256 in plain JavaScript, so the runtime and the stdlib
// can hash without Node's `crypto` module. The browser's built-in crypto is
// async only, and several callers hash inside synchronous code, so the
// functions here are synchronous. The algorithm follows FIPS 180-4.
//
// Node's `createHash` is faster on large inputs. Code that hashes files of
// many megabytes, such as model verification, stays on Node and keeps using
// it. Everything here hashes text and small byte strings.

const BLOCK_BYTES = 64;
const DIGEST_BYTES = 32;

// The first 32 bits of the fractional parts of the cube roots of the first
// 64 primes.
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// The first 32 bits of the fractional parts of the square roots of the first
// 8 primes.
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Mix one 64-byte block into the running state. */
function compressBlock(state: Uint32Array, block: Uint8Array, schedule: Uint32Array): void {
  for (let i = 0; i < 16; i++) {
    const offset = i * 4;
    schedule[i] =
      (block[offset] << 24) |
      (block[offset + 1] << 16) |
      (block[offset + 2] << 8) |
      block[offset + 3];
  }
  for (let i = 16; i < 64; i++) {
    const w15 = schedule[i - 15];
    const w2 = schedule[i - 2];
    const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
    const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
    schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
  }

  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];

  for (let i = 0; i < 64; i++) {
    const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 = (h + bigSigma1 + choose + ROUND_CONSTANTS[i] + schedule[i]) >>> 0;
    const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (bigSigma0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

/** The SHA-256 digest of `data`, as 32 bytes. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const state = new Uint32Array(INITIAL_STATE);
  const schedule = new Uint32Array(64);

  const wholeBlocks = Math.floor(data.length / BLOCK_BYTES);
  for (let i = 0; i < wholeBlocks; i++) {
    compressBlock(state, data.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES), schedule);
  }

  // Padding: the remaining bytes, a 0x80 byte, zeros, then the message
  // length in bits as a 64-bit big-endian number. That takes one block, or
  // two when the remainder leaves fewer than 9 bytes free.
  const remainder = data.subarray(wholeBlocks * BLOCK_BYTES);
  const paddedLength = remainder.length + 9 <= BLOCK_BYTES ? BLOCK_BYTES : 2 * BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(remainder);
  padded[remainder.length] = 0x80;
  const bitLength = data.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  for (let offset = 0; offset < paddedLength; offset += BLOCK_BYTES) {
    compressBlock(state, padded.subarray(offset, offset + BLOCK_BYTES), schedule);
  }

  const digest = new Uint8Array(DIGEST_BYTES);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    digestView.setUint32(i * 4, state[i], false);
  }
  return digest;
}

/** HMAC-SHA256 of `data` under `key`, as 32 bytes (RFC 2104). */
export function hmacSha256(key: Uint8Array | string, data: Uint8Array | string): Uint8Array {
  let keyBytes = toBytes(key);
  if (keyBytes.length > BLOCK_BYTES) {
    keyBytes = sha256Bytes(keyBytes);
  }
  const paddedKey = new Uint8Array(BLOCK_BYTES);
  paddedKey.set(keyBytes);

  const innerKey = new Uint8Array(BLOCK_BYTES);
  const outerKey = new Uint8Array(BLOCK_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i++) {
    innerKey[i] = paddedKey[i] ^ 0x36;
    outerKey[i] = paddedKey[i] ^ 0x5c;
  }

  const dataBytes = toBytes(data);
  const inner = new Uint8Array(BLOCK_BYTES + dataBytes.length);
  inner.set(innerKey);
  inner.set(dataBytes, BLOCK_BYTES);
  const innerDigest = sha256Bytes(inner);

  const outer = new Uint8Array(BLOCK_BYTES + DIGEST_BYTES);
  outer.set(outerKey);
  outer.set(innerDigest, BLOCK_BYTES);
  return sha256Bytes(outer);
}

/** The SHA-256 digest of `data` as lowercase hex. A string is hashed as UTF-8. */
export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256Bytes(toBytes(data)));
}

/** The SHA-256 digest of a UTF-8 string, as lowercase hex. */
export function sha256Text(value: string): string {
  return sha256Hex(value);
}

/** Bytes as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return value;
}
