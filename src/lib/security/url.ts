import dns from "node:dns/promises";
import net from "node:net";

/**
 * Guards against SSRF when the application fetches a URL it did not
 * hard-code itself (feed URLs configured by an admin, article links, feed
 * item images/enclosures). Rejects anything that is not plain http/https,
 * or that resolves to a private/loopback/link-local address, so a
 * misconfigured or malicious feed entry can't be used to reach internal
 * infrastructure.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  // A userinfo segment (`https://user:pass@host`) has no legitimate use for
  // a feed/redirect target and is a classic way to smuggle credentials or
  // make a URL's visible host misleading — same check already applied to
  // every other URL this app treats as a link target (see
  // src/lib/security/sanitize.ts's safeHttpUrl).
  if (url.username !== "" || url.password !== "") {
    throw new Error("Refusing to fetch a URL with embedded credentials");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Refusing to fetch localhost");
  }

  // If the hostname is already a literal IP, check it directly. Otherwise
  // resolve it and check every returned address, since DNS can return a
  // mix of public and private records ("DNS rebinding").
  const literal = net.isIP(hostname) ? [hostname] : await resolveAll(hostname);
  if (literal.length === 0) {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const address of literal) {
    if (isPrivateAddress(address)) {
      throw new Error(`Refusing to fetch private/internal address: ${address}`);
    }
  }

  return url;
}

async function resolveAll(hostname: string): Promise<string[]> {
  try {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
    const addresses: string[] = [];
    if (v4.status === "fulfilled") addresses.push(...v4.value);
    if (v6.status === "fulfilled") addresses.push(...v6.value);
    return addresses;
  } catch {
    return [];
  }
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true; // unknown format: treat as unsafe
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast/reserved

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped address; check the embedded IPv4 part too
    const v4 = lower.split(":").pop();
    if (v4 && net.isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}
