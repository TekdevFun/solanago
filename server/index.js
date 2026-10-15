// Starts SolanaGO: opens the database, connects the treasury wallet, serves the app,
// and runs the background jobs (fee counter, payout checks, batch schedule).

const log = console;
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  log.error(`SolanaGO needs Node 22.13 or newer, and this is Node ${process.versions.node}. Get the current version at https://nodejs.org`);
  process.exit(1);
}
// loaded after the version check, because older versions of Node cannot even read these files
const { loadConfig, loadEnvFile } = await import('./config.js');
const { openDbFor } = await import('./store.js');
const { Game, solString } = await import('./game.js');
const { MockChain, SolanaChain } = await import('./solana.js');
const { createServer } = await import('./http.js');

loadEnvFile();

let cfg;
let chain;
try {
  cfg = loadConfig();
  if (cfg.treasurySecret) {
    chain = new SolanaChain({ rpcUrl: cfg.rpcUrl, secret: cfg.treasurySecret, priorityMicroLamports: cfg.priorityMicroLamports });
    log.info(`Treasury wallet: ${chain.address}`);
  } else {
    chain = new MockChain({ balance: 25e9 });
    log.warn('PRACTICE MODE: no TREASURY_SECRET_KEY is set, so payouts are pretend and the treasury holds 25 play SOL.');
  }
} catch (e) {
  log.error(`Cannot start: ${e.message}`); // never print the settings themselves: one of them is the wallet key
  process.exit(1);
}

if (!cfg.adminToken) log.warn('ADMIN_TOKEN is not set: the admin console is off.');
else if (cfg.adminToken.length < 16) log.warn('ADMIN_TOKEN is short. Use a long random password: it guards the treasury.');
if (!cfg.tokenMint) log.warn('TOKEN_MINT is not set: every wallet counts as a non-holder until the coin is live.');
if (!chain.mock && /api\.mainnet-beta\.solana\.com/.test(cfg.rpcUrl)) log.warn('RPC_URL is the public Solana endpoint, which is slow and rate-limited. Use your own RPC provider before launch.');

let db;
try {
  db = openDbFor(cfg.dbPath, chain.mock ? 'practice' : chain.address, log);
} catch (e) {
  log.error(`Cannot start: ${e.message}`);
  process.exit(1);
}
const game = new Game({ db, chain, cfg, log });
if (game.paused) log.warn('Claims are PAUSED. Switch them back on in the admin console.');

const safely = (label, fn) => async () => {
  try {
    await fn();
  } catch (e) {
    log.warn(`${label}: ${e.message}`);
  }
};

await safely('treasury check', async () => {
  const balance = await game.watchTreasury();
  log.info(balance === null ? 'Treasury balance: waiting for an up-to-date reading.' : `Treasury balance: ${solString(balance)} SOL`);
})();

if (!chain.mock) {
  safely('wallet self-check', async () => {
    const check = await chain.selfCheck();
    if (!check.history) log.error('This RPC provider cannot look up past transactions. A payout interrupted by a network hiccup could not be settled. Use a provider that keeps transaction history before hiding drops.');
    if (check.simulation === 'ok') log.info('Wallet self-check passed: a test payout was signed and accepted by the network (nothing was sent).');
    else if (check.balance < 2_000_000) log.warn('The treasury wallet is empty. Send it some SOL, then restart to run the payout self-check.');
    else log.error(`Wallet self-check FAILED: the network refused a test payout (${check.simulation}). Do not hide drops until this passes.`);
  })();
}

const server = createServer({ game, cfg, log });
server.on('error', (e) => {
  log.error(e.code === 'EADDRINUSE' ? `Cannot start: port ${cfg.port} is already in use.` : `Cannot start: ${e.message}`);
  process.exit(1);
});
server.listen(cfg.port, () => {
  log.info(`${cfg.appName} is running on port ${cfg.port}`);
  if (!process.env.PORT) log.info(`Open http://localhost:${cfg.port} for the app and http://localhost:${cfg.port}/admin for the console.`);
});

const timers = [
  setInterval(safely('treasury check', () => game.watchTreasuryIfDue()), 10_000),
  setInterval(safely('payout check', () => game.reconcile()), 20_000),
  setInterval(safely('batch expiry', async () => game.expireBatches()), 30_000),
  setInterval(safely('batch schedule', async () => {
    const made = game.autoTick();
    if (made.length) log.info(`Scheduled drop: ${made.length} batch(es) hidden from fees`);
  }), 30_000),
];

function shutdown() {
  for (const t of timers) clearInterval(t);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
