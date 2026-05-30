import express from "express";
import { config } from "./config.js";
import { safeFetch } from "./safeFetch.js";
import { extractMetadata } from "./extract.js";

const app = express();
app.disable("x-powered-by");

// Lightweight request logging so we can see exactly what reaches the origin
// (e.g. when called through the RapidAPI gateway). Never logs the secret value
// itself — only whether the header was present and whether it matched.
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
// Keeps repeat lookups of the same URL fast and reduces outbound traffic.
const cache = new Map(); // url -> { expires, value }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU ordering.
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

// --- RapidAPI proxy gate ---------------------------------------------------
// On RapidAPI every request carries X-RapidAPI-Proxy-Secret. If we've configured
// a secret, reject anything that doesn't match so the origin can't be called
// directly (which would bypass RapidAPI's metering & billing).
function requireProxy(req, res, next) {
  if (!config.rapidApiSecret) return next(); // disabled in local dev
  if (req.get("X-RapidAPI-Proxy-Secret") === config.rapidApiSecret) return next();
  return res.status(403).json({ error: "Forbidden. Call this API through RapidAPI." });
}

app.get("/health", (req, res) => {
  res.json({ ok: true, cacheSize: cache.size });
});

app.get("/preview", requireProxy, async (req, res) => {
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

app.use((req, res) => res.status(404).json({ error: "Not found." }));

app.listen(config.port, () => {
  console.log(`Link Preview API listening on port ${config.port}`);
  console.log(`RapidAPI gate: ${config.rapidApiSecret ? "enabled" : "disabled (dev)"}`);
});
