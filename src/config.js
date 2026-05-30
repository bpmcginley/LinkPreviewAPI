// Centralised configuration. All values come from the environment so the same
// build runs locally and on a host (Render, Fly, etc.).
import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3100,

  // Public base URL of this service (used in Stripe redirect URLs and the
  // upgrade link returned on quota errors). Set in prod, e.g. https://...onrender.com
  baseUrl: process.env.BASE_URL || "http://localhost:3100",

  // Self-serve billing. When a Stripe secret key + price id are set, the /api
  // billing routes go live; otherwise the service still issues free API keys.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    priceId: process.env.STRIPE_PRICE_ID || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  },

  // Monthly request quotas per plan, enforced per API key.
  quotas: {
    free: Number(process.env.FREE_MONTHLY_QUOTA) || 100,
    pro: Number(process.env.PRO_MONTHLY_QUOTA) || 10000,
  },

  // When listed on RapidAPI, every request is proxied by RapidAPI and carries a
  // secret header (X-RapidAPI-Proxy-Secret). We reject anything missing it so the
  // origin can't be called directly, bypassing metering/billing. Leave unset in
  // local dev to disable the check.
  rapidApiSecret: process.env.RAPIDAPI_PROXY_SECRET || "",

  // Network safety knobs for the outbound fetch.
  fetch: {
    timeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || 9000,
    maxBytes: Number(process.env.FETCH_MAX_BYTES) || 2 * 1024 * 1024, // 2 MB
    maxRedirects: Number(process.env.FETCH_MAX_REDIRECTS) || 5,
    userAgent:
      process.env.FETCH_USER_AGENT ||
      "Mozilla/5.0 (compatible; LinkPreviewBot/1.0; +https://link-preview-api)",
  },

  // Optional in-memory cache to cut repeat fetches of the same URL.
  cache: {
    ttlMs: Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000, // 10 min
    max: Number(process.env.CACHE_MAX) || 500,
  },
};

export const stripeEnabled = Boolean(
  config.stripe.secretKey && config.stripe.priceId,
);
