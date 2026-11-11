import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

export function openDb(path = ":memory:"): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS access_codes(code TEXT PRIMARY KEY, used_by TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS vendors(
  id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, business_id TEXT,
  status TEXT DEFAULT 'pending', api_key_hash TEXT UNIQUE,
  confirm_channel TEXT DEFAULT 'email', auto_approve_under INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS vendor_defaults(
  vendor_id TEXT, category TEXT, floor_pct REAL, target_pct REAL, max_discount_pct REAL,
  warranty_days INTEGER, return_window_days INTEGER, warranty_cost_per_day INTEGER,
  PRIMARY KEY(vendor_id, category));
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, vendor_id TEXT, title TEXT, category TEXT, specs TEXT, condition TEXT,
  list_price INTEGER, stock INTEGER, status TEXT DEFAULT 'live', photo_url TEXT,
  views INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS item_rules(
  item_id TEXT PRIMARY KEY, floor INTEGER, target INTEGER, max_discount_pct REAL,
  warranty_options TEXT, warranty_cost_per_day INTEGER, return_window_days INTEGER, lead_days INTEGER);
CREATE TABLE IF NOT EXISTS clients(
  id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, api_key_hash TEXT UNIQUE, pin_hash TEXT,
  profile_enc TEXT, webhook_url TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS mandates(
  id TEXT PRIMARY KEY, client_id TEXT, query TEXT, category TEXT, must_haves TEXT, budget INTEGER,
  deadline_days INTEGER, warranty_value_per_day INTEGER, status TEXT DEFAULT 'open', created_at INTEGER);
CREATE TABLE IF NOT EXISTS quotes(
  id TEXT PRIMARY KEY, mandate_id TEXT, item_id TEXT, vendor_id TEXT, client_id TEXT,
  price INTEGER, warranty_days INTEGER, status TEXT, expires_at INTEGER, reason TEXT,
  confirm_token_hash TEXT, auto_approved INTEGER DEFAULT 0, created_at INTEGER, confirmed_at INTEGER);
CREATE TABLE IF NOT EXISTS negotiation_turns(
  id INTEGER PRIMARY KEY AUTOINCREMENT, quote_id TEXT, seq INTEGER, side TEXT, kind TEXT,
  price INTEGER, warranty_days INTEGER, note TEXT, flagged TEXT);
CREATE TABLE IF NOT EXISTS deals(
  id TEXT PRIMARY KEY, quote_id TEXT UNIQUE, client_id TEXT, vendor_id TEXT, item_id TEXT,
  price INTEGER, warranty_days INTEGER, status TEXT, method TEXT DEFAULT 'pickup',
  promised_by INTEGER, delivered_at INTEGER, release_at INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS escrow(
  id TEXT PRIMARY KEY, deal_id TEXT UNIQUE, provider TEXT, provider_ref TEXT, amount INTEGER,
  state TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS disputes(
  id TEXT PRIMARY KEY, deal_id TEXT, reason TEXT, status TEXT DEFAULT 'open', decision TEXT,
  admin_reason TEXT, created_at INTEGER, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS leads(
  id TEXT PRIMARY KEY, vendor_id TEXT, item_id TEXT, mandate_id TEXT, quote_id TEXT,
  outcome TEXT, reason TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS decision_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT, user_id TEXT, ref TEXT, event TEXT,
  price INTEGER, detail TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, event TEXT, ref TEXT, detail TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, to_addr TEXT, subject TEXT, body TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_items_vendor ON items(vendor_id);
CREATE INDEX IF NOT EXISTS idx_quotes_mandate ON quotes(mandate_id);
CREATE INDEX IF NOT EXISTS idx_leads_vendor ON leads(vendor_id);
CREATE INDEX IF NOT EXISTS idx_decision_user ON decision_log(user_type, user_id);
-- Billing is counted, not charged, during the pilot: confirmed quotes per vendor per day.
CREATE VIEW IF NOT EXISTS v_billing AS
  SELECT vendor_id, date(confirmed_at/1000,'unixepoch') AS day, COUNT(*) AS confirmed_quotes
  FROM quotes WHERE confirmed_at IS NOT NULL GROUP BY vendor_id, day;
`);
  return db;
}
