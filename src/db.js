import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";

// DB_PATH lets the host point SQLite at a persistent disk (e.g. /data/data.db).
// Falls back to a local file for development.
const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    usage_period TEXT NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

const currentPeriod = () => new Date().toISOString().slice(0, 7); // YYYY-MM
const newId = () => crypto.randomBytes(12).toString("hex");
const newApiKey = () => "lpk_" + crypto.randomBytes(24).toString("hex");

export function createAccount(email) {
  const account = {
    id: newId(),
    email: email.toLowerCase().trim(),
    api_key: newApiKey(),
    plan: "free",
    usage_period: currentPeriod(),
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO accounts (id, email, api_key, plan, usage_period, usage_count, created_at)
     VALUES (@id, @email, @api_key, @plan, @usage_period, 0, @created_at)`,
  ).run(account);
  return getAccountByKey(account.api_key);
}

export function getAccountByEmail(email) {
  return db
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .get(email.toLowerCase().trim());
}

export function getAccountByKey(apiKey) {
  if (!apiKey) return undefined;
  return db.prepare("SELECT * FROM accounts WHERE api_key = ?").get(apiKey);
}

export function getAccountById(id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

export function getAccountByCustomerId(customerId) {
  return db
    .prepare("SELECT * FROM accounts WHERE stripe_customer_id = ?")
    .get(customerId);
}

// Atomically reset the counter when the month rolls over, increment,
// and return the new count.
export function recordUsage(accountId) {
  const period = currentPeriod();
  db.prepare(
    `UPDATE accounts
     SET usage_count = CASE WHEN usage_period = @period THEN usage_count + 1 ELSE 1 END,
         usage_period = @period
     WHERE id = @id`,
  ).run({ id: accountId, period });
  return db
    .prepare("SELECT usage_count FROM accounts WHERE id = ?")
    .get(accountId).usage_count;
}

export function setStripeCustomer(accountId, customerId) {
  db.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ?").run(
    customerId,
    accountId,
  );
}

export function setPlan(accountId, plan, subscriptionId) {
  db.prepare(
    "UPDATE accounts SET plan = ?, stripe_subscription_id = ? WHERE id = ?",
  ).run(plan, subscriptionId ?? null, accountId);
}

export default db;
