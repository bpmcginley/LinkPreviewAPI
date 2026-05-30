import * as cheerio from "cheerio";

// Turn a possibly-relative URL into an absolute one against the page URL.
function absolutize(value, base) {
  if (!value) return null;
  try {
    return new URL(value.trim(), base).href;
  } catch {
    return null;
  }
}

function clean(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t || null;
}

// Pull a value by trying a list of CSS selectors in priority order. Each entry
// is [selector, attribute] — attribute null means use the element's text.
function pick($, candidates) {
  for (const [selector, attr] of candidates) {
    const el = $(selector).first();
    if (!el.length) continue;
    const raw = attr ? el.attr(attr) : el.text();
    const value = clean(raw);
    if (value) return value;
  }
  return null;
}

// Resolve a favicon: explicit <link rel="icon"> variants, else /favicon.ico.
function findFavicon($, base) {
  const rels = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
    'link[rel="mask-icon"]',
  ];
  for (const sel of rels) {
    const href = $(sel).first().attr("href");
    const abs = absolutize(href, base);
    if (abs) return abs;
  }
  return absolutize("/favicon.ico", base);
}

// Try to read author / published time from JSON-LD structured data.
function fromJsonLd($) {
  const out = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(data) ? data : data["@graph"] || [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (!out.author) {
        const a = node.author;
        if (typeof a === "string") out.author = a;
        else if (a && typeof a === "object") out.author = a.name || null;
        else if (Array.isArray(a) && a[0]) out.author = a[0].name || a[0];
      }
      if (!out.publishedTime) {
        out.publishedTime = node.datePublished || node.dateCreated || null;
      }
    }
  });
  return out;
}

export function extractMetadata(html, finalUrl) {
  const $ = cheerio.load(html);

  const title =
    pick($, [
      ['meta[property="og:title"]', "content"],
      ['meta[name="twitter:title"]', "content"],
      ['meta[name="title"]', "content"],
      ["title", null],
      ["h1", null],
    ]) || null;

  const description =
    pick($, [
      ['meta[property="og:description"]', "content"],
      ['meta[name="twitter:description"]', "content"],
      ['meta[name="description"]', "content"],
    ]) || null;

  const rawImage = pick($, [
    ['meta[property="og:image:secure_url"]', "content"],
    ['meta[property="og:image:url"]', "content"],
    ['meta[property="og:image"]', "content"],
    ['meta[name="twitter:image"]', "content"],
    ['meta[name="twitter:image:src"]', "content"],
    ['link[rel="image_src"]', "href"],
  ]);
  // Last-ditch: first reasonably-sized <img> in the body.
  let image = absolutize(rawImage, finalUrl);
  if (!image) {
    const firstImg = $("img[src]").first().attr("src");
    image = absolutize(firstImg, finalUrl);
  }

  const siteName =
    pick($, [
      ['meta[property="og:site_name"]', "content"],
      ['meta[name="application-name"]', "content"],
    ]) || new URL(finalUrl).hostname.replace(/^www\./, "");

  const type = pick($, [['meta[property="og:type"]', "content"]]) || null;
  const themeColor = pick($, [['meta[name="theme-color"]', "content"]]) || null;

  const ld = fromJsonLd($);
  const author =
    pick($, [
      ['meta[property="article:author"]', "content"],
      ['meta[name="author"]', "content"],
      ['meta[name="twitter:creator"]', "content"],
    ]) ||
    ld.author ||
    null;
  const publishedTime =
    pick($, [
      ['meta[property="article:published_time"]', "content"],
      ['meta[name="date"]', "content"],
      ['meta[itemprop="datePublished"]', "content"],
    ]) ||
    ld.publishedTime ||
    null;

  return {
    resolvedUrl: finalUrl,
    title,
    description,
    image,
    favicon: findFavicon($, finalUrl),
    siteName,
    type,
    author,
    publishedTime,
    themeColor,
  };
}
