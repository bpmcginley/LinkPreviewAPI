// Centralised configuration. All values come from the environment so the same
// build runs locally and on a host (Render, Fly, etc.).
export const config = {
  port: Number(process.env.PORT) || 3100,

  // When listed on RapidAPI, every request is proxied by RapidAPI and carries a
  // secret header (X-RapidAPI-Proxy-Secret). We reject anything missing it so the
  // origin can't be called directly, bypassing metering/billing. Leave unset in
  // local dev to disable the check.
  rapidApiSecret: process.env.RAPIDAPI_PROXY_SECRET || "",

  // Network safety knobs for the outbound fetch.
  fetch: {
    timeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || 6000,
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
