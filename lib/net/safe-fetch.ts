import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetch a URL supplied by an API client without letting it reach internal networks (SSRF guard):
 * http(s) only, every hop's host must resolve to public addresses, redirects followed manually (max 3),
 * time-limited, and the declared size is checked before reading.
 * Residual risk: DNS can change between our lookup and fetch's own (rebinding); acceptable for public media URLs.
 */
export class UnsafeUrlError extends Error {}

export function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

async function assertPublicHost(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http(s) URLs are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new UnsafeUrlError("URL points to a private host");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("URL points to a private or reserved network address");
}

export async function safeFetch(rawUrl: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<Response> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), headers: { "User-Agent": "SocialPlanner-MediaFetcher/1.0" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`Media URL returned HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > opts.maxBytes) throw new Error(`Media is ${(len / 1048576).toFixed(1)} MB; the limit is ${(opts.maxBytes / 1048576).toFixed(0)} MB`);
    return res;
  }
  throw new Error("Too many redirects");
}

/** Read a body into memory, aborting once it exceeds maxBytes (content-length can lie or be missing). */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Media is larger than ${(maxBytes / 1048576).toFixed(0)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
