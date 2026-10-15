import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { b58encode } from '../server/base58.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/store.js';
import { Game } from '../server/game.js';
import { MockChain, generateKeypair } from '../server/solana.js';
import { offsetM, seededRandom } from '../server/geo.js';

export const SOL = 1e9;
export const HERE = { lat: 35.6702, lng: 139.7027 }; // Yoyogi Park
export const quiet = { info() {}, warn() {}, error() {} };
export const wallet = () => generateKeypair().address;
export const east = (point, metres) => offsetM(point, metres, 0);

/** A game with a pretend chain, an in-memory database and a clock the test controls. */
export function makeGame({ balance = 100 * SOL, env = {}, seed = 'test' } = {}) {
  const cfg = loadConfig({ ADMIN_TOKEN: 'secret-admin', SERVER_SECRET: 'unit-test', TOKEN_MINT: generateKeypair().address, DROP_FUZZ_M: '12', ...env });
  const clock = { t: Date.UTC(2026, 9, 17, 1, 0, 0) };
  const chain = new MockChain({ balance });
  const game = new Game({ db: openDb(':memory:'), chain, cfg, now: () => clock.t, log: quiet, random: seededRandom(seed) });
  return { game, chain, cfg, clock };
}

/** One batch with a single drop exactly at `at`, so tests know where it is. */
export function oneDrop(game, { at = HERE, tier = 'm', gold = 0, startsIn = 0, hours = 6, onePerPerson = true } = {}) {
  const now = game.now();
  const batch = game.createBatch({
    name: 'Test drop', area: 'Yoyogi Park', lat: at.lat, lng: at.lng, radiusM: 10,
    counts: { s: tier === 's' ? 1 : 0, m: tier === 'm' ? 1 : 0, l: tier === 'l' ? 1 : 0 },
    startsAt: now + startsIn, endsAt: now + startsIn + hours * 3_600_000, onePerPerson,
  });
  const drop = game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').get(batch.id);
  game.db.prepare('UPDATE drops SET lat = ?, lng = ?, gold = ? WHERE id = ?').run(at.lat, at.lng, gold, drop.id);
  return { batch, dropId: drop.id };
}

/** Walks a device toward a point: a few believable position reports, a few seconds apart. */
export function walkTo(game, clock, device, target, { from = 80, steps = 4, seconds = 8 } = {}) {
  for (let i = steps; i >= 1; i--) {
    const p = east(target, (from * i) / steps);
    game.recordPing(device, p.lat, p.lng, 8);
    clock.t += seconds * 1000;
  }
}

export const claimAt = (game, { dropId, address, device, at, acc = 8, ip = '203.0.113.7' }) =>
  game.claim({ dropId, address, device, ip, lat: at.lat, lng: at.lng, acc });

/* ---------- a pretend Solana node that checks transactions the way a real one would ---------- */

/**
 * Decodes a raw transaction independently of the code that built it, verifies its signature,
 * and returns the SOL transfer inside. Throws if anything is off.
 */
export function decodeTransfer(raw) {
  let o = 0;
  const shortvec = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = raw[o++];
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
    }
  };
  assert.equal(shortvec(), 1, 'one signature');
  const signature = raw.subarray(o, (o += 64));
  const message = raw.subarray(o);
  const [signers, readOnlySigners, readOnlyOthers] = [raw[o++], raw[o++], raw[o++]];
  assert.deepEqual([signers, readOnlySigners], [1, 0]);
  const keys = Array.from({ length: shortvec() }, () => raw.subarray(o, (o += 32)));
  const firstReadOnly = keys.length - readOnlyOthers;
  o += 32; // recent blockhash
  let transfer = null;
  let cuLimit = 200_000;
  let cuPrice = 0;
  const count = shortvec();
  for (let i = 0; i < count; i++) {
    const programIndex = raw[o++];
    const program = b58encode(keys[programIndex]);
    assert.ok(programIndex >= firstReadOnly, 'programs are read-only accounts');
    const accounts = [...raw.subarray(o + 1, o + 1 + raw[o])];
    o += 1 + accounts.length;
    const data = raw.subarray(o + 1, o + 1 + raw[o]);
    o += 1 + data.length;
    if (program === '11111111111111111111111111111111') {
      assert.equal(data.length, 12);
      assert.equal(data.readUInt32LE(0), 2, 'System program: Transfer');
      assert.equal(accounts[0], 0, 'the payer is the signer');
      assert.ok(accounts[1] < firstReadOnly, 'the recipient is writable');
      assert.equal(transfer, null, 'exactly one transfer');
      transfer = { from: b58encode(keys[accounts[0]]), to: b58encode(keys[accounts[1]]), lamports: Number(data.readBigUInt64LE(4)) };
    } else if (program === 'ComputeBudget111111111111111111111111111111') {
      if (data[0] === 2) cuLimit = data.readUInt32LE(1);
      else if (data[0] === 3) cuPrice = Number(data.readBigUInt64LE(1));
      else assert.fail(`unexpected compute budget instruction ${data[0]}`);
    } else assert.fail(`unexpected program ${program}`);
  }
  assert.equal(o, raw.length, 'no bytes left over');
  assert.ok(transfer, 'has a transfer');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keys[0]]);
  assert.ok(crypto.verify(null, message, crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature), 'the signature is valid for the payer');
  return { ...transfer, signature: b58encode(signature), fee: 5000 + Math.ceil((cuPrice * cuLimit) / 1_000_000) };
}

/** Balances, token holdings and a block height, behind the same JSON-RPC calls the app makes. */
export function fakeNode() {
  // kinds: address -> { executable, owner } for accounts that are not plain wallets. swallow: accept transactions but never land them.
  const node = { height: 1000, balances: new Map(), holdings: new Map(), firstUsed: new Map(), kinds: new Map(), landed: new Map(), calls: [], swallow: false };
  node.fetchImpl = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    node.calls.push(method);
    node.height++;
    const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) });
    const refuse = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, error: { code: -32002, message } }) });
    if (method === 'getBalance') return reply({ context: { slot: node.height }, value: node.balances.get(params[0]) || 0 });
    if (method === 'getLatestBlockhash') return reply({ value: { blockhash: b58encode(crypto.randomBytes(32)), lastValidBlockHeight: node.height + 150 } });
    if (method === 'getBlockHeight') return reply(node.height);
    if (method === 'getSignatureStatuses') return reply({ value: params[0].map((s) => (node.landed.has(s) ? { slot: node.landed.get(s).slot, confirmationStatus: 'confirmed', err: null } : null)) });
    if (method === 'getTokenSupply') return reply({ value: { uiAmountString: '1000000000', decimals: 6 } });
    if (method === 'getAccountInfo') {
      const special = node.kinds.get(params[0]);
      if (special) return reply({ value: { executable: !!special.executable, owner: special.owner, lamports: 1, data: ['', 'base64'] } });
      return reply({ value: node.balances.has(params[0]) ? { executable: false, owner: '11111111111111111111111111111111', lamports: node.balances.get(params[0]), data: ['', 'base64'] } : null });
    }
    if (method === 'getSignaturesForAddress') {
      const first = node.firstUsed.get(params[0]);
      return reply(first === undefined ? [] : [{ signature: 'newest', blockTime: Math.floor(Date.now() / 1000) }, { signature: 'oldest', blockTime: Math.floor(first / 1000) }]);
    }
    if (method === 'getTokenAccountsByOwner') {
      const held = node.holdings.get(params[0]) || 0;
      return reply({ value: held ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: String(held), uiAmount: held } } } } } }] : [] });
    }
    if (method === 'sendTransaction' || method === 'simulateTransaction') {
      const t = decodeTransfer(Buffer.from(params[0], 'base64'));
      const short = (node.balances.get(t.from) || 0) < t.lamports + t.fee;
      if (method === 'simulateTransaction') return reply({ value: { err: short ? 'AccountNotFound' : null } });
      if (short) return refuse('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.');
      if (node.swallow) return reply(t.signature);
      if (!node.landed.has(t.signature)) {
        node.balances.set(t.from, node.balances.get(t.from) - t.lamports - t.fee);
        node.balances.set(t.to, (node.balances.get(t.to) || 0) + t.lamports);
        node.landed.set(t.signature, { ...t, slot: node.height });
      }
      return reply(t.signature);
    }
    throw new Error(`the app made an RPC call the test does not know: ${method}`);
  };
  return node;
}
