// SQLite storage (built into Node, nothing to install).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL, lng REAL NOT NULL, radius_m REAL NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  early_min INTEGER NOT NULL DEFAULT 15,
  one_per_person INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'live',
  total_lamports INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  lat REAL NOT NULL, lng REAL NOT NULL,
  lamports INTEGER NOT NULL,
  tier TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'hidden',
  claimed_by TEXT, claimed_at INTEGER, sig TEXT,
  held_until INTEGER,
  visible_at INTEGER
);
CREATE INDEX IF NOT EXISTS drops_by_batch ON drops(batch_id, status);
CREATE INDEX IF NOT EXISTS drops_by_place ON drops(status, lat, lng);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id INTEGER NOT NULL REFERENCES drops(id),
  batch_id INTEGER NOT NULL,
  address TEXT NOT NULL, device TEXT NOT NULL, ip TEXT NOT NULL,
  lat REAL, lng REAL, acc REAL, dist REAL,
  lamports INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0,
  one_per_person INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  sig TEXT, last_valid_height INTEGER, error TEXT,
  created_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_address ON claims(batch_id, address) WHERE status IN ('paying', 'paid') AND one_per_person = 1;
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_device ON claims(batch_id, device) WHERE status IN ('paying', 'paid') AND one_per_person = 1;
CREATE INDEX IF NOT EXISTS claims_by_address ON claims(address, status);
CREATE INDEX IF NOT EXISTS claims_by_ip ON claims(ip, created_at);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  lamports INTEGER NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // columns added after the first version
  const dropColumns = new Set(db.prepare('PRAGMA table_info(drops)').all().map((col) => col.name));
  if (!dropColumns.has('held_until')) db.exec('ALTER TABLE drops ADD COLUMN held_until INTEGER');
  if (!dropColumns.has('visible_at')) db.exec('ALTER TABLE drops ADD COLUMN visible_at INTEGER'); // drops added to a running batch: when everyone may see them
  // One signature, one claim. If an old database already breaks that rule, start anyway: the payout code has its own guard.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS claims_one_sig ON claims(sig) WHERE sig IS NOT NULL');
  } catch {}
  return db;
}

/**
 * Opens the database for one treasury wallet and refuses to mix it with another's records.
 * `identity` is the wallet address, or "practice" when no wallet is connected.
 * Practice data is set aside on its own when a real wallet is connected, so going live starts clean.
 */
export function openDbFor(file, identity, log = console) {
  let db = openDb(file);
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('treasury');
  const owner = row ? row.v : null;
  if (owner !== null && owner !== identity) {
    db.close();
    if (owner !== 'practice' || file === ':memory:') {
      const now = identity === 'practice' ? 'practice mode (TREASURY_SECRET_KEY is missing)' : `wallet ${identity}`;
      throw new Error(
        `the database at ${file} holds the records of treasury wallet ${owner}, but the server is now set up for ${now}. ` +
          'Put the right TREASURY_SECRET_KEY back, or set DATABASE_PATH to a new file to start a separate game.',
      );
    }
    const aside = `${file}.practice-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, aside + ext);
    log.warn(`The practice data was set aside as ${aside}. Starting clean for the live wallet.`);
    db = openDb(file);
  }
  db.prepare('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('treasury', identity);
  return db;
}

/** Runs fn inside one database transaction; any throw rolls everything back. */
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const isUniqueViolation = (e) => e && e.code === 'ERR_SQLITE_ERROR' && (e.errcode === 2067 || e.errcode === 1555 || /UNIQUE constraint failed/.test(e.message));
