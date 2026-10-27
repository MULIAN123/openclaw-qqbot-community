/**
 * Compatibility preflight only. Do not use this to authorize a domain request:
 * DNS validation without connection pinning is vulnerable to rebinding.
 * Actual outbound requests must use requestPublicUrl from safe-remote-request.ts.
 */

import net from "node:net";
import { isRestrictedRemoteAddress } from "./safe-remote-request.js";

export function isReservedAddr(address: string): boolean {
  return isRestrictedRemoteAddress(address);
}

/**
 * Retains the old API for literal public IP callers. Hostnames fail closed so
 * callers cannot mistake a DNS preflight for a connection-level guarantee.
 */
export async function validateRemoteUrl(raw: string): Promise<void> {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Invalid remote URL"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Remote URL must be credential-free HTTP or HTTPS");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!net.isIP(host)) {
    throw new Error("Hostname preflight is not a safe connection boundary; use requestPublicUrl");
  }
  if (isRestrictedRemoteAddress(host)) throw new Error("Remote host resolved to a restricted network address");
}
