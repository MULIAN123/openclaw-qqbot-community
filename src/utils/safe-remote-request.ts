import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import type { IncomingMessage } from "node:http";

const restrictedAddresses = new net.BlockList();
for (const [subnet, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 96, "ipv6"], ["64:ff9b::", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"], ["2001::", 23, "ipv6"], ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
] as const) {
  restrictedAddresses.addSubnet(subnet, prefix, family);
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type PinnedRequestOptions = {
  address: string;
  family: 4 | 6;
  lookup: LookupFunction;
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  signal?: AbortSignal;
};

type SafeRequestOptions = {
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  requestTransport?: (url: URL, options: PinnedRequestOptions) => Promise<IncomingMessage>;
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  signal?: AbortSignal;
};

export function isRestrictedRemoteAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 4) return restrictedAddresses.check(address, "ipv4");

  const mapped = ipv4FromMappedAddress(address);
  if (mapped) return restrictedAddresses.check(mapped, "ipv4");
  return restrictedAddresses.check(address, "ipv6");
}

function ipv4FromMappedAddress(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const tail = lower.slice(7);
  if (net.isIPv4(tail)) return tail;
  const words = tail.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  const value = (Number.parseInt(words[0], 16) * 0x10000) + Number.parseInt(words[1], 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map(({ address, family }): ResolvedAddress => {
      if (family !== 4 && family !== 6) throw new Error("unexpected address family");
      return { address, family: family === 6 ? 6 : 4 };
    });
  } catch {
    throw new Error("Remote host DNS resolution failed");
  }
}

function resolveWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Remote request aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Remote request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function makePinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function requestWithPinnedAddress(url: URL, options: PinnedRequestOptions): Promise<IncomingMessage> {
  const transport = url.protocol === "https:" ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      signal: options.signal,
      agent: false,
      lookup: options.lookup,
      ...(net.isIP(hostname) ? {} : { servername: hostname }),
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

/** Resolve and validate every address, then pin the socket lookup to one validated IP. Redirects are never followed here. */
export async function requestPublicUrl(rawUrl: string, options: SafeRequestOptions = {}): Promise<IncomingMessage> {
  if (options.signal?.aborted) throw new Error("Remote request aborted");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid remote URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Remote URL must be credential-free HTTP or HTTPS");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: ResolvedAddress[];
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  } else {
    try {
      addresses = await resolveWithAbort((options.resolveHost ?? resolveHost)(hostname), options.signal);
    } catch {
      if (options.signal?.aborted) throw new Error("Remote request aborted");
      throw new Error("Remote host DNS resolution failed");
    }
  }
  if (options.signal?.aborted) throw new Error("Remote request aborted");
  if (addresses.length === 0) throw new Error("Remote host DNS resolution returned no addresses");
  if (addresses.some(({ address }) => isRestrictedRemoteAddress(address))) {
    throw new Error("Remote host resolved to a restricted network address");
  }

  const selected = addresses[0];
  const pinnedOptions: PinnedRequestOptions = {
    address: selected.address,
    family: selected.family,
    lookup: makePinnedLookup(selected.address, selected.family),
    method: options.method,
    headers: options.headers,
    signal: options.signal,
  };
  return (options.requestTransport ?? requestWithPinnedAddress)(url, pinnedOptions);
}
