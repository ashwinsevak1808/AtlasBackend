import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * What this server is allowed to call on a user's behalf.
 *
 * This is the most important control in the flow runner. Without it, "run this
 * flow" is a request to fetch any URL from inside our infrastructure, which is
 * a textbook SSRF: `http://169.254.169.254/latest/meta-data/` returns cloud
 * credentials, and `http://10.0.0.5/` is whatever is on the private network.
 * A user pointing a flow at either would be exfiltrating our servers, not
 * testing their API.
 *
 * So every URL is resolved and every address it resolves to is checked against
 * the ranges below before a socket is opened, and again for every redirect.
 *
 * It also does double duty as the honest half of a product decision: this is
 * exactly why a flow pointed at `localhost` cannot be scheduled. The block is
 * the same one, and the message says so.
 */

export type UrlVerdict =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string; code: UrlRejection };

export type UrlRejection =
  | 'malformed'
  | 'scheme'
  | 'unresolvable'
  | 'private_address'
  | 'credentials_in_url';

/* IPv4 ranges that must never be reached from a server. Each is [network,
   prefix length]; an address is blocked when its top `bits` match. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], /* "this network" */
  ['10.0.0.0', 8], /* RFC 1918 private */
  ['100.64.0.0', 10], /* carrier-grade NAT */
  ['127.0.0.0', 8], /* loopback — the server itself */
  ['169.254.0.0', 16], /* link-local, and every cloud metadata endpoint */
  ['172.16.0.0', 12], /* RFC 1918 private */
  ['192.0.0.0', 24], /* IETF protocol assignments */
  ['192.0.2.0', 24], /* documentation */
  ['192.168.0.0', 16], /* RFC 1918 private */
  ['198.18.0.0', 15], /* benchmarking */
  ['224.0.0.0', 4], /* multicast */
  ['240.0.0.0', 4], /* reserved, includes broadcast */
];

const toV4Int = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
};

function isBlockedV4(ip: string): boolean {
  const address = toV4Int(ip);
  if (address === null) return true; /* unparseable is not a reason to allow it */

  for (const [network, bits] of BLOCKED_V4) {
    const base = toV4Int(network);
    if (base === null) continue;
    /* >>> 0 keeps the mask unsigned; a /0 shift would otherwise be -1. */
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((address & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

/**
 * IPv6, checked on the canonical form Node hands back.
 *
 * Prefix rules on a normalised string rather than a hand-written parser: the
 * ranges that matter are all identified by their first hextet, and a parser
 * bug here would be a hole rather than a crash.
 */
function isBlockedV6(ip: string): boolean {
  const address = (ip.split('%')[0] ?? '').toLowerCase();

  if (address === '::1' || address === '::') return true; /* loopback, unspecified */

  /* ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 hat. */
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);

  /* 64:ff9b::/96, NAT64. Same trick, different prefix. */
  if (address.startsWith('64:ff9b::')) {
    const tail = address.slice('64:ff9b::'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isBlockedV4(tail);
  }

  const head = address.split(':')[0] ?? '';
  const hextet = Number.parseInt(head || '0', 16);
  if (Number.isNaN(hextet)) return true;

  if ((hextet & 0xfe00) === 0xfc00) return true; /* fc00::/7 unique local */
  if ((hextet & 0xffc0) === 0xfe80) return true; /* fe80::/10 link local */
  if ((hextet & 0xff00) === 0xff00) return true; /* ff00::/8 multicast */

  return false;
}

export const isPrivateAddress = (ip: string): boolean =>
  net.isIPv4(ip) ? isBlockedV4(ip) : net.isIPv6(ip) ? isBlockedV6(ip) : true;

/**
 * Resolves a URL and decides whether the server may call it.
 *
 * Every address the host resolves to has to pass, not just the first: a name
 * with both a public and a private A record must not be reachable by luck of
 * which one the connection happens to pick.
 *
 * The gap this leaves is DNS rebinding — the name is resolved here and again
 * by the HTTP client moments later, and a hostile resolver could answer
 * differently the second time. Closing it properly means pinning the socket to
 * the address that passed, which needs a custom dispatcher. The window is
 * small, the payoff for an attacker is our metadata endpoint, and it is worth
 * doing later; it is not a reason to skip the check that stops the direct
 * attempt.
 */
export async function checkUrl(raw: string): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'malformed', reason: `"${raw}" is not a valid URL.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'scheme',
      reason: `Only http and https can be called from the server. This one is ${url.protocol.replace(':', '')}.`,
    };
  }

  /* user:pass@host puts a credential in every log line that records the URL. */
  if (url.username || url.password) {
    return {
      ok: false,
      code: 'credentials_in_url',
      reason: 'Put credentials in the request auth, not in the URL.',
    };
  }

  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(url.hostname, { all: true });
  } catch {
    return {
      ok: false,
      code: 'unresolvable',
      reason: `${url.hostname} does not resolve from our servers. If it only exists on your machine or your network, this flow can only be run from your browser.`,
    };
  }

  if (resolved.length === 0) {
    return { ok: false, code: 'unresolvable', reason: `${url.hostname} does not resolve.` };
  }

  const addresses = resolved.map((entry) => entry.address);
  const offending = addresses.find(isPrivateAddress);

  if (offending) {
    return {
      ok: false,
      code: 'private_address',
      reason:
        `${url.hostname} resolves to ${offending}, which is a private or local address. ` +
        'Scheduled and server-side runs happen on our servers, which cannot reach your machine or your private network — run this flow from the workspace instead.',
    };
  }

  return { ok: true, url, addresses };
}

/** Every distinct host a set of URLs calls, for showing before an upload. */
export function hostsOf(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const raw of urls) {
    try {
      hosts.add(new URL(raw).host);
    } catch {
      /* Unresolvable at this stage means it still has {{variables}} in it. */
    }
  }
  return [...hosts].sort();
}
