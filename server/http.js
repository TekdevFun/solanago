// The web server: the public API, the admin API and the static app files.
// Built on Node's own http module so there is nothing to install.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { GameError, soon } from './game.js';
import { placeName } from './geocode.js';
import { WORLD_PLACES } from './places.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/demo': 'demo.html' };
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);
// Pages and code are checked with the server on every visit, so a new version reaches phones at once. Images can wait a day.
const REVALIDATE = new Set(['.html', '.js', '.css', '.webmanifest']);
const KEEP_IN_MEMORY = 4 * 1024 * 1024; // files up to this size are served from memory

const csp = (scripts) =>
  [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
const CSP = csp("'self'"); // the app and the admin console only run script files from this server
const CSP_DEMO = csp("'self' 'unsafe-inline'"); // the demo is one self-contained page with its script inside

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(self), camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), microphone=()',
  'content-security-policy': CSP,
};

/** Counts requests per key in fixed windows. Good enough to stop hammering from one address. */
class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  allow(key, max, windowMs, now = Date.now()) {
    const slot = this.hits.get(key);
    if (!slot || now - slot.start >= windowMs) {
      if (this.hits.size > 100_000) this.hits.clear();
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    slot.n++;
    return slot.n <= max;
  }
}

/**
 * One key per visitor network: the address itself for IPv4, the /64 block for IPv6
 * (a phone can hop between addresses inside its own block, so the block is what identifies it).
 */
export function networkKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') < 0 ? undefined : s.indexOf(']'));
  if (s.includes('%')) s = s.slice(0, s.indexOf('%'));
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  if (v4) return v4[1];
  if (!s.includes(':')) return s || 'unknown';
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Loopback, private-network and link-local addresses: where a proxy on the host's own network connects from. */
export function isInternalAddress(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return s === '::1' || /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
}

/**
 * Works out a visitor's address from what a request shows.
 *
 * Every proxy between a visitor and the server adds the address it saw to the end of X-Forwarded-For. With N
 * proxies, the visitor's own address is N entries from the right, and anything further left was typed by the
 * visitor and proves nothing.
 *
 *   socket   the address that actually connected to us
 *   chain    the X-Forwarded-For entries, left to right
 *   hops     N, or null when it is not known
 *   pinned   true when the owner set N with TRUST_PROXY, false when the server learned it
 *
 * The header is believed only when there is a reason to: the owner said so, or the connection comes from the
 * host's own network (so a proxy sent it) and N has been learned. In every other case the visitor is whoever
 * connected, which nobody can fake.
 */
export function visitorAddress({ socket, chain, hops, pinned = false }) {
  const direct = socket || 'unknown';
  if (!hops || !chain.length) return direct;
  if (!pinned && !isInternalAddress(direct)) return direct;
  return chain[Math.max(0, chain.length - hops)];
}

/**
 * What one of the admin's own requests says about how visitors reach the app.
 * Returns { learn } with the number of proxies to believe in from now on, or { warning } naming a set-up worth a notice.
 *
 *   internal   the connection came from the host's own network (so from a proxy), not from the internet
 *   seen       how many X-Forwarded-For entries the request carried
 *   publicProxyHeader  the request carried a header only a public proxy such as Cloudflare adds
 *   known      the number believed so far, or null
 *   frontDoor  the request came in through the site's own address (PUBLIC_URL), the way visitors do
 *
 * The two ways of being wrong are not equally bad. Believing in one proxy too many lets someone who types the header
 * themselves pick their own address, which dodges a limit. Believing in one too few makes every visitor look like
 * the proxy in front of them, and then one person's limits land on everybody. So the number goes up as soon as any
 * admin request shows more proxies, but it only comes down on the word of a request through the front door: a look
 * in through a side door (the host's own address, a tunnel, the server itself) says nothing about how visitors arrive.
 */
export function proxyAdvice({ internal, seen, publicProxyHeader, known = null, frontDoor = false }) {
  if (internal && seen >= 1 && seen <= 10) {
    if (known === null || seen > known || (frontDoor && seen < known)) return { learn: seen };
    return seen < known ? { warning: 'fewer' } : {};
  }
  // No entries at all. If the number is already known, the admin simply came in by a side door (the server itself,
  // a tunnel) and nothing is wrong. If it is not, a proxy may be hiding visitors' addresses.
  if (internal) return known === null ? { warning: 'no_header' } : {};
  if (seen >= 1 || publicProxyHeader) return { warning: 'public_proxy' };
  return {};
}
const NETWORK_WARNINGS = {
  fewer:
    "This request came through fewer proxies than the app allows for. If you only opened this console through a different address than your visitors use, ignore this. If you took a proxy such as Cloudflare away from in front of the site: set PUBLIC_URL to the site's address, restart, and open this console through that address. (Or set TRUST_PROXY to the new number of proxies and restart.) Until then, someone who knows how could dodge the limits per network.",
  no_header:
    "The app cannot tell visitors apart: requests reach it from the server's own network with no visitor address on them, so the daily allowance per network is switched off. If a proxy such as nginx is in front, make it send X-Forwarded-For (nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;) and restart the app.",
  public_proxy:
    "Requests reach the app through a proxy on the public internet (Cloudflare, for example), so the app sees everyone as that proxy. Set CLIENT_IP_HEADER to the header your proxy puts the visitor's address in (Cloudflare: cf-connecting-ip).",
};
/** A host name as typed in an address, without port, "www." or a trailing dot, for comparing two of them. */
const bareHost = (name) => String(name || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');

function sameToken(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Whatever arrives in a request is turned into a plain string or number here, so odd JSON can never throw later.
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new GameError('too_large', 'Request is too large.', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        reject(new GameError('bad_json', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ game, cfg, log = console }) {
  const limiter = new RateLimiter();
  const fileCache = new Map(); // file path -> { mtimeMs, raw, gzip }

  const send = (res, status, body, headers = {}) => {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': TYPES['.json'], 'cache-control': 'no-store', 'content-length': payload.length, ...headers });
    res.end(payload);
  };

  /* ---------- who is asking ---------- */

  // How many proxies are in front (see visitorAddress). TRUST_PROXY pins the number. Otherwise the server reads it
  // off the admin's own requests (see proxyAdvice): they carry the password, so nobody else can stage one, and a
  // browser adds no such header itself, so every entry on one was put there by a real proxy.
  const pinned = cfg.proxyHops !== null;
  let learned = null;
  if (!pinned) {
    const saved = game.getKV('proxy_hops');
    if (saved !== null && /^([1-9]|10)$/.test(saved)) learned = Number(saved);
  }
  const siteHost = cfg.publicUrl ? bareHost(new URL(cfg.publicUrl).host) : '';
  const forwardedChain = (req) => String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const clientIp = (req) => {
    if (cfg.clientIpHeader) {
      const named = String(req.headers[cfg.clientIpHeader] || '').split(',')[0].trim();
      if (named) return named;
    }
    return visitorAddress({ socket: req.socket.remoteAddress, chain: forwardedChain(req), hops: pinned ? cfg.proxyHops : learned, pinned });
  };
  /**
   * The key that per-visitor limits are counted under, or '' when the visitor cannot be told from anyone else:
   * all we have is the address of a proxy on the host's own network. Limits meant for one person would then
   * land on everybody at once, so such requests only count against wide, shared ceilings.
   */
  const visitor = (req) => {
    const address = clientIp(req);
    return address === 'unknown' || isInternalAddress(address) ? '' : networkKey(address).slice(0, 64);
  };
  /** A per-visitor limit; for visitors we cannot tell apart, the same limit times `shared`, for all of them together. */
  const within = (name, ip, max, shared = 20) => limiter.allow(`${name}:${ip}`, ip ? max : max * shared, 60_000);

  let networkWarning = '';
  /** Looks at an admin request to learn how visitors reach the app, and to spot set-ups where they cannot be told apart. */
  const learnFromAdmin = (req) => {
    if (pinned || cfg.clientIpHeader) return;
    const advice = proxyAdvice({
      internal: isInternalAddress(req.socket.remoteAddress),
      seen: forwardedChain(req).length,
      publicProxyHeader: !!req.headers['cf-connecting-ip'],
      known: learned,
      frontDoor: !!siteHost && [req.headers['x-forwarded-host'], req.headers.host].some((name) => name && bareHost(name) === siteHost),
    });
    if (advice.learn) {
      log.info(`Proxies between visitors and the app: ${advice.learn}${learned === null ? '' : ` (it was ${learned})`}, read off an admin request.`);
      learned = advice.learn;
      game.setKV('proxy_hops', learned);
    }
    // Trying the app out with pretend money on your own computer looks just like a proxy that hides addresses. Say nothing then.
    const warning = advice.warning && !(advice.warning === 'no_header' && game.chain.mock) ? NETWORK_WARNINGS[advice.warning] : '';
    if (warning && warning !== networkWarning) log.warn(warning);
    networkWarning = warning;
  };

  const requireAdmin = (req, ip) => {
    if (!cfg.adminToken) throw new GameError('admin_off', 'The admin console is off until ADMIN_TOKEN is set on the server.', { status: 503 });
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (given && sameToken(given, cfg.adminToken)) return learnFromAdmin(req);
    // Only wrong passwords are slowed down, so nobody can lock the real admin out of the pause button by hammering.
    if (!within('wrong', ip, 30, 1)) throw new GameError('slow_down', 'Too many wrong passwords. Wait a minute.', { status: 429 });
    throw new GameError('unauthorized', 'Wrong admin password.', { status: 401 });
  };

  const publicConfig = () => ({
    app: cfg.appName,
    ticker: cfg.tokenTicker,
    mint: cfg.tokenMint,
    tokenUrl: cfg.tokenUrl || (cfg.tokenMint ? `https://pump.fun/coin/${cfg.tokenMint}` : ''),
    xHandle: cfg.xHandle,
    xUrl: cfg.xHandle ? `https://x.com/${cfg.xHandle}` : '',
    githubUrl: cfg.githubUrl,
    tierLevels: cfg.tierLevels,
    earlyMin: cfg.earlyMin,
    goldTier: cfg.goldTier,
    reachM: cfg.reachM,
    reachTopM: cfg.reachTopM,
    tierValues: cfg.tierValues,
    tileUrl: cfg.tileUrl,
    tileAttribution: cfg.tileAttribution,
    tileAttributionUrl: cfg.tileAttributionUrl,
    tileMaxZoom: cfg.tileMaxZoom,
    explorerTx: cfg.explorerTx,
    explorerAddress: cfg.explorerAddress,
    treasury: game.chain.address,
    practice: !!game.chain.mock,
    home: { lat: cfg.homeLat, lng: cfg.homeLng },
    nearbyKm: cfg.nearbyKm,
  });

  /* ---------- the API ---------- */

  async function adminApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/admin/overview') {
      // a fresh look at the wallet if it can be had quickly; the console must stay usable when the RPC is slow
      await soon(game.watchTreasury().catch(() => {}), game.patienceMs, () => {});
      return send(res, 200, { ...game.overview(), networkWarning });
    }
    if (route === 'POST /api/admin/preview') {
      const body = await readJson(req);
      const plan = game.planDrops({ totalLamports: Math.round(num(body.totalSol) * 1e9), counts: body.counts, goldShare: num(body.goldShare) || 0 });
      return send(res, 200, { counts: plan.counts, total: plan.total, gold: plan.gold, drops: plan.drops.length, available: game.available() });
    }
    if (route === 'POST /api/admin/batches') {
      await game.watchTreasury().catch(() => {});
      return send(res, 200, { ok: true, batch: game.createBatch(await readJson(req)) });
    }
    const end = url.pathname.match(/^\/api\/admin\/batches\/(\d{1,15})\/end$/);
    if (end && req.method === 'POST') return send(res, 200, { ok: game.endBatch(Number(end[1])) });
    if (route === 'POST /api/admin/auto') return send(res, 200, { ok: true, auto: game.setAuto(await readJson(req)) });
    if (route === 'GET /api/admin/places') return send(res, 200, { places: WORLD_PLACES });
    if (route === 'GET /api/admin/place') {
      // a name for the spot under the circle, so the admin does not have to type one
      if (!limiter.allow('geocode', 60, 60_000)) return send(res, 200, { name: '' });
      const name = await placeName(num(url.searchParams.get('lat')), num(url.searchParams.get('lng')), { tileUrl: cfg.tileUrl });
      return send(res, 200, { name });
    }
    if (route === 'POST /api/admin/pause') return send(res, 200, { ok: true, paused: game.setPaused((await readJson(req)).paused === true) });
    throw new GameError('not_found', 'No such endpoint.', { status: 404 });
  }

  async function api(req, res, url, ip) {
    if (url.pathname.startsWith('/api/admin/')) {
      requireAdmin(req, ip);
      return adminApi(req, res, url);
    }
    const route = `${req.method} ${url.pathname}`;
    const q = url.searchParams;
    if (!within('all', ip, 300)) throw new GameError('slow_down', 'Too many requests. Slow down a little.', { status: 429 });

    if (route === 'GET /api/config') return send(res, 200, publicConfig());

    if (route === 'GET /api/sync') {
      const address = q.get('address') || '';
      // fresh=1 re-reads the token balance now (the app asks when someone comes back from buying); kept rare per visitor
      const fresh = q.get('fresh') === '1' && within('fresh', ip, 6);
      const { tier, balance } = await game.tierSoon(address, { fresh, visitor: ip }); // never keeps the map waiting on a slow RPC
      const out = game.sync({ lat: num(q.get('lat')), lng: num(q.get('lng')), acc: num(q.get('acc')), device: q.get('device') || '', address, tier });
      return send(res, 200, { ...out, balance });
    }

    if (route === 'POST /api/claim') {
      if (!within('claim', ip, 12)) throw new GameError('slow_down', 'Too many tries. Wait a minute.', { status: 429 });
      const body = await readJson(req);
      const result = await game.claim({ dropId: num(body.dropId), address: text(body.address), device: text(body.device), ip, lat: num(body.lat), lng: num(body.lng), acc: num(body.acc) });
      return send(res, 200, { ok: true, ...result, explorer: cfg.explorerTx.replace('{sig}', result.signature) });
    }

    if (route === 'GET /api/me') {
      if (!within('me', ip, 40)) throw new GameError('slow_down', 'Too many requests. Slow down a little.', { status: 429 });
      return send(res, 200, await game.me(q.get('address') || '', ip));
    }
    if (route === 'GET /api/stats') return send(res, 200, game.stats());

    throw new GameError('not_found', 'No such endpoint.', { status: 404 });
  }

  /* ---------- the app's files ---------- */

  function staticFile(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    const notFound = () => {
      res.writeHead(404, { 'content-type': TYPES['.txt'] });
      res.end('Not found');
    };
    const page = PAGES[url.pathname.replace(/\/+$/, '') || '/'];
    let rel;
    try {
      rel = page || decodeURIComponent(url.pathname);
    } catch {
      rel = '';
    }
    const file = path.join(cfg.publicDir, rel);
    const hidden = path.relative(cfg.publicDir, file).split(path.sep).some((part) => part.startsWith('.'));
    if (!rel || rel.includes('\0') || hidden || !file.startsWith(cfg.publicDir + path.sep)) return notFound();
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return notFound();
      const ext = path.extname(file).toLowerCase();
      if (path.basename(file) === 'demo.html') res.setHeader('content-security-policy', CSP_DEMO);
      const headers = {
        'content-type': TYPES[ext] || 'application/octet-stream',
        'cache-control': REVALIDATE.has(ext) ? 'no-cache' : 'public, max-age=86400',
        'last-modified': stat.mtime.toUTCString(),
      };
      const since = req.headers['if-modified-since'];
      if (since && Math.floor(stat.mtimeMs / 1000) <= Math.floor(new Date(since).getTime() / 1000)) {
        res.writeHead(304, headers);
        return res.end();
      }
      if (stat.size > KEEP_IN_MEMORY) {
        res.writeHead(200, { ...headers, 'content-length': stat.size });
        if (req.method === 'HEAD') return res.end();
        // pipeline closes the file when the visitor hangs up half way; a bare pipe() would leave it open for good
        return pipeline(fs.createReadStream(file), res, () => {});
      }
      const finish = (entry) => {
        const gzipOk = COMPRESSIBLE.has(ext) && entry.raw.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
        if (gzipOk && !entry.gzip) entry.gzip = zlib.gzipSync(entry.raw);
        const body = gzipOk ? entry.gzip : entry.raw;
        res.writeHead(200, { ...headers, ...(gzipOk ? { 'content-encoding': 'gzip' } : {}), ...(COMPRESSIBLE.has(ext) ? { vary: 'accept-encoding' } : {}), 'content-length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      };
      const cached = fileCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs) return finish(cached);
      fs.readFile(file, (readErr, data) => {
        if (readErr) {
          res.writeHead(500);
          return res.end();
        }
        // Link previews on X and Telegram need full addresses, so pages can say %ORIGIN% and get the site's own.
        const raw = ext === '.html' ? Buffer.from(data.toString('utf8').replaceAll('%ORIGIN%', cfg.publicUrl).replaceAll('%X_SITE%', cfg.xHandle ? `@${cfg.xHandle}` : '')) : data;
        const entry = { mtimeMs: stat.mtimeMs, raw, gzip: null };
        if (fileCache.size > 300) fileCache.clear();
        fileCache.set(file, entry);
        finish(entry);
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (!url.pathname.startsWith('/api/')) return staticFile(req, res, url);
    try {
      await api(req, res, url, visitor(req));
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof GameError) return send(res, e.status, { ok: false, error: e.code, message: e.message, dist: e.extra.dist, reach: e.extra.reach, held: e.extra.held });
      log.error(`${req.method} ${url.pathname} failed:`, e);
      send(res, 500, { ok: false, error: 'server', message: 'Something went wrong on our side. Try again.' });
    }
  });
  // Hosts keep connections to the app open and reuse them; closing ours first causes stray 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
