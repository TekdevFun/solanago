// Settings come from environment variables (or a .env file next to package.json when running locally).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loads KEY=VALUE lines from a file into process.env without overwriting what is already set. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/** A web address that will be used as a link: only http(s) is accepted. */
function webLink(value, fallback, name) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a web address starting with https://`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must be a web address starting with https://`);
  return url.href;
}

/**
 * TRUST_PROXY: how many proxies stand between visitors and the app.
 * Empty or "auto" (the default) lets the server work it out; 0 means visitors connect straight to it.
 */
function proxyHops(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'auto') return null;
  if (['false', 'no', 'off'].includes(raw)) return 0;
  if (['true', 'yes', 'on'].includes(raw)) return 1;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
  throw new Error('TRUST_PROXY must be auto, 0, or the number of proxies in front of the app');
}

/** PUBLIC_URL ends up inside pages, so only a plain web address is accepted. */
function siteOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_URL must look like https://your-site.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PUBLIC_URL must start with https://');
  return url.origin;
}

export function loadConfig(env = process.env) {
  // A number that is not one (a typo, a value pasted with its quotes) is refused, not quietly swapped for the default.
  // (The value itself is never repeated in the message: settings pasted into the wrong box can be secrets.)
  const num = (key, fallback) => {
    if (env[key] === undefined || String(env[key]).trim() === '') return fallback;
    const n = Number(env[key]);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    return n;
  };
  const sol = (key, fallback) => Math.round(num(key, fallback) * 1e9);
  const tierValues = (env.DROP_SIZES_SOL || '0.05,0.5,1').split(',').map((v) => Math.round(Number(v) * 1e9));
  const tierLevels = (env.TIER_LEVELS || '100000,1000000,5000000').split(',').map(Number);
  if (tierValues.length !== 3 || tierValues.some((v) => !(v > 0))) throw new Error('DROP_SIZES_SOL must be three positive numbers, small,mid,big');
  // The network refuses a transfer that would leave a brand-new wallet below its minimum balance (about 0.0009 SOL).
  if (tierValues.some((v) => v < 1_000_000)) throw new Error('DROP_SIZES_SOL: each drop must be at least 0.001 SOL, or payouts to new wallets fail');
  if (!(tierValues[0] <= tierValues[1] && tierValues[1] <= tierValues[2])) throw new Error('DROP_SIZES_SOL must go from small to big');
  if (tierValues.some((v) => !Number.isSafeInteger(v) || v > 1000e9)) throw new Error('DROP_SIZES_SOL: a single drop cannot be more than 1,000 SOL');
  if (!(num('PRIORITY_FEE_MICROLAMPORTS', 0) <= 50_000_000)) throw new Error('PRIORITY_FEE_MICROLAMPORTS is far too high (more than 0.0001 SOL per payout). Check for a typo.');
  if (!(num('TREASURY_RESERVE_SOL', 0) >= 0)) throw new Error('TREASURY_RESERVE_SOL cannot be negative');
  if (tierLevels.length !== 3 || tierLevels.some((v) => !(v > 0))) throw new Error('TIER_LEVELS must be three positive numbers');
  if (!(tierLevels[0] <= tierLevels[1] && tierLevels[1] <= tierLevels[2])) throw new Error('TIER_LEVELS must go from low to high');
  // Settings that would quietly stop every claim are refused here instead.
  const reachM = num('CLAIM_RADIUS_M', 30);
  if (!(reachM >= 1)) throw new Error('CLAIM_RADIUS_M must be at least 1 (metres)');
  if (!(num('MAX_GPS_ACCURACY_M', 65) >= 1)) throw new Error('MAX_GPS_ACCURACY_M must be at least 1 (metres), or no phone could ever claim');
  if (!(num('CLAIMS_PER_IP_PER_DAY', 30) >= 1)) throw new Error('CLAIMS_PER_IP_PER_DAY must be at least 1. For no limit in practice, use a large number');
  if (!(num('MAX_SPEED_MS', 15) > 0)) throw new Error('MAX_SPEED_MS must be more than 0');
  if (!(num('NEARBY_KM', 5) > 0)) throw new Error('NEARBY_KM must be more than 0');
  return {
    root: ROOT,
    publicDir: env.PUBLIC_DIR ? path.resolve(env.PUBLIC_DIR) : path.join(ROOT, 'public'),
    port: num('PORT', 8080),
    publicUrl: siteOrigin(env.PUBLIC_URL), // e.g. https://solanago.app, used for link previews
    dbPath: env.DATABASE_PATH || path.join(ROOT, 'data', 'solanago.db'),

    // chain
    rpcUrl: env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    treasurySecret: env.TREASURY_SECRET_KEY || '',
    priorityMicroLamports: num('PRIORITY_FEE_MICROLAMPORTS', 20_000),
    reserveLamports: sol('TREASURY_RESERVE_SOL', 0.02),
    explorerTx: env.EXPLORER_TX_URL || 'https://solscan.io/tx/{sig}',
    explorerAddress: env.EXPLORER_ADDRESS_URL || 'https://solscan.io/account/{address}',

    // token and perks
    tokenTicker: env.TOKEN_TICKER || 'SolanaGO',
    tokenMint: env.TOKEN_MINT || '',
    tokenUrl: webLink(env.TOKEN_URL, '', 'TOKEN_URL'),
    tierLevels, // holdings needed for tier 1, 2, 3
    earlyMin: num('EARLY_ACCESS_MIN', 15), // tier 1: minutes of head start
    goldTier: 2, // tier needed for holder-only drops
    reachM,
    reachTopM: Math.max(reachM, num('CLAIM_RADIUS_TOP_TIER_M', 50)), // tier 3. Never shorter than everyone else's reach

    // drops
    tierValues: { s: tierValues[0], m: tierValues[1], l: tierValues[2] },
    fuzzM: num('DROP_FUZZ_M', 12), // how far the map pin sits from the true spot until you are close
    nearbyKm: num('NEARBY_KM', 5),

    // anti-abuse
    maxAccuracyM: num('MAX_GPS_ACCURACY_M', 65),
    trailMinPings: num('TRAIL_MIN_PINGS', 3),
    trailMinSeconds: num('TRAIL_MIN_SECONDS', 20),
    maxSpeedMs: num('MAX_SPEED_MS', 15),
    claimsPerIpPerDay: num('CLAIMS_PER_IP_PER_DAY', 30),
    minWalletLamports: sol('MIN_WALLET_SOL', 0),
    minWalletAgeDays: Math.max(0, num('MIN_WALLET_AGE_DAYS', 0)), // 0 = any wallet may claim
    proxyHops: proxyHops(env.TRUST_PROXY),
    clientIpHeader: (env.CLIENT_IP_HEADER || '').trim().toLowerCase(), // e.g. cf-connecting-ip or fly-client-ip
    holderLookupsPerMin: Math.max(1, num('HOLDER_LOOKUPS_PER_MIN', 600)), // token-balance lookups the server will make per minute for visitors

    // admin
    adminToken: env.ADMIN_TOKEN || '',
    serverSecret: env.SERVER_SECRET || '', // when empty, the app makes one and keeps it in the database

    // map
    tileUrl: env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: env.MAP_ATTRIBUTION || '© OpenStreetMap contributors',
    tileAttributionUrl: webLink(env.MAP_ATTRIBUTION_URL, 'https://www.openstreetmap.org/copyright', 'MAP_ATTRIBUTION_URL'),
    tileMaxZoom: num('MAP_MAX_ZOOM', 19),
    homeLat: num('HOME_LAT', 35.6702),
    homeLng: num('HOME_LNG', 139.7027),

    appName: env.APP_NAME || 'SolanaGO',
  };
}
