import { promises as dnsPromises } from 'node:dns';
import { URL } from 'node:url';

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);

const ALWAYS_BLOCKED_IPS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.169.253',
  '100.100.100.200',
]);

/** Returns true if the IPv4 address string falls in a private/reserved range. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local covers entire /16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC 6598
  if (a === 0) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 51 || b === 18 || b === 19)) return true; // TEST-NET-2/benchmark
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower === 'fd00:ec2::254') return true;
  return false;
}

function isBlockedAddress(ip: string): boolean {
  if (ALWAYS_BLOCKED_IPS.has(ip)) return true;
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

/**
 * Returns true if the URL is safe to fetch (not an SSRF target).
 * Resolves hostname via DNS and checks against private/internal ranges.
 * Fails closed: DNS errors and unexpected exceptions block the request.
 */
export async function isSafeUrl(rawUrl: string): Promise<boolean> {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');

    if (BLOCKED_HOSTNAMES.has(hostname)) return false;

    // Literal IP — check directly without DNS
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':')) {
      return !isBlockedAddress(hostname);
    }

    let addresses: string[];
    try {
      const results = await dnsPromises.lookup(hostname, { all: true, family: 0 });
      addresses = results.map((r) => r.address);
    } catch {
      return false; // DNS failure — fail closed
    }

    for (const addr of addresses) {
      if (isBlockedAddress(addr)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
