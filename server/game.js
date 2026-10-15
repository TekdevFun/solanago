// The rules of the game: batches of drops, who can see them, who can claim them,
// paying out, and keeping the public fee counter honest.

import crypto from 'node:crypto';
import { isAddress } from './base58.js';
import { boundingBox, distanceM, fuzzPoint, randomInCircle, validLatLng } from './geo.js';
import { EXPIRY_MARGIN, failedForGood, landed as confirmed } from './solana.js';
import { inTransaction, isUniqueViolation } from './store.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const MAX_DROPS_PER_BATCH = 5000;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/; // the random id a phone makes for itself
const PASTE_HINT = 'Paste the address shown at the top of your wallet app.';
const NOT_A_WALLET = {
  token: `That address is a coin or a token account, not a wallet. ${PASTE_HINT}`,
  program: `That address is a program, not a wallet. ${PASTE_HINT}`,
  other: `That address belongs to a program, not to a person. ${PASTE_HINT}`,
};
const SECOND_LOOK = 30 * MINUTE; // after a payout that was sent but never confirmed: how long its drop stays off the map while we keep asking the chain
const IN_FLIGHT = 5 * MINUTE; // a payout confirms or expires well inside this; older than that it is "unresolved", not "on its way"
const GIVE_UP = 24 * HOUR; // a payout the chain could tell us nothing about for this long is closed for good
const BOOK_FROM = 10_000; // lamports. Smaller gaps between the wallet and the books are fee rounding, not events
const FLOOR_TRUST = 5 * MINUTE; // how long "the books are at least as new as slot N" is held against an older-looking answer
const TIER_GRACE = 10 * MINUTE; // when a holder lookup fails, an answer no older than this is still believed
const LOOKUP_BACKOFF = 10_000; // after a holder lookup made for a visitor fails, how long their app goes without another try
// Written-off payouts that still get second looks: the transfer was signed and may have gone out.
// (Claims c joined to their drop d. One parameter: now - SECOND_LOOK.)
const UNDER_REVIEW = `c.status = 'failed' AND c.sig IS NOT NULL AND c.error NOT LIKE '%on-chain%'
  AND (c.settled_at > ? OR (d.status = 'held' AND d.held_until = c.settled_at + ${SECOND_LOOK}))`;

export class GameError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = extra.status || 400;
    this.extra = extra;
  }
}

export const solString = (lamports) => {
  const s = (lamports / 1e9).toFixed(4);
  return s.replace(/\.?0+$/, '');
};
const short = (address) => `${address.slice(0, 4)}…${address.slice(-4)}`;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
// Input from the admin console arrives as JSON: take strings and numbers as they are, and anything else as missing.
const str = (v) => (typeof v === 'string' ? v : '');
const numOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const clampInt = (v, lo, hi, fallback) => (Number.isFinite(numOf(v)) ? Math.min(hi, Math.max(lo, Math.round(numOf(v)))) : fallback);
/**
 * The promise's answer if it comes within `ms`, otherwise whatever `fallback()` says then. The work behind the
 * promise carries on either way. (The promise must not reject.)
 */
export function soon(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
/** The promise's answer, or an error if none has come after `ms`: a last resort so that nothing can wait for ever. */
function orGiveUp(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class Game {
  constructor({ db, chain, cfg, now = () => Date.now(), log = console, random = Math.random }) {
    this.db = db;
    this.chain = chain;
    this.cfg = cfg;
    this.now = now;
    this.log = log;
    this.random = random;
    this.pings = new Map(); // device -> recent positions, newest last
    this.tierCache = new Map(); // address -> { tier, balance, ts, ttl }
    this.seasoned = new Set(); // wallets already known to be old enough to claim
    this.plainWallets = new Set(); // addresses already checked to be ordinary wallets
    this.balance = null; // treasury lamports, refreshed by watchTreasury()
    this.watching = null; // a treasury check in progress, shared by everyone who asks meanwhile
    this.lastReadAt = 0; // when a wallet reading was last accepted
    this.settleSeq = 0; // goes up with every payout booked, so a reading that overlapped one can be recognised
    this.lookups = { start: 0, n: 0, first: 0, claims: 0 }; // lookups made this minute: for visitors, for their first of the minute, for claims
    this.visitors = new Map(); // ...and by each visitor
    this.troubled = new Map(); // visitor -> when a holder lookup made for them last failed
    this.lookingUp = new Map(); // address -> a holder lookup on its way for the app, shared by every refresh that asks meanwhile
    this.patienceMs = 2500; // how long a page waits for the RPC before it is answered with what is already known
    this.lookupLimitMs = 20_000; // a holder lookup with no answer after this long counts as failed (the RPC code gives up at 15 s by itself)
    this.lookupWarned = { at: 0, missed: 0 }; // keeps a failing RPC from burying the log
    this.statements = new Map();
    // "The books already include everything up to this point of the chain": the slot of the last payout or wallet reading used.
    this.floor = null;
    try {
      const saved = JSON.parse(this.getKV('floor') || 'null');
      if (saved && Number.isSafeInteger(saved.slot) && Number.isFinite(saved.at)) this.floor = { slot: saved.slot, at: saved.at };
    } catch {}
    this.lastSettledAt = this.sql(`SELECT COALESCE(MAX(settled_at), 0) AS t FROM claims WHERE status = 'paid'`).get().t; // when the last payout was booked
    // Key for hashing network addresses and for nudging map pins. Made once and kept, unless SERVER_SECRET is set.
    this.secret = cfg.serverSecret || this.getKV('server_secret') || '';
    if (!this.secret) {
      this.secret = crypto.randomBytes(32).toString('hex');
      this.setKV('server_secret', this.secret);
    }
  }

  sql(text) {
    let st = this.statements.get(text);
    if (!st) {
      st = this.db.prepare(text);
      this.statements.set(text, st);
    }
    return st;
  }

  getKV(key) {
    const row = this.sql('SELECT v FROM kv WHERE k = ?').get(key);
    return row ? row.v : null;
  }

  setKV(key, value) {
    this.sql('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value));
  }

  hashIp(ip) {
    return crypto.createHmac('sha256', this.secret).update(String(ip || '')).digest('hex').slice(0, 20);
  }

  /** How close a hunter must get, in metres. Top holders get the longer reach, which is never shorter than everyone else's. */
  reachFor(tier) {
    return tier >= 3 ? Math.max(this.cfg.reachM, this.cfg.reachTopM) : this.cfg.reachM;
  }

  /* ---------- the emergency brake ---------- */

  /** While paused nobody can claim. Drops stay on the map and nothing else changes. */
  get paused() {
    return this.getKV('paused') === '1';
  }

  setPaused(on) {
    this.setKV('paused', on ? '1' : '0');
    this.log.warn(on ? 'Claims paused from the admin console.' : 'Claims switched back on from the admin console.');
    return !!on;
  }

  /* ---------- holder tiers ---------- */

  /**
   * Which holder tier a wallet is in, from its token balance. Answers are kept for a few minutes to go easy on the RPC;
   * `fresh` asks again unless we looked seconds ago (used when a perk is about to be refused, or someone just bought).
   * An answer marked `unsure` is not one: the lookup failed, and what comes back is the last thing known, or nothing.
   */
  async tierOf(address, { fresh = false, priority = false, visitor = '' } = {}) {
    if (!address || !this.cfg.tokenMint || !isAddress(address)) return { tier: 0, balance: 0 };
    const now = this.now();
    const hit = this.tierCache.get(address);
    if (hit && now - hit.ts < (fresh ? Math.min(hit.ttl, 10_000) : hit.ttl)) return hit;
    // A claim always gets a lookup of its own, there and then, whatever else is going on.
    if (priority) return this.lookUp(address, '');
    // The app's refreshes share: whoever asks about a wallet while a lookup for it is on its way gets that one's
    // answer, so a slow RPC is not asked the same thing again by every refresh that comes in meanwhile.
    const underWay = this.lookingUp.get(address);
    if (underWay) return underWay;
    // Past the ration, or just after a lookup made for them failed, people keep the answer we already have (or none) for now.
    const backingOff = now - (this.troubled.get(visitor) ?? -Infinity) < LOOKUP_BACKOFF;
    if (backingOff || !this.mayLookUp(visitor, now)) return hit || { tier: 0, balance: 0 };
    const lookup = this.lookUp(address, visitor).finally(() => this.lookingUp.delete(address));
    this.lookingUp.set(address, lookup);
    return lookup;
  }

  /**
   * The same, for the app's own refreshes, which must not hang on a slow RPC: the answer if it comes within a couple
   * of seconds, otherwise what is already known. The lookup carries on, and its answer is there for the next refresh.
   */
  tierSoon(address, options) {
    return soon(this.tierOf(address, options), this.patienceMs, () => this.tierCache.get(address) || { tier: 0, balance: 0 });
  }

  /** Asks the chain what a wallet holds and remembers the answer. Never throws: a failed lookup comes back marked `unsure`. */
  async lookUp(address, visitor) {
    let balance;
    try {
      // (The app's lookups for one wallet wait on each other, so one that never came back would leave that wallet's app without an answer for good.)
      balance = await orGiveUp(this.chain.tokenBalance(address, this.cfg.tokenMint), this.lookupLimitMs, 'the RPC');
      if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) throw new Error('the answer makes no sense');
    } catch (e) {
      const now = this.now(); // when it failed, which can be a good while after it was asked: a hanging RPC takes its time to give up
      this.noteFailedLookup(address, e, now);
      if (visitor) {
        // While the RPC is struggling, every phone asking again on every refresh would only make it worse, and
        // would use up the visitor's ration on failures. Their app goes without for a few seconds instead.
        if (this.troubled.size > 50_000) this.troubled.clear();
        this.troubled.set(visitor, now);
      }
      // A recent answer beats locking a holder out over a network blip. An old one proves nothing: they may have sold
      // long ago. Either way the caller is told that this is not a fresh answer, so that nobody is refused, and
      // nobody who has not been seen holding lately is let in, on the strength of a lookup that failed.
      const known = this.tierCache.get(address);
      if (known && !known.unsure && now - known.ts < TIER_GRACE) return { ...known, unsure: true };
      const miss = { tier: 0, balance: 0, ts: now, ttl: 3000, unsure: true }; // kept for a few seconds, so a struggling RPC is not asked again at once
      this.tierCache.set(address, miss);
      return miss;
    }
    const entry = { tier: this.cfg.tierLevels.filter((level) => balance >= level).length, balance, ts: this.now(), ttl: 180_000 };
    if (this.tierCache.size > 20_000) {
      // Make room by dropping the oldest answers, never everyone's at once, and non-holders before holders.
      let n = 2000;
      for (const pass of ['strangers', 'anyone']) {
        for (const [key, value] of this.tierCache) {
          if (n <= 0) break;
          if (pass === 'strangers' && value.tier > 0) continue;
          this.tierCache.delete(key);
          n--;
        }
      }
    }
    this.tierCache.delete(address);
    this.tierCache.set(address, entry);
    return entry;
  }

  /** Says so in the log when holder lookups fail: one line per ten seconds at most, so an RPC outage cannot bury everything else. */
  noteFailedLookup(address, e, now) {
    const w = this.lookupWarned;
    if (now - w.at < 10_000 && now >= w.at) {
      w.missed++;
      return;
    }
    this.log.warn(`holder lookup failed for ${short(address)}${w.missed ? ` (and for ${w.missed} more since the last such line)` : ''}: ${e.message}`);
    this.lookupWarned = { at: now, missed: 0 };
  }

  /** Anyone can ask about any wallet, so lookups are rationed: a few per visitor per minute, and a ceiling for everyone together. */
  mayLookUp(visitor, now) {
    if (now - this.lookups.start >= MINUTE) {
      this.lookups = { start: now, n: 0, first: 0, claims: 0 };
      this.visitors.clear();
    }
    if (!visitor) {
      // a visitor we cannot tell from anyone else: only the ceiling for everyone applies
      if (this.lookups.n >= this.cfg.holderLookupsPerMin) return false;
      this.lookups.n++;
      return true;
    }
    const mine = (this.visitors.get(visitor) || 0) + 1;
    // Everyone's first lookup of the minute is theirs by right, so a crowd of strangers asking about made-up
    // wallets cannot stop a real holder from being recognised. Further ones come out of the shared ceiling.
    // (Those first lookups have a ceiling of their own, five times as high: visitor addresses are cheap to come by.)
    if (mine > 12 || (mine > 1 ? this.lookups.n >= this.cfg.holderLookupsPerMin : this.lookups.first >= 5 * this.cfg.holderLookupsPerMin)) return false;
    if (this.visitors.size > 50_000) this.visitors.clear();
    this.visitors.set(visitor, mine);
    if (mine > 1) this.lookups.n++;
    else this.lookups.first++;
    return true;
  }

  /** Claims may ask the network about a wallet, but not without end: past a generous ceiling they are asked to come back in a moment. */
  spendClaimLookup(now) {
    if (now - this.lookups.start >= MINUTE) {
      this.lookups = { start: now, n: 0, first: 0, claims: 0 };
      this.visitors.clear();
    }
    if (++this.lookups.claims > 5 * this.cfg.holderLookupsPerMin) throw new GameError('busy', 'The app is very busy right now. Try again in a moment.', { status: 503 });
  }

  /**
   * Is this address an ordinary wallet? People paste the coin's address, or a token account, by mistake,
   * and SOL sent there cannot be got back. Returns 'wallet', 'token', 'program' or 'other'.
   */
  async walletKind(address) {
    if (this.plainWallets.has(address)) return 'wallet';
    const kind = await this.chain.accountKind(address);
    if (kind === 'wallet') {
      if (this.plainWallets.size > 50_000) this.plainWallets.clear();
      this.plainWallets.add(address);
    }
    return kind;
  }

  /**
   * Has this wallet been in use for at least MIN_WALLET_AGE_DAYS? A farm of wallets made this morning has not.
   * A wallet with 1,000 or more transactions counts as seasoned however recent they are.
   */
  async walletOldEnough(address) {
    const days = this.cfg.minWalletAgeDays;
    if (!(days > 0) || this.seasoned.has(address)) return true;
    const { count, oldest } = await this.chain.walletHistory(address);
    const ok = count >= 1000 || (oldest !== null && this.now() - oldest >= days * 24 * HOUR);
    if (ok) {
      if (this.seasoned.size > 50_000) this.seasoned.clear();
      this.seasoned.add(address);
    }
    return ok;
  }

  /* ---------- treasury ---------- */

  /** Lamports spoken for: hidden in live drops, being paid right now, or held back while a payout is double-checked. */
  outstanding() {
    return this.sql(
      `SELECT COALESCE(SUM(d.lamports), 0) AS n FROM drops d JOIN batches b ON b.id = d.batch_id
       WHERE (b.status = 'live' AND d.status = 'hidden') OR d.status IN ('paying', 'held')`,
    ).get().n;
  }

  /** Lamports free to hide in a new batch, or null when the wallet balance is not known yet. */
  available() {
    if (this.balance === null) return null;
    return this.balance - this.outstanding() - this.cfg.reserveLamports;
  }

  /**
   * Reads the wallet and records anything that arrived since last time as fees in.
   * Payouts are subtracted as they happen, so whatever is left over is new money.
   */
  watchTreasury() {
    // One check at a time: two overlapping answers arriving out of order would be read as money leaving and coming back.
    this.watching ||= this.readTreasury().finally(() => {
      this.watching = null;
    });
    return this.watching;
  }

  /** Called every few seconds. Reads the wallet about once a minute, and sooner when a reading had to be put off. */
  watchTreasuryIfDue() {
    return this.now() - this.lastReadAt >= MINUTE ? this.watchTreasury() : Promise.resolve(this.balance);
  }

  /** Payouts on their way right now. */
  inFlight(now) {
    return this.sql(`SELECT COUNT(*) AS n FROM claims WHERE status = 'paying' AND created_at > ?`).get(now - IN_FLIGHT).n;
  }

  /**
   * Lamports that may have left the wallet without the books knowing: payouts written off but still being
   * re-checked, and payouts the chain has not been able to tell us about for a while.
   */
  underReview(now) {
    const writtenOff = this.sql(`SELECT COALESCE(SUM(c.lamports + c.fee), 0) AS n FROM claims c JOIN drops d ON d.id = c.drop_id WHERE ${UNDER_REVIEW}`).get(now - SECOND_LOOK).n;
    const unresolved = this.sql(`SELECT COALESCE(SUM(lamports + fee), 0) AS n FROM claims WHERE status = 'paying' AND sig IS NOT NULL AND created_at <= ?`).get(now - IN_FLIGHT).n;
    return writtenOff + unresolved;
  }

  /** Notes that the books now include everything up to this slot of the chain. */
  raiseFloor(slot, now) {
    if (!Number.isSafeInteger(slot)) return;
    if (this.floor && slot <= this.floor.slot && now - this.floor.at < FLOOR_TRUST) return;
    this.floor = { slot, at: now };
    this.setKV('floor', JSON.stringify(this.floor));
  }

  /** Is a wallet reading taken at this slot at least as new as what the books already include? */
  freshEnough(slot, now) {
    if (slot === null) return now - this.lastSettledAt >= 15_000; // the node does not say where it is: give it time after a payout instead
    // The floor only counts for a short while, so one nonsense slot number cannot shut readings out for good.
    return !(this.floor && slot < this.floor.slot && now - this.floor.at < FLOOR_TRUST);
  }

  async readTreasury() {
    // Nothing can be learned while a payout is on its way: the wallet may or may not show it yet.
    if (this.balance !== null && this.inFlight(this.now()) > 0) return this.balance;
    const seq = this.settleSeq;
    const { lamports: balance, slot } = await this.chain.balanceAt();
    if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('the treasury balance could not be read');
    const now = this.now();
    // The answer must be at least as new as everything already in the books: not read further back in the chain
    // than the last payout, and no payout started or finished while we were waiting for it.
    if (!this.freshEnough(slot, now)) return this.balance;
    if (this.settleSeq !== seq || this.inFlight(now) > 0) {
      if (this.balance === null) this.balance = balance; // the first reading after a restart: better than nothing until things are quiet
      return this.balance;
    }
    this.raiseFloor(slot, now);
    this.balance = balance;
    this.lastReadAt = now;
    const accounted = Number(this.getKV('accounted') ?? NaN);
    if (!Number.isFinite(accounted)) {
      if (balance > 0) this.sql('INSERT INTO ledger(ts, kind, lamports, note) VALUES (?, ?, ?, ?)').run(now, 'fee_in', balance, 'opening balance');
      this.setKV('accounted', balance);
      return balance;
    }
    const delta = balance - accounted;
    if (delta >= BOOK_FROM) {
      this.sql('INSERT INTO ledger(ts, kind, lamports, note) VALUES (?, ?, ?, ?)').run(now, 'fee_in', delta, 'received');
      this.setKV('accounted', balance);
    } else if (delta <= -BOOK_FROM) {
      // Money is missing. Up to the amount of payouts still under review, it may be one of ours that landed unseen:
      // if so, settle() will book it, and booking it here as well would count it twice. Only the rest is booked now.
      const unexplained = -delta - this.underReview(now);
      if (unexplained >= BOOK_FROM) {
        this.sql('INSERT INTO ledger(ts, kind, lamports, note) VALUES (?, ?, ?, ?)').run(now, 'adjust', -unexplained, 'left the wallet outside the app');
        this.setKV('accounted', accounted - unexplained);
      }
    }
    return balance;
  }

  /* ---------- batches ---------- */

  /** Splits an amount into small, mid and big drops (45% / 45% / 10% of the value), or uses explicit counts. */
  planDrops({ totalLamports, counts, goldShare = 0 }) {
    const v = this.cfg.tierValues;
    let n;
    if (counts && typeof counts === 'object') {
      n = { s: clampInt(counts.s, 0, MAX_DROPS_PER_BATCH, 0), m: clampInt(counts.m, 0, MAX_DROPS_PER_BATCH, 0), l: clampInt(counts.l, 0, MAX_DROPS_PER_BATCH, 0) };
    } else {
      const asked = Math.floor(Number(totalLamports));
      // refuse absurd amounts before doing any work with them (a typo here must not stall the server)
      if (asked / v.s > 2 * MAX_DROPS_PER_BATCH) throw new GameError('bad_batch', `A batch can hold ${MAX_DROPS_PER_BATCH.toLocaleString('en-US')} drops at most. Hide less, or make the drops bigger.`);
      const total = asked > 0 ? asked : 0;
      const l = Math.floor((total * 0.1) / v.l);
      const m = Math.floor((total * 0.45) / v.m);
      const s = Math.floor((total - l * v.l - m * v.m) / v.s);
      n = { s, m, l };
    }
    if (n.s + n.m + n.l > MAX_DROPS_PER_BATCH) throw new GameError('bad_batch', `A batch can hold ${MAX_DROPS_PER_BATCH.toLocaleString('en-US')} drops at most. Hide less, or make the drops bigger.`);
    const drops = [];
    for (const tier of ['l', 'm', 's']) for (let i = 0; i < n[tier]; i++) drops.push({ tier, lamports: v[tier], gold: 0 });
    const eligible = drops.filter((d) => d.tier !== 's');
    const goldCount = Math.min(eligible.length, Math.round(eligible.length * Math.min(1, Math.max(0, Number.isFinite(goldShare) ? goldShare : 0))));
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    for (let i = 0; i < goldCount; i++) eligible[i].gold = 1;
    return { drops, counts: n, total: drops.reduce((sum, d) => sum + d.lamports, 0), gold: goldCount };
  }

  createBatch(input, { source = 'manual', skipFundsCheck = false } = {}) {
    const now = this.now();
    const name = str(input.name).trim().slice(0, 60);
    const area = str(input.area).trim().slice(0, 40);
    const lat = numOf(input.lat);
    const lng = numOf(input.lng);
    const radiusM = numOf(input.radiusM);
    const startsAt = input.startsAt === undefined || input.startsAt === null ? now : numOf(input.startsAt);
    const endsAt = numOf(input.endsAt);
    if (!name) throw new GameError('bad_batch', 'Give the batch a name.');
    if (!validLatLng(lat, lng)) throw new GameError('bad_batch', 'Pick a spot on the map.');
    if (!(radiusM >= 10 && radiusM <= 20_000)) throw new GameError('bad_batch', 'The radius must be between 10 m and 20 km.');
    if (!(endsAt > startsAt) || !(endsAt > now)) throw new GameError('bad_batch', 'The end time must be after the start, and in the future.');
    if (endsAt - startsAt > 30 * 24 * HOUR) throw new GameError('bad_batch', 'A batch can run for 30 days at most.');
    const earlyMin = clampInt(input.earlyMin, 0, 240, this.cfg.earlyMin);
    const onePerPerson = input.onePerPerson === false || input.onePerPerson === 0 ? 0 : 1;
    const counts = input.counts && typeof input.counts === 'object' ? input.counts : null;
    const totalLamports = input.totalSol !== undefined ? Math.round(numOf(input.totalSol) * 1e9) : undefined;
    if (!counts && !(totalLamports > 0)) throw new GameError('bad_batch', 'Enter how much SOL to hide.');
    const plan = this.planDrops({ totalLamports, counts, goldShare: numOf(input.goldShare) || 0 });
    if (!plan.drops.length) throw new GameError('bad_batch', `That is too little for even one drop. The smallest drop is ${solString(this.cfg.tierValues.s)} SOL.`);
    if (!skipFundsCheck) {
      const free = this.available();
      if (free === null || !Number.isFinite(free)) throw new GameError('funds', 'The treasury balance is not known yet. Try again in a minute.', { status: 503 });
      if (!(plan.total <= free)) throw new GameError('funds', `The treasury has ${solString(Math.max(0, free))} SOL free. This batch needs ${solString(plan.total)}.`, { available: free });
    }
    const center = { lat, lng };
    const id = inTransaction(this.db, () => {
      const batchId = Number(
        this.sql(
          `INSERT INTO batches(name, area, lat, lng, radius_m, starts_at, ends_at, early_min, one_per_person, source, total_lamports, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(name, area, lat, lng, radiusM, startsAt, endsAt, earlyMin, onePerPerson, source, plan.total, now).lastInsertRowid,
      );
      const insert = this.sql('INSERT INTO drops(batch_id, lat, lng, lamports, tier, gold) VALUES (?, ?, ?, ?, ?, ?)');
      for (const d of plan.drops) {
        const p = randomInCircle(center, radiusM, this.random);
        insert.run(batchId, p.lat, p.lng, d.lamports, d.tier, d.gold);
      }
      return batchId;
    });
    this.log.info(`batch ${id} "${name}": ${plan.drops.length} drops, ${solString(plan.total)} SOL (${source})`);
    return this.batchSummary(id);
  }

  batchSummary(id) {
    const b = this.sql('SELECT * FROM batches WHERE id = ?').get(id);
    if (!b) return null;
    const c = this.sql(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'hidden'), 0) AS hidden, COALESCE(SUM(status = 'claimed'), 0) AS claimed,
              COALESCE(SUM(CASE WHEN status = 'claimed' THEN lamports ELSE 0 END), 0) AS claimedLamports, COALESCE(SUM(gold), 0) AS gold
       FROM drops WHERE batch_id = ?`,
    ).get(id);
    return {
      id: b.id, name: b.name, area: b.area, lat: b.lat, lng: b.lng, radiusM: b.radius_m, startsAt: b.starts_at, endsAt: b.ends_at,
      earlyMin: b.early_min, onePerPerson: !!b.one_per_person, source: b.source, status: b.status, totalLamports: b.total_lamports,
      drops: c.total, left: c.hidden, claimed: c.claimed, claimedLamports: c.claimedLamports, gold: c.gold,
    };
  }

  /** Ends a batch now. Drops nobody found go back to the free balance. */
  endBatch(id) {
    return inTransaction(this.db, () => {
      const r = this.sql(`UPDATE batches SET status = 'ended' WHERE id = ? AND status = 'live'`).run(id);
      if (r.changes) this.sql(`UPDATE drops SET status = 'expired' WHERE batch_id = ? AND status = 'hidden'`).run(id);
      return r.changes === 1;
    });
  }

  expireBatches() {
    const due = this.sql(`SELECT id FROM batches WHERE status = 'live' AND ends_at <= ?`).all(this.now());
    for (const b of due) this.endBatch(b.id);
    return due.length;
  }

  /* ---------- what a hunter sees ---------- */

  recordPing(device, lat, lng, acc) {
    if (!device || !validLatLng(lat, lng)) return;
    const now = this.now();
    let trail = this.pings.get(device);
    if (!trail) {
      if (this.pings.size > 50_000) this.pings.clear();
      trail = [];
      this.pings.set(device, trail);
    }
    const ping = { ts: now, lat, lng, acc: Number.isFinite(acc) ? acc : null };
    const last = trail[trail.length - 1];
    if (last && now - last.ts < 1500) trail[trail.length - 1] = { ...ping, ts: last.ts };
    else trail.push(ping);
    while (trail.length > 60 || (trail.length && now - trail[0].ts > 30 * MINUTE)) trail.shift();
  }

  hasClaimedIn(batchId, address, device) {
    return !!this.sql(
      `SELECT 1 AS x FROM claims WHERE batch_id = ? AND status IN ('paying', 'paid') AND one_per_person = 1 AND (address = ? OR device = ?) LIMIT 1`,
    ).get(batchId, address || '', device || '');
  }

  sync({ lat, lng, acc, device, address, tier = 0 }) {
    const cfg = this.cfg;
    const now = this.now();
    const here = validLatLng(lat, lng) ? { lat, lng } : null;
    if (typeof device !== 'string' || !DEVICE_ID.test(device)) device = ''; // anything else is not one of our phones: nothing is remembered for it
    if (here && device) this.recordPing(device, lat, lng, acc);
    const reach = this.reachFor(tier);
    const open = new Set();
    const batches = [];
    for (const b of this.sql(`SELECT * FROM batches WHERE status = 'live' AND ends_at > ? ORDER BY starts_at`).all(now)) {
      const opensAt = tier >= 1 ? b.starts_at - b.early_min * MINUTE : b.starts_at;
      const isOpen = now >= opensAt;
      if (isOpen) open.add(b.id);
      const c = this.sql(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'hidden'), 0) AS hidden FROM drops WHERE batch_id = ?`).get(b.id);
      batches.push({
        id: b.id, name: b.name, area: b.area, lat: b.lat, lng: b.lng, radiusM: b.radius_m, startsAt: b.starts_at, endsAt: b.ends_at,
        opensAt, open: isOpen, early: isOpen && now < b.starts_at, totalLamports: b.total_lamports, drops: c.total, left: c.hidden,
        source: b.source, onePerPerson: !!b.one_per_person, distM: here ? Math.round(distanceM(here, b)) : null,
        done: !!b.one_per_person && this.hasClaimedIn(b.id, address, device),
      });
    }
    const drops = [];
    if (here && open.size) {
      const maxM = cfg.nearbyKm * 1000;
      const box = boundingBox(here, maxM);
      const rows = this.sql(
        `SELECT id, batch_id, lat, lng, lamports, tier, gold FROM drops WHERE status = 'hidden' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
      ).all(box.minLat, box.maxLat, box.minLng, box.maxLng);
      for (const d of rows) {
        if (!open.has(d.batch_id)) continue;
        const trueDist = distanceM(here, d);
        if (trueDist > maxM) continue;
        const exact = trueDist <= reach + 8;
        const shown = exact ? d : fuzzPoint(d, d.id, this.secret, cfg.fuzzM);
        drops.push({
          id: d.id, b: d.batch_id, lat: round6(shown.lat), lng: round6(shown.lng), exact, lamports: d.lamports, tier: d.tier,
          gold: !!d.gold, locked: !!d.gold && tier < cfg.goldTier, dist: Math.round(exact ? trueDist : distanceM(here, shown)),
        });
      }
      drops.sort((a, b) => a.dist - b.dist);
      drops.length = Math.min(drops.length, 300);
    }
    return { now, reach, tier, paused: this.paused, batches, drops };
  }

  /* ---------- claiming ---------- */

  /** A hunter must have reported a believable path, not a single point out of nowhere. */
  checkTrail(device, now) {
    const cfg = this.cfg;
    const trail = (this.pings.get(device) || []).filter((p) => now - p.ts <= 10 * MINUTE);
    if (!trail.length || trail.length < cfg.trailMinPings || trail[trail.length - 1].ts - trail[0].ts < cfg.trailMinSeconds * 1000) {
      throw new GameError('trail', 'Hold on a few seconds while we confirm your location.', { status: 425 });
    }
    for (let i = 1; i < trail.length; i++) {
      const dt = (trail[i].ts - trail[i - 1].ts) / 1000;
      const slack = 25 + Math.min(60, (trail[i].acc || 0) + (trail[i - 1].acc || 0));
      if (distanceM(trail[i - 1], trail[i]) > cfg.maxSpeedMs * Math.max(dt, 1) + slack) {
        this.pings.set(device, [trail[trail.length - 1]]); // start the trail over from where they are now
        throw new GameError('teleport', 'Your location jumped. Stay put for a moment and try again.', { status: 425 });
      }
    }
  }

  async claim({ dropId, address, device, ip, lat, lng, acc }) {
    const cfg = this.cfg;
    const now = this.now();
    if (!isAddress(address)) throw new GameError('bad_address', 'Add a valid Solana address first.');
    if (address === this.chain.address) throw new GameError('bad_address', 'That is the treasury wallet.');
    if (address === cfg.tokenMint) throw new GameError('bad_address', `That is the coin's own address, not your wallet. ${PASTE_HINT}`);
    if (typeof device !== 'string' || !DEVICE_ID.test(device)) throw new GameError('bad_request', 'Missing device id.');
    if (!validLatLng(lat, lng)) throw new GameError('no_location', 'We need your location to check you are at the drop.');
    const drop = this.sql(
      `SELECT d.*, b.status AS batch_status, b.starts_at, b.ends_at, b.early_min, b.one_per_person, b.name AS batch_name, b.area
       FROM drops d JOIN batches b ON b.id = d.batch_id WHERE d.id = ?`,
    ).get(Number(dropId) || 0);
    if (!drop) throw new GameError('no_drop', 'That drop does not exist.', { status: 404 });
    if (drop.status !== 'hidden') {
      // The same hunter asking again (their first answer got lost on a bad connection) gets the same answer, not "too late".
      const mine = this.sql(`SELECT status, sig FROM claims WHERE drop_id = ? AND address = ? AND device = ? AND status IN ('paying', 'paid') ORDER BY id DESC LIMIT 1`).get(drop.id, address, device);
      if (mine && mine.status === 'paid') {
        return { lamports: drop.lamports, signature: mine.sig, tier: drop.tier, gold: !!drop.gold, area: drop.area || drop.batch_name, left: this.batchSummary(drop.batch_id).left, repeat: true };
      }
      if (mine) throw new GameError('pending', 'Your payout is being confirmed. Check your wallet in a minute.', { status: 202 });
      if (drop.status === 'held') throw new GameError('held', 'This drop is being double-checked after a payout problem. It will be back on the map within half an hour.', { status: 409, held: true });
      throw new GameError('gone', 'Someone got there first. This drop is gone.', { status: 410 });
    }
    if (this.paused) throw new GameError('paused', 'Claims are paused for a moment. This drop is not going anywhere, try again soon.', { status: 503 });
    if (drop.batch_status !== 'live' || now >= drop.ends_at) throw new GameError('not_live', 'This batch has ended.', { status: 410 });
    // Before the head start begins, nobody can claim, whatever they hold.
    if (now < drop.starts_at - drop.early_min * MINUTE) throw new GameError('not_live', 'This batch is not live yet.', { status: 403 });

    // Everything that can be decided from what the phone sent comes first. The network is only asked about a
    // wallet once the claim comes from within reach, so nobody can make the server spend lookups from far away.
    const accuracy = Number.isFinite(acc) ? acc : Infinity;
    if (accuracy > cfg.maxAccuracyM) throw new GameError('gps_weak', 'Your GPS signal is too weak here. Step into the open and try again.', { status: 425 });
    this.recordPing(device, lat, lng, accuracy);
    const dist = distanceM({ lat, lng }, drop);
    const tooFar = (reach) => {
      const far = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(dist < 10_000 ? 1 : 0)} km`;
      return new GameError('too_far', `You are ${far} away. Get within ${reach} m.`, { status: 403, dist: Math.round(dist), reach });
    };
    const remembered = this.tierCache.get(address);
    if (dist > this.reachFor(3)) throw tooFar(this.reachFor(remembered ? remembered.tier : 0));

    // A holder's balance is looked up only when this claim needs a perk: the head start, a holder-only drop, or the longer reach.
    const early = now < drop.starts_at;
    let tier = 0;
    if (early || drop.gold || dist > cfg.reachM) {
      const lacking = (t) => (early && t < 1) || (drop.gold && t < cfg.goldTier) || (dist > cfg.reachM && t < 3);
      this.spendClaimLookup(now);
      let seen = await this.tierOf(address, { priority: true });
      // About to refuse? Read their balance again first, in case they just bought.
      if (lacking(seen.tier)) seen = await this.tierOf(address, { fresh: true, priority: true });
      // A lookup that failed is not an answer. Nobody is told they are not a holder because of one: they are asked to try again.
      if (lacking(seen.tier) && seen.unsure) {
        throw new GameError('busy', `Could not check your $${cfg.tokenTicker} just now. Try again in a moment.`, { status: 503 });
      }
      tier = seen.tier;
      if (early && tier < 1) throw new GameError('not_live', 'This batch is not live yet.', { status: 403 });
      if (drop.gold && tier < cfg.goldTier) {
        throw new GameError('holders_only', `Holders only. This drop needs ${cfg.tierLevels[cfg.goldTier - 1].toLocaleString('en-US')} $${cfg.tokenTicker}.`, { status: 403 });
      }
    }
    const reach = this.reachFor(tier);
    if (dist > reach) throw tooFar(reach);
    this.checkTrail(device, now);

    const ipHash = this.hashIp(ip);
    // (No network address means the server cannot tell visitors apart; a cap on "this network" would then cap everyone together.)
    const fromIp = ip ? this.sql(`SELECT COUNT(*) AS n FROM claims WHERE ip = ? AND status IN ('paying', 'paid') AND created_at > ?`).get(ipHash, now - 24 * HOUR).n : 0;
    if (fromIp >= cfg.claimsPerIpPerDay) throw new GameError('ip_limit', 'Too many claims from this network today. Try again tomorrow.', { status: 429 });
    if (cfg.minWalletLamports > 0) {
      const walletBalance = await this.chain.getBalance(address).catch(() => null);
      if (walletBalance !== null && walletBalance < cfg.minWalletLamports) {
        throw new GameError('wallet_new', `Your wallet needs at least ${solString(cfg.minWalletLamports)} SOL in it to claim.`, { status: 403 });
      }
    }
    if (cfg.minWalletAgeDays > 0) {
      const seasoned = await this.walletOldEnough(address).catch(() => null);
      if (seasoned === null) throw new GameError('busy', 'Could not check your wallet just now. Try again in a moment.', { status: 503 });
      if (!seasoned) {
        const days = cfg.minWalletAgeDays;
        throw new GameError('wallet_new', `This wallet is too new. Use one you have had for at least ${days} ${days === 1 ? 'day' : 'days'}.`, { status: 403 });
      }
    }
    if (!this.plainWallets.has(address)) this.spendClaimLookup(now);
    const kind = await this.walletKind(address).catch(() => null);
    if (kind === null) throw new GameError('busy', 'Could not check your wallet just now. Try again in a moment.', { status: 503 });
    if (kind !== 'wallet') throw new GameError('bad_address', NOT_A_WALLET[kind] || NOT_A_WALLET.other);
    const fee = this.chain.feeFor();
    if (this.balance !== null && this.balance < drop.lamports + fee) {
      throw new GameError('treasury_empty', 'The treasury is being topped up. Try again in a few minutes.', { status: 503 });
    }

    // Reserve the drop and the hunter's one claim in a single step, so two people can never both win it.
    let claimId;
    try {
      claimId = inTransaction(this.db, () => {
        // The lookups above take time, so the things that can have changed meanwhile are checked again here, where nothing can slip in between.
        if (this.paused) throw new GameError('paused', 'Claims are paused for a moment. This drop is not going anywhere, try again soon.', { status: 503 });
        if (ip && this.sql(`SELECT COUNT(*) AS n FROM claims WHERE ip = ? AND status IN ('paying', 'paid') AND created_at > ?`).get(ipHash, now - 24 * HOUR).n >= cfg.claimsPerIpPerDay) {
          throw new GameError('ip_limit', 'Too many claims from this network today. Try again tomorrow.', { status: 429 });
        }
        // The unique indexes cover the usual case. This also covers a payout that was revived after being written off.
        if (drop.one_per_person && this.sql(`SELECT 1 AS x FROM claims WHERE batch_id = ? AND status = 'paid' AND (address = ? OR device = ?) LIMIT 1`).get(drop.batch_id, address, device)) {
          throw new GameError('one_per_person', 'One drop per person in this batch, and you already found yours.', { status: 409 });
        }
        // The wallet has to cover this payout on top of every other one already on its way.
        const onTheirWay = this.sql(`SELECT COALESCE(SUM(lamports + fee), 0) AS n FROM claims WHERE status = 'paying'`).get().n;
        if (this.balance !== null && this.balance - onTheirWay < drop.lamports + fee) {
          throw new GameError('treasury_empty', 'The treasury is being topped up. Try again in a few minutes.', { status: 503 });
        }
        const taken = this.sql(`UPDATE drops SET status = 'paying' WHERE id = ? AND status = 'hidden'`).run(drop.id);
        if (taken.changes !== 1) throw new GameError('gone', 'Someone got there first. This drop is gone.', { status: 410 });
        return Number(
          this.sql(
            `INSERT INTO claims(drop_id, batch_id, address, device, ip, lat, lng, acc, dist, lamports, fee, one_per_person, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paying', ?)`,
          ).run(drop.id, drop.batch_id, address, device, ipHash, lat, lng, Number.isFinite(accuracy) ? accuracy : null, dist, drop.lamports, fee, drop.one_per_person, now).lastInsertRowid,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new GameError('one_per_person', 'One drop per person in this batch, and you already found yours.', { status: 409 });
      throw e;
    }

    const pending = () => new GameError('pending', 'Your payout is being confirmed. Check your wallet in a minute.', { status: 202 });
    let signature;
    let slot;
    try {
      ({ signature, slot } = await this.chain.transfer(address, drop.lamports, {
        onSent: ({ signature: sig, lastValidBlockHeight }) => this.sql('UPDATE claims SET sig = ?, last_valid_height = ? WHERE id = ?').run(sig, lastValidBlockHeight ?? null, claimId),
      }));
    } catch (e) {
      // Only an error that says outright "nothing moved" closes the claim. Anything else, including an error
      // nobody planned for, leaves the claim as it is for the reconciler, which decides from the chain itself.
      if (isUniqueViolation(e)) {
        // The record of the signature could not be written because another claim already has it, so nothing was sent.
        this.fail(claimId, 'never sent: the same transaction was already on record');
        throw new GameError('payout_failed', 'The payout did not go through. Nothing was lost, so try again.', { status: 502, held: false });
      }
      if (e.uncertain !== false) {
        this.log.warn(`claim ${claimId}: payout status unknown (${e.message}), the reconciler will settle it`);
        throw pending();
      }
      this.fail(claimId, e.message, { feeSpent: e.code === 'tx_error' });
      this.log.warn(`claim ${claimId}: payout failed: ${e.message}`);
      const held = this.sql('SELECT status FROM drops WHERE id = ?').get(drop.id).status === 'held';
      throw new GameError(
        'payout_failed',
        held ? 'The payout did not go through. Nothing was lost. This drop is being double-checked and will be back on the map within half an hour.' : 'The payout did not go through. Nothing was lost, so try again.',
        { status: 502, held },
      );
    }
    // The money has moved. A problem writing that down must never be mistaken for a failed payout.
    try {
      this.settle(claimId, signature, slot);
    } catch (e) {
      this.log.error(`claim ${claimId}: paid ${signature} but could not be booked (${e.message}); the reconciler will book it`);
      throw pending();
    }
    let left = 0;
    try {
      left = this.batchSummary(drop.batch_id).left;
    } catch {}
    return { lamports: drop.lamports, signature, tier: drop.tier, gold: !!drop.gold, area: drop.area || drop.batch_name, left };
  }

  /**
   * Books a payout the network has confirmed. Safe to call twice.
   * It also accepts a claim that was written off as failed: if the transfer landed after all,
   * the books must say so, and the drop comes off the map again unless someone else has it by now.
   * `slot` is where in the chain the payout landed, when known.
   */
  settle(claimId, signature, slot = null) {
    return inTransaction(this.db, () => {
      const c = this.sql('SELECT * FROM claims WHERE id = ?').get(claimId);
      if (!c || c.status === 'paid') return false;
      const now = this.now();
      const revived = c.status === 'failed';
      let onePerPerson = c.one_per_person;
      if (revived && onePerPerson) {
        const other = this.sql(
          `SELECT 1 AS x FROM claims WHERE batch_id = ? AND id != ? AND status IN ('paying', 'paid') AND one_per_person = 1 AND (address = ? OR device = ?) LIMIT 1`,
        ).get(c.batch_id, c.id, c.address, c.device);
        if (other) onePerPerson = 0; // they already claimed again in the meantime; both payouts are real, so record both
      }
      this.sql(`UPDATE claims SET status = 'paid', sig = ?, settled_at = ?, error = NULL, one_per_person = ? WHERE id = ?`).run(signature, now, onePerPerson, claimId);
      const took = this.sql(
        `UPDATE drops SET status = 'claimed', claimed_by = ?, claimed_at = ?, sig = ?, held_until = NULL WHERE id = ? AND status IN (${revived ? `'held', 'hidden', 'expired'` : `'paying'`})`,
      ).run(c.address, now, signature, c.drop_id);
      if (!took.changes) this.log.error(`claim ${claimId}: paid ${signature}, but drop ${c.drop_id} had already gone to someone else`);
      const spent = c.lamports + c.fee;
      const accounted = Number(this.getKV('accounted') ?? NaN);
      if (Number.isFinite(accounted)) this.setKV('accounted', accounted - spent);
      if (this.balance !== null) this.balance -= spent;
      this.lastSettledAt = now;
      this.settleSeq++;
      this.raiseFloor(slot, now);
      return true;
    });
  }

  /**
   * Closes a claim whose payout did not happen. Safe to call twice.
   *
   * What becomes of the drop depends on how sure we are:
   * - nothing was ever signed: it goes straight back on the map;
   * - a transfer was signed and may have gone out (refused, or expired unseen): it is held off the map for half an
   *   hour of second looks, because a slow node could still turn out to have a landed transfer;
   * - `feeSpent`: the transaction ran on the chain and failed there. That is final, so the drop goes straight back;
   *   no SOL moved, but the network kept its fee, which is booked;
   * - `retire`: nobody could tell what happened for a day. The drop is taken out of the game for good.
   */
  fail(claimId, error, { feeSpent = false, retire = false } = {}) {
    return inTransaction(this.db, () => {
      const c = this.sql('SELECT * FROM claims WHERE id = ?').get(claimId);
      if (!c || c.status !== 'paying') return false;
      const now = this.now();
      this.sql(`UPDATE claims SET status = 'failed', error = ?, settled_at = ? WHERE id = ?`).run(String(error || '').slice(0, 300), now, claimId);
      if (feeSpent) {
        const accounted = Number(this.getKV('accounted') ?? NaN);
        if (Number.isFinite(accounted)) this.setKV('accounted', accounted - c.fee);
        if (this.balance !== null) this.balance -= c.fee;
        this.lastSettledAt = now;
        this.settleSeq++;
      }
      // If an earlier payout for this drop was revived as paid in the meantime, the drop is spoken for.
      const paid = this.sql(`SELECT address, sig, settled_at FROM claims WHERE drop_id = ? AND status = 'paid' ORDER BY id LIMIT 1`).get(c.drop_id);
      if (paid) {
        this.sql(`UPDATE drops SET status = 'claimed', claimed_by = ?, claimed_at = ?, sig = ?, held_until = NULL WHERE id = ? AND status = 'paying'`).run(paid.address, paid.settled_at, paid.sig, c.drop_id);
        return true;
      }
      if (retire) {
        this.sql(`UPDATE drops SET status = 'expired', held_until = NULL WHERE id = ? AND status = 'paying'`).run(c.drop_id);
      } else if (c.sig !== null && !feeSpent) {
        this.sql(`UPDATE drops SET status = 'held', held_until = ? WHERE id = ? AND status = 'paying'`).run(now + SECOND_LOOK, c.drop_id);
      } else {
        this.sql(`UPDATE drops SET status = ?, held_until = NULL WHERE id = ? AND status = 'paying'`).run(this.batchIsLive(c.batch_id, now) ? 'hidden' : 'expired', c.drop_id);
      }
      return true;
    });
  }

  batchIsLive(batchId, now) {
    const batch = this.sql('SELECT status, ends_at FROM batches WHERE id = ?').get(batchId);
    return !!batch && batch.status === 'live' && batch.ends_at > now;
  }

  /**
   * Runs every few seconds. Settles payouts whose outcome we could not see at the time (network trouble, a restart),
   * gives written-off payouts their second looks, and puts held drops back once the chain has cleared them.
   */
  async reconcile() {
    const now = this.now();
    let resolved = 0;

    // 1. Payouts still open.
    for (const c of this.sql(`SELECT * FROM claims WHERE status = 'paying' AND created_at < ?`).all(now - 20_000)) {
      if (!c.sig) {
        if (now - c.created_at > 3 * MINUTE && this.fail(c.id, 'never sent')) resolved++;
        continue;
      }
      let status; // an object, null for "the chain has never heard of it", undefined for "the chain cannot say right now"
      try {
        status = await this.chain.signatureStatus(c.sig);
      } catch {
        status = undefined;
      }
      if (failedForGood(status)) {
        if (this.fail(c.id, 'failed on-chain', { feeSpent: true })) resolved++;
      } else if (confirmed(status)) {
        if (this.settle(c.id, c.sig, status.slot)) resolved++;
      } else if (status === null) {
        // Once its window has closed, with a margin for a node that is a little behind, it can no longer land.
        let closed;
        if (c.last_valid_height !== null) {
          const height = await this.chain.blockHeight().catch(() => null);
          closed = Number.isFinite(height) && height > c.last_valid_height + EXPIRY_MARGIN;
        } else closed = now - c.created_at > 10 * MINUTE; // no window on record; no blockhash lives this long
        if (closed && this.fail(c.id, 'expired')) resolved++;
      } else if (now - c.created_at > GIVE_UP) {
        if (this.fail(c.id, 'could not be verified in 24 hours', { retire: true })) {
          this.log.error(`claim ${c.id}: the chain could not say what became of payout ${c.sig} for 24 hours. Closed; its drop is out of the game. Check that transaction by hand.`);
          resolved++;
        }
      }
    }

    // 2. Second looks. A payout we wrote off may still turn out to have landed, if the node was behind when we asked.
    const review = this.sql(
      `SELECT c.id, c.sig, c.drop_id FROM claims c JOIN drops d ON d.id = c.drop_id WHERE ${UNDER_REVIEW} ORDER BY c.id`,
    ).all(now - SECOND_LOOK);
    const cleared = new Map(); // drop id -> has the chain just said "never happened" for every payout tried on it?
    for (let i = 0; i < review.length; i += 200) {
      const chunk = review.slice(i, i + 200);
      const statuses = await this.chain.signatureStatuses(chunk.map((c) => c.sig)).catch(() => null);
      chunk.forEach((c, j) => {
        const status = statuses ? statuses[j] : undefined;
        if (confirmed(status)) {
          if (this.settle(c.id, c.sig, status.slot)) {
            this.log.error(`claim ${c.id}: was written off but the transfer landed after all (${c.sig}); corrected`);
            resolved++;
          }
          cleared.set(c.drop_id, false);
        } else {
          const gone = status === null || failedForGood(status);
          cleared.set(c.drop_id, gone && cleared.get(c.drop_id) !== false);
        }
      });
    }

    // 3. A held drop goes back once its time is up, but only on the chain's word, never on a guess.
    for (const d of this.sql(`SELECT id, batch_id FROM drops WHERE status = 'held' AND held_until <= ?`).all(now)) {
      if (cleared.get(d.id) === false) continue;
      this.sql(`UPDATE drops SET status = ?, held_until = NULL WHERE id = ? AND status = 'held'`).run(this.batchIsLive(d.batch_id, now) ? 'hidden' : 'expired', d.id);
    }
    return resolved;
  }

  /* ---------- fee-funded batches on a schedule ---------- */

  autoConfig() {
    const saved = JSON.parse(this.getKV('auto') || '{}');
    return { enabled: false, everyHours: 6, durationHours: 6, minSol: 1, maxSol: 50, goldShare: 0.2, areas: [], nextAt: null, ...saved };
  }

  setAuto(input) {
    const prev = this.autoConfig();
    const areas = (Array.isArray(input.areas) ? input.areas : prev.areas)
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({ name: str(a.name).trim().slice(0, 40), lat: numOf(a.lat), lng: numOf(a.lng), radiusM: numOf(a.radiusM) }))
      .filter((a) => a.name && validLatLng(a.lat, a.lng) && a.radiusM >= 10 && a.radiusM <= 20_000)
      .slice(0, 20);
    const next = {
      enabled: !!input.enabled && areas.length > 0,
      everyHours: Math.min(168, Math.max(0.25, numOf(input.everyHours) || prev.everyHours)),
      durationHours: Math.min(168, Math.max(0.25, numOf(input.durationHours) || prev.durationHours)),
      minSol: Math.min(1e6, Math.max(0, numOf(input.minSol ?? prev.minSol) || 0)),
      maxSol: Math.min(1e6, Math.max(0, numOf(input.maxSol ?? prev.maxSol) || 0)),
      goldShare: Math.min(1, Math.max(0, numOf(input.goldShare ?? prev.goldShare) || 0)),
      areas,
      nextAt: prev.nextAt,
    };
    if (next.enabled && (!next.nextAt || next.nextAt < this.now() || next.everyHours !== prev.everyHours)) {
      const step = next.everyHours * HOUR;
      next.nextAt = Math.ceil((this.now() + 1) / step) * step; // lands on round times: 00:00, 06:00, 12:00 ... UTC
    }
    if (!next.enabled) next.nextAt = null;
    this.setKV('auto', JSON.stringify(next));
    return next;
  }

  /** Called on a timer. When the schedule is due, hides whatever fees have built up. */
  autoTick() {
    const auto = this.autoConfig();
    const now = this.now();
    if (!auto.enabled || !auto.areas.length || !auto.nextAt || now < auto.nextAt) return [];
    const step = auto.everyHours * HOUR;
    let nextAt = auto.nextAt;
    while (nextAt <= now) nextAt += step;
    this.setKV('auto', JSON.stringify({ ...auto, nextAt })); // move the clock first, so a crash cannot repeat a batch
    const free = this.available();
    if (free === null) return [];
    const budget = Math.min(free, Math.round(auto.maxSol * 1e9));
    if (budget < Math.max(auto.minSol * 1e9, this.cfg.tierValues.s)) return [];
    const share = Math.floor(budget / auto.areas.length);
    const startsAt = now + this.cfg.earlyMin * MINUTE; // holders see it right away, everyone else after the head start
    const made = [];
    for (const a of auto.areas) {
      try {
        made.push(
          this.createBatch(
            { name: `Fee drop · ${a.name}`, area: a.name, lat: a.lat, lng: a.lng, radiusM: a.radiusM, totalSol: share / 1e9, goldShare: auto.goldShare, startsAt, endsAt: startsAt + auto.durationHours * HOUR },
            { source: 'fees' },
          ),
        );
      } catch (e) {
        this.log.warn(`auto batch for ${a.name} skipped: ${e.message}`);
      }
    }
    return made;
  }

  /* ---------- public numbers ---------- */

  stats() {
    const one = (text) => this.sql(text).get();
    const claimed = one(`SELECT COALESCE(SUM(lamports), 0) AS n, COUNT(*) AS c FROM drops WHERE status = 'claimed'`);
    const waiting = one(
      `SELECT COALESCE(SUM(d.lamports), 0) AS n, COUNT(*) AS c FROM drops d JOIN batches b ON b.id = d.batch_id
       WHERE b.status = 'live' AND d.status IN ('hidden', 'paying')`,
    );
    const free = this.available();
    const auto = this.autoConfig();
    const recent = this.sql(
      `SELECT c.lamports, c.settled_at AS ts, c.sig, c.address, b.area, b.name FROM claims c JOIN batches b ON b.id = c.batch_id
       WHERE c.status = 'paid' ORDER BY c.settled_at DESC, c.id DESC LIMIT 12`,
    ).all();
    return {
      treasury: this.chain.address,
      practice: !!this.chain.mock,
      balance: this.balance,
      feesIn: one(`SELECT COALESCE(SUM(lamports), 0) AS n FROM ledger WHERE kind = 'fee_in'`).n,
      hidden: one('SELECT COALESCE(SUM(lamports), 0) AS n FROM drops').n,
      claimed: claimed.n,
      claimedCount: claimed.c,
      waiting: waiting.n,
      waitingCount: waiting.c,
      pending: free === null ? null : Math.max(0, free),
      nextBatchAt: auto.enabled ? auto.nextAt : null,
      recent: recent.map((r) => ({ lamports: r.lamports, ts: r.ts, sig: r.sig, who: short(r.address), area: r.area || r.name })),
    };
  }

  async me(address, visitor = '') {
    if (!isAddress(address)) throw new GameError('bad_address', 'That is not a Solana address.');
    const { tier, balance } = await this.tierSoon(address, { visitor });
    let kind = address === this.cfg.tokenMint ? 'token' : 'unknown';
    if (kind === 'unknown' && (this.plainWallets.has(address) || this.mayLookUp(visitor, this.now()))) {
      kind = await soon(this.walletKind(address).catch(() => 'unknown'), this.patienceMs, () => 'unknown');
    }
    const claims = this.sql(
      `SELECT c.lamports, c.settled_at AS ts, c.sig, d.tier, d.gold, b.area, b.name FROM claims c
       JOIN drops d ON d.id = c.drop_id JOIN batches b ON b.id = c.batch_id
       WHERE c.address = ? AND c.status = 'paid' ORDER BY c.settled_at DESC, c.id DESC LIMIT 100`,
    ).all(address);
    return {
      address, tier, balance, kind,
      hint: kind === 'wallet' || kind === 'unknown' ? '' : NOT_A_WALLET[kind] || NOT_A_WALLET.other,
      total: claims.reduce((sum, c) => sum + c.lamports, 0),
      claims: claims.map((c) => ({ lamports: c.lamports, ts: c.ts, sig: c.sig, tier: c.tier, gold: !!c.gold, area: c.area || c.name })),
    };
  }

  /** Everything the admin console shows. */
  overview() {
    const batches = this.sql('SELECT id FROM batches ORDER BY id DESC LIMIT 60').all().map((b) => this.batchSummary(b.id));
    const claims = this.sql(
      `SELECT c.id, c.address, c.device, c.ip, c.dist, c.acc, c.lamports, c.status, c.sig, c.error, c.created_at AS ts, b.name FROM claims c
       JOIN batches b ON b.id = c.batch_id ORDER BY c.id DESC LIMIT 80`,
    ).all();
    const free = this.available();
    return {
      treasury: this.chain.address,
      practice: !!this.chain.mock,
      paused: this.paused,
      balance: this.balance,
      outstanding: this.outstanding(),
      available: free,
      reserve: this.cfg.reserveLamports,
      tierValues: this.cfg.tierValues,
      auto: this.autoConfig(),
      batches,
      claims: claims.map((c) => ({ ...c, device: c.device.slice(0, 8), dist: c.dist === null ? null : Math.round(c.dist) })),
    };
  }
}
