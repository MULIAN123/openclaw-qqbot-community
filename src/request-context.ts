/**
 * 请求级上下文（基于 AsyncLocalStorage）
 *
 * 解决并发消息下工具获取当前会话信息的竞态问题。
 * gateway 在处理每条入站消息时通过 runWithRequestContext() 建立作用域，
 * 作用域内的所有异步代码（包括 AI agent 调用、tool execute）
 * 都能通过 getRequestContext() 安全地拿到当前请求的上下文。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** 投递目标地址，如 qqbot:c2c:xxx 或 qqbot:group:xxx */
  target: string;
  /** 当前请求的 QQBot 账户 ID（多账户场景） */
  accountId?: string;
  /** Stable OpenClaw runId for this inbound QQ message; kept in memory only. */
  turnId?: string;
  traceId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionLaneHash?: string;
  messageSource?: string;
  chatType?: string;
  /** Exact requester for the current inbound QQ turn; memory-only. */
  requesterId?: string;
  /** Workspace assigned to the selected QQ agent for this turn. */
  workspaceRoot?: string;
  /** Explicit Agent Task Delivery direct-turn task binding for this QQ turn. */
  directTaskId?: string;
  groupSearch?: {
    groupId: string;
    wasMentioned: boolean;
    userText: string;
  };
  searchCallCount?: number;
}

export type GroupSearchGuardInput = {
  agentId?: string;
  channel?: string;
  chatType?: string;
  groupId?: string;
  wasMentioned?: boolean;
  userText?: string;
};

export type GroupSearchGuardDecision = {
  wouldAllow: boolean;
  denyReason?: string;
  searchIntent: boolean;
  questionCountEstimate: number;
};

const GROUP_SEARCH_INTENT_RE = /(搜索|查一下|联网查|最新|官网|来源|官方公告)/i;

function estimateQuestionCount(value?: string): number {
  const text = (value ?? "").trim();
  if (!text) return 0;
  const numbered = text.match(/(?:^|\n)\s*(?:\d+[\.、)]|[一二三四五六七八九十]+[、.])\s+/g)?.length ?? 0;
  const questionMarks = text.match(/[？?]/g)?.length ?? 0;
  const intentSegments = text.split(/[\n；;]/).filter((part) => GROUP_SEARCH_INTENT_RE.test(part)).length;
  return Math.max(numbered, questionMarks, intentSegments, 1);
}

export function evaluateGroupSearchGuard(
  ctx: GroupSearchGuardInput,
  toolName: string,
  isAllowlistedGroup: boolean,
): GroupSearchGuardDecision {
  const agentId = (ctx.agentId ?? "").trim();
  const channel = (ctx.channel ?? "").trim();
  const chatType = (ctx.chatType ?? "").trim();
  const groupId = (ctx.groupId ?? "").trim();
  const userText = ctx.userText ?? "";
  const searchIntent = GROUP_SEARCH_INTENT_RE.test(userText);
  const questionCountEstimate = estimateQuestionCount(userText);
  if (!agentId || !channel || !chatType || !groupId || typeof ctx.wasMentioned !== "boolean" || !userText) {
    return { wouldAllow: false, denyReason: "missing_context", searchIntent, questionCountEstimate };
  }
  if (agentId !== "qq-group-pro") return { wouldAllow: false, denyReason: "not_group_agent", searchIntent, questionCountEstimate };
  if (channel !== "qqbot") return { wouldAllow: false, denyReason: "not_qqbot", searchIntent, questionCountEstimate };
  if (chatType !== "group") return { wouldAllow: false, denyReason: "not_group_chat", searchIntent, questionCountEstimate };
  if (!isAllowlistedGroup) return { wouldAllow: false, denyReason: "group_not_whitelisted", searchIntent, questionCountEstimate };
  if (ctx.wasMentioned !== true) return { wouldAllow: false, denyReason: "not_mentioned", searchIntent, questionCountEstimate };
  if (!searchIntent) return { wouldAllow: false, denyReason: "no_search_intent", searchIntent, questionCountEstimate };
  if (questionCountEstimate > 2) return { wouldAllow: false, denyReason: "too_many_questions", searchIntent, questionCountEstimate };
  if (toolName === "browser") return { wouldAllow: false, denyReason: "sidepath_blocked_browser", searchIntent, questionCountEstimate };
  if (toolName === "exec") return { wouldAllow: false, denyReason: "sidepath_blocked_exec", searchIntent, questionCountEstimate };
  return { wouldAllow: true, searchIntent, questionCountEstimate };
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export type StableTurnIdentity = {
  turnId?: string;
  sessionKey?: string;
  agentId?: string;
};

export type SearchCallLimitDecision = {
  allowed: boolean;
  count: number;
  maxCalls: number;
  reason?: "missing_turn_identity";
};

type SearchCallCounter = {
  count: number;
  expiresAt: number;
};

export class TurnSearchCallLimiter {
  private readonly counters = new Map<string, SearchCallCounter>();

  constructor(
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly maxEntries = 4096,
  ) {}

  private key(identity: StableTurnIdentity): string | undefined {
    const turnId = (identity.turnId ?? "").trim();
    const sessionKey = (identity.sessionKey ?? "").trim();
    const agentId = (identity.agentId ?? "").trim();
    if (!turnId || !sessionKey || !agentId) return undefined;
    return `${agentId}\u001f${sessionKey}\u001f${turnId}`;
  }

  private cleanup(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= now) this.counters.delete(key);
    }
    while (this.counters.size >= this.maxEntries) {
      const oldestKey = this.counters.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.counters.delete(oldestKey);
    }
  }

  consume(
    identity: StableTurnIdentity,
    toolName: string,
    maxCalls = 3,
    now = Date.now(),
  ): SearchCallLimitDecision {
    const key = this.key(identity);
    if (toolName !== "web_search") {
      return { allowed: true, count: key ? (this.counters.get(key)?.count ?? 0) : 0, maxCalls };
    }
    if (!key) return { allowed: false, count: 0, maxCalls, reason: "missing_turn_identity" };

    this.cleanup(now);
    const previous = this.counters.get(key);
    const count = (previous?.count ?? 0) + 1;
    this.counters.delete(key);
    this.counters.set(key, { count, expiresAt: now + this.ttlMs });
    return { allowed: count <= maxCalls, count, maxCalls };
  }

  size(): number {
    return this.counters.size;
  }
}

const turnSearchCallLimiter = new TurnSearchCallLimiter();

export function consumeTurnSearchToolCall(
  identity: StableTurnIdentity,
  toolName: string,
  maxCalls = 3,
): SearchCallLimitDecision {
  return turnSearchCallLimiter.consume(identity, toolName, maxCalls);
}

type StoredQqTurnContext = {
  context: RequestContext;
  runId?: string;
  expiresAt: number;
};

const QQ_TURN_CONTEXT_TTL_MS = 15 * 60 * 1000;
const QQ_TURN_CONTEXT_MAX_ENTRIES = 4096;
const qqTurnContextsByLane = new Map<string, StoredQqTurnContext>();
const qqTurnContextsByRun = new Map<string, StoredQqTurnContext>();

export const OUTBOUND_SENT_AT_STATUS = "unavailable_by_design" as const;

function qqTurnLaneKey(identity: Pick<StableTurnIdentity, "agentId" | "sessionKey">): string | undefined {
  const agentId = (identity.agentId ?? "").trim();
  const sessionKey = (identity.sessionKey ?? "").trim();
  if (!agentId || !sessionKey) return undefined;
  return `${agentId}\u001f${sessionKey}`;
}

function qqTurnRunKey(identity: StableTurnIdentity): string | undefined {
  const laneKey = qqTurnLaneKey(identity);
  const turnId = (identity.turnId ?? "").trim();
  return laneKey && turnId ? `${laneKey}\u001f${turnId}` : undefined;
}

function cleanupQqTurnContexts(now: number): void {
  for (const [key, stored] of qqTurnContextsByLane) {
    if (stored.expiresAt <= now) {
      qqTurnContextsByLane.delete(key);
      if (stored.runId) qqTurnContextsByRun.delete(`${key}\u001f${stored.runId}`);
    }
  }
  while (qqTurnContextsByLane.size >= QQ_TURN_CONTEXT_MAX_ENTRIES) {
    const oldestKey = qqTurnContextsByLane.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = qqTurnContextsByLane.get(oldestKey);
    qqTurnContextsByLane.delete(oldestKey);
    if (oldest?.runId) qqTurnContextsByRun.delete(`${oldestKey}\u001f${oldest.runId}`);
  }
}

export function rememberCurrentQqTurnContext(now = Date.now()): void {
  const context = asyncLocalStorage.getStore();
  if (context?.messageSource !== "qqbot" || !context.traceId) return;
  const laneKey = qqTurnLaneKey(context);
  if (!laneKey) return;
  cleanupQqTurnContexts(now);
  const previous = qqTurnContextsByLane.get(laneKey);
  if (previous?.runId) qqTurnContextsByRun.delete(`${laneKey}\u001f${previous.runId}`);
  qqTurnContextsByLane.delete(laneKey);
  const runId = (context.turnId ?? "").trim() || undefined;
  const stored: StoredQqTurnContext = {
    context: { ...context, groupSearch: context.groupSearch ? { ...context.groupSearch } : undefined },
    runId,
    expiresAt: now + QQ_TURN_CONTEXT_TTL_MS,
  };
  qqTurnContextsByLane.set(laneKey, stored);
  if (runId) qqTurnContextsByRun.set(`${laneKey}\u001f${runId}`, stored);
}

export function resolveQqTurnContext(identity: StableTurnIdentity, now = Date.now()): RequestContext | undefined {
  cleanupQqTurnContexts(now);
  const runKey = qqTurnRunKey(identity);
  let stored = runKey ? qqTurnContextsByRun.get(runKey) : undefined;
  const laneKey = qqTurnLaneKey(identity);
  if (!runKey && laneKey) stored = qqTurnContextsByLane.get(laneKey);
  if (!stored) return undefined;

  stored.expiresAt = now + QQ_TURN_CONTEXT_TTL_MS;
  return stored.context;
}

/**
 * 在请求级作用域中执行回调。
 * 作用域内所有同步/异步代码都能通过 getRequestContext() 获取上下文。
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(ctx, fn);
}

/**
 * 获取当前请求的上下文，不存在时返回 undefined。
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * 获取当前请求的投递目标地址。
 * 便捷方法，等价于 getRequestContext()?.target。
 */
export function getRequestTarget(): string | undefined {
  return asyncLocalStorage.getStore()?.target;
}

/**
 * 获取当前请求的账户 ID。
 * 便捷方法，等价于 getRequestContext()?.accountId。
 */
export function getRequestAccountId(): string | undefined {
  return asyncLocalStorage.getStore()?.accountId;
}

export function consumeWebSearchCall(maxCalls = 3): { allowed: boolean; count: number; maxCalls: number } {
  const ctx = asyncLocalStorage.getStore();
  if (!ctx) return { allowed: true, count: 1, maxCalls };
  const count = (ctx.searchCallCount ?? 0) + 1;
  ctx.searchCallCount = count;
  return { allowed: count <= maxCalls, count, maxCalls };
}

export function consumeSearchToolCall(toolName: string, maxCalls = 3): { allowed: boolean; count: number; maxCalls: number } {
  if (toolName !== "web_search") {
    return { allowed: true, count: asyncLocalStorage.getStore()?.searchCallCount ?? 0, maxCalls };
  }
  return consumeWebSearchCall(maxCalls);
}

export function runBestEffort<T>(
  promise: Promise<T>,
  onFulfilled?: (value: T) => void | Promise<void>,
  onRejected?: (error: unknown) => void,
): void {
  void promise.then((value) => onFulfilled?.(value)).catch((error) => onRejected?.(error));
}

export function buildDispatchTraceRecord(ctx: RequestContext, timestampField: string, at = new Date().toISOString()) {
  return {
    event: "qqbot-dispatch-trace",
    traceId: ctx.traceId,
    agentId: ctx.agentId,
    sessionLane: ctx.sessionLaneHash,
    messageSource: ctx.messageSource,
    chatType: ctx.chatType,
    [timestampField]: at,
  };
}
