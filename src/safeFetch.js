import dns from "node:dns/promises";
import net from "node:net";
import { config } from "./config.js";

// --- SSRF protection -------------------------------------------------------
// This service fetches arbitrary user-supplied URLs. Without guards it could be
// used to reach internal services (cloud metadata endpoints, databases on a
// private network, localhost admin panels). We therefore (a) allow only http/s,
// and (b) resolve the hostname and refuse if it maps to a private / loopback /
// link-local address — re-checking on every redirect hop.

function ipToLong(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inRange(ip, cidr) {
  const [range, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local (incl. cloud metadata 169.254.169.254)
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some((cidr) => inRange(ip, cidr));

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — unwrap and check as v4.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("ff")) return true; // multicast
    return false;
  }
  return true; // unparseable -> treat as unsafe
}

async function assertPublicHost(hostname) {
  // A literal IP in the URL skips DNS — validate it directly.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Refusing to fetch a private address.");
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve host.");
  }
  if (!records.length) throw new Error("Could not resolve host.");
  for (const { address } of records) {
    if (isPrivateIp(address)) throw new Error("Refusing to fetch a private address.");
  }
}

// --- Fetch with manual redirect handling -----------------------------------
// We follow redirects ourselves (redirect: "manual") so the SSRF check runs on
// every hop — a public URL could 30x to an internal one.
export async function safeFetch(rawUrl) {
  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("Invalid URL."), { status: 400 });
  }

  for (let hop = 0; hop <= config.fetch.maxRedirects; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw Object.assign(new Error("Only http and https URLs are supported."), {
        status: 400,
      });
    }
    await assertPublicHost(current.hostname).catch((e) => {
      throw Object.assign(e, { status: 400 });
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
    let resp;
    try {
      resp = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": config.fetch.userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw Object.assign(
        new Error(err.name === "AbortError" ? "Upstream timed out." : "Upstream fetch failed."),
        { status: 502 },
      );
    }

    // Handle redirects ourselves so each hop is re-validated.
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      clearTimeout(timer);
      current = new URL(resp.headers.get("location"), current);
      continue;
    }

    if (!resp.ok) {
      clearTimeout(timer);
      throw Object.assign(new Error(`Upstream returned ${resp.status}.`), { status: 502 });
    }

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
      clearTimeout(timer);
      throw Object.assign(new Error("URL did not return an HTML page."), { status: 415 });
    }

    // Stream the body but stop once we exceed the byte cap.
    const reader = resp.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      const text = await resp.text();
      return { finalUrl: current.href, html: text };
    }
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > config.fetch.maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    } finally {
      clearTimeout(timer);
    }
    const html = Buffer.concat(chunks).toString("utf8");
    return { finalUrl: current.href, html };
  }

  throw Object.assign(new Error("Too many redirects."), { status: 502 });
}
