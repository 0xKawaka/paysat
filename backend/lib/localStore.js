import fs from 'fs';
import path from 'path';

import { DATA_FILE } from './config.js';

const DEFAULT_DB = () => ({ users: {}, addresses: {}, invoices: {}, nonces: {}, payments: {} });

function ensureDataFile() {
  const filePath = path.resolve(DATA_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    const initial = DEFAULT_DB();
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
  }
  return filePath;
}

function initDB() {
  const filePath = ensureDataFile();
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const db = { ...DEFAULT_DB(), ...parsed };
  db.users ||= {};
  db.addresses ||= {};
  db.invoices ||= {};
  db.nonces ||= {};
  db.payments ||= {};
  return { db, filePath };
}

const { db: DB, filePath: DATA_PATH } = initDB();

export function getDB() {
  return DB;
}

export function saveDB() {
  const tmp = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}

export function reloadDB() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const fresh = { ...DEFAULT_DB(), ...parsed };

  for (const key of Object.keys(DB)) {
    if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete DB[key];
  }

  Object.assign(DB, fresh);
  DB.users ||= {};
  DB.addresses ||= {};
  DB.invoices ||= {};
  DB.nonces ||= {};
  DB.payments ||= {};
  return DB;
}

export function withDB(mutator) {
  reloadDB();
  const result = mutator(DB);
  saveDB();
  return result;
}
