declare module "openclaw/plugin-sdk/webhook-ingress" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export interface WebhookInFlightLimiter {
    tryAcquire(key: string): boolean;
    release(key: string): void;
    size(): number;
    clear(): void;
  }

  export interface FixedWindowRateLimiter {
    isRateLimited(key: string, nowMs?: number): boolean;
    size(): number;
    clear(): void;
  }

  export function createWebhookInFlightLimiter(opts?: {
    maxInFlightPerKey?: number;
    maxTrackedKeys?: number;
  }): WebhookInFlightLimiter;

  export function createFixedWindowRateLimiter(opts: {
    windowMs: number;
    maxRequests: number;
    maxTrackedKeys: number;
    pruneIntervalMs?: number;
  }): FixedWindowRateLimiter;

  export function registerWebhookTargetWithPluginRoute<T extends { path: string }>(opts: {
    targetsByPath: Map<string, T[]>;
    target: T;
    route: {
      auth: string;
      match: "exact" | "prefix";
      pluginId: string;
      source: string;
      accountId: string;
      replaceExisting?: boolean;
      log?: (msg: string) => void;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
    };
    onLastPathTargetRemoved?: () => void;
  }): { unregister: () => void };

  export function withResolvedWebhookRequestPipeline<T extends { path: string }>(opts: {
    req: IncomingMessage;
    res: ServerResponse;
    targetsByPath: Map<string, T[]>;
    rateLimiter?: FixedWindowRateLimiter;
    inFlightLimiter?: WebhookInFlightLimiter;
    requireJsonContentType?: boolean;
    handle: (ctx: { path: string; targets: T[] }) => Promise<boolean | void> | boolean | void;
  }): Promise<boolean>;

  export function resolveWebhookTargetWithAuthOrRejectSync<T>(opts: {
    targets: readonly T[];
    res: ServerResponse;
    isMatch: (target: T) => boolean;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
  }): T | null;

  export function readWebhookBodyOrReject(opts: {
    req: IncomingMessage;
    res: ServerResponse;
    maxBytes?: number;
    timeoutMs?: number;
  }): Promise<{ ok: true; value: string } | { ok: false }>;
}
