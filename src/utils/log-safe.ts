/**
 * Log-safe formatting helpers.
 *
 * Logs must not carry message bodies, raw webhook payloads, secrets, raw user/group
 * openids, or URLs with query parameters. These helpers keep enough to diagnose
 * (error type/code/status, correlatable ID hashes, URL origin) without the raw data.
 */

import { createHash } from "node:crypto";

const MESSAGE_LIMIT = 120;

/** Stable, non-reversible short hash for correlating an identifier across log lines. */
export function redactId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  return `#${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

/** Keeps only scheme and host of http(s) URLs; never logs path, query, or fragment. */
export function redactUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "none";
  if (value.startsWith("data:")) {
    const mime = value.slice(5, value.indexOf(";") > 0 ? value.indexOf(";") : 5) || "unknown";
    return `data:${mime};len=${value.length}`;
  }
  // Windows drive paths ("C:\..."), UNC/posix paths and file: URLs are local files, not URLs.
  if (/^[A-Za-z]:[\\/]|^[\\/]|^file:/i.test(value)) return `local:${redactId(value)}`;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") {
      const hasMore = (url.pathname && url.pathname !== "/") || url.search || url.hash;
      return `${url.protocol}//${url.host}${hasMore ? "/…" : ""}`;
    }
    return `${url.protocol}…`;
  } catch {
    return `local:${redactId(value)}`;
  }
}

/** Removes URLs, long identifiers/tokens, and home-directory names from free text, then truncates. */
export function sanitizeLogText(text: string): string {
  const cleaned = text
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, (match) => redactUrl(match))
    .replace(/([A-Za-z]:\\Users\\|\/home\/|\/Users\/)[^\\/\s"']+/g, "$1<user>")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "<redacted>")
    .replace(/\b[A-Fa-f0-9]{16,}\b/g, "<id>")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MESSAGE_LIMIT ? `${cleaned.slice(0, MESSAGE_LIMIT)}…` : cleaned;
}

/**
 * Normalizes any thrown value into a log-safe summary:
 * `<name>[code] status=<http> bizCode=<code>: <sanitized message>`.
 * Response bodies, stack traces, and request payloads are never included.
 */
export function safeError(error: unknown): string {
  if (error === undefined || error === null) return "unknown_error";
  if (typeof error === "string") return sanitizeLogText(error) || "error";
  if (typeof error !== "object") return typeof error;

  const e = error as {
    name?: unknown; message?: unknown; code?: unknown; status?: unknown;
    httpStatus?: unknown; bizCode?: unknown; cause?: unknown;
  };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const parts = [name];
  const code = typeof e.code === "string" || typeof e.code === "number" ? e.code : undefined;
  if (code !== undefined) parts[0] += `[${code}]`;
  const status = typeof e.httpStatus === "number" ? e.httpStatus : typeof e.status === "number" ? e.status : undefined;
  if (status !== undefined) parts.push(`status=${status}`);
  if (typeof e.bizCode === "number" || typeof e.bizCode === "string") parts.push(`bizCode=${e.bizCode}`);
  const causeCode = (e.cause as { code?: unknown } | undefined)?.code;
  if (typeof causeCode === "string") parts.push(`cause=${causeCode}`);
  const message = typeof e.message === "string" ? sanitizeLogText(e.message) : "";
  return message ? `${parts.join(" ")}: ${message}` : parts.join(" ");
}
