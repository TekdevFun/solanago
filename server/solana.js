// Everything that touches the Solana network, with no dependencies:
// key handling, building and signing a SOL transfer, sending it, confirming it,
// and reading balances. A MockChain with the same shape is used for tests and
// for running the app before a treasury wallet is configured.

import crypto from 'node:crypto';
import { b58decode, b58encode, isAddress } from './base58.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SYSTEM_PROGRAM = Buffer.alloc(32); // 11111111111111111111111111111111
const COMPUTE_BUDGET = b58decode('ComputeBudget111111111111111111111111111111');
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const BASE_FEE = 5000; // lamports per signature
export const CU_LIMIT = 2000; // a transfer plus two compute-budget instructions uses about 450
// A payout can only land while the chain is at or below its "last valid block height".
// We wait this many blocks past that before calling it dead, in case the RPC node answering us is a little behind.
export const EXPIRY_MARGIN = 32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settled = (status) => !!status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
/** The network has confirmed the transfer. */
export const landed = (status) => settled(status) && !status.err;
/** The network has confirmed that the transaction failed. A failure seen only on an unconfirmed fork is not final. */
export const failedForGood = (status) => settled(status) && !!status.err;
/**
 * JSON-RPC error codes with which a node refuses a transaction without passing it on
 * (failed simulation, bad signature, node behind, malformed request). Any other error might have let it through.
 */
const refusedBeforeSending = (code) => Number.isInteger(code) && ((code <= -32002 && code >= -32016) || [-32600, -32601, -32602, -32700].includes(code));

export class ChainError extends Error {
  /** uncertain = we cannot tell whether the transfer happened. */
  constructor(message, { uncertain = false, code } = {}) {
    super(message);
    this.name = 'ChainError';
    this.uncertain = uncertain;
    this.code = code;
  }
}

/* ---------- keys ---------- */

function privateKeyFromSeed(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function publicKeyFromSeed(seed) {
  const der = crypto.createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

/**
 * Accepts the formats wallets export: a base58 string (Phantom, 64 bytes),
 * a JSON array of 64 numbers (Solana CLI id.json), or a 32-byte seed in base58.
 */
export function parseSecretKey(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('secret key is empty');
  let bytes;
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('secret key: bad JSON array');
    bytes = Buffer.from(arr);
  } else {
    bytes = b58decode(raw);
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error(`secret key: expected 64 or 32 bytes, got ${bytes.length}`);
  const seed = Buffer.from(bytes.subarray(0, 32));
  const publicKey = publicKeyFromSeed(seed);
  if (bytes.length === 64 && !publicKey.equals(bytes.subarray(32))) throw new Error('secret key: public half does not match the private half');
  return { seed, publicKey };
}

export function generateKeypair() {
  const seed = crypto.randomBytes(32);
  const publicKey = publicKeyFromSeed(seed);
  return { seed, publicKey, address: b58encode(publicKey), secretKey: b58encode(Buffer.concat([seed, publicKey])) };
}

/* ---------- transaction encoding (legacy format) ---------- */

export function shortvec(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const instruction = (programIndex, accountIndexes, data) =>
  Buffer.concat([Buffer.from([programIndex]), shortvec(accountIndexes.length), Buffer.from(accountIndexes), shortvec(data.length), data]);

export const priorityFee = (cuPrice) => Math.ceil((cuPrice * CU_LIMIT) / 1_000_000);

/** The message of a plain SOL transfer, optionally with a priority fee. */
export function transferMessage({ from, to, lamports, blockhash, cuPrice = 0 }) {
  if (from.length !== 32 || to.length !== 32) throw new Error('transfer: keys must be 32 bytes');
  if (Buffer.compare(from, to) === 0) throw new Error('transfer: sender and recipient are the same');
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error('transfer: bad amount');
  const recent = b58decode(blockhash);
  if (recent.length !== 32) throw new Error('transfer: bad blockhash');
  // Order: writable signer, writable non-signer, then read-only programs.
  const keys = cuPrice > 0 ? [from, to, SYSTEM_PROGRAM, COMPUTE_BUDGET] : [from, to, SYSTEM_PROGRAM];
  const header = Buffer.from([1, 0, keys.length - 2]); // 1 signature, 0 read-only signers, N read-only non-signers
  const ixs = [];
  if (cuPrice > 0) {
    ixs.push(instruction(3, [], Buffer.concat([Buffer.from([2]), u32(CU_LIMIT)]))); // SetComputeUnitLimit
    ixs.push(instruction(3, [], Buffer.concat([Buffer.from([3]), u64(cuPrice)]))); // SetComputeUnitPrice
  }
  ixs.push(instruction(2, [0, 1], Buffer.concat([u32(2), u64(lamports)]))); // System: Transfer
  return Buffer.concat([header, shortvec(keys.length), ...keys, recent, shortvec(ixs.length), ...ixs]);
}

export function signMessage(message, seed) {
  return crypto.sign(null, message, privateKeyFromSeed(seed));
}

export const serializeTransaction = (signature, message) => Buffer.concat([shortvec(1), signature, message]);

/* ---------- the real chain ---------- */

export class SolanaChain {
  constructor({ rpcUrl, secret, priorityMicroLamports = 0, fetchImpl = globalThis.fetch, pollMs = 900, resendMs = 2500, timeoutMs = 75_000 }) {
    const { seed, publicKey } = parseSecretKey(secret);
    this.seed = seed;
    this.pub = publicKey;
    this.rpcUrl = rpcUrl;
    this.cuPrice = Math.max(0, Math.floor(priorityMicroLamports));
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
    this.resendMs = resendMs;
    this.timeoutMs = timeoutMs;
    this.requestId = 0;
    this.mock = false;
    this.recent = new Map(); // signatures of payouts made in the last few minutes
  }

  get address() {
    return b58encode(this.pub);
  }

  /** Network cost of one payout, in lamports. */
  feeFor() {
    return BASE_FEE + priorityFee(this.cuPrice);
  }

  /** Remembers a signature for as long as its blockhash could still be current. */
  remember(signature) {
    const now = Date.now();
    for (const [sig, at] of this.recent) if (now - at > 180_000) this.recent.delete(sig);
    this.recent.set(signature, now);
  }

  async rpc(method, params = []) {
    let res;
    try {
      res = await this.fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ChainError(`RPC ${method} unreachable: ${e.message}`, { uncertain: true });
    }
    if (!res.ok) throw new ChainError(`RPC ${method} returned HTTP ${res.status}`, { uncertain: true });
    // An answer that is cut off or unreadable tells us nothing about what the node did with the request.
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new ChainError(`RPC ${method} sent an answer that could not be read: ${e.message}`, { uncertain: true });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChainError(`RPC ${method} sent an empty answer`, { uncertain: true });
    if (body.error) throw new ChainError(`RPC ${method}: ${body.error.message ?? 'error'}`, { code: body.error.code });
    return body.result;
  }

  /** A balance together with the slot it was read at, so an older answer is never taken for a newer one. */
  async balanceAt(address = this.address) {
    const r = await this.rpc('getBalance', [address, { commitment: 'confirmed' }]);
    const lamports = r ? r.value : undefined;
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new ChainError('RPC getBalance sent an answer that makes no sense', { uncertain: true });
    const slot = r.context ? r.context.slot : null;
    return { lamports, slot: Number.isSafeInteger(slot) ? slot : null };
  }

  async getBalance(address = this.address) {
    return (await this.balanceAt(address)).lamports;
  }

  async latestBlockhash() {
    const r = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const v = r ? r.value : null;
    // Without the height at which this blockhash stops being valid, a payout could never be declared expired.
    if (!v || typeof v.blockhash !== 'string' || !Number.isSafeInteger(v.lastValidBlockHeight) || v.lastValidBlockHeight <= 0) {
      throw new ChainError('RPC getLatestBlockhash sent an answer that makes no sense', { uncertain: true });
    }
    return v;
  }

  blockHeight() {
    return this.rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
  }

  /**
   * The network's verdict on each signature, in order: an object, or null when it has never heard of it.
   * Throws if it cannot say. Up to 256 signatures per call.
   */
  async signatureStatuses(signatures) {
    if (!signatures.length) return [];
    const r = await this.rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
    if (!r || !Array.isArray(r.value) || r.value.length !== signatures.length) throw new ChainError('RPC getSignatureStatuses sent an answer that makes no sense', { uncertain: true });
    return r.value.map((status) => (status && typeof status === 'object' ? status : null));
  }

  async signatureStatus(signature) {
    return (await this.signatureStatuses([signature]))[0];
  }

  build(to, lamports, blockhash) {
    if (!isAddress(to)) throw new ChainError('Recipient is not a Solana address', { code: 'bad_address' });
    const message = transferMessage({ from: this.pub, to: b58decode(to), lamports, blockhash, cuPrice: this.cuPrice });
    const signature = signMessage(message, this.seed);
    return { raw: serializeTransaction(signature, message), signature: b58encode(signature) };
  }

  /**
   * Sends SOL and waits until the network confirms it.
   * Throws ChainError: `uncertain` false means nothing moved, true means we could not find out.
   * onSent fires as soon as the signature is known, so the caller can record it first.
   */
  async transfer(to, lamports, { onSent } = {}) {
    let raw;
    let signature;
    let lastValidBlockHeight;
    for (let attempt = 0; ; attempt++) {
      const latest = await this.latestBlockhash().catch((e) => {
        throw new ChainError(`Could not start the payout: ${e.message}`, { code: 'no_blockhash' }); // nothing was sent
      });
      ({ raw, signature } = this.build(to, lamports, latest.blockhash));
      lastValidBlockHeight = latest.lastValidBlockHeight;
      // Same recipient, same amount and same blockhash give the very same transaction, and the network would
      // count two of those as one payout. Wait for the next blockhash so every payout is its own transaction.
      if (!this.recent.has(signature)) {
        this.remember(signature); // at once, before anything is awaited, or a twin starting now would slip past
        break;
      }
      if (attempt >= 8) throw new ChainError('Could not start the payout: the network gave no fresh blockhash', { code: 'no_blockhash' });
      await sleep(Math.min(600, this.pollMs));
    }
    const encoded = raw.toString('base64');
    // Dress rehearsal: the node runs the transaction without sending it. Whatever is wrong with it (a recipient that
    // cannot be paid, an empty treasury) shows up here, before anything is on record or on its way.
    for (let attempt = 0; ; attempt++) {
      const err = await this.simulate(encoded).catch((e) => {
        throw new ChainError(`Could not start the payout: ${e.message}`, { code: 'no_blockhash' }); // nothing was sent
      });
      if (err === null) break;
      const behind = /BlockhashNotFound/i.test(typeof err === 'string' ? err : JSON.stringify(err)); // this node has not caught up yet
      if (!behind || attempt >= 4) throw new ChainError(`Payout refused in rehearsal: ${typeof err === 'string' ? err : JSON.stringify(err)}`, { code: 'rehearsal' });
      await sleep(Math.min(400, this.pollMs));
    }
    if (onSent) onSent({ signature, lastValidBlockHeight });
    const send = () => this.rpc('sendTransaction', [encoded, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 }]);
    try {
      await send();
    } catch (e) {
      // Only a refusal we recognise means nothing went out. No answer, an unreadable answer or an error we do not
      // know may all hide a transaction that got through, and so does "already processed": keep watching for it.
      const refused = e.uncertain === false && refusedBeforeSending(e.code) && !/already\s+(been\s+)?processed/i.test(e.message);
      // A node that is a step behind ("blockhash not found", "node is behind") will take the same transaction in a moment:
      // the loop below sends it again, which is kinder than failing a hunter who is standing at the drop.
      const willPass = /blockhash not found/i.test(e.message) || e.code === -32005 || e.code === -32016;
      if (refused && !willPass) throw new ChainError(`Payout rejected: ${e.message}`, { code: e.code });
    }
    const done = (status) => ({ signature, slot: Number.isSafeInteger(status.slot) ? status.slot : null });
    const started = Date.now();
    let lastSend = Date.now();
    for (;;) {
      await sleep(this.pollMs);
      const status = await this.signatureStatus(signature).catch(() => undefined);
      if (failedForGood(status)) throw new ChainError('Payout failed on-chain', { code: 'tx_error' });
      if (landed(status)) return done(status);
      const height = await this.blockHeight().catch(() => null);
      if (Number.isFinite(height) && height > lastValidBlockHeight + EXPIRY_MARGIN) {
        // Too late for it to land now. One last look decides between "never happened" and "we cannot tell".
        const last = await this.signatureStatus(signature).catch(() => undefined);
        if (last === null) throw new ChainError('Payout expired before it landed', { code: 'expired' });
        if (failedForGood(last)) throw new ChainError('Payout failed on-chain', { code: 'tx_error' });
        if (landed(last)) return done(last);
        throw new ChainError('Payout status unknown', { uncertain: true });
      }
      if ((!Number.isFinite(height) || height <= lastValidBlockHeight) && Date.now() - lastSend > this.resendMs) {
        lastSend = Date.now();
        send().catch(() => {});
      }
      if (Date.now() - started > this.timeoutMs) throw new ChainError('Payout status unknown', { uncertain: true });
    }
  }

  /** Asks the node whether it would accept this transaction, without sending it. Null means yes; otherwise the reason. */
  async simulate(encoded) {
    const r = await this.rpc('simulateTransaction', [encoded, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
    if (!r || !r.value || typeof r.value !== 'object') throw new ChainError('RPC simulateTransaction sent an answer that makes no sense', { uncertain: true });
    return r.value.err ?? null;
  }

  /**
   * What an address is: 'wallet' (an ordinary account, or one that does not exist yet), 'token' (a coin or a
   * token account), 'program', or 'other' (an account some program owns). SOL sent to anything but a wallet
   * may be gone for good.
   */
  async accountKind(address) {
    const r = await this.rpc('getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    if (!r || typeof r !== 'object' || !('value' in r)) throw new ChainError('RPC getAccountInfo sent an answer that makes no sense', { uncertain: true });
    const info = r.value;
    if (info === null) return 'wallet';
    if (typeof info !== 'object' || typeof info.owner !== 'string') throw new ChainError('RPC getAccountInfo sent an answer that makes no sense', { uncertain: true });
    if (info.executable) return 'program';
    if (info.owner === SYSTEM_PROGRAM_ID) return 'wallet';
    return TOKEN_PROGRAMS.includes(info.owner) ? 'token' : 'other';
  }

  /** Whole-token balance of `mint` held by `owner`, across all of their token accounts. */
  async tokenBalance(owner, mint) {
    const r = await this.rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let total = 0;
    for (const item of r.value || []) {
      const amount = item?.account?.data?.parsed?.info?.tokenAmount;
      if (amount) total += Number(amount.uiAmountString ?? amount.uiAmount ?? 0);
    }
    return total;
  }

  /**
   * When a wallet was first used, as far back as its latest 1,000 transactions show.
   * Returns { count, oldest } with oldest in milliseconds, or null when the wallet has never been used.
   */
  async walletHistory(address) {
    const list = await this.rpc('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed' }]);
    const times = (list || []).map((s) => s.blockTime).filter((t) => Number.isFinite(t));
    return { count: (list || []).length, oldest: times.length ? Math.min(...times) * 1000 : null };
  }

  /** Proves the key, the RPC and the transaction encoding work, without moving funds. */
  async selfCheck() {
    const balance = await this.getBalance();
    const { blockhash } = await this.latestBlockhash();
    const { raw } = this.build(INCINERATOR, 1_000_000, blockhash);
    const sim = await this.rpc('simulateTransaction', [raw.toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
    // Settling a payout after a hiccup needs the provider to look up past transactions. Ask about a signature that cannot exist.
    const history = await this.signatureStatuses([b58encode(Buffer.alloc(64, 1))]).then(
      () => true,
      () => false,
    );
    return { address: this.address, balance, simulation: sim.value.err ? JSON.stringify(sim.value.err) : 'ok', history };
  }
}

/* ---------- a stand-in chain for tests and for running without a wallet ---------- */

export class MockChain {
  constructor({ balance = 0, address } = {}) {
    this.balance = balance;
    this._address = address || b58encode(crypto.randomBytes(32));
    this.sent = [];
    this.holdings = new Map();
    this.firstUsed = new Map(); // address -> time in ms of its first transaction
    this.kinds = new Map(); // address -> 'token' | 'program' | 'other' for addresses that are not wallets
    this.failWith = null; // set to a ChainError to make the next transfer fail
    this.mock = true;
  }

  get address() {
    return this._address;
  }

  feeFor() {
    return BASE_FEE;
  }

  async getBalance() {
    return this.balance;
  }

  async balanceAt() {
    this.slot = (this.slot || 0) + 1;
    return { lamports: this.balance, slot: this.slot };
  }

  async blockHeight() {
    return 1;
  }

  async signatureStatus(signature) {
    return this.sent.some((s) => s.signature === signature) ? { confirmationStatus: 'finalized', err: null } : null;
  }

  async signatureStatuses(signatures) {
    return Promise.all(signatures.map((s) => this.signatureStatus(s)));
  }

  async transfer(to, lamports, { onSent } = {}) {
    if (!isAddress(to)) throw new ChainError('Recipient is not a Solana address', { code: 'bad_address' });
    if (this.failWith && this.failWith.early) {
      // a failure before anything was signed or sent
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    const signature = b58encode(crypto.randomBytes(64));
    if (onSent) onSent({ signature, lastValidBlockHeight: 0 });
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      if (err.landed) this.sent.push({ to, lamports, signature });
      throw err;
    }
    if (lamports + BASE_FEE > this.balance) throw new ChainError('Payout rejected: insufficient funds', { code: 'insufficient' });
    this.balance -= lamports + BASE_FEE;
    this.sent.push({ to, lamports, signature });
    this.slot = (this.slot || 0) + 1;
    return { signature, slot: this.slot };
  }

  async tokenBalance(owner) {
    return this.holdings.get(owner) || 0;
  }

  async accountKind(address) {
    return this.kinds.get(address) || 'wallet';
  }

  async walletHistory(address) {
    const first = this.firstUsed.get(address);
    return first === undefined ? { count: 0, oldest: null } : { count: 1, oldest: first };
  }

  async selfCheck() {
    return { address: this.address, balance: this.balance, simulation: 'mock', history: true };
  }
}
