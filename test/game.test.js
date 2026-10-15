import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainError, MockChain } from '../server/solana.js';
import { distanceM } from '../server/geo.js';
import { loadConfig } from '../server/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openDbFor } from '../server/store.js';
import { Game } from '../server/game.js';
import { SOL, HERE, makeGame, oneDrop, walkTo, claimAt, wallet, east, quiet } from './helpers.js';

const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));

test('an amount is split into small, mid and big drops', () => {
  const { game } = makeGame();
  assert.deepEqual(game.planDrops({ totalLamports: 100 * SOL }).counts, { s: 900, m: 90, l: 10 });
  assert.deepEqual(game.planDrops({ totalLamports: 10 * SOL }).counts, { s: 90, m: 9, l: 1 });
  const odd = game.planDrops({ totalLamports: 12.6 * SOL });
  assert.deepEqual(odd.counts, { s: 122, m: 11, l: 1 });
  assert.equal(odd.total, 12.6 * SOL);
  assert.equal(game.planDrops({ totalLamports: 0.04 * SOL }).drops.length, 0);
  const gold = game.planDrops({ totalLamports: 100 * SOL, goldShare: 0.2 });
  assert.equal(gold.gold, 20);
  assert.ok(gold.drops.filter((d) => d.gold).every((d) => d.tier !== 's'), 'small drops are never holder-only');
});

test('a batch needs free money in the treasury and scatters drops inside its circle', () => {
  const { game } = makeGame({ balance: 10 * SOL });
  assert.throws(() => game.createBatch({ name: 'x', lat: HERE.lat, lng: HERE.lng, radiusM: 300, totalSol: 5, endsAt: game.now() + 1e6 }), (e) => e.code === 'funds' && e.status === 503);
  return game.watchTreasury().then(() => {
    assert.throws(() => game.createBatch({ name: 'Too big', lat: HERE.lat, lng: HERE.lng, radiusM: 300, totalSol: 11, endsAt: game.now() + 1e6 }), (e) => e.code === 'funds');
    const batch = game.createBatch({ name: 'Fits', area: 'Harajuku', lat: HERE.lat, lng: HERE.lng, radiusM: 300, totalSol: 5, endsAt: game.now() + 1e6 });
    assert.equal(batch.totalLamports, 5 * SOL);
    const drops = game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').all(batch.id);
    assert.equal(drops.length, batch.drops);
    assert.ok(drops.every((d) => distanceM(HERE, d) <= 300.5));
    assert.equal(game.available(), 10 * SOL - 5 * SOL - game.cfg.reserveLamports);
    assert.throws(() => game.createBatch({ name: 'No room left', lat: HERE.lat, lng: HERE.lng, radiusM: 300, totalSol: 5, endsAt: game.now() + 1e6 }), (e) => e.code === 'funds');
    for (const bad of [{ name: '' }, { radiusM: 5 }, { lat: 120 }, { endsAt: game.now() - 1 }, { totalSol: 0 }]) {
      assert.throws(() => game.createBatch({ name: 'x', lat: HERE.lat, lng: HERE.lng, radiusM: 300, totalSol: 1, endsAt: game.now() + 1e6, ...bad }), (e) => e.code === 'bad_batch');
    }
  });
});

test('a hunter who walks to the drop gets paid, once', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const { dropId, batch } = oneDrop(game);
  const address = wallet();
  walkTo(game, clock, 'device-aaaaaaaa', HERE);
  const result = await claimAt(game, { dropId, address, device: 'device-aaaaaaaa', at: east(HERE, 6) });
  assert.equal(result.lamports, 0.5 * SOL);
  assert.equal(chain.sent.length, 1);
  assert.deepEqual({ to: chain.sent[0].to, lamports: chain.sent[0].lamports }, { to: address, lamports: 0.5 * SOL });
  assert.equal(result.signature, chain.sent[0].signature);
  const drop = game.db.prepare('SELECT * FROM drops WHERE id = ?').get(dropId);
  assert.equal(drop.status, 'claimed');
  assert.equal(drop.claimed_by, address);
  assert.equal(game.batchSummary(batch.id).left, 0);
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'device-bbbbbbbb', at: HERE }), 'gone');
  const mine = await game.me(address);
  assert.equal(mine.total, 0.5 * SOL);
  assert.equal(mine.claims[0].sig, result.signature);
  const stats = game.stats();
  assert.equal(stats.claimed, 0.5 * SOL);
  assert.equal(stats.recent[0].sig, result.signature);
  assert.ok(!stats.recent[0].who.includes(address), 'full addresses are not published');
});

test('claims are refused when the hunter is not really there', async () => {
  const { game, clock } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const address = wallet();
  const device = 'device-cccccccc';
  await rejects(claimAt(game, { dropId, address: 'nope', device, at: HERE }), 'bad_address');
  await rejects(claimAt(game, { dropId, address: game.chain.address, device, at: HERE }), 'bad_address');
  await rejects(game.claim({ dropId, address, device, ip: '1.1.1.1', lat: NaN, lng: NaN, acc: 5 }), 'no_location');
  await rejects(claimAt(game, { dropId: 9999, address, device, at: HERE }), 'no_drop');
  await rejects(claimAt(game, { dropId, address, device, at: HERE, acc: 200 }), 'gps_weak');
  const far = await claimAt(game, { dropId, address, device, at: east(HERE, 46) }).catch((e) => e);
  assert.equal(far.code, 'too_far');
  assert.equal(far.extra.dist, 46);
  assert.equal(far.extra.reach, 30);
  // standing on the spot with no history: must wait
  await rejects(claimAt(game, { dropId, address, device: 'device-dddddddd', at: HERE }), 'trail');
  // a position that jumps across town is thrown out
  const jumper = 'device-eeeeeeee';
  game.recordPing(jumper, HERE.lat + 0.05, HERE.lng, 8);
  clock.t += 10_000;
  game.recordPing(jumper, HERE.lat, HERE.lng, 8);
  clock.t += 15_000;
  await rejects(claimAt(game, { dropId, address, device: jumper, at: HERE }), 'teleport');
  // after the reset they have to build a believable trail again
  await rejects(claimAt(game, { dropId, address, device: jumper, at: HERE }), 'trail');
  clock.t += 12_000;
  game.recordPing(jumper, HERE.lat, HERE.lng, 8);
  clock.t += 12_000;
  assert.equal((await claimAt(game, { dropId, address, device: jumper, at: HERE })).lamports, 0.5 * SOL);
});

test('one drop per person per batch, by wallet and by phone', async () => {
  const { game, clock } = makeGame();
  await game.watchTreasury();
  const batch = game.createBatch({ name: 'Three', lat: HERE.lat, lng: HERE.lng, radiusM: 15, counts: { s: 3 }, endsAt: game.now() + 1e7 });
  const ids = game.db.prepare('SELECT id FROM drops WHERE batch_id = ?').all(batch.id).map((d) => d.id);
  for (const id of ids) game.db.prepare('UPDATE drops SET lat = ?, lng = ? WHERE id = ?').run(HERE.lat, HERE.lng, id);
  const a = wallet();
  walkTo(game, clock, 'phone-one-1111', HERE);
  await claimAt(game, { dropId: ids[0], address: a, device: 'phone-one-1111', at: HERE });
  await rejects(claimAt(game, { dropId: ids[1], address: a, device: 'phone-one-1111', at: HERE }), 'one_per_person');
  walkTo(game, clock, 'phone-two-2222', HERE);
  await rejects(claimAt(game, { dropId: ids[1], address: a, device: 'phone-two-2222', at: HERE }), 'one_per_person'); // same wallet, new phone
  await rejects(claimAt(game, { dropId: ids[1], address: wallet(), device: 'phone-one-1111', at: HERE }), 'one_per_person'); // same phone, new wallet
  assert.equal(game.db.prepare(`SELECT status FROM drops WHERE id = ?`).get(ids[1]).status, 'hidden', 'a refused claim leaves the drop in place');
  assert.equal((await claimAt(game, { dropId: ids[1], address: wallet(), device: 'phone-two-2222', at: HERE })).lamports, 0.05 * SOL);
  assert.equal(game.sync({ ...HERE, device: 'phone-one-1111', address: a }).batches[0].done, true);
  // a batch can allow several per person
  const open = oneDrop(game, { onePerPerson: false });
  assert.equal((await claimAt(game, { dropId: open.dropId, address: a, device: 'phone-one-1111', at: HERE })).lamports, 0.5 * SOL);
});

test('two people grabbing the same drop at the same moment: exactly one is paid', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game, { tier: 'l' });
  walkTo(game, clock, 'racer-one-1111', HERE);
  walkTo(game, clock, 'racer-two-2222', HERE);
  const results = await Promise.allSettled([
    claimAt(game, { dropId, address: wallet(), device: 'racer-one-1111', at: HERE }),
    claimAt(game, { dropId, address: wallet(), device: 'racer-two-2222', at: HERE }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'gone');
  assert.equal(chain.sent.length, 1);
});

test('holder perks: head start, holder-only drops, longer reach', async () => {
  const { game, chain, clock, cfg } = makeGame();
  await game.watchTreasury();
  const none = wallet(), t1 = wallet(), t2 = wallet(), t3 = wallet();
  chain.holdings.set(t1, 100_000).set(t2, 1_000_000).set(t3, 5_000_000);
  assert.deepEqual((await Promise.all([none, t1, t2, t3].map((a) => game.tierOf(a)))).map((t) => t.tier), [0, 1, 2, 3]);

  // head start: the batch opens in 10 minutes, tier 1 gets in 15 minutes early
  const soon = oneDrop(game, { startsIn: 10 * 60_000 });
  assert.equal(game.sync({ ...HERE, device: 'dev-none-0000', address: none, tier: 0 }).drops.length, 0);
  assert.equal(game.sync({ ...HERE, device: 'dev-tier-1111', address: t1, tier: 1 }).drops.length, 1);
  assert.equal(game.sync({ ...HERE, device: 'dev-tier-1111', address: t1, tier: 1 }).batches[0].early, true);
  walkTo(game, clock, 'dev-none-0000', HERE);
  walkTo(game, clock, 'dev-tier-1111', HERE);
  await rejects(claimAt(game, { dropId: soon.dropId, address: none, device: 'dev-none-0000', at: HERE }), 'not_live');
  assert.equal((await claimAt(game, { dropId: soon.dropId, address: t1, device: 'dev-tier-1111', at: HERE })).lamports, 0.5 * SOL);

  // holder-only drops need tier 2
  const gold = oneDrop(game, { gold: 1, tier: 'l' });
  const seen = game.sync({ ...HERE, device: 'dev-none-0000', address: none, tier: 0 }).drops.find((d) => d.id === gold.dropId);
  assert.deepEqual({ gold: seen.gold, locked: seen.locked }, { gold: true, locked: true });
  assert.equal(game.sync({ ...HERE, device: 'dev-tier-2222', address: t2, tier: 2 }).drops.find((d) => d.id === gold.dropId).locked, false);
  await rejects(claimAt(game, { dropId: gold.dropId, address: none, device: 'dev-none-0000', at: HERE }), 'holders_only');
  await rejects(claimAt(game, { dropId: gold.dropId, address: t1, device: 'dev-tier-1111', at: HERE }), 'holders_only');
  walkTo(game, clock, 'dev-tier-2222', HERE);
  assert.equal((await claimAt(game, { dropId: gold.dropId, address: t2, device: 'dev-tier-2222', at: HERE })).gold, true);

  // tier 3 claims from 50 m, everyone else from 30 m
  const reach = oneDrop(game);
  assert.equal(game.sync({ ...HERE, device: 'x', address: t3, tier: 3 }).reach, cfg.reachTopM);
  walkTo(game, clock, 'dev-none-0000', east(HERE, 44));
  walkTo(game, clock, 'dev-tier-3333', east(HERE, 44));
  await rejects(claimAt(game, { dropId: reach.dropId, address: none, device: 'dev-none-0000', at: east(HERE, 44) }), 'too_far');
  assert.equal((await claimAt(game, { dropId: reach.dropId, address: t3, device: 'dev-tier-3333', at: east(HERE, 44) })).lamports, 0.5 * SOL);
});

test('the map shows a nearby spot until the hunter is close', async () => {
  const { game } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const from = (metres) => game.sync({ ...east(HERE, metres), device: 'dev-look-0000', address: '' }).drops.find((d) => d.id === dropId);
  const far = from(200);
  assert.equal(far.exact, false);
  const shift = distanceM(far, HERE);
  assert.ok(shift > 0 && shift <= 12.5, `shown ${shift.toFixed(1)} m from the true spot`);
  assert.deepEqual(from(200), far, 'the shifted position is stable');
  const near = from(20);
  assert.equal(near.exact, true);
  assert.ok(distanceM(near, HERE) < 0.2);
  assert.equal(game.sync({ lat: NaN, lng: NaN, device: 'dev-look-0000' }).drops.length, 0, 'no location, no pins');
  assert.equal(game.sync({ lat: NaN, lng: NaN }).batches.length, 1, 'but the live batch is still listed');
  assert.equal(game.sync({ ...east(HERE, 9000), device: 'dev-look-0000' }).drops.length, 0, 'drops far away are not sent');
});

test('a payout that failed before anything was signed puts the drop straight back', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const address = wallet();
  walkTo(game, clock, 'dev-retry-0000', HERE);
  chain.failWith = Object.assign(new ChainError('Could not start the payout: RPC unreachable', { code: 'no_blockhash' }), { early: true });
  const failed = await claimAt(game, { dropId, address, device: 'dev-retry-0000', at: HERE }).catch((e) => e);
  assert.equal(failed.code, 'payout_failed');
  assert.match(failed.message, /try again/);
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(dropId).status, 'hidden');
  assert.equal(chain.sent.length, 0);
  assert.equal((await claimAt(game, { dropId, address, device: 'dev-retry-0000', at: HERE })).lamports, 0.5 * SOL);
});

test('a payout that was signed but never confirmed keeps its drop off the map until the chain clears it', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  chain.blockHeight = async () => 500;
  const { dropId } = oneDrop(game);
  const status = () => game.db.prepare('SELECT status FROM drops WHERE id = ?').get(dropId).status;
  const a = wallet();
  walkTo(game, clock, 'dev-held-00000', HERE);
  chain.failWith = new ChainError('Payout rejected: node says no', { code: -32002 });
  const refused = await claimAt(game, { dropId, address: a, device: 'dev-held-00000', at: HERE }).catch((e) => e);
  assert.equal(refused.code, 'payout_failed');
  assert.equal(refused.extra.held, true);
  assert.match(refused.message, /half an hour/);
  assert.equal(status(), 'held');
  // nobody can take it meanwhile, it is not on the map, and its money stays spoken for
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-held-11111', at: HERE }), 'held');
  await rejects(claimAt(game, { dropId, address: a, device: 'dev-held-00000', at: HERE }), 'held');
  assert.equal(game.sync({ ...HERE, device: 'dev-held-11111', address: '' }).drops.length, 0);
  assert.equal(game.outstanding(), 0.5 * SOL);
  // second looks during the half hour find nothing
  clock.t += 10 * 60_000;
  assert.equal(await game.reconcile(), 0);
  assert.equal(status(), 'held');
  // when the time is up but the chain cannot answer, the drop is not released on a guess
  clock.t += 21 * 60_000;
  const statuses = chain.signatureStatuses.bind(chain);
  chain.signatureStatuses = async () => {
    throw new Error('rpc down');
  };
  await game.reconcile();
  assert.equal(status(), 'held');
  chain.signatureStatuses = statuses;
  await game.reconcile();
  assert.equal(status(), 'hidden', 'cleared by the chain: back on the map');
  assert.equal(game.sync({ ...HERE, device: 'dev-held-11111', address: '' }).drops.length, 1);
  // the hunter whose payout failed can come back for it
  walkTo(game, clock, 'dev-held-00000', HERE);
  assert.equal((await claimAt(game, { dropId, address: a, device: 'dev-held-00000', at: HERE })).lamports, 0.5 * SOL);
  assert.equal(chain.sent.length, 1);

  // a batch that ends while one of its drops is held: the drop is retired afterwards, not hidden again
  const late = oneDrop(game, { hours: 1 });
  walkTo(game, clock, 'dev-held-22222', HERE);
  chain.failWith = new ChainError('Payout rejected: node says no', { code: -32002 });
  await rejects(claimAt(game, { dropId: late.dropId, address: wallet(), device: 'dev-held-22222', at: HERE }), 'payout_failed');
  clock.t += 61 * 60_000;
  game.expireBatches();
  assert.equal(game.outstanding(), 0.5 * SOL, 'still spoken for while it is being checked');
  await game.reconcile();
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(late.dropId).status, 'expired');
  assert.equal(game.outstanding(), 0);
});

test('a payout with an unknown outcome is settled later, never paid twice', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  // it landed, but we lost the connection before seeing it
  const first = oneDrop(game);
  const a = wallet();
  walkTo(game, clock, 'dev-lost-00000', HERE);
  chain.failWith = Object.assign(new ChainError('Payout status unknown', { uncertain: true }), { landed: true });
  const pending = await claimAt(game, { dropId: first.dropId, address: a, device: 'dev-lost-00000', at: HERE }).catch((e) => e);
  assert.equal(pending.code, 'pending');
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(first.dropId).status, 'paying');
  await rejects(claimAt(game, { dropId: first.dropId, address: wallet(), device: 'dev-other-0000', at: HERE }), 'gone');
  assert.equal(await game.reconcile(), 0, 'too soon to judge');
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1);
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(first.dropId).status, 'claimed');
  assert.equal((await game.me(a)).total, 0.5 * SOL);
  assert.equal(await game.reconcile(), 0);

  // it never landed and its window passed: the claim is closed, and the drop comes back after its half hour of checks
  const second = oneDrop(game);
  const b = wallet();
  walkTo(game, clock, 'dev-drop-00000', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId: second.dropId, address: b, device: 'dev-drop-00000', at: HERE }), 'pending');
  chain.blockHeight = async () => 500;
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1);
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(second.dropId).status, 'held');
  assert.equal(game.sync({ ...HERE, device: 'dev-drop-00000', address: b }).batches.find((x) => x.id === second.batch.id).done, false, 'the hunter is free to find another');
  clock.t += 31 * 60_000;
  await game.reconcile();
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(second.dropId).status, 'hidden');
  assert.equal(chain.sent.length, 1, 'only the first payout ever happened');

  // a payout with no expiry on record, which the chain never hears of, is closed after ten minutes rather than never
  const third = oneDrop(game);
  walkTo(game, clock, 'dev-drop-11111', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId: third.dropId, address: wallet(), device: 'dev-drop-11111', at: HERE }), 'pending');
  game.db.prepare('UPDATE claims SET last_valid_height = NULL WHERE drop_id = ?').run(third.dropId);
  clock.t += 5 * 60_000;
  assert.equal(await game.reconcile(), 0);
  clock.t += 6 * 60_000;
  assert.equal(await game.reconcile(), 1);
  // and one the chain cannot tell us anything about for a whole day is closed for good, its drop out of the game
  const fourth = oneDrop(game, { hours: 48 });
  walkTo(game, clock, 'dev-drop-22222', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId: fourth.dropId, address: wallet(), device: 'dev-drop-22222', at: HERE }), 'pending');
  const ask = chain.signatureStatus.bind(chain);
  chain.signatureStatus = async () => {
    throw new Error('this node keeps no history');
  };
  clock.t += 23 * 3_600_000;
  assert.equal(await game.reconcile(), 0);
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(fourth.dropId).status, 'paying');
  clock.t += 2 * 3_600_000;
  assert.equal(await game.reconcile(), 1);
  chain.signatureStatus = ask;
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(fourth.dropId).status, 'expired');
  assert.match(game.db.prepare('SELECT error FROM claims WHERE drop_id = ?').get(fourth.dropId).error, /24 hours/);
});

test('limits: per network, treasury empty, ended batches', async () => {
  const { game, chain, clock } = makeGame({ env: { CLAIMS_PER_IP_PER_DAY: '2' } });
  await game.watchTreasury();
  const drops = [oneDrop(game), oneDrop(game), oneDrop(game)];
  for (let i = 0; i < 3; i++) {
    const device = `dev-ip-limit-${i}`;
    walkTo(game, clock, device, HERE);
    const attempt = claimAt(game, { dropId: drops[i].dropId, address: wallet(), device, at: HERE, ip: '198.51.100.9' });
    if (i < 2) await attempt;
    else await rejects(attempt, 'ip_limit');
  }
  walkTo(game, clock, 'dev-other-net0', HERE);
  await claimAt(game, { dropId: drops[2].dropId, address: wallet(), device: 'dev-other-net0', at: HERE, ip: '198.51.100.77' });

  const last = oneDrop(game);
  walkTo(game, clock, 'dev-empty-0000', HERE);
  game.balance = 1000;
  await rejects(claimAt(game, { dropId: last.dropId, address: wallet(), device: 'dev-empty-0000', at: HERE }), 'treasury_empty');
  await game.watchTreasury();
  clock.t += 7 * 3_600_000;
  walkTo(game, clock, 'dev-empty-0000', HERE);
  await rejects(claimAt(game, { dropId: last.dropId, address: wallet(), device: 'dev-empty-0000', at: HERE }), 'not_live');
  assert.equal(game.expireBatches(), 4, 'all four batches have run out by now');
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(last.dropId).status, 'expired');
  await rejects(claimAt(game, { dropId: last.dropId, address: wallet(), device: 'dev-empty-0000', at: HERE }), 'gone');
  assert.equal(chain.sent.length, 3);
});

test('the fee counter: money arriving is counted in, payouts are not counted out twice', async () => {
  const { game, chain, clock } = makeGame({ balance: 10 * SOL });
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 10 * SOL, 'what is in the wallet at the start counts as fees in');
  const { dropId } = oneDrop(game);
  walkTo(game, clock, 'dev-fees-00000', HERE);
  await claimAt(game, { dropId, address: wallet(), device: 'dev-fees-00000', at: HERE });
  await game.watchTreasury();
  let s = game.stats();
  assert.deepEqual([s.feesIn, s.claimed, s.hidden], [10 * SOL, 0.5 * SOL, 0.5 * SOL]);
  assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind = 'adjust'`).get().n, 0, 'a payout is not mistaken for a withdrawal');
  clock.t += 60_000;
  chain.balance += 3.25 * SOL; // creator fees land
  await game.watchTreasury();
  s = game.stats();
  assert.equal(s.feesIn, 13.25 * SOL);
  assert.equal(s.pending, chain.balance - game.cfg.reserveLamports, 'everything not in a live drop is waiting for the next batch');
  chain.balance -= 2 * SOL; // the owner moves money out by hand
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 13.25 * SOL);
  assert.equal(game.db.prepare(`SELECT lamports FROM ledger WHERE kind = 'adjust'`).get().lamports, -2 * SOL);
});

test('scheduled fee drops: on time, within the budget, never twice', async () => {
  const { game, chain, clock } = makeGame({ balance: 30 * SOL });
  await game.watchTreasury();
  assert.deepEqual(game.autoTick(), []);
  const auto = game.setAuto({ enabled: true, everyHours: 6, durationHours: 6, minSol: 1, maxSol: 20, goldShare: 0.25, areas: [{ name: 'Shibuya', lat: 35.6595, lng: 139.7005, radiusM: 400 }, { name: 'Harajuku', lat: HERE.lat, lng: HERE.lng, radiusM: 300 }, { name: 'bad', lat: 999, lng: 0, radiusM: 100 }] });
  assert.equal(auto.areas.length, 2);
  assert.equal(new Date(auto.nextAt).getUTCHours() % 6, 0);
  assert.ok(auto.nextAt > clock.t);
  assert.deepEqual(game.autoTick(), [], 'not due yet');
  clock.t = auto.nextAt + 5000;
  const made = game.autoTick();
  assert.equal(made.length, 2);
  assert.deepEqual(made.map((b) => [b.name, b.source, b.totalLamports]), [['Fee drop · Shibuya', 'fees', 10 * SOL], ['Fee drop · Harajuku', 'fees', 10 * SOL]]);
  assert.equal(made[0].startsAt, clock.t + game.cfg.earlyMin * 60_000, 'holders get their head start');
  assert.ok(made[0].gold > 0);
  assert.deepEqual(game.autoTick(), [], 'the same slot never fires twice');
  assert.equal(game.autoConfig().nextAt, auto.nextAt + 6 * 3_600_000);
  assert.equal(game.stats().nextBatchAt, auto.nextAt + 6 * 3_600_000);
  // next slot: only 10 SOL minus the reserve is free, which is still above the minimum
  clock.t = game.autoConfig().nextAt + 1000;
  assert.equal(game.autoTick().length, 2);
  // then nothing is left, so the slot is skipped without error
  clock.t = game.autoConfig().nextAt + 1000;
  assert.deepEqual(game.autoTick(), []);
  // unfound drops come back when their batch ends, and get hidden again
  game.expireBatches();
  clock.t = game.autoConfig().nextAt + 1000;
  game.expireBatches();
  assert.equal(game.autoTick().length, 2);
  assert.equal(game.setAuto({ enabled: false }).nextAt, null);
  assert.equal(chain.sent.length, 0);
});

test('asking again after a lost answer gives the same receipt, never a second payout', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const address = wallet();
  const device = 'dev-again-0000';
  walkTo(game, clock, device, HERE);
  const first = await claimAt(game, { dropId, address, device, at: HERE });
  const again = await claimAt(game, { dropId, address, device, at: HERE });
  assert.equal(again.signature, first.signature);
  assert.equal(again.lamports, first.lamports);
  assert.equal(again.repeat, true);
  assert.equal(chain.sent.length, 1);
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-else-00000', at: HERE }), 'gone');
  await rejects(claimAt(game, { dropId, address: wallet(), device, at: HERE }), 'gone'); // same phone, another wallet: no receipt for someone else's payout
  // while a payout is still being confirmed, the same hunter is told to wait, not that they lost it
  const second = oneDrop(game, { onePerPerson: false });
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId: second.dropId, address, device, at: HERE }), 'pending');
  await rejects(claimAt(game, { dropId: second.dropId, address, device, at: HERE }), 'pending');
  assert.equal(chain.sent.length, 1);
});

test('a payout written off as expired that landed after all is put right', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  chain.blockHeight = async () => 500;
  const dropStatus = (id) => game.db.prepare('SELECT status, claimed_by FROM drops WHERE id = ?').get(id);
  const lostPayout = async (dropId, address, device) => {
    walkTo(game, clock, device, HERE);
    chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
    await rejects(claimAt(game, { dropId, address, device, at: HERE }), 'pending');
    clock.t += 30_000;
    assert.equal(await game.reconcile(), 1, 'the node cannot see it and its window has passed: written off');
    assert.equal(dropStatus(dropId).status, 'held', 'but the drop stays off the map while we keep looking');
    return game.db.prepare(`SELECT * FROM claims WHERE drop_id = ? AND address = ?`).get(dropId, address);
  };
  const lands = (claim) => {
    chain.sent.push({ to: claim.address, lamports: claim.lamports, signature: claim.sig });
    chain.balance -= claim.lamports + claim.fee;
  };

  // the transfer shows up twenty minutes later: the drop is marked found, and never went back on the map
  const one = oneDrop(game);
  const a = wallet();
  const lostA = await lostPayout(one.dropId, a, 'dev-late-00000');
  clock.t += 20 * 60_000;
  assert.equal(await game.reconcile(), 0);
  lands(lostA);
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1);
  assert.deepEqual({ ...dropStatus(one.dropId) }, { status: 'claimed', claimed_by: a });
  assert.equal((await game.me(a)).total, 0.5 * SOL);
  assert.equal(await game.reconcile(), 0);
  clock.t += 40 * 60_000;
  await game.reconcile();
  assert.equal(dropStatus(one.dropId).status, 'claimed', 'and it stays found');

  // the hunter went on to find another drop of the batch before the first transfer showed up:
  // both payouts are real, so both are on the books
  const batch = game.createBatch({ name: 'Two', lat: HERE.lat, lng: HERE.lng, radiusM: 15, counts: { m: 2 }, endsAt: game.now() + 1e7 });
  const [d1, d2] = game.db.prepare('SELECT id FROM drops WHERE batch_id = ? ORDER BY id').all(batch.id).map((d) => d.id);
  for (const id of [d1, d2]) game.db.prepare('UPDATE drops SET lat = ?, lng = ? WHERE id = ?').run(HERE.lat, HERE.lng, id);
  const b = wallet();
  const lostB = await lostPayout(d1, b, 'dev-late-11111');
  walkTo(game, clock, 'dev-late-11111', HERE);
  assert.equal((await claimAt(game, { dropId: d2, address: b, device: 'dev-late-11111', at: HERE })).lamports, 0.5 * SOL);
  lands(lostB);
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1);
  assert.deepEqual([dropStatus(d1).claimed_by, dropStatus(d2).claimed_by], [b, b]);
  assert.deepEqual(game.db.prepare('SELECT status FROM claims WHERE address = ? ORDER BY id').all(b).map((r) => r.status), ['paid', 'paid']);
  assert.equal((await game.me(b)).total, 1 * SOL);

  // and the fee counter still matches the wallet: nothing shows up as an unexplained loss
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.balance, chain.balance);
  assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind = 'adjust'`).get().n, 0);
  assert.equal(chain.sent.length, 3);
});

test('a node slow to show a payout does not inflate the fee counter', async () => {
  const { game, chain, clock } = makeGame({ balance: 10 * SOL });
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  walkTo(game, clock, 'dev-stale-0000', HERE);
  const before = chain.slot;
  await claimAt(game, { dropId, address: wallet(), device: 'dev-stale-0000', at: HERE });
  const real = chain.balance;
  const live = chain.balanceAt.bind(chain);
  // the node answering is still at a point of the chain from before the payout, even a minute later
  chain.balanceAt = async () => ({ lamports: 10 * SOL, slot: before });
  for (const wait of [3000, 20_000, 60_000]) {
    clock.t += wait;
    await game.watchTreasury();
    assert.equal(game.stats().feesIn, 10 * SOL);
    assert.equal(game.balance, real, 'our own running total is kept meanwhile');
  }
  // the same after a restart: the first reading must not be one from before the last payout
  const restarted = new Game({ db: game.db, chain, cfg: game.cfg, now: () => clock.t, log: quiet });
  assert.equal(await restarted.watchTreasury(), null, 'an old answer is not taken for the balance');
  assert.throws(() => restarted.createBatch({ name: 'x', lat: HERE.lat, lng: HERE.lng, radiusM: 50, totalSol: 1, endsAt: clock.t + 1e6 }), (e) => e.code === 'funds' && e.status === 503);
  chain.balanceAt = live; // and then the node catches up
  assert.equal(await restarted.watchTreasury(), real);
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 10 * SOL);
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1, 'only the opening balance was ever recorded');

  // a node that does not say where in the chain it is: readings wait a little after each payout instead
  const second = oneDrop(game);
  walkTo(game, clock, 'dev-stale-1111', HERE);
  await claimAt(game, { dropId: second.dropId, address: wallet(), device: 'dev-stale-1111', at: HERE });
  const real2 = chain.balance;
  chain.balanceAt = async () => ({ lamports: real, slot: null });
  clock.t += 5000;
  await game.watchTreasury();
  assert.equal(game.balance, real2);
  chain.balanceAt = async () => ({ lamports: real2, slot: null });
  clock.t += 20_000;
  await game.watchTreasury();
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);

  // one nonsense slot number from the node does not shut readings out for good
  chain.balanceAt = async () => ({ lamports: real2, slot: 9e15 });
  clock.t += 60_000;
  await game.watchTreasury();
  chain.balanceAt = live;
  chain.balance += 2 * SOL;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 10 * SOL, 'for a few minutes the normal answers look old and are set aside');
  clock.t += 5 * 60_000;
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 12 * SOL, 'then readings carry on as before');
});

test('the wallet is still read while claims keep coming', async () => {
  const { game, chain, clock } = makeGame({ balance: 50 * SOL });
  await game.watchTreasury();
  // a claim every four seconds for five minutes, each confirmed within the second
  let seen = 0;
  for (let i = 0; i < 75; i++) {
    const { dropId } = oneDrop(game, { tier: 's', onePerPerson: false });
    const device = `dev-busy-${String(i).padStart(5, '0')}`;
    game.recordPing(device, HERE.lat, HERE.lng, 8);
    clock.t += 2000;
    game.recordPing(device, HERE.lat, HERE.lng, 8);
    clock.t += 2000;
    await claimAt(game, { dropId, address: wallet(), device, at: HERE }).catch((e) => assert.equal(e.code, 'trail'));
    if (i === 30) chain.balance += 4 * SOL; // fees arrive in the middle of it
    const read = game.lastReadAt;
    await game.watchTreasuryIfDue();
    if (game.lastReadAt !== read) seen++;
  }
  assert.ok(seen >= 3, `the wallet was read ${seen} times in five busy minutes`);
  assert.equal(game.stats().feesIn, 54 * SOL, 'and the fees that arrived were counted');
  assert.equal(game.balance, chain.balance);
});

test('someone who buys the token while standing at a holder drop gets in right away', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const gold = oneDrop(game, { gold: 1, tier: 'l' });
  const a = wallet();
  assert.equal((await game.tierOf(a)).tier, 0);
  walkTo(game, clock, 'dev-buyer-0000', HERE); // half a minute: well inside the time a balance is remembered
  chain.holdings.set(a, 2_000_000);
  assert.equal((await game.tierOf(a)).tier, 0, 'the remembered answer is still the old one');
  assert.equal((await claimAt(game, { dropId: gold.dropId, address: a, device: 'dev-buyer-0000', at: HERE })).gold, true);
  assert.equal((await game.tierOf(a)).tier, 2);
  // selling does not keep the perk for long either
  chain.holdings.set(a, 0);
  clock.t += 181_000;
  assert.equal((await game.tierOf(a)).tier, 0);
});

test('settings that would break payouts are refused at start-up', () => {
  assert.throws(() => loadConfig({ DROP_SIZES_SOL: '0.0005,0.5,1' }), /0\.001/);
  assert.throws(() => loadConfig({ DROP_SIZES_SOL: '1,0.5,0.05' }), /small to big/);
  assert.throws(() => loadConfig({ DROP_SIZES_SOL: '1,2' }), /three/);
  assert.throws(() => loadConfig({ TIER_LEVELS: '5,1,2' }), /low to high/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'javascript:alert(1)' }), /https/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'not a url' }), /PUBLIC_URL/);
  assert.equal(loadConfig({ PUBLIC_URL: 'https://solanago.app/' }).publicUrl, 'https://solanago.app');
  assert.equal(loadConfig({ PUBLIC_URL: 'https://solanago.app/"><script>' }).publicUrl, 'https://solanago.app');
  assert.equal(loadConfig({}).publicUrl, '');
});

test('the app makes its own secret once and keeps it', () => {
  const db = openDb(':memory:');
  const make = (database, env = {}) => new Game({ db: database, chain: new MockChain(), cfg: loadConfig(env), log: quiet });
  const one = make(db);
  assert.match(one.secret, /^[0-9a-f]{64}$/);
  assert.equal(make(db).secret, one.secret, 'the same after a restart');
  assert.notEqual(make(openDb(':memory:')).secret, one.secret, 'different for every install');
  assert.equal(make(db, { SERVER_SECRET: 'mine' }).secret, 'mine');
});

test('the pause switch stops every claim and nothing else', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const done = oneDrop(game, { onePerPerson: false });
  const address = wallet();
  walkTo(game, clock, 'dev-pause-0000', HERE);
  const receipt = await claimAt(game, { dropId: done.dropId, address, device: 'dev-pause-0000', at: HERE });
  assert.equal(game.paused, false);
  assert.equal(game.setPaused(true), true);
  await rejects(claimAt(game, { dropId, address, device: 'dev-pause-0000', at: HERE }), 'paused');
  assert.equal(chain.sent.length, 1);
  const seen = game.sync({ ...HERE, device: 'dev-pause-0000', address });
  assert.equal(seen.paused, true);
  assert.equal(seen.drops.length, 1, 'drops stay on the map');
  assert.equal((await claimAt(game, { dropId: done.dropId, address, device: 'dev-pause-0000', at: HERE })).signature, receipt.signature, 'a receipt for a payout already made is still given');
  assert.equal(new Game({ db: game.db, chain, cfg: game.cfg, log: quiet }).paused, true, 'and it stays paused across a restart');
  game.setPaused(false);
  assert.equal((await claimAt(game, { dropId, address, device: 'dev-pause-0000', at: HERE })).lamports, 0.5 * SOL);
});

test('one database belongs to one treasury wallet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solanago-db-'));
  const file = path.join(dir, 'game.db');
  const notes = [];
  const log = { ...quiet, warn: (m) => notes.push(m) };
  try {
    // practice first
    let db = openDbFor(file, 'practice', log);
    db.prepare(`INSERT INTO ledger(ts, kind, lamports, note) VALUES (1, 'fee_in', 25, 'play money')`).run();
    db.close();
    db = openDbFor(file, 'practice', log);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1, 'the same mode keeps its data');
    db.close();
    // going live: the practice records are set aside, not mixed in
    const live = wallet();
    db = openDbFor(file, live, log);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0, 'the live game starts with clean books');
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('game.db.practice-')).length, 1, 'and the practice file is kept on the side');
    assert.match(notes.join(' '), /set aside/);
    db.prepare(`INSERT INTO ledger(ts, kind, lamports, note) VALUES (2, 'fee_in', 7, 'real')`).run();
    db.close();
    db = openDbFor(file, live, log);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
    db.close();
    // losing the key, or swapping the wallet, must never quietly reuse real records
    assert.throws(() => openDbFor(file, 'practice', log), /TREASURY_SECRET_KEY is missing/);
    assert.throws(() => openDbFor(file, wallet(), log), new RegExp(`holds the records of treasury wallet ${live}`));
    db = openDbFor(file, live, log);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1, 'and the refused starts changed nothing');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database written by an earlier version still opens, and is brought up to date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solanago-old-'));
  const file = path.join(dir, 'game.db');
  const columns = (db) => db.prepare('PRAGMA table_info(drops)').all().map((col) => col.name);
  const indexes = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => row.name);
  try {
    // Make today's database look like the first version's: no hold column, no one-signature rule, and two claims
    // that break that rule already on record.
    let db = openDb(file);
    db.exec('DROP INDEX claims_one_sig; ALTER TABLE drops DROP COLUMN held_until;');
    db.exec(`INSERT INTO batches(name, lat, lng, radius_m, starts_at, ends_at, total_lamports, created_at) VALUES ('old', 1, 2, 50, 0, 9, 100, 0)`);
    db.exec(`INSERT INTO drops(batch_id, lat, lng, lamports, tier) VALUES (1, 1, 2, 50, 's'), (1, 1, 2, 50, 's')`);
    const claim = db.prepare(`INSERT INTO claims(drop_id, batch_id, address, device, ip, lamports, status, sig, created_at) VALUES (?, 1, ?, ?, 'x', 50, 'failed', 'same-signature', 0)`);
    claim.run(1, wallet(), 'old-device-0001');
    claim.run(2, wallet(), 'old-device-0002');
    assert.ok(!columns(db).includes('held_until') && !indexes(db).includes('claims_one_sig'));
    db.close();

    db = openDb(file); // must not throw, even though the one-signature rule cannot be switched on over those two rows
    assert.ok(columns(db).includes('held_until'), 'the hold column is added');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 2, 'nothing on record is lost');
    assert.ok(!indexes(db).includes('claims_one_sig'));
    const game = new Game({ db, chain: new MockChain({ balance: 5 * SOL }), cfg: loadConfig({ SERVER_SECRET: 'old' }), log: quiet });
    assert.equal(game.overview().claims.length, 2, 'and the game runs on it');
    db.close();

    // A healthy old database gets the rule the next time it opens.
    db = openDb(file);
    db.exec(`UPDATE claims SET sig = 'another-signature' WHERE id = 2`);
    db.close();
    db = openDb(file);
    assert.ok(indexes(db).includes('claims_one_sig'));
    assert.throws(() => db.exec(`UPDATE claims SET sig = 'same-signature' WHERE id = 2`), /UNIQUE/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MIN_WALLET_AGE_DAYS keeps out wallets made to collect twice', async () => {
  const { game, chain, clock } = makeGame({ env: { MIN_WALLET_AGE_DAYS: '7' } });
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const fresh = wallet();
  const young = wallet();
  const old = wallet();
  chain.firstUsed.set(young, clock.t - 2 * 86_400_000).set(old, clock.t - 30 * 86_400_000);
  for (const device of ['dev-age-fresh00', 'dev-age-young00', 'dev-age-old0000']) walkTo(game, clock, device, HERE);
  const tooNew = await claimAt(game, { dropId, address: fresh, device: 'dev-age-fresh00', at: HERE }).catch((e) => e);
  assert.equal(tooNew.code, 'wallet_new');
  assert.match(tooNew.message, /at least 7 days/);
  await rejects(claimAt(game, { dropId, address: young, device: 'dev-age-young00', at: HERE }), 'wallet_new');
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0, 'a refused wallet leaves no trace and the drop stays');
  // if the wallet cannot be checked, nobody is waved through
  const history = chain.walletHistory;
  chain.walletHistory = async () => {
    throw new Error('rpc down');
  };
  await rejects(claimAt(game, { dropId, address: old, device: 'dev-age-old0000', at: HERE }), 'busy');
  chain.walletHistory = history;
  assert.equal((await claimAt(game, { dropId, address: old, device: 'dev-age-old0000', at: HERE })).lamports, 0.5 * SOL);
  assert.equal(chain.sent.length, 1);
  // a very busy wallet counts as seasoned even if all we can see is recent
  chain.walletHistory = async () => ({ count: 1000, oldest: clock.t - 3_600_000 });
  assert.equal(await game.walletOldEnough(wallet()), true);
  // and the check is off unless asked for
  assert.equal(await makeGame().game.walletOldEnough(fresh), true);
});

test('a payout that landed is never undone by a problem writing it down', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const a = wallet();
  walkTo(game, clock, 'dev-book-00000', HERE);
  const settle = game.settle.bind(game);
  game.settle = () => {
    throw new Error('database is locked');
  };
  await rejects(claimAt(game, { dropId, address: a, device: 'dev-book-00000', at: HERE }), 'pending');
  game.settle = settle;
  assert.equal(chain.sent.length, 1, 'the transfer did happen');
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(dropId).status, 'paying', 'so the drop must not go back on the map');
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-book-11111', at: HERE }), 'gone');
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1, 'the reconciler books it from the chain');
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(dropId).status, 'claimed');
  assert.equal((await game.me(a)).total, 0.5 * SOL);
  assert.equal(chain.sent.length, 1);

  // an error nobody planned for is not proof that nothing was sent either
  const second = oneDrop(game, { onePerPerson: false });
  const transfer = chain.transfer.bind(chain);
  chain.transfer = async () => {
    throw new TypeError('something unexpected');
  };
  await rejects(claimAt(game, { dropId: second.dropId, address: a, device: 'dev-book-00000', at: HERE }), 'pending');
  chain.transfer = transfer;
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(second.dropId).status, 'paying');
  clock.t += 4 * 60_000;
  assert.equal(await game.reconcile(), 1, 'with no signature on record after three minutes, it was never sent');
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(second.dropId).status, 'hidden');
});

test('beyond the half hour: a drop paid by a late-seen payout still cannot be found twice', async () => {
  // These states need a node more than half an hour behind, so they are set up by hand.
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  chain.blockHeight = async () => 500;
  const { dropId } = oneDrop(game);
  const status = () => game.db.prepare('SELECT status, claimed_by FROM drops WHERE id = ?').get(dropId);
  const x = wallet();
  walkTo(game, clock, 'dev-x-0000000', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId, address: x, device: 'dev-x-0000000', at: HERE }), 'pending');
  clock.t += 30_000;
  await game.reconcile();
  const lost = game.db.prepare('SELECT * FROM claims WHERE address = ?').get(x);
  game.db.prepare(`UPDATE drops SET status = 'hidden', held_until = NULL WHERE id = ?`).run(dropId); // as if the half hour had passed
  // Y claims the same drop and that payout is in flight...
  walkTo(game, clock, 'dev-y-0000000', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-y-0000000', at: HERE }), 'pending');
  // ...when X's transfer turns up after all
  chain.sent.push({ to: x, lamports: lost.lamports, signature: lost.sig });
  chain.balance -= lost.lamports + lost.fee;
  assert.equal(game.settle(lost.id, lost.sig), true);
  assert.equal(status().status, 'paying', 'the drop is held by Y for now');
  // Y's payout never lands
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1);
  assert.deepEqual({ ...status() }, { status: 'claimed', claimed_by: x }, 'the drop belongs to X and must not be found again');
  walkTo(game, clock, 'dev-z-0000000', HERE);
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-z-0000000', at: HERE }), 'gone');
  assert.equal(chain.sent.length, 1);
  // X cannot take a second drop in a one-per-person batch either
  const batchId = game.db.prepare('SELECT batch_id FROM drops WHERE id = ?').get(dropId).batch_id;
  game.db.prepare(`INSERT INTO drops(batch_id, lat, lng, lamports, tier, gold) VALUES (?, ?, ?, ?, 'm', 0)`).run(batchId, HERE.lat, HERE.lng, 0.5 * SOL);
  const extra = game.db.prepare('SELECT id FROM drops WHERE batch_id = ? ORDER BY id DESC').get(batchId).id;
  walkTo(game, clock, 'dev-x-0000000', HERE);
  await rejects(claimAt(game, { dropId: extra, address: x, device: 'dev-x-0000000', at: HERE }), 'one_per_person');
});

test('the fee counter survives a written-off payout that landed', async () => {
  const { game, chain, clock } = makeGame({ balance: 10 * SOL });
  await game.watchTreasury();
  chain.blockHeight = async () => 500;
  const { dropId } = oneDrop(game);
  const a = wallet();
  walkTo(game, clock, 'dev-ledger-000', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId, address: a, device: 'dev-ledger-000', at: HERE }), 'pending');
  const lost = game.db.prepare('SELECT * FROM claims WHERE address = ?').get(a);
  chain.balance -= lost.lamports + lost.fee; // it did land; our node just cannot see the signature yet
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1, 'written off');
  clock.t += 60_000;
  await game.watchTreasury(); // the wallet is lower than the books say, but that may be our own payout
  assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind = 'adjust'`).get().n, 0, 'not booked as money leaving yet');
  chain.sent.push({ to: a, lamports: lost.lamports, signature: lost.sig });
  assert.equal(await game.reconcile(), 1, 'revived');
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 10 * SOL, 'no phantom fees');
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1, 'only the opening balance was ever booked');
  assert.equal(game.balance, chain.balance);
  // money that really leaves is still booked once nothing is under review
  chain.balance -= 1 * SOL;
  clock.t += 31 * 60_000;
  await game.watchTreasury();
  assert.equal(game.db.prepare(`SELECT lamports FROM ledger WHERE kind = 'adjust'`).get().lamports, -1 * SOL);
});

test('money for a payout in flight is never hidden twice', async () => {
  const { game, chain, clock } = makeGame({ balance: 1.03 * SOL });
  await game.watchTreasury();
  const { dropId, batch } = oneDrop(game, { tier: 'l', hours: 1 });
  walkTo(game, clock, 'dev-commit-000', HERE);
  chain.failWith = new ChainError('Payout status unknown', { uncertain: true });
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-commit-000', at: HERE }), 'pending');
  assert.equal(game.endBatch(batch.id), true); // the batch ends while that payout is still being confirmed
  assert.equal(game.outstanding(), 1 * SOL, 'its money is still spoken for');
  assert.ok(game.available() < 0.05 * SOL);
  assert.throws(() => game.createBatch({ name: 'again', lat: HERE.lat, lng: HERE.lng, radiusM: 50, totalSol: 1, endsAt: clock.t + 1e6 }), (e) => e.code === 'funds');
});

test('treasury checks cannot trip over each other or over an old answer', async () => {
  const { game, chain, clock } = makeGame({ balance: 10 * SOL });
  await game.watchTreasury();
  const first = game.watchTreasury();
  assert.equal(game.watchTreasury(), first, 'a second caller shares the check already under way');
  await first;
  chain.balance += 3 * SOL;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 13 * SOL);
  // an answer read at an earlier slot than one already used is ignored
  const stale = chain.balanceAt.bind(chain);
  chain.balanceAt = async () => ({ lamports: 10 * SOL, slot: 1 });
  clock.t += 60_000;
  assert.equal(await game.watchTreasury(), 13 * SOL);
  chain.balanceAt = stale;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.deepEqual(game.db.prepare('SELECT kind, lamports FROM ledger ORDER BY id').all().map((r) => [r.kind, r.lamports]), [['fee_in', 10 * SOL], ['fee_in', 3 * SOL]]);
  // and an answer that is not a number never reaches the books
  chain.balanceAt = async () => ({ lamports: undefined, slot: 99 });
  await assert.rejects(game.watchTreasury());
  assert.equal(game.getKV('accounted'), String(13 * SOL));
});

test('an absurd amount is refused at once instead of stalling the server', () => {
  const { game } = makeGame();
  const started = Date.now();
  for (const total of [1e6 * SOL, 1e15 * SOL, Infinity]) {
    assert.throws(() => game.planDrops({ totalLamports: total }), (e) => e.code === 'bad_batch' && /5,000 drops at most/.test(e.message));
  }
  assert.throws(() => game.planDrops({ counts: { s: 5000, m: 5000, l: 5000 } }), (e) => e.code === 'bad_batch');
  for (const junk of [NaN, -5, undefined, 'x']) assert.equal(game.planDrops({ totalLamports: junk }).drops.length, 0);
  assert.equal(game.planDrops({ totalLamports: 250 * SOL }).drops.length, 2500, 'a big but sane batch still works');
  assert.ok(Date.now() - started < 500);
});

test('limits hold when many claims arrive at the same moment', async () => {
  const { game, chain, clock } = makeGame({ env: { CLAIMS_PER_IP_PER_DAY: '2' } });
  await game.watchTreasury();
  const drops = [oneDrop(game), oneDrop(game), oneDrop(game), oneDrop(game)];
  const devices = drops.map((_, i) => `dev-burst-${i}0000`);
  for (const d of devices) walkTo(game, clock, d, HERE);
  const results = await Promise.allSettled(drops.map((d, i) => claimAt(game, { dropId: d.dropId, address: wallet(), device: devices[i], at: HERE, ip: '198.51.100.50' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, 'exactly the daily allowance is paid');
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ip_limit'));
  assert.equal(chain.sent.length, 2);
  assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM drops WHERE status = 'hidden'`).get().n, 2, 'the refused ones left their drops in place');

  // the pause switch thrown while a claim is being checked still stops that claim
  const late = makeGame();
  await late.game.watchTreasury();
  const gold = oneDrop(late.game, { gold: 1 });
  walkTo(late.game, late.clock, 'dev-late-pause', HERE);
  const holder = wallet();
  late.chain.holdings.set(holder, 2_000_000);
  const lookup = late.chain.tokenBalance.bind(late.chain);
  late.chain.tokenBalance = async (...args) => {
    late.game.setPaused(true); // the admin presses Pause while the holder lookup is on its way
    return lookup(...args);
  };
  await rejects(claimAt(late.game, { dropId: gold.dropId, address: holder, device: 'dev-late-pause', at: HERE }), 'paused');
  assert.equal(late.chain.sent.length, 0);
  assert.equal(late.game.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0);
});

test('holder lookups share a budget, and a claim always gets its own', async () => {
  const { game, chain, clock } = makeGame({ env: { HOLDER_LOOKUPS_PER_MIN: '3' } });
  let lookups = 0;
  const lookup = chain.tokenBalance.bind(chain);
  chain.tokenBalance = async (...args) => {
    lookups++;
    return lookup(...args);
  };
  const holders = Array.from({ length: 6 }, () => wallet());
  for (const h of holders) chain.holdings.set(h, 1_000_000);
  const tiers = [];
  for (const h of holders.slice(0, 5)) tiers.push((await game.tierOf(h)).tier);
  assert.deepEqual(tiers, [2, 2, 2, 0, 0], 'past the budget, strangers are not looked up');
  assert.equal(lookups, 3);
  assert.equal((await game.tierOf(holders[0])).tier, 2, 'answers already known are still given');
  assert.equal((await game.tierOf(holders[5], { priority: true })).tier, 2, 'a claim is never told "non-holder" for lack of budget');
  clock.t += 61_000;
  assert.equal((await game.tierOf(holders[3])).tier, 2, 'and the next minute brings a new budget');
  assert.equal(lookups, 5);
});

test('one signature can never stand for two claims', () => {
  const { game } = makeGame();
  const insert = (sig) => game.db.prepare(`INSERT INTO claims(drop_id, batch_id, address, device, ip, lamports, status, sig, created_at) VALUES (1, 1, ?, ?, 'ip', 5, 'failed', ?, 1)`).run(wallet(), `dev-${Math.random().toString(36).slice(2, 12)}`, sig);
  game.createBatch({ name: 'x', lat: HERE.lat, lng: HERE.lng, radiusM: 50, counts: { s: 1 }, endsAt: game.now() + 1e6 }, { skipFundsCheck: true });
  insert('sig-one');
  insert(null);
  insert(null);
  assert.throws(() => insert('sig-one'), /UNIQUE/);
});

test('only real device ids are remembered, and a failed transaction\'s fee is booked', async () => {
  const { game, chain, clock } = makeGame({ balance: 10 * SOL });
  await game.watchTreasury();
  for (const junk of ['x', 'd'.repeat(5000), 'has spaces in it', '<script>', '', undefined, 42, {}]) game.sync({ ...HERE, device: junk, address: '' });
  assert.equal(game.pings.size, 0);
  game.sync({ ...HERE, device: 'dev-real-000001', address: '' });
  assert.equal(game.pings.size, 1);

  // the transfer reached the chain and failed there: nothing moved, but the network kept its fee
  const { dropId } = oneDrop(game);
  walkTo(game, clock, 'dev-fee-000000', HERE);
  chain.failWith = new ChainError('Payout failed on-chain', { code: 'tx_error' });
  chain.balance -= 5000;
  await rejects(claimAt(game, { dropId, address: wallet(), device: 'dev-fee-000000', at: HERE }), 'payout_failed');
  assert.equal(game.db.prepare('SELECT status FROM drops WHERE id = ?').get(dropId).status, 'hidden');
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.getKV('accounted'), String(10 * SOL - 5000), 'the books match the wallet');
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
});

test('money that leaves is booked even while a payout is under review, and a refused payout gets second looks too', async () => {
  const { game, chain, clock } = makeGame({ balance: 20 * SOL });
  await game.watchTreasury();
  chain.blockHeight = async () => 500;
  const ledger = () => game.db.prepare('SELECT kind, lamports FROM ledger ORDER BY id').all().map((r) => [r.kind, r.lamports]);
  // a payout the node refused; its 0.5 SOL (plus fee) is under review for half an hour
  const { dropId } = oneDrop(game);
  const a = wallet();
  walkTo(game, clock, 'dev-defer-0000', HERE);
  chain.failWith = new ChainError('Payout rejected: node says no', { code: -32002 });
  await rejects(claimAt(game, { dropId, address: a, device: 'dev-defer-0000', at: HERE }), 'payout_failed');
  const refused = game.db.prepare('SELECT * FROM claims WHERE address = ?').get(a);
  assert.equal(game.underReview(clock.t), refused.lamports + refused.fee);
  // 3 SOL leave the wallet by hand: all but the amount under review is booked at once
  chain.balance -= 3 * SOL;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.deepEqual(ledger(), [['fee_in', 20 * SOL], ['adjust', -(3 * SOL - refused.lamports - refused.fee)]]);
  const booksMatchWallet = () => assert.equal(ledger().reduce((sum, r) => sum + r[1], 0), chain.balance, 'everything in, minus everything out, is what the wallet holds');
  // a deposit arrives while that last half SOL is still open: the two are settled against each other, so the
  // counter can understate what came in by at most the amount under review, and never invents money
  chain.balance += 5 * SOL;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.stats().feesIn, 25 * SOL - refused.lamports - refused.fee);
  booksMatchWallet();
  // without anything under review, money that leaves is booked whole and at once
  clock.t += 31 * 60_000;
  await game.reconcile();
  assert.equal(game.underReview(clock.t), 0);
  chain.balance -= 1 * SOL;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.deepEqual(ledger().at(-1), ['adjust', -1 * SOL]);
  booksMatchWallet();
  assert.equal(game.balance, chain.balance);
  assert.equal(Number(game.getKV('accounted')), chain.balance);
  const adjustedSoFar = ledger().filter((r) => r[0] === 'adjust').reduce((sum, r) => sum + r[1], 0);

  // a refused payout that went through after all (a balancer that had already passed it on) is found by the second looks
  const again = oneDrop(game);
  const b = wallet();
  walkTo(game, clock, 'dev-defer-1111', HERE);
  chain.failWith = new ChainError('Payout rejected: Blockhash not found', { code: -32002 });
  await rejects(claimAt(game, { dropId: again.dropId, address: b, device: 'dev-defer-1111', at: HERE }), 'payout_failed');
  const sneaky = game.db.prepare('SELECT * FROM claims WHERE address = ?').get(b);
  chain.sent.push({ to: b, lamports: sneaky.lamports, signature: sneaky.sig });
  chain.balance -= sneaky.lamports + sneaky.fee;
  clock.t += 30_000;
  assert.equal(await game.reconcile(), 1);
  assert.equal(game.db.prepare('SELECT status, claimed_by FROM drops WHERE id = ?').get(again.dropId).claimed_by, b);
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(Number(game.getKV('accounted')), chain.balance);
  assert.equal(ledger().filter((r) => r[0] === 'adjust').reduce((sum, r) => sum + r[1], 0), adjustedSoFar, 'no second, phantom entry');
  assert.equal(game.stats().feesIn, 25 * SOL - refused.lamports - refused.fee);
});

test('holder lookups: one visitor cannot use up everyone else\'s', async () => {
  const { game, chain, clock } = makeGame();
  let lookups = 0;
  const lookup = chain.tokenBalance.bind(chain);
  chain.tokenBalance = async (...args) => {
    lookups++;
    return lookup(...args);
  };
  const holder = wallet();
  chain.holdings.set(holder, 5_000_000);
  // one visitor asks about wallet after wallet
  for (let i = 0; i < 300; i++) await game.tierOf(wallet(), { visitor: '198.51.100.1' });
  assert.equal(lookups, 12, 'a dozen a minute is plenty for one person');
  // a holder arriving from somewhere else is still recognised
  assert.equal((await game.tierOf(holder, { visitor: '203.0.113.50' })).tier, 3);
  clock.t += 61_000;
  await game.tierOf(wallet(), { visitor: '198.51.100.1' });
  assert.equal(lookups, 14);
  // a hundred visitors each asking about a dozen made-up wallets use up the shared ceiling (600 a minute)...
  clock.t += 61_000;
  lookups = 0;
  for (let v = 0; v < 100; v++) for (let i = 0; i < 12; i++) await game.tierOf(wallet(), { visitor: `198.51.101.${v}` });
  assert.equal(lookups, 100 + 600, 'each got their first, and the rest came out of the ceiling until it ran dry');
  // ...and a holder nobody has looked up before, opening the app in that same minute, is still recognised
  const newcomer = wallet();
  chain.holdings.set(newcomer, 1_000_000);
  assert.equal((await game.tierOf(newcomer, { visitor: '203.0.113.99' })).tier, 2);
  // when the store of answers is full, the oldest go first; a recent holder keeps their tier
  // (the holder's answer is by now the oldest in the store, the first in line to go)
  for (let i = 0; i < 20_010; i++) game.tierCache.set(`filler-${i}`, { tier: 0, balance: 0, ts: clock.t, ttl: 180_000 });
  await game.tierOf(wallet(), { priority: true });
  assert.ok(game.tierCache.size <= 20_002 && game.tierCache.size > 15_000);
  assert.equal(game.tierCache.get(holder).tier, 3, 'non-holders are dropped before holders');
});

test('a payout is only sent to a real wallet, never to a coin, a token account or a program', async () => {
  const { game, chain, clock, cfg } = makeGame();
  await game.watchTreasury();
  const { dropId } = oneDrop(game);
  const device = 'dev-kind-000000';
  walkTo(game, clock, device, HERE);
  // the coin's own address, pasted by mistake, is caught before anything else
  const mint = await claimAt(game, { dropId, address: cfg.tokenMint, device, at: HERE }).catch((e) => e);
  assert.equal(mint.code, 'bad_address');
  assert.match(mint.message, /coin's own address/);
  const tokenAccount = wallet();
  const program = wallet();
  const pda = wallet();
  chain.kinds.set(tokenAccount, 'token').set(program, 'program').set(pda, 'other');
  for (const [address, words] of [[tokenAccount, /token account/], [program, /program/], [pda, /program/]]) {
    const refused = await claimAt(game, { dropId, address, device, at: HERE }).catch((e) => e);
    assert.equal(refused.code, 'bad_address');
    assert.match(refused.message, words);
    assert.match(refused.message, /top of your wallet app/);
  }
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0, 'nothing was reserved or sent');
  assert.equal(chain.sent.length, 0);
  // if the check cannot be made, nobody is paid on a guess
  const ask = chain.accountKind.bind(chain);
  chain.accountKind = async () => {
    throw new Error('rpc down');
  };
  const good = wallet();
  await rejects(claimAt(game, { dropId, address: good, device, at: HERE }), 'busy');
  chain.accountKind = ask;
  assert.equal((await claimAt(game, { dropId, address: good, device, at: HERE })).lamports, 0.5 * SOL);
  // the app is told what kind of address it has, so it can say so when the address is saved
  assert.deepEqual([(await game.me(good)).kind, (await game.me(tokenAccount)).kind, (await game.me(cfg.tokenMint)).kind], ['wallet', 'token', 'token']);
  assert.match((await game.me(tokenAccount)).hint, /token account/);
  assert.equal((await game.me(good)).hint, '');
});

test('the network is only asked about a wallet when a claim comes from within reach and needs it', async () => {
  const { game, chain, clock } = makeGame({ env: { HOLDER_LOOKUPS_PER_MIN: '2' } });
  await game.watchTreasury();
  const calls = { token: 0, kind: 0 };
  const token = chain.tokenBalance.bind(chain);
  const kind = chain.accountKind.bind(chain);
  chain.tokenBalance = async (...a) => (calls.token++, token(...a));
  chain.accountKind = async (...a) => (calls.kind++, kind(...a));
  const gold = oneDrop(game, { gold: 1 });
  const plain = oneDrop(game, { onePerPerson: false });
  // from across town, however often and under however many names: refused on distance alone
  for (let i = 0; i < 50; i++) await rejects(claimAt(game, { dropId: gold.dropId, address: wallet(), device: `dev-far-${String(i).padStart(6, '0')}`, at: east(HERE, 5000) }), 'too_far');
  assert.deepEqual(calls, { token: 0, kind: 0 });
  // an ordinary drop, claimed from within 30 m, needs no look at the hunter's coins at all
  const a = wallet();
  walkTo(game, clock, 'dev-near-00000', HERE);
  await claimAt(game, { dropId: plain.dropId, address: a, device: 'dev-near-00000', at: HERE });
  assert.deepEqual(calls, { token: 0, kind: 1 });
  // a holder-only drop does: a non-holder is looked up (twice, the second time fresh) and refused
  await rejects(claimAt(game, { dropId: gold.dropId, address: a, device: 'dev-near-00000', at: HERE }), 'holders_only');
  assert.equal(calls.token, 1, 'one look is enough when the answer is seconds old');
  // and even those lookups have a ceiling (here 5 x 2 a minute), after which people are asked to come back in a moment
  clock.t += 61_000;
  const outcomes = [];
  for (let i = 0; i < 14; i++) outcomes.push((await claimAt(game, { dropId: gold.dropId, address: wallet(), device: `dev-ask-${String(i).padStart(6, '0')}`, at: HERE }).catch((e) => e)).code);
  assert.deepEqual([...new Set(outcomes.slice(0, 10))], ['holders_only']);
  assert.deepEqual([...new Set(outcomes.slice(10))], ['busy']);
});

test('when the treasury cannot cover every claim arriving at once, the extra ones are turned away before anything is signed', async () => {
  const { game, chain, clock } = makeGame({ balance: 10 * SOL });
  await game.watchTreasury();
  const drops = Array.from({ length: 5 }, () => oneDrop(game));
  // the batches were hidden; then most of the money left the wallet by hand, and the server has seen that
  chain.balance = 1.03 * SOL;
  clock.t += 60_000;
  await game.watchTreasury();
  assert.equal(game.balance, 1.03 * SOL);
  const devices = drops.map((_, i) => `dev-rush-${i}00000`);
  for (const d of devices) walkTo(game, clock, d, HERE);
  const results = await Promise.allSettled(drops.map((d, i) => claimAt(game, { dropId: d.dropId, address: wallet(), device: devices[i], at: HERE })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, 'two half-SOL payouts are all a 1.03 SOL wallet can make');
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'treasury_empty'));
  assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM drops WHERE status = 'held'`).get().n, 0, 'no drop was taken off the map for it');
  assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM drops WHERE status = 'hidden'`).get().n, 3);
  assert.equal(game.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 2);
  assert.equal(chain.sent.length, 2);
});

test('a holder lookup that fails is never taken for an answer', async () => {
  const failing = async () => {
    throw new Error('429 Too Many Requests');
  };
  // Someone who held long ago and has sold: what the server remembers from then opens nothing while lookups fail.
  {
    const { game, chain, clock } = makeGame();
    await game.watchTreasury();
    const exHolder = wallet();
    chain.holdings.set(exHolder, 5_000_000);
    assert.equal((await game.tierOf(exHolder)).tier, 3);
    chain.holdings.delete(exHolder);
    clock.t += 6 * 3_600_000;
    const gold = oneDrop(game, { gold: 1 });
    const plain = oneDrop(game);
    const working = chain.tokenBalance;
    chain.tokenBalance = failing;
    walkTo(game, clock, 'dev-unsure-0001', HERE);
    const refused = await claimAt(game, { dropId: gold.dropId, address: exHolder, device: 'dev-unsure-0001', at: HERE }).catch((e) => e);
    assert.deepEqual([refused.code, refused.status], ['busy', 503]);
    assert.match(refused.message, /Could not check your \$SolanaGO/);
    const spot = east(HERE, 44);
    walkTo(game, clock, 'dev-unsure-0002', spot);
    await rejects(claimAt(game, { dropId: plain.dropId, address: exHolder, device: 'dev-unsure-0002', at: spot }), 'busy');
    assert.equal(chain.sent.length, 0);
    assert.equal(game.sync({ ...HERE, device: 'dev-unsure-0001', address: exHolder, tier: (await game.tierOf(exHolder)).tier }).reach, 30, 'and the app is not told they are a holder either');
    // once lookups work again, the answer is the plain truth
    chain.tokenBalance = working;
    clock.t += 5000;
    await rejects(claimAt(game, { dropId: gold.dropId, address: exHolder, device: 'dev-unsure-0001', at: HERE }), 'holders_only');
    await rejects(claimAt(game, { dropId: plain.dropId, address: exHolder, device: 'dev-unsure-0002', at: spot }), 'too_far');
  }
  // A real holder nobody has looked up yet: asked to try again, never told "holders only". A moment later it works.
  {
    const { game, chain, clock } = makeGame();
    await game.watchTreasury();
    const holder = wallet();
    chain.holdings.set(holder, 5_000_000);
    const working = chain.tokenBalance.bind(chain);
    let asked = 0;
    chain.tokenBalance = async (...a) => (++asked === 1 ? failing() : working(...a));
    const gold = oneDrop(game, { gold: 1 });
    walkTo(game, clock, 'dev-unsure-0003', HERE);
    await rejects(claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-unsure-0003', at: HERE }), 'busy');
    assert.equal(asked, 1, 'a struggling RPC is not asked twice in the same breath');
    clock.t += 5000;
    assert.equal((await claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-unsure-0003', at: HERE })).gold, true);
    assert.equal(asked, 2);
  }
  // Someone who bought a minute ago, and the fresh look fails: "try again", not "you are not a holder".
  {
    const { game, chain, clock } = makeGame();
    await game.watchTreasury();
    const buyer = wallet();
    assert.equal((await game.tierOf(buyer)).tier, 0);
    chain.holdings.set(buyer, 1_000_000);
    const gold = oneDrop(game, { gold: 1 });
    walkTo(game, clock, 'dev-unsure-0004', HERE);
    chain.tokenBalance = failing;
    await rejects(claimAt(game, { dropId: gold.dropId, address: buyer, device: 'dev-unsure-0004', at: HERE }), 'busy');
  }
  // A holder seen holding a few minutes ago keeps their perks through a short outage...
  {
    const { game, chain, clock } = makeGame();
    await game.watchTreasury();
    const holder = wallet();
    chain.holdings.set(holder, 5_000_000);
    await game.tierOf(holder);
    clock.t += 4 * 60_000; // past the three minutes an answer is normally kept for
    chain.tokenBalance = failing;
    const gold = oneDrop(game, { gold: 1 });
    const far = oneDrop(game, { onePerPerson: false });
    walkTo(game, clock, 'dev-unsure-0005', HERE);
    assert.equal((await claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-unsure-0005', at: HERE })).gold, true);
    // ...but not for ever
    clock.t += 10 * 60_000;
    const spot = east(HERE, 44);
    walkTo(game, clock, 'dev-unsure-0006', spot);
    await rejects(claimAt(game, { dropId: far.dropId, address: holder, device: 'dev-unsure-0006', at: spot }), 'busy');
  }
  // A lookup that answers with nonsense counts as failed too.
  {
    const { game, chain } = makeGame();
    chain.tokenBalance = async () => NaN;
    assert.deepEqual((({ tier, unsure }) => ({ tier, unsure }))(await game.tierOf(wallet())), { tier: 0, unsure: true });
  }
});

test('before the head start nobody can claim, and nobody is looked up for trying', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  const whale = wallet();
  chain.holdings.set(whale, 50_000_000);
  let asked = 0;
  const working = chain.tokenBalance.bind(chain);
  chain.tokenBalance = async (...a) => (asked++, working(...a));
  const later = oneDrop(game, { startsIn: 60 * 60_000 }); // opens in an hour; holders get in 15 minutes before that
  walkTo(game, clock, 'dev-early-0001', HERE);
  const refused = await claimAt(game, { dropId: later.dropId, address: whale, device: 'dev-early-0001', at: HERE }).catch((e) => e);
  assert.deepEqual([refused.code, refused.status, asked], ['not_live', 403, 0]);
  // from far away too: no distance is given out for a drop nobody can see yet
  const far = await claimAt(game, { dropId: later.dropId, address: whale, device: 'dev-early-0001', at: east(HERE, 900) }).catch((e) => e);
  assert.deepEqual([far.code, far.extra.dist], ['not_live', undefined]);
  // inside the head start the holder gets it, and a non-holder standing on it does not
  clock.t += 50 * 60_000;
  walkTo(game, clock, 'dev-early-0002', HERE);
  walkTo(game, clock, 'dev-early-0001', HERE);
  await rejects(claimAt(game, { dropId: later.dropId, address: wallet(), device: 'dev-early-0002', at: HERE }), 'not_live');
  assert.equal((await claimAt(game, { dropId: later.dropId, address: whale, device: 'dev-early-0001', at: HERE })).lamports, 0.5 * SOL);
});

test('a longer ordinary reach than the top-tier default does not shut anyone out', async () => {
  // CLAIM_RADIUS_M raised to 60 while CLAIM_RADIUS_TOP_TIER_M is left at its default of 50
  const { game, chain, clock, cfg } = makeGame({ env: { CLAIM_RADIUS_M: '60' } });
  await game.watchTreasury();
  assert.deepEqual([cfg.reachM, cfg.reachTopM], [60, 60], 'top holders never get less than everyone else');
  const { dropId } = oneDrop(game);
  const spot = east(HERE, 55);
  const address = wallet();
  walkTo(game, clock, 'dev-radius-0001', spot);
  assert.equal(game.sync({ ...spot, acc: 8, device: 'dev-radius-0001', address, tier: 0 }).reach, 60);
  assert.equal((await claimAt(game, { dropId, address, device: 'dev-radius-0001', at: spot })).lamports, 0.5 * SOL);
  assert.equal(chain.sent.length, 1);
  // and a game handed odd numbers directly copes as well
  const odd = makeGame();
  odd.game.cfg.reachM = 60;
  await odd.game.watchTreasury();
  const second = oneDrop(odd.game);
  walkTo(odd.game, odd.clock, 'dev-radius-0002', spot);
  assert.equal((await claimAt(odd.game, { dropId: second.dropId, address: wallet(), device: 'dev-radius-0002', at: spot })).lamports, 0.5 * SOL);
  assert.deepEqual([loadConfig({ CLAIM_RADIUS_M: '20', CLAIM_RADIUS_TOP_TIER_M: '80' }).reachM, loadConfig({ CLAIM_RADIUS_M: '20', CLAIM_RADIUS_TOP_TIER_M: '80' }).reachTopM], [20, 80]);
  for (const env of [{ CLAIM_RADIUS_M: '0' }, { CLAIM_RADIUS_M: '-5' }, { CLAIMS_PER_IP_PER_DAY: '0' }, { MAX_GPS_ACCURACY_M: '0' }, { MAX_SPEED_MS: '0' }, { NEARBY_KM: '0' }]) {
    assert.throws(() => loadConfig(env), new RegExp(Object.keys(env)[0]), JSON.stringify(env));
  }
});

test('after an RPC outage, holders are recognised again within seconds, not at the end of the minute', async () => {
  // Three phones on one network (the same Wi-Fi), each refreshing every 6.5 seconds like the app does. All three hold tier 3.
  const { game, chain, clock } = makeGame();
  const NET = '203.0.113.7';
  const phones = [0, 1, 2].map((i) => ({ address: wallet(), next: i * 2000 }));
  for (const p of phones) chain.holdings.set(p.address, 5_000_000);
  const working = chain.tokenBalance.bind(chain);
  let reached = 0;
  chain.tokenBalance = async () => {
    reached++;
    throw new Error('fetch failed');
  };
  const warnings = [];
  game.log = { ...quiet, warn: (m) => warnings.push(m) };
  const start = clock.t;
  let duringOutage = 0;
  let recognisedAt = null;
  for (let t = 0; t <= 60_000; t += 500) {
    clock.t = start + t;
    if (t === 30_000) {
      duringOutage = reached;
      chain.tokenBalance = working; // the RPC is back
    }
    for (const p of phones) {
      if (t < p.next) continue;
      p.next += 6500;
      const { tier } = await game.tierOf(p.address, { visitor: NET });
      if (t < 30_000) assert.equal(tier, 0);
      else if (tier === 3 && p === phones[0] && recognisedAt === null) recognisedAt = t;
    }
  }
  assert.ok(duringOutage <= 4, `a failing RPC is asked now and then, not on every refresh of every phone (asked ${duringOutage} times in 30 s)`);
  assert.ok(recognisedAt !== null && recognisedAt - 30_000 <= 13_000, `recognised ${recognisedAt === null ? 'never' : `${(recognisedAt - 30_000) / 1000} s after the RPC came back`}`);
  assert.equal((await Promise.all(phones.map((p) => game.tierOf(p.address, { visitor: NET })))).filter((r) => r.tier === 3).length, 3, 'and so are the others on that network');
  assert.ok(warnings.length <= 4, `the log gets a line now and then, not one per failure (${warnings.length} lines)`);
  // a claim never waits for any of this: it gets its own lookup, even right after a failure on the same network
  const other = makeGame();
  await other.game.watchTreasury();
  const holder = wallet();
  other.chain.holdings.set(holder, 5_000_000);
  const fine = other.chain.tokenBalance.bind(other.chain);
  other.chain.tokenBalance = async () => {
    throw new Error('fetch failed');
  };
  assert.equal((await other.game.tierOf(holder, { visitor: NET })).unsure, true);
  other.chain.tokenBalance = fine;
  other.clock.t += 4000;
  const gold = oneDrop(other.game, { gold: 1 });
  walkTo(other.game, other.clock, 'dev-outage-0001', HERE);
  assert.equal((await claimAt(other.game, { dropId: gold.dropId, address: holder, device: 'dev-outage-0001', at: HERE, ip: NET })).gold, true);
});

test('one lookup at a time per wallet, and a slow one is not repeated the moment it fails', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // Two phones ask about the same wallet at the same moment: the chain is asked once, and both get its answer.
  {
    const { game, chain } = makeGame();
    const holder = wallet();
    chain.holdings.set(holder, 5_000_000);
    const working = chain.tokenBalance.bind(chain);
    const answers = [];
    chain.tokenBalance = (...a) => new Promise((resolve) => answers.push(() => resolve(working(...a))));
    const phones = [game.tierOf(holder, { visitor: '203.0.113.1' }), game.tierOf(holder, { visitor: '203.0.113.2' })];
    await tick();
    assert.equal(answers.length, 1);
    // A claim does not wait behind them: it gets a lookup of its own, and its answer as soon as that one is back.
    const claim = game.tierOf(holder, { priority: true });
    await tick();
    assert.equal(answers.length, 2);
    answers[1]();
    assert.deepEqual((({ tier, unsure }) => [tier, !!unsure])(await claim), [3, false]);
    answers[0]();
    assert.deepEqual((await Promise.all(phones)).map((r) => [r.tier, !!r.unsure]), [[3, false], [3, false]]);
    assert.equal(game.lookingUp.size, 0, 'nothing is left hanging');
    assert.equal((await game.tierOf(holder)).tier, 3);
    assert.equal(answers.length, 2, 'and the answer is kept');
  }
  // The same when the lookup fails: one try, both told "not sure", and a good answer from a few minutes ago is kept.
  {
    const { game, chain, clock } = makeGame();
    const holder = wallet();
    chain.holdings.set(holder, 5_000_000);
    assert.equal((await game.tierOf(holder)).tier, 3);
    clock.t += 4 * 60_000;
    let calls = 0;
    let fail;
    chain.tokenBalance = () => new Promise((_, reject) => (calls++, (fail = () => reject(new Error('timed out')))));
    const asking = [game.tierOf(holder, { visitor: '203.0.113.1' }), game.tierOf(holder, { visitor: '203.0.113.2' })];
    await tick();
    fail();
    assert.deepEqual((await Promise.all(asking)).map((r) => [r.tier, r.unsure]), [[3, true], [3, true]]);
    assert.equal(calls, 1);
    const kept = game.tierCache.get(holder);
    assert.deepEqual([kept.tier, !!kept.unsure], [3, false]);
  }
  // A lookup for a claim that fails late does not wipe out a good answer that another lookup brought meanwhile.
  {
    const { game, chain, clock } = makeGame();
    await game.watchTreasury();
    const holder = wallet();
    chain.holdings.set(holder, 5_000_000);
    const working = chain.tokenBalance.bind(chain);
    let fail;
    chain.tokenBalance = () => new Promise((_, reject) => (fail = () => reject(new Error('timed out'))));
    const slow = game.tierOf(holder, { priority: true });
    chain.tokenBalance = working;
    assert.equal((await game.tierOf(holder, { priority: true })).tier, 3);
    fail();
    assert.deepEqual((({ tier, unsure }) => ({ tier, unsure }))(await slow), { tier: 3, unsure: true }, 'the late failure reports what is known by now');
    const kept = game.tierCache.get(holder);
    assert.deepEqual([kept.tier, !!kept.unsure], [3, false], 'and the good answer is still there');
    // so when the RPC goes down a little later, this holder still gets their drop
    chain.tokenBalance = async () => {
      throw new Error('fetch failed');
    };
    clock.t += 4 * 60_000;
    const gold = oneDrop(game, { gold: 1 });
    walkTo(game, clock, 'dev-late-00001', HERE);
    assert.equal((await claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-late-00001', at: HERE })).gold, true);
  }
  // An RPC that hangs for 15 seconds before giving up: the waiting is not started again at once.
  {
    const { game, chain, clock } = makeGame();
    await game.watchTreasury();
    const holder = wallet();
    chain.holdings.set(holder, 5_000_000);
    let calls = 0;
    chain.tokenBalance = async () => {
      calls++;
      clock.t += 15_000; // what server/solana.js gives an RPC call before it gives up
      throw new Error('RPC unreachable');
    };
    const NET = '198.51.100.9';
    const asked = clock.t;
    assert.equal((await game.tierOf(holder, { visitor: NET })).unsure, true);
    assert.equal(clock.t - asked, 15_000);
    // that phone's next refreshes come straight back, for ten seconds counted from the failure, not from the asking
    for (const later of [0, 5000, 9000]) {
      clock.t = asked + 15_000 + later;
      await game.tierOf(holder, { visitor: NET });
      assert.equal(clock.t, asked + 15_000 + later, `${later} ms after the failure`);
    }
    assert.equal(calls, 1);
    // a claim two seconds after the failure is told to try again without a second wait...
    const gold = oneDrop(game, { gold: 1 });
    clock.t = asked + 15_000;
    walkTo(game, clock, 'dev-hang-00001', HERE, { from: 4, steps: 4, seconds: 0.5 });
    let at = clock.t;
    await rejects(claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-hang-00001', at: HERE }), 'busy');
    assert.deepEqual([calls, clock.t - at], [1, 0]);
    // ...and one a little later gets a try of its own
    clock.t += 2000;
    at = clock.t;
    await rejects(claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-hang-00001', at: HERE }), 'busy');
    assert.deepEqual([calls, clock.t - at], [2, 15_000]);
  }
});

test('a lookup that never comes back does not shut its wallet out for good', async () => {
  const { game, chain, clock } = makeGame();
  await game.watchTreasury();
  game.lookupLimitMs = 60;
  const holder = wallet();
  chain.holdings.set(holder, 5_000_000);
  const working = chain.tokenBalance.bind(chain);
  let calls = 0;
  chain.tokenBalance = () => (calls++, new Promise(() => {})); // no answer, no error, ever
  const gold = oneDrop(game, { gold: 1 });
  walkTo(game, clock, 'dev-never-0001', HERE);
  const stuck = claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-never-0001', at: HERE });
  const phones = [game.tierOf(holder, { visitor: '203.0.113.1' }), game.tierOf(holder, { visitor: '203.0.113.2' })];
  const first = await stuck.catch((e) => e);
  assert.deepEqual([first.code, first.status], ['busy', 503], 'the claim is answered, not left hanging');
  assert.deepEqual((await Promise.all(phones)).map((r) => r.unsure), [true, true], 'and so are the phones that were waiting on one lookup together');
  assert.deepEqual([calls, game.lookingUp.size], [2, 0]);
  // and once the RPC answers again, so does the wallet
  chain.tokenBalance = working;
  clock.t += 4000;
  assert.equal((await claimAt(game, { dropId: gold.dropId, address: holder, device: 'dev-never-0001', at: HERE })).gold, true);
});

test('the app is answered with what is known when a lookup takes too long', async () => {
  const { game, chain } = makeGame();
  game.patienceMs = 40;
  const holder = wallet();
  chain.holdings.set(holder, 5_000_000);
  const working = chain.tokenBalance.bind(chain);
  let answer;
  chain.tokenBalance = (...a) => new Promise((resolve) => (answer = () => resolve(working(...a))));
  const started = Date.now();
  assert.deepEqual(await game.tierSoon(holder, { visitor: '203.0.113.1' }), { tier: 0, balance: 0 }, 'nothing known yet');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await game.tierSoon(holder, { visitor: '203.0.113.1' }), { tier: 0, balance: 0 }, 'still waiting, and still only one lookup');
  answer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await game.tierSoon(holder, { visitor: '203.0.113.1' })).tier, 3, 'the answer is there for the next refresh');
  // a claim, on the other hand, waits for its answer
  const other = wallet();
  chain.holdings.set(other, 1_000_000);
  const waiting = game.tierOf(other, { priority: true });
  setTimeout(() => answer(), 80);
  assert.equal((await waiting).tier, 2);
});

test('a setting that should be a number and is not one stops the server from starting', () => {
  for (const key of ['CLAIM_RADIUS_M', 'CLAIM_RADIUS_TOP_TIER_M', 'CLAIMS_PER_IP_PER_DAY', 'TREASURY_RESERVE_SOL', 'PRIORITY_FEE_MICROLAMPORTS', 'MIN_WALLET_SOL', 'MIN_WALLET_AGE_DAYS', 'EARLY_ACCESS_MIN', 'PORT', 'HOME_LAT']) {
    for (const value of ['3O', '"30"', 'thirty', '1e400', '12 m']) {
      assert.throws(() => loadConfig({ [key]: value }), (e) => e.message === `${key} must be a number`, `${key}=${value}`);
    }
  }
  // an empty value means "not set", and spaces around a number do no harm
  assert.equal(loadConfig({ CLAIM_RADIUS_M: '', CLAIMS_PER_IP_PER_DAY: '   ' }).reachM, 30);
  assert.equal(loadConfig({ CLAIM_RADIUS_M: ' 45 ' }).reachM, 45);
  // the message never repeats the value: something pasted into the wrong box may be a secret
  const secret = '5J3mBbAH58CpQ3Y5RNJpUKPE62SQ5tfcvU2JpbnkeyhfsYB1Jcn';
  assert.throws(() => loadConfig({ PORT: secret }), (e) => !e.message.includes(secret));
});

