// Checks the settings before you go live, without moving any money.
//
//   npm run check                      settings, treasury wallet, RPC, token
//   npm run check -- <wallet address>  also shows which holder tier that wallet is in

import { loadConfig, loadEnvFile } from '../server/config.js';
import { isAddress } from '../server/base58.js';
import { SolanaChain } from '../server/solana.js';

const ok = (text) => console.log(`  ok    ${text}`);
const warn = (text) => console.log(`  WARN  ${text}`);
const bad = (text) => {
  console.log(`  FAIL  ${text}`);
  process.exitCode = 1;
};
const sol = (lamports) => (lamports / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 });

loadEnvFile();
let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  bad(`Settings: ${e.message}`);
  process.exit(1);
}

console.log('\nSettings');
if (cfg.adminToken.length >= 16) ok('ADMIN_TOKEN is set');
else if (cfg.adminToken) warn('ADMIN_TOKEN is short. Use a long random password: it guards the treasury.');
else warn('ADMIN_TOKEN is not set, so the admin console is off');
if (cfg.publicUrl) ok(`PUBLIC_URL is ${cfg.publicUrl}`);
else warn('PUBLIC_URL is not set, so shared links will not show a preview card');
if (/tile\.openstreetmap\.org/.test(cfg.tileUrl)) warn('MAP_TILE_URL is the free OpenStreetMap server. Fine for testing; use a map provider with a key before launch.');
else ok('MAP_TILE_URL points at your own map provider');
ok(`Drops are ${sol(cfg.tierValues.s)}, ${sol(cfg.tierValues.m)} and ${sol(cfg.tierValues.l)} SOL; claim from ${cfg.reachM} m (${cfg.reachTopM} m for top holders)`);

console.log('\nTreasury wallet');
if (!cfg.treasurySecret) {
  warn('TREASURY_SECRET_KEY is not set: the app runs in practice mode with pretend payouts.');
  console.log('\nNothing else to check until a wallet is set.\n');
  process.exit();
}
let chain;
try {
  chain = new SolanaChain({ rpcUrl: cfg.rpcUrl, secret: cfg.treasurySecret, priorityMicroLamports: cfg.priorityMicroLamports });
  ok(`Key reads fine. Address: ${chain.address}`);
} catch (e) {
  bad(`TREASURY_SECRET_KEY: ${e.message}`);
  process.exit(1);
}

console.log('\nNetwork');
if (/api\.mainnet-beta\.solana\.com/.test(cfg.rpcUrl)) warn('RPC_URL is the public Solana endpoint: slow and rate-limited. Use your own RPC provider before launch.');
try {
  const started = Date.now();
  const check = await chain.selfCheck();
  ok(`RPC answers (${Date.now() - started} ms for four calls)`);
  ok(`Balance: ${sol(check.balance)} SOL`);
  if (check.history) ok('The provider can look up past transactions');
  else bad('This RPC provider cannot look up past transactions, so an interrupted payout could not be settled. Use another provider.');
  if (check.simulation === 'ok') ok('Test payout signed and accepted by the network. Nothing was sent.');
  else if (check.balance < 2_000_000) warn('The wallet is empty, so the test payout could not run. Send it some SOL and check again.');
  else bad(`The network refused a test payout: ${check.simulation}`);
  const fee = chain.feeFor();
  ok(`Each payout costs about ${fee.toLocaleString('en-US')} lamports in network fees (${sol(fee * 1000)} SOL per 1,000 payouts)`);
} catch (e) {
  bad(`RPC: ${e.message}`);
}

console.log('\nToken');
if (!cfg.tokenMint) warn('TOKEN_MINT is not set: holder perks are off until you add the coin address.');
else if (!isAddress(cfg.tokenMint)) bad('TOKEN_MINT is not a valid Solana address');
else {
  try {
    const supply = await chain.rpc('getTokenSupply', [cfg.tokenMint]);
    const total = Number(supply.value.uiAmountString);
    ok(`$${cfg.tokenTicker} found. Supply: ${total.toLocaleString('en-US')}`);
    cfg.tierLevels.forEach((level, i) => ok(`Tier ${i + 1} needs ${level.toLocaleString('en-US')} (${((level / total) * 100).toFixed(3)}% of supply)`));
    const who = process.argv[2];
    if (who && isAddress(who)) {
      const balance = await chain.tokenBalance(who, cfg.tokenMint);
      ok(`${who} holds ${balance.toLocaleString('en-US')}: tier ${cfg.tierLevels.filter((level) => balance >= level).length}`);
    } else if (who) bad(`${who} is not a valid Solana address`);
  } catch (e) {
    bad(`TOKEN_MINT: ${e.message}`);
  }
}
console.log(process.exitCode ? '\nFix the FAIL lines above before going live.\n' : '\nAll good.\n');
