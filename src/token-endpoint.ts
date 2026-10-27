const OFFICIAL_TOKEN_ORIGIN = "https://bots.qq.com";
const OFFICIAL_API_ORIGIN = "https://api.sgroup.qq.com";

/** Validate a configured third-party API base before an API key is attached. */
export function resolveCredentialServiceBaseUrl(configuredBaseUrl: string): string {
  let url: URL;
  try { url = new URL(configuredBaseUrl); }
  catch { throw new Error("HTTPS credential endpoint is required"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("HTTPS credential endpoint is required");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Resolve the QQ API origin. Non-official endpoints are limited to explicit localhost tests. */
export function resolveApiBaseUrl(
  configuredBaseUrl: string | undefined,
  options: { allowLocalTestEndpoint?: boolean; nodeEnv?: string } = {},
): string {
  const raw = (configuredBaseUrl || OFFICIAL_API_ORIGIN).replace(/\/+$/, "") || OFFICIAL_API_ORIGIN;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Invalid QQBot API base URL"); }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("QQBot API base URL must be an origin without credentials, path, query, or fragment");
  }
  if (url.origin === OFFICIAL_API_ORIGIN) return OFFICIAL_API_ORIGIN;

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const localTestAllowed = options.allowLocalTestEndpoint === true
    && options.nodeEnv === "test"
    && localHosts.has(url.hostname);
  if (localTestAllowed && (url.protocol === "http:" || url.protocol === "https:")) return url.origin;
  throw new Error("QQBot API base URL must use https://api.sgroup.qq.com");
}

/** Prevent credential-bearing requests from following redirects to another origin. */
export function noRedirectRequestInit(options: RequestInit = {}): RequestInit {
  return { ...options, redirect: "error" };
}

/** Resolve a token API origin, allowing only Tencent's endpoint by default. */
export function resolveTokenEndpoint(
  configuredBaseUrl: string | undefined,
  options: { allowLocalTestEndpoint?: boolean; nodeEnv?: string } = {},
): string {
  const raw = (configuredBaseUrl || OFFICIAL_TOKEN_ORIGIN).replace(/\/+$/, "") || OFFICIAL_TOKEN_ORIGIN;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Invalid QQBot token endpoint URL"); }

  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("QQBot token endpoint must be an origin without credentials, path, query, or fragment");
  }
  if (url.origin === OFFICIAL_TOKEN_ORIGIN) return `${OFFICIAL_TOKEN_ORIGIN}/app/getAppAccessToken`;

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const localTestAllowed = options.allowLocalTestEndpoint === true
    && options.nodeEnv === "test"
    && localHosts.has(url.hostname);
  if (localTestAllowed && (url.protocol === "http:" || url.protocol === "https:")) {
    return `${url.origin}/app/getAppAccessToken`;
  }
  throw new Error("QQBot token endpoint must use https://bots.qq.com");
}

export const DEFAULT_TOKEN_ENDPOINT = `${OFFICIAL_TOKEN_ORIGIN}/app/getAppAccessToken`;
