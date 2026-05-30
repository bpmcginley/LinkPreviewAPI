import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, stripeEnabled } from "./config.js";
import { safeFetch } from "./safeFetch.js";
import { extractMetadata } from "./extract.js";
import { gateAccess, quotaFor } from "./auth.js";
import { createAccount, getAccountByEmail, getAccountByKey } from "./db.js";
import { createCheckout, createPortal, handleWebhook } from "./stripe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");

// Stripe webhook needs the raw body, so mount it BEFORE the JSON parser.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!stripeEnabled) return res.status(503).end();
    try {
      const type = handleWebhook(req.body, req.get("stripe-signature"));
      res.json({ received: true, type });
    } catch (err) {
      res.status(400).send(`Webhook error: ${err.message}`);
    }
  },
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Lightweight request logging. Never logs the secret value itself — only
// whether the RapidAPI header was present and whether it matched.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const hasSecret = Boolean(req.get("X-RapidAPI-Proxy-Secret"));
    const secretMatches =
      config.rapidApiSecret && req.get("X-RapidAPI-Proxy-Secret") === config.rapidApiSecret;
    console.log(
      `[req] ${req.method} ${req.path} q=${JSON.stringify(req.query)} -> ${res.statusCode} ` +
        `${Date.now() - start}ms hasSecret=${hasSecret} secretMatches=${Boolean(secretMatches)}`,
    );
  });
  next();
});

// --- Tiny in-memory TTL cache ---------------------------------------------
const cache = new Map(); // url -> { expires, value }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}
function cacheSet(key, value) {
  if (cache.size >= config.cache.max) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + config.cache.ttlMs, value });
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cacheSize: cache.size,
    stripe_enabled: stripeEnabled,
    commit: (process.env.RENDER_GIT_COMMIT || "local").slice(0, 7),
  });
});

// --- The core endpoint ----------------------------------------------------
// Reachable via RapidAPI (proxy secret) or self-serve (API key + metering).
app.get("/preview", gateAccess, async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing required query parameter: url" });
  }

  const cached = cacheGet(url);
  if (cached) {
    res.set("X-Cache", "HIT");
    return res.json(cached);
  }

  try {
    const { finalUrl, html } = await safeFetch(url);
    const meta = extractMetadata(html, finalUrl);
    const payload = { url, ...meta, fetchedAt: new Date().toISOString() };
    cacheSet(url, payload);
    res.set("X-Cache", "MISS");
    res.set("Cache-Control", "public, max-age=600");
    return res.json(payload);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "Failed to fetch preview." });
  }
});

// --- Account signup (issues an API key) ---
app.post("/api/signup", (req, res) => {
  const email = (req.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email required." });
  }
  if (getAccountByEmail(email)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }
  const account = createAccount(email);
  res.json({
    api_key: account.api_key,
    plan: account.plan,
    quota: quotaFor(account.plan),
  });
});

// --- Account status ---
app.get("/api/account", (req, res) => {
  const key = req.query.key || req.get("x-api-key");
  const account = getAccountByKey(key);
  if (!account) return res.status(401).json({ error: "Invalid API key." });
  res.json({
    email: account.email,
    plan: account.plan,
    quota: quotaFor(account.plan),
    used_this_month:
      account.usage_period === new Date().toISOString().slice(0, 7)
        ? account.usage_count
        : 0,
    stripe_enabled: stripeEnabled,
  });
});

// --- Billing ---
app.post("/api/billing/checkout", async (req, res) => {
  if (!stripeEnabled)
    return res.status(503).json({ error: "Billing not configured yet." });
  try {
    const url = await createCheckout(req.body?.key);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/billing/portal", async (req, res) => {
  if (!stripeEnabled)
    return res.status(503).json({ error: "Billing not configured yet." });
  try {
    const url = await createPortal(req.body?.key);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found." }));

app.listen(config.port, () => {
  console.log(`Link Preview API listening on port ${config.port}`);
  console.log(`RapidAPI gate: ${config.rapidApiSecret ? "enabled" : "disabled (dev)"}`);
  console.log(`Stripe billing: ${stripeEnabled ? "enabled" : "NOT configured"}`);
});
