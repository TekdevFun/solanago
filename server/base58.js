// Base58 (Bitcoin alphabet), the encoding Solana uses for addresses and signatures.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function b58encode(input) {
  const bytes = Buffer.from(input);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = []; // base58 digits, least significant first
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function b58decode(str) {
  if (typeof str !== 'string' || str.length === 0) throw new Error('base58: empty or not a string');
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = []; // least significant first
  for (let i = zeros; i < str.length; i++) {
    const value = INDEX.get(str[i]);
    if (value === undefined) throw new Error('base58: invalid character');
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** True when the string is a 32-byte Solana address. */
export function isAddress(str) {
  if (typeof str !== 'string' || str.length < 32 || str.length > 44) return false;
  try {
    return b58decode(str).length === 32;
  } catch {
    return false;
  }
}
