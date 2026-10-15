// The server as a hunter's phone and the admin console see it: real HTTP requests against a running instance.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/store.js';
import { Game } from '../server/game.js';
import { createServer, isInternalAddress, networkKey, proxyAdvice, visitorAddress } from '../server/http.js';
import { BASE_FEE, MockChain, SolanaChain, generateKeypair, priorityFee } from '../server/solana.js';
import { SOL, HERE, east, fakeNode, quiet, wallet } from './helpers.js';

const ADMIN = 'correct-horse-battery-staple';

async function startApp({ env = {}, real = false, balance = 20 * SOL, db = openDb(':memory:') } = {}) {
  const cfg = loadConfig({ ADMIN_TOKEN: ADMIN, TOKEN_MINT: generateKeypair().address, TRAIL_MIN_PINGS: '1', TRAIL_MIN_SECONDS: '0', ...env });
  const clock = { t: Date.now() };
  let chain;
  let node = null;
  if (real) {
    // the real wallet code, talking to a pretend node that decodes and checks every transaction
    const treasury = generateKeypair();
    node = fakeNode();
    node.balances.set(treasury.address, balance);
    chain = new SolanaChain({ rpcUrl: 'http://rpc.test', secret: treasury.secretKey, priorityMicroLamports: 20_000, fetchImpl: node.fetchImpl, pollMs: 5 });
  } else chain = new MockChain({ balance });
  const game = new Game({ db, chain, cfg, log: quiet, now: () => clock.t });
  await game.watchTreasury();
  const server = createServer({ game, cfg, log: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = async (route, { body, token, headers = {}, method } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, json };
  };
  /** A request with the path sent exactly as written (fetch would tidy "../" away before sending). */
  const raw = (rawPath) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: rawPath, agent: false }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }).on('error', reject);
    });
  /** A request with headers fetch will not let us set, such as Host. */
  const send = (method, route, headers = {}, body = undefined) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on('error', reject);
      req.end(payload || undefined);
    });
  const close = () =>
    new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  return { cfg, chain, node, game, clock, port, call, raw, send, close };
}

test('pages and files are served; anything outside the public folder is not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solanago-'));
  const pub = path.join(root, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<meta property="og:image" content="%ORIGIN%/card.png"><p>home</p>');
  fs.writeFileSync(path.join(pub, 'admin.html'), '<p>admin</p>');
  fs.writeFileSync(path.join(pub, 'app.js'), `// ${'x'.repeat(3000)}\nconsole.log(1);`);
  fs.writeFileSync(path.join(pub, 'logo.png'), Buffer.alloc(64, 7));
  fs.writeFileSync(path.join(pub, '.env'), 'TREASURY_SECRET_KEY=leak');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'private');
  const app = await startApp({ env: { PUBLIC_DIR: pub, PUBLIC_URL: 'https://solanago.app/' } });
  try {
    const home = await app.call('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.text, /content="https:\/\/solanago\.app\/card\.png"/, 'link previews get the full site address');
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.equal((await app.call('/admin')).text, '<p>admin</p>');
    assert.equal((await app.call('/admin/')).status, 200);

    const js = await app.call('/app.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(js.headers.get('content-encoding'), 'gzip');
    assert.equal(js.headers.get('cache-control'), 'no-cache', 'a new version of the app reaches phones at once');
    assert.ok(js.text.endsWith('console.log(1);'));
    const png = await app.call('/logo.png');
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('cache-control'), 'public, max-age=86400');
    const notModified = await app.call('/app.js', { headers: { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() } });
    assert.equal(notModified.status, 304);
    assert.equal((await app.call('/app.js', { method: 'HEAD' })).text, '');

    assert.equal((await app.call('/missing.png')).status, 404);
    assert.equal((await app.call('/.env')).status, 404, 'dot files are never served');
    for (const sneaky of ['/../outside.txt', '/..%2Foutside.txt', '/%2e%2e/outside.txt', '/public/../../outside.txt', '/..\\outside.txt', '/%00', '/%E0%A4%A']) {
      const res = await app.raw(sneaky);
      assert.equal(res.status, 404, sneaky);
      assert.doesNotMatch(res.text, /private|leak/);
    }
    assert.equal((await app.call('/', { method: 'POST', body: {} })).status, 405);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the app shipped in public/ is complete: every file a page asks for exists', async () => {
  const app = await startApp();
  try {
    for (const page of ['/', '/admin', '/demo']) {
      const res = await app.call(page);
      assert.equal(res.status, 200, page);
      const local = [...res.text.matchAll(/(?:src|href)="(\/[^"#?]*\.[a-z0-9]+)"/g)].map((m) => m[1]);
      for (const file of new Set(local)) assert.equal((await app.call(file)).status, 200, `${page} asks for ${file}`);
    }
    const manifest = (await app.call('/manifest.webmanifest')).json;
    for (const icon of manifest.icons) assert.equal((await app.call(icon.src)).status, 200, icon.src);
    assert.equal((await app.call('/card.jpg')).headers.get('content-type'), 'image/jpeg');
    assert.match((await app.call('/robots.txt')).text, /Disallow: \/admin/);
  } finally {
    await app.close();
  }
});

test('the public API tells the app what it needs and nothing private', async () => {
  const app = await startApp({ env: { SERVER_SECRET: 'keep-this-quiet' } });
  try {
    assert.deepEqual((await app.call('/healthz')).json, { ok: true });
    const config = await app.call('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.treasury, app.chain.address);
    assert.equal(config.json.practice, true);
    assert.deepEqual(config.json.tierLevels, [100000, 1000000, 5000000]);
    assert.equal(config.json.tokenUrl, `https://pump.fun/coin/${app.cfg.tokenMint}`);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    const stats = await app.call('/api/stats');
    assert.equal(stats.json.feesIn, 20 * SOL);
    for (const res of [config, stats, await app.call('/api/sync?lat=35.67&lng=139.70&device=dev-http-0000')]) {
      assert.doesNotMatch(res.text, new RegExp(`${ADMIN}|keep-this-quiet`));
    }
    assert.equal((await app.call('/api/me?address=nope')).status, 400);
    assert.equal((await app.call(`/api/me?address=${wallet()}`)).json.total, 0);
    assert.equal((await app.call('/api/nope')).status, 404);
    assert.equal((await app.call('/api/claim', { method: 'POST', headers: { 'content-type': 'application/json' } })).json.error, 'bad_address');
    const junk = await fetch(`http://127.0.0.1:${app.port}/api/claim`, { method: 'POST', body: '{not json' });
    assert.equal(junk.status, 400);
    const huge = await fetch(`http://127.0.0.1:${app.port}/api/claim`, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(100_000) }) }).catch(() => ({ status: 413 }));
    assert.equal(huge.status, 413);
  } finally {
    await app.close();
  }
});

test('the admin API needs the password, and is off without one', async () => {
  const app = await startApp();
  try {
    const batch = { name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 100, totalSol: 1, endsAt: Date.now() + 3_600_000 };
    for (const route of ['/api/admin/overview', '/api/admin/nothing']) {
      assert.equal((await app.call(route)).status, 401);
      assert.equal((await app.call(route, { token: 'guess' })).status, 401);
      assert.equal((await app.call(route, { headers: { authorization: ADMIN } })).status, 401, 'the password must come as a Bearer token');
    }
    assert.equal((await app.call('/api/admin/batches', { body: batch })).status, 401);
    assert.equal((await app.call('/api/admin/batches', { body: batch, token: `${ADMIN}x` })).status, 401);
    assert.equal(app.game.overview().batches.length, 0, 'nothing was hidden by the refused calls');

    const overview = await app.call('/api/admin/overview', { token: ADMIN });
    assert.equal(overview.status, 200);
    assert.equal(overview.json.balance, 20 * SOL);
    const preview = await app.call('/api/admin/preview', { token: ADMIN, body: { totalSol: 10, goldShare: 0.2 } });
    assert.deepEqual(preview.json.counts, { s: 90, m: 9, l: 1 });
    assert.equal(preview.json.gold, 2);
    const made = await app.call('/api/admin/batches', { token: ADMIN, body: batch });
    assert.equal(made.json.batch.totalLamports, 1 * SOL);
    const tooMuch = await app.call('/api/admin/batches', { token: ADMIN, body: { ...batch, totalSol: 500 } });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.json.message, /18\.98 SOL free/);
    assert.equal((await app.call(`/api/admin/batches/${made.json.batch.id}/end`, { token: ADMIN, body: {} })).json.ok, true);
    assert.equal((await app.call(`/api/admin/batches/${made.json.batch.id}/end`, { token: ADMIN, body: {} })).json.ok, false, 'ending twice does nothing');
    const auto = await app.call('/api/admin/auto', { token: ADMIN, body: { enabled: true, everyHours: 6, areas: [{ name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 200 }] } });
    assert.equal(auto.json.auto.enabled, true);
    assert.equal((await app.call('/api/admin/nothing', { token: ADMIN })).status, 404);
    // the emergency brake
    assert.equal((await app.call('/api/admin/pause', { body: { paused: true } })).status, 401);
    assert.equal((await app.call('/api/admin/pause', { token: ADMIN, body: { paused: true } })).json.paused, true);
    assert.equal((await app.call('/api/admin/overview', { token: ADMIN })).json.paused, true);
    assert.equal((await app.call(`/api/sync?lat=${HERE.lat}&lng=${HERE.lng}&device=dev-http-0000`)).json.paused, true);
    assert.equal((await app.call('/api/admin/pause', { token: ADMIN, body: {} })).json.paused, false, 'only an explicit true pauses');
  } finally {
    await app.close();
  }
  const off = await startApp({ env: { ADMIN_TOKEN: '' } });
  try {
    assert.equal((await off.call('/api/admin/overview', { token: '' })).status, 503);
    assert.equal((await off.call('/api/admin/overview', { token: 'anything' })).status, 503);
  } finally {
    await off.close();
  }
});

test('a hunt over HTTP with the real wallet code: found, signed, paid once, books balanced', async () => {
  const app = await startApp({ real: true, balance: 3 * SOL });
  const { node, chain, game, clock } = app;
  try {
    assert.equal((await app.call('/api/config')).json.practice, false);
    const made = await app.call('/api/admin/batches', { token: ADMIN, body: { name: 'Fee drop · Park', area: 'Yoyogi Park', lat: HERE.lat, lng: HERE.lng, radiusM: 10, counts: { m: 1 }, endsAt: clock.t + 3_600_000 } });
    assert.equal(made.status, 200);
    const drop = game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').get(made.json.batch.id);
    const hunter = wallet();
    const device = 'dev-http-hunter1';
    const at = (p) => `lat=${p.lat}&lng=${p.lng}&acc=8&device=${device}&address=${hunter}`;

    // from 200 m away the pin is shown near the spot, not on it
    const far = (await app.call(`/api/sync?${at(east(drop, 200))}`)).json;
    assert.equal(far.drops.length, 1);
    assert.equal(far.drops[0].exact, false);
    assert.ok(Math.abs(far.drops[0].lat - drop.lat) + Math.abs(far.drops[0].lng - drop.lng) > 1e-6);
    assert.equal(far.batches[0].left, 1);
    const tooFar = await app.call('/api/claim', { body: { dropId: drop.id, address: hunter, device, ...east(drop, 200), acc: 8 } });
    assert.equal(tooFar.status, 403);
    assert.deepEqual([tooFar.json.error, tooFar.json.dist, tooFar.json.reach], ['too_far', 200, 30]);
    assert.equal(node.landed.size, 0);

    // standing on it
    const near = (await app.call(`/api/sync?${at(east(drop, 5))}`)).json;
    assert.equal(near.drops[0].exact, true);
    const before = node.balances.get(chain.address);
    const paid = await app.call('/api/claim', { body: { dropId: drop.id, address: hunter, device, ...east(drop, 5), acc: 8 } });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.lamports, 0.5 * SOL);
    assert.equal(paid.json.explorer, `https://solscan.io/tx/${paid.json.signature}`);
    assert.equal(node.landed.size, 1);
    const tx = node.landed.get(paid.json.signature);
    assert.deepEqual({ from: tx.from, to: tx.to, lamports: tx.lamports }, { from: chain.address, to: hunter, lamports: 0.5 * SOL }, 'the node received a validly signed transfer of the right amount to the right wallet');
    assert.equal(node.balances.get(hunter), 0.5 * SOL);
    assert.equal(tx.fee, BASE_FEE + priorityFee(20_000));
    assert.equal(before - node.balances.get(chain.address), 0.5 * SOL + chain.feeFor(), 'the fee we book is the fee the network charges');

    // a second ask, a second phone, and the public numbers
    const again = await app.call('/api/claim', { body: { dropId: drop.id, address: hunter, device, ...east(drop, 5), acc: 8 } });
    assert.equal(again.json.signature, paid.json.signature);
    const other = await app.call('/api/claim', { body: { dropId: drop.id, address: wallet(), device: 'dev-http-hunter2', ...east(drop, 5), acc: 8 } });
    assert.equal(other.status, 410);
    assert.equal(node.landed.size, 1, 'one drop, one payout');
    assert.equal((await app.call(`/api/me?address=${hunter}`)).json.total, 0.5 * SOL);
    const stats = (await app.call('/api/stats')).json;
    assert.deepEqual([stats.claimed, stats.claimedCount, stats.waiting, stats.recent[0].sig], [0.5 * SOL, 1, 0, paid.json.signature]);
    assert.equal((await app.call(`/api/sync?${at(east(drop, 5))}`)).json.drops.length, 0);

    // a minute later the wallet and the books agree to the lamport
    clock.t += 60_000;
    assert.equal(await game.watchTreasury(), node.balances.get(chain.address));
    assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind = 'adjust'`).get().n, 0);
    assert.equal((await app.call('/api/stats')).json.feesIn, 3 * SOL);
    assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE status = 'failed'`).get().n, 0);
  } finally {
    await app.close();
  }
});

test('with the real wallet code: an empty treasury refuses cleanly, and holders are recognised', async () => {
  const app = await startApp({ real: true, balance: 0.6 * SOL });
  const { node, chain, game, clock } = app;
  try {
    const make = (counts) => app.call('/api/admin/batches', { token: ADMIN, body: { name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 10, counts, endsAt: clock.t + 4 * 3_600_000 } });
    const batch = (await make({ m: 1 })).json.batch;
    const drop = game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').get(batch.id);
    const status = () => game.db.prepare('SELECT status FROM drops WHERE id = ?').get(drop.id).status;
    node.balances.set(chain.address, 1000); // the money left the wallet behind the app's back
    const hunter = wallet();
    const body = { dropId: drop.id, address: hunter, device: 'dev-http-broke00', lat: drop.lat, lng: drop.lng, acc: 8 };
    const failed = await app.call('/api/claim', { body });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error, 'payout_failed');
    assert.ok(!failed.json.held);
    assert.ok(node.calls.includes('simulateTransaction') && !node.calls.includes('sendTransaction'), 'the rehearsal caught it: nothing was ever sent');
    assert.equal(status(), 'hidden', 'so the drop stays on the map');
    assert.equal(game.db.prepare('SELECT sig FROM claims WHERE drop_id = ?').get(drop.id).sig, null);
    // a "wallet" that is really a token account or a program is turned away before anything is signed
    const tokenAccount = wallet();
    node.kinds.set(tokenAccount, { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
    const wrongKind = await app.call('/api/claim', { body: { ...body, address: tokenAccount } });
    assert.deepEqual([wrongKind.status, wrongKind.json.error], [400, 'bad_address']);
    assert.match(wrongKind.json.message, /token account/);
    assert.equal((await app.call(`/api/me?address=${tokenAccount}`)).json.kind, 'token');
    for (const programId of ['11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111']) {
      node.kinds.set(programId, { executable: true, owner: 'NativeLoader1111111111111111111111111111111' });
      assert.equal((await app.call('/api/claim', { body: { ...body, address: programId } })).json.error, 'bad_address');
    }
    assert.equal(game.db.prepare(`SELECT COUNT(*) AS n FROM drops WHERE status = 'held'`).get().n, 0, 'none of that can take a drop off the map');

    // the node accepts a transfer but it never lands: only now is the drop held back while the chain is asked again
    node.balances.set(chain.address, 0.6 * SOL);
    node.swallow = true;
    const lostInFlight = app.call('/api/claim', { body });
    await new Promise((r) => setTimeout(r, 150));
    node.height += 400; // its window closes
    const expired = await lostInFlight;
    assert.deepEqual([expired.status, expired.json.error, expired.json.held], [502, 'payout_failed', true]);
    assert.equal(status(), 'held');
    assert.equal((await app.call('/api/claim', { body })).json.error, 'held');
    assert.equal((await app.call(`/api/sync?lat=${drop.lat}&lng=${drop.lng}&device=dev-http-broke00`)).json.drops.length, 0);
    node.swallow = false;
    clock.t += 31 * 60_000;
    await game.reconcile();
    assert.equal(status(), 'hidden', 'half an hour of second looks through the real status lookups, then it is back');
    assert.equal((await app.call('/api/claim', { body })).status, 200);
    assert.equal(node.landed.size, 1);
    assert.equal(node.balances.get(hunter), 0.5 * SOL);

    // holder tiers come from the token balance the node reports
    const whale = wallet();
    node.holdings.set(whale, 5_000_000);
    const sync = (address, extra = '') => app.call(`/api/sync?lat=${HERE.lat}&lng=${HERE.lng}&device=dev-http-holder0&address=${address}${extra}`).then((r) => r.json);
    assert.deepEqual([(await sync(whale)).tier, (await sync(whale)).balance, (await sync(whale)).reach], [3, 5_000_000, 50]);
    const lookupsBefore = node.calls.filter((m) => m === 'getTokenAccountsByOwner').length;
    const other = wallet();
    assert.equal((await sync(other)).tier, 0);
    node.holdings.set(other, 150_000);
    assert.equal((await sync(other)).tier, 0, 'a balance is remembered for a few minutes');
    clock.t += 11_000;
    assert.equal((await sync(other, '&fresh=1')).tier, 1, 'unless the app asks for a fresh look');
    assert.equal(node.calls.filter((m) => m === 'getTokenAccountsByOwner').length - lookupsBefore, 2);
  } finally {
    await app.close();
  }
});

test('visitors are told apart by the address the host passes on, and hammering is slowed', async () => {
  const app = await startApp({ env: { CLIENT_IP_HEADER: 'CF-Connecting-IP' } });
  try {
    const body = { dropId: 1, address: wallet(), device: 'dev-http-limit00', lat: HERE.lat, lng: HERE.lng, acc: 8 };
    const tries = [];
    for (let i = 0; i < 14; i++) tries.push((await app.call('/api/claim', { body, headers: { 'cf-connecting-ip': '198.51.100.20' } })).status);
    assert.deepEqual([...new Set(tries.slice(0, 12))], [404], 'the first dozen are answered (there is no such drop)');
    assert.deepEqual(tries.slice(12), [429, 429], 'then that visitor is told to wait');
    assert.equal((await app.call('/api/claim', { body, headers: { 'cf-connecting-ip': '198.51.100.21' } })).status, 404, 'someone else is not affected');
    assert.equal((await app.call('/api/claim', { body, headers: { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '203.0.113.99' } })).status, 429, 'and the limit cannot be dodged with a made-up forwarding header');
  } finally {
    await app.close();
  }
});

test('one key per visitor network', () => {
  assert.equal(networkKey('203.0.113.7'), '203.0.113.7');
  assert.equal(networkKey(' 203.0.113.7:51234 '), '203.0.113.7');
  assert.equal(networkKey('::ffff:203.0.113.7'), '203.0.113.7');
  // a phone can use any address inside its own IPv6 block, so the block is the key
  assert.equal(networkKey('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:8d3::/64');
  assert.equal(networkKey('2001:0DB8:85A3:08D3:ffff:ffff:ffff:ffff'), '2001:db8:85a3:8d3::/64');
  assert.equal(networkKey('[2001:db8:85a3:8d3::1]:443'), '2001:db8:85a3:8d3::/64');
  assert.equal(networkKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkKey('::1'), '0:0:0:0::/64');
  assert.equal(networkKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(networkKey('2001:db8:85a3:8d4::1'), networkKey('2001:db8:85a3:8d3::1'));
  for (const odd of ['', undefined, 'unknown', 'not an ip', '1:2:3', ':::']) assert.equal(typeof networkKey(odd), 'string');
  assert.equal(networkKey(''), 'unknown');
});

test('with the real wallet code: a wallet\'s age is read from the chain', async () => {
  const app = await startApp({ real: true, env: { MIN_WALLET_AGE_DAYS: '7' } });
  try {
    const made = await app.call('/api/admin/batches', { token: ADMIN, body: { name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 10, counts: { s: 1 }, endsAt: app.clock.t + 3_600_000 } });
    const drop = app.game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').get(made.json.batch.id);
    const hunter = wallet();
    const body = { dropId: drop.id, address: hunter, device: 'dev-http-age0000', lat: drop.lat, lng: drop.lng, acc: 8 };
    const refused = await app.call('/api/claim', { body });
    assert.deepEqual([refused.status, refused.json.error], [403, 'wallet_new']);
    assert.equal(app.node.landed.size, 0);
    app.node.firstUsed.set(hunter, Date.now() - 30 * 86_400_000);
    assert.equal((await app.call('/api/claim', { body })).status, 200);
    assert.equal(app.node.balances.get(hunter), 0.05 * SOL);
  } finally {
    await app.close();
  }
});

test('behind proxies, the visitor is who the last proxy says, not who the request claims to be', async () => {
  // (The test server is reached over the loopback address, which is what a proxy on the host's own network looks like.)
  const db = openDb(':memory:');
  const body = () => ({ dropId: 1, address: wallet(), device: 'dev-http-proxy00', lat: HERE.lat, lng: HERE.lng, acc: 8 });
  const SITE = 'solanago.example';
  const claimAs = (app, forwarded, host = SITE) => app.send('POST', '/api/claim', { host, ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) }, body()).then((r) => r.status);
  /** Twelve tries a minute are allowed per visitor; returns how the 13th and 14th were answered. */
  const hammer = async (app, forwardedFor, host) => {
    const out = [];
    for (let i = 0; i < 14; i++) out.push(await claimAs(app, forwardedFor(i), host));
    return out.slice(12);
  };
  const admin = (app, forwarded, host = SITE, token = ADMIN, extra = {}) => app.send('GET', '/api/admin/overview', { host, authorization: `Bearer ${token}`, ...(forwarded ? { 'x-forwarded-for': forwarded } : {}), ...extra });
  /** Thirty wrong passwords a minute are allowed per visitor. If typed headers were believed, each of these would count as someone new. */
  const typedHeadersBelieved = async (app, host = SITE) => {
    let last;
    for (let i = 0; i < 32; i++) last = (await admin(app, `10.77.0.${i}`, host, 'guess')).status;
    return last !== 429;
  };
  let app = await startApp({ db });
  try {
    // before anything is known about the proxies, a typed header proves nothing
    assert.equal(await typedHeadersBelieved(app), false);
    // ...and since visitors cannot be told apart yet, limits meant for one person are not applied to all of them together
    assert.deepEqual(await hammer(app, (i) => `10.0.9.${i}`), [404, 404]);
  } finally {
    await app.close();
  }
  app = await startApp({ db });
  try {
    // the admin opens the console through the site: one proxy added one entry
    assert.equal((await admin(app, '203.0.113.5')).status, 200);
    assert.equal(app.game.getKV('proxy_hops'), '1');
    assert.deepEqual(await hammer(app, (i) => `10.0.0.${i}, 198.51.100.77`), [429, 429], 'made-up addresses in front do not buy more tries');
    assert.equal(await claimAs(app, '10.0.0.1, 198.51.100.78'), 404, 'a different real visitor is not affected');
    // calling the site by another name (its address with a port, a trailing dot, the host's own name) changes nothing
    for (const alias of ['solanago.example:443', 'solanago.example.', 'app.host.example', '']) {
      assert.deepEqual(await hammer(app, (i) => `10.5.0.${i}, 198.51.100.77`, alias), [429, 429], `Host "${alias}"`);
    }
    // a wrong password teaches nothing, and neither does an admin request that carries no entry at all
    await admin(app, 'a, b, c, d', SITE, 'guess');
    await admin(app, '');
    assert.equal(app.game.getKV('proxy_hops'), '1');
  } finally {
    await app.close();
  }
  app = await startApp({ db });
  try {
    assert.deepEqual(await hammer(app, (i) => `10.1.0.${i}, 198.51.100.90`), [429, 429], 'and it is remembered across a restart');
  } finally {
    await app.close();
  }

  // A second proxy is put in front of the site (Cloudflare, say). The admin's next request shows two entries and the
  // number follows at once: believing in one too few would make every visitor look like that new proxy.
  const grown = await startApp({ env: { PUBLIC_URL: `https://${SITE}` } });
  try {
    await admin(grown, '203.0.113.5');
    assert.equal(grown.game.getKV('proxy_hops'), '1');
    assert.equal((await admin(grown, '203.0.113.5, 198.51.100.200')).json.networkWarning, '');
    assert.equal(grown.game.getKV('proxy_hops'), '2');
    assert.deepEqual(await hammer(grown, () => '203.0.113.1, 198.51.100.200'), [429, 429]);
    assert.equal(await claimAs(grown, '192.0.2.77, 198.51.100.200'), 404, 'two people behind the outer proxy are two visitors, not one');
    // The admin looks in through a side door: the host's own address for the app, or the server itself through the
    // inner proxy only. One entry instead of two. That says nothing about how visitors arrive, so nothing changes.
    for (const sideDoor of ['solanago-production.up.host.example', '127.0.0.1:8080', '']) {
      const seen = await admin(grown, '203.0.113.5', sideDoor);
      assert.match(seen.json.networkWarning, /fewer proxies/, `Host "${sideDoor}"`);
      assert.equal(grown.game.getKV('proxy_hops'), '2', `Host "${sideDoor}"`);
    }
    assert.equal(await claimAs(grown, '192.0.2.78, 198.51.100.200'), 404, 'visitors are still told apart');
    assert.equal((await admin(grown, '203.0.113.5, 198.51.100.200')).json.networkWarning, '', 'and the notice goes away on the next ordinary visit');
    // The outer proxy is taken away again. Through the site's own address one entry is the truth, and it is believed,
    // however the address is written and whichever header the host passes it on in.
    const names = [[SITE, {}], [`www.${SITE}`, {}], [`${SITE}:443`, {}], [`${SITE.toUpperCase()}.`, {}], ['10.0.0.9:8080', { 'x-forwarded-host': SITE }]];
    for (const [host, extra] of names) {
      await admin(grown, '203.0.113.5, 198.51.100.200');
      assert.equal(grown.game.getKV('proxy_hops'), '2');
      assert.equal((await admin(grown, '203.0.113.5', host, ADMIN, extra)).json.networkWarning, '', host);
      assert.equal(grown.game.getKV('proxy_hops'), '1', host);
    }
    assert.deepEqual(await hammer(grown, (i) => `10.6.0.${i}, 198.51.100.95`), [429, 429], 'so made-up addresses in front buy nothing again');
    // a wrong password through the front door teaches nothing in either direction
    await admin(grown, 'a, b, c', SITE, 'guess');
    assert.equal(grown.game.getKV('proxy_hops'), '1');
  } finally {
    await grown.close();
  }
  // Without PUBLIC_URL the server cannot tell the front door from a side door, so it never lowers the number by
  // itself: it says what it saw and leaves the choice to the owner.
  const unanchored = await startApp();
  try {
    await admin(unanchored, '192.0.2.10, 203.0.113.5');
    const later = await admin(unanchored, '203.0.113.5');
    assert.equal(unanchored.game.getKV('proxy_hops'), '2');
    assert.match(later.json.networkWarning, /PUBLIC_URL/);
    assert.match(later.json.networkWarning, /TRUST_PROXY/);
  } finally {
    await unanchored.close();
  }
  // TRUST_PROXY sets the number by hand, which is how a second proxy (Cloudflare in front of the host) is declared
  const pinned = await startApp({ env: { TRUST_PROXY: '2' } });
  try {
    await admin(pinned, '203.0.113.5');
    assert.equal(pinned.game.getKV('proxy_hops'), null);
    assert.deepEqual(await hammer(pinned, (i) => `10.3.0.${i}, 198.51.100.93, 172.16.0.1`), [429, 429]);
    assert.equal(await claimAs(pinned, '10.3.0.1, 198.51.100.94, 172.16.0.1'), 404, 'visitors behind the same outer proxy are told apart');
  } finally {
    await pinned.close();
  }
  // ...and 0 switches the header off for a server that visitors reach directly
  const direct = await startApp({ env: { TRUST_PROXY: '0' } });
  try {
    assert.equal(await typedHeadersBelieved(direct), false);
  } finally {
    await direct.close();
  }
  assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
});

test('a proxy that hides visitors\' addresses is reported, and does not turn one person\'s limits into everyone\'s', async () => {
  const app = await startApp({ real: true, env: { CLAIMS_PER_IP_PER_DAY: '2' } });
  try {
    const made = await app.call('/api/admin/batches', { token: ADMIN, body: { name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 10, counts: { s: 30 }, endsAt: app.clock.t + 3_600_000 } });
    assert.equal(made.status, 200);
    const drops = app.game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').all(made.json.batch.id);
    // thirty different people, all arriving through a proxy that passes no address on (plain nginx proxy_pass)
    const results = [];
    for (const [i, drop] of drops.entries()) {
      results.push((await app.call('/api/claim', { body: { dropId: drop.id, address: wallet(), device: `dev-http-crowd${String(i).padStart(2, '0')}`, lat: drop.lat, lng: drop.lng, acc: 8 } })).status);
    }
    assert.deepEqual([...new Set(results)], [200], 'nobody is turned away for what the crowd did: a daily allowance of 2 per network would have stopped the game at 2');
    // someone typing an address of their own into the header gains nothing by it: still not believed
    assert.equal((await app.call('/api/claim', { body: { dropId: 987654, address: wallet(), device: 'dev-http-crowdxx', lat: HERE.lat, lng: HERE.lng, acc: 8 }, headers: { 'x-forwarded-for': '8.8.8.8' } })).status, 404);
    assert.equal(app.game.getKV('proxy_hops'), null);
    const overview = (await app.call('/api/admin/overview', { token: ADMIN })).json;
    assert.match(overview.networkWarning, /cannot tell visitors apart/);
    assert.match(overview.networkWarning, /X-Forwarded-For/);
  } finally {
    await app.close();
  }
});

test("the admin looking in through a side door does not turn one person's limits into everyone's", async () => {
  // Visitors arrive through two proxies: an outer one (a CDN on the internet, or a load balancer on the host's own
  // network) and an inner one on the server. The test plays the inner proxy.
  for (const outer of ['198.51.100.200', '10.0.0.5']) {
    const app = await startApp({ env: { CLAIMS_PER_IP_PER_DAY: '1' } });
    try {
      const through = (visitor) => ({ 'x-forwarded-for': `${visitor}, ${outer}` });
      const made = await app.call('/api/admin/batches', { token: ADMIN, headers: through('203.0.113.50'), body: { name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 10, counts: { s: 3 }, endsAt: app.clock.t + 3_600_000 } });
      assert.equal(made.status, 200);
      assert.equal(app.game.getKV('proxy_hops'), '2');
      const drops = app.game.db.prepare('SELECT * FROM drops WHERE batch_id = ?').all(made.json.batch.id);
      // the admin runs a command on the server itself, which goes through the inner proxy only: one entry
      assert.equal((await app.call('/api/admin/overview', { token: ADMIN, headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 200);
      assert.equal(app.game.getKV('proxy_hops'), '2', outer);
      const claim = (n, visitor) => app.call('/api/claim', { headers: through(visitor), body: { dropId: drops[n].id, address: wallet(), device: `dev-http-side000${n}`, lat: drops[n].lat, lng: drops[n].lng, acc: 8 } });
      assert.equal((await claim(0, '203.0.113.1')).status, 200, outer);
      assert.equal((await claim(1, '192.0.2.77')).status, 200, `${outer}: someone else behind the same outer proxy has an allowance of their own`);
      const again = await claim(2, '203.0.113.1');
      assert.deepEqual([again.status, again.json.error], [429, 'ip_limit'], `${outer}: and the allowance of one a day still holds for each of them`);
    } finally {
      await app.close();
    }
  }
});

test('the admin console says so when visitors cannot be told apart', async () => {
  // with real money in play
  const live = await startApp({ real: true });
  try {
    const overview = (headers = {}) => live.call('/api/admin/overview', { token: ADMIN, headers }).then((r) => r.json.networkWarning);
    assert.match(await overview(), /X-Forwarded-For/, 'a proxy that passes no visitor address on');
    assert.equal(await overview({ 'x-forwarded-for': '203.0.113.5' }), '', 'fixed: the warning goes away');
  } finally {
    await live.close();
  }
  // trying the app out with pretend money on your own computer is not a misconfiguration
  const practice = await startApp();
  try {
    assert.equal((await practice.call('/api/admin/overview', { token: ADMIN })).json.networkWarning, '');
  } finally {
    await practice.close();
  }
  assert.deepEqual(proxyAdvice({ internal: true, seen: 1 }), { learn: 1 });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 3 }), { learn: 3 });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 1, known: 1 }), {});
  assert.deepEqual(proxyAdvice({ internal: true, seen: 1, known: 1, frontDoor: true }), {});
  // more proxies than believed in: followed at once, whichever way the admin came in
  assert.deepEqual(proxyAdvice({ internal: true, seen: 2, known: 1 }), { learn: 2 });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 2, known: 1, frontDoor: true }), { learn: 2 });
  // fewer: believed only through the front door, and otherwise reported
  assert.deepEqual(proxyAdvice({ internal: true, seen: 1, known: 2 }), { warning: 'fewer' });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 1, known: 2, frontDoor: true }), { learn: 1 });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 0 }), { warning: 'no_header' });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 0, known: 1 }), {}, 'the admin came in by a side door on a server that is set up fine');
  assert.deepEqual(proxyAdvice({ internal: true, seen: 0, known: 2, frontDoor: true }), {}, 'no entries at all never lowers the number');
  assert.deepEqual(proxyAdvice({ internal: true, seen: 50 }), { warning: 'no_header' });
  assert.deepEqual(proxyAdvice({ internal: true, seen: 50, known: 1, frontDoor: true }), {}, 'nor does an absurd number raise it');
  // straight from the internet with no proxy: fine. Through a public proxy such as Cloudflare: needs CLIENT_IP_HEADER
  assert.deepEqual(proxyAdvice({ internal: false, seen: 0 }), {});
  assert.deepEqual(proxyAdvice({ internal: false, seen: 1 }), { warning: 'public_proxy' });
  assert.deepEqual(proxyAdvice({ internal: false, seen: 0, publicProxyHeader: true }), { warning: 'public_proxy' });
});

test('the admin cannot be locked out by strangers, and wrong passwords are slowed down', async () => {
  const app = await startApp();
  try {
    const from = { 'x-forwarded-for': '203.0.113.5' };
    const wrong = [];
    for (let i = 0; i < 40; i++) wrong.push((await app.call('/api/admin/pause', { token: `guess-${i}`, body: { paused: true }, headers: from })).status);
    assert.deepEqual([...new Set(wrong.slice(0, 30))], [401]);
    assert.deepEqual([...new Set(wrong.slice(30))], [429]);
    assert.equal(app.game.paused, false);
    // the real admin, from the very same address, still gets through, however busy the console is
    const right = [];
    for (let i = 0; i < 350; i++) right.push((await app.call('/api/admin/overview', { token: ADMIN, headers: from })).status);
    assert.deepEqual([...new Set(right)], [200]);
    assert.equal((await app.call('/api/admin/pause', { token: ADMIN, body: { paused: true }, headers: from })).json.paused, true);
  } finally {
    await app.close();
  }
});

test('odd JSON gets a plain refusal, never a server error', async () => {
  const app = await startApp();
  try {
    const weird = [{ toString: 1 }, { valueOf: 1 }, [], [1, 2], {}, null, true, 1e999, -0, '\u0000', 'x'.repeat(5000), { __proto__: { admin: true } }];
    for (const v of weird) {
      for (const field of ['dropId', 'address', 'device', 'lat', 'lng', 'acc']) {
        const body = { dropId: 987654, address: wallet(), device: 'dev-http-odd0000', lat: HERE.lat, lng: HERE.lng, acc: 8, [field]: v }; // no such drop, so nothing here can succeed
        const res = await app.call('/api/claim', { body, headers: { 'x-forwarded-for': `10.9.${weird.indexOf(v)}.${field.length}` } });
        assert.ok(res.status >= 400 && res.status < 500, `${field}=${JSON.stringify(v)} gave ${res.status}`);
      }
      for (const field of ['name', 'area', 'lat', 'lng', 'radiusM', 'totalSol', 'counts', 'goldShare', 'startsAt', 'endsAt', 'earlyMin', 'onePerPerson']) {
        const body = { name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 100, totalSol: 1, endsAt: Date.now() + 3_600_000, [field]: v };
        const res = await app.call('/api/admin/batches', { token: ADMIN, body });
        assert.ok(res.status === 200 || (res.status >= 400 && res.status < 500), `batch ${field}=${JSON.stringify(v)} gave ${res.status}`);
        if (res.status === 200) assert.ok(Number.isSafeInteger(res.json.batch.totalLamports) && res.json.batch.totalLamports > 0 && Math.abs(res.json.batch.lat) <= 90);
      }
      for (const field of ['enabled', 'everyHours', 'durationHours', 'minSol', 'maxSol', 'goldShare', 'areas']) {
        const res = await app.call('/api/admin/auto', { token: ADMIN, body: { enabled: true, areas: [{ name: 'Park', lat: HERE.lat, lng: HERE.lng, radiusM: 100 }, v], [field]: v } });
        assert.equal(res.status, 200, `schedule ${field}=${JSON.stringify(v)} gave ${res.status}`);
      }
      const preview = await app.call('/api/admin/preview', { token: ADMIN, body: { totalSol: v, goldShare: v, counts: v } });
      assert.ok(preview.status === 200 || preview.status === 400, `preview ${JSON.stringify(v)} gave ${preview.status}`);
    }
    assert.equal((await app.call('/api/admin/batches', { token: ADMIN, body: { name: 'Nowhere', lat: null, lng: '', radiusM: 100, totalSol: 1, endsAt: Date.now() + 3_600_000 } })).status, 400, 'a batch without a real position is refused, not put at 0,0');
    for (const query of ['lat=1e999&lng=x', 'lat=&lng=&device=&address=', `device=${'d'.repeat(4000)}`, 'lat=35.67&lng=139.70&acc=-1&address=%00']) {
      assert.equal((await app.call(`/api/sync?${query}`)).status, 200);
    }
    assert.equal((await app.call('/healthz')).status, 200);
  } finally {
    await app.close();
  }
});

test('files are closed again when a visitor hangs up half way', { skip: process.platform !== 'linux' }, async () => {
  const net = await import('node:net');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solanago-fd-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'home');
  fs.writeFileSync(path.join(root, 'small.png'), Buffer.alloc(200_000, 1));
  fs.writeFileSync(path.join(root, 'huge.png'), Buffer.alloc(6 * 1024 * 1024, 2)); // over the in-memory limit, so it is streamed
  const app = await startApp({ env: { PUBLIC_DIR: root } });
  const openFiles = () => fs.readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(root);
    } catch {
      return false;
    }
  }).length;
  const hangUp = (file) => new Promise((resolve) => {
    const socket = net.connect(app.port, '127.0.0.1', () => {
      socket.write(`GET /${file} HTTP/1.1\r\nHost: x\r\n\r\n`);
      socket.once('data', () => {
        socket.destroy(); // the first bytes arrive, then the visitor is gone
        resolve();
      });
    });
    socket.on('error', resolve);
  });
  try {
    for (let i = 0; i < 40; i++) await Promise.all([hangUp('huge.png'), hangUp('small.png')]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(openFiles(), 0);
    const whole = await fetch(`http://127.0.0.1:${app.port}/huge.png`);
    assert.equal((await whole.arrayBuffer()).byteLength, 6 * 1024 * 1024, 'and a patient visitor still gets the whole file');
    assert.equal((await app.call('/small.png')).headers.get('content-length'), '200000');
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pages only run script files from this server; the demo is the one exception', async () => {
  const app = await startApp();
  try {
    for (const page of ['/', '/admin']) {
      const res = await app.call(page);
      assert.match(res.headers.get('content-security-policy'), /script-src 'self';/, page);
      assert.equal([...res.text.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].length, 0, `${page} has no inline script`);
      assert.doesNotMatch(res.text, /\son[a-z]+\s*=\s*["']/, `${page} has no inline event handlers`);
    }
    assert.match((await app.call('/demo')).headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline';/);
    assert.match((await app.call('/api/config')).headers.get('content-security-policy'), /script-src 'self';/);
  } finally {
    await app.close();
  }
  // /api/me cannot be used by one visitor to make the server look up wallets without end
  const known = await startApp({ env: { CLIENT_IP_HEADER: 'x-visitor' } });
  try {
    const statuses = [];
    for (let i = 0; i < 45; i++) statuses.push((await known.call(`/api/me?address=${wallet()}`, { headers: { 'x-visitor': '203.0.113.77' } })).status);
    assert.deepEqual([statuses.slice(0, 40).every((x) => x === 200), statuses.slice(40).every((x) => x === 429)], [true, true]);
    assert.equal((await known.call(`/api/me?address=${wallet()}`, { headers: { 'x-visitor': '203.0.113.78' } })).status, 200);
  } finally {
    await known.close();
  }
});

test('working out who a visitor is, for every way the server can be set up', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.9', '169.254.1.1', '::1', '::ffff:10.0.0.1', 'fd12:3456::1', 'fe80::1']) assert.equal(isInternalAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.1.1', '::ffff:8.8.8.8', '2001:db8::1', '', undefined, 'unknown']) assert.equal(isInternalAddress(ip), false, String(ip));

  const who = (socket, forwarded, hops, pinned = false) => visitorAddress({ socket, chain: forwarded ? forwarded.split(', ') : [], hops, pinned });
  // visitors connect straight to the server: the header is theirs to invent, so it is never believed...
  assert.equal(who('203.0.113.9', '', null), '203.0.113.9');
  assert.equal(who('203.0.113.9', '1.1.1.1', null), '203.0.113.9');
  assert.equal(who('203.0.113.9', '1.1.1.1, 2.2.2.2', 0, true), '203.0.113.9');
  // ...even after a proxy count was learned on some other route (the origin reached directly, past its proxy)
  assert.equal(who('203.0.113.9', '1.1.1.1', 1), '203.0.113.9');
  assert.equal(who('203.0.113.9', '1.1.1.1, 2.2.2.2', 2), '203.0.113.9');
  // one proxy on the host's network (most hosts): once the count is known, only the entry the proxy added counts
  assert.equal(who('10.0.0.2', '203.0.113.9', 1), '203.0.113.9');
  assert.equal(who('10.0.0.2', '1.1.1.1, 203.0.113.9', 1), '203.0.113.9');
  // two proxies (for example Cloudflare, then the host)
  assert.equal(who('10.0.0.2', '203.0.113.9, 172.70.1.1', 2), '203.0.113.9');
  assert.equal(who('10.0.0.2', '1.1.1.1, 203.0.113.9, 172.70.1.1', 2), '203.0.113.9');
  // before the count is known, nothing in the header is believed: the visitor is the proxy itself for now
  assert.equal(who('10.0.0.2', '203.0.113.9', null), '10.0.0.2');
  assert.equal(who('10.0.0.2', '1.1.1.1, 203.0.113.9', null), '10.0.0.2');
  // the owner said how many proxies there are (TRUST_PROXY): believed whatever the connection looks like,
  // which is what a public proxy straight in front of the server needs
  assert.equal(who('172.70.1.1', '1.1.1.1, 203.0.113.9', 1, true), '203.0.113.9');
  // a request that came through fewer proxies than expected still resolves to its first entry, never to nothing
  assert.equal(who('10.0.0.2', '203.0.113.9', 3), '203.0.113.9');
  assert.equal(who(undefined, '', null), 'unknown');
});

test('an RPC that has stopped answering does not freeze the map or the admin console', async () => {
  const app = await startApp();
  try {
    app.game.patienceMs = 60;
    app.game.lookupLimitMs = 200;
    const never = () => new Promise(() => {});
    app.chain.tokenBalance = never;
    app.chain.accountKind = never;
    app.chain.balanceAt = never;
    const address = wallet();
    const started = Date.now();
    const sync = await app.call(`/api/sync?lat=${HERE.lat}&lng=${HERE.lng}&acc=8&device=dev-http-slow000&address=${address}`);
    assert.deepEqual([sync.status, sync.json.tier, sync.json.balance], [200, 0, 0]);
    assert.equal(app.game.pings.get('dev-http-slow000').length, 1, 'the phone\'s position was taken down all the same');
    const me = await app.call(`/api/me?address=${address}`);
    assert.deepEqual([me.status, me.json.kind, me.json.hint], [200, 'unknown', '']);
    const overview = await app.call('/api/admin/overview', { token: ADMIN });
    assert.deepEqual([overview.status, overview.json.balance], [200, 20 * SOL], 'the console shows the last balance it knows');
    assert.equal((await app.call('/api/admin/pause', { token: ADMIN, body: { paused: true } })).json.paused, true, 'and the pause button works');
    assert.ok(Date.now() - started < 3000, `answered in ${Date.now() - started} ms`);
  } finally {
    await app.close();
  }
});

