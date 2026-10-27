import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTBOUND_SENT_AT_STATUS,
  TurnSearchCallLimiter,
  buildDispatchTraceRecord,
  consumeSearchToolCall,
  evaluateGroupSearchGuard,
  getRequestContext,
  rememberCurrentQqTurnContext,
  resolveQqTurnContext,
  runBestEffort,
  runWithRequestContext,
} from "./request-context.js";

const validGroupContext = {
  agentId: "qq-group-pro",
  channel: "qqbot",
  chatType: "group",
  groupId: "allowed-group",
  wasMentioned: true,
  userText: "搜索一下版本更新时间",
};

test("group guard preserves authorization boundaries", () => {
  assert.equal(evaluateGroupSearchGuard(validGroupContext, "web_search", true).wouldAllow, true);
  assert.equal(evaluateGroupSearchGuard({ ...validGroupContext, wasMentioned: false }, "web_search", true).denyReason, "not_mentioned");
  assert.equal(evaluateGroupSearchGuard(validGroupContext, "web_search", false).denyReason, "group_not_whitelisted");
  assert.equal(evaluateGroupSearchGuard({}, "web_search", true).denyReason, "missing_context");
});

test("request context survives the async route-agent-tool chain", async () => {
  await runWithRequestContext({
    target: "qqbot:group:redacted",
    traceId: "trace-1",
    agentId: "qq-group-pro",
    sessionKey: "session-1",
    messageSource: "qqbot",
    chatType: "group",
    groupSearch: { groupId: "allowed-group", wasMentioned: true, userText: "搜索一下更新时间" },
  }, async () => {
    await Promise.resolve();
    assert.equal(getRequestContext()?.groupSearch?.wasMentioned, true);
    assert.equal(getRequestContext()?.groupSearch?.userText.includes("搜索"), true);
  });
  assert.equal(getRequestContext(), undefined);
});

test("web_search is limited to three calls per turn and resets for a new turn", () => {
  const runTurn = () => runWithRequestContext({ target: "qqbot:c2c:redacted" }, () => [
    consumeSearchToolCall("web_search"),
    consumeSearchToolCall("web_search"),
    consumeSearchToolCall("web_search"),
    consumeSearchToolCall("web_search"),
  ]);
  assert.deepEqual(runTurn().map((x) => x.allowed), [true, true, true, false]);
  assert.deepEqual(runTurn().map((x) => x.allowed), [true, true, true, false]);
});

test("different concurrent sessions do not share search counters", async () => {
  const runSession = (target: string) => runWithRequestContext({ target }, async () => {
    await Promise.resolve();
    return consumeSearchToolCall("web_search").count;
  });
  assert.deepEqual(await Promise.all([runSession("qqbot:c2c:a"), runSession("qqbot:c2c:b")]), [1, 1]);
});

test("web_fetch does not consume the web_search budget", () => {
  runWithRequestContext({ target: "qqbot:c2c:redacted" }, () => {
    assert.equal(consumeSearchToolCall("web_fetch").count, 0);
    assert.equal(consumeSearchToolCall("web_search").count, 1);
  });
});

test("stable turn limiter survives different hook context objects", () => {
  const limiter = new TurnSearchCallLimiter();
  const identity = { turnId: "turn-1", sessionKey: "session-1", agentId: "qq-private-pro" };
  let providerCalls = 0;
  const decisions = Array.from({ length: 4 }, () => {
    const decision = limiter.consume({ ...identity }, "web_search");
    if (decision.allowed) providerCalls++;
    return decision;
  });
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, true, false]);
  assert.equal(providerCalls, 3);
  assert.deepEqual(
    { reason: decisions[3].reason ?? "search_call_limit_reached", maxCalls: decisions[3].maxCalls },
    { reason: "search_call_limit_reached", maxCalls: 3 },
  );
});

test("stable turn limiter isolates new turns, sessions, and agents", () => {
  const limiter = new TurnSearchCallLimiter();
  const consume = (turnId: string, sessionKey: string, agentId: string) =>
    limiter.consume({ turnId, sessionKey, agentId }, "web_search").count;
  assert.equal(consume("turn-a", "session-a", "agent-a"), 1);
  assert.equal(consume("turn-a", "session-a", "agent-a"), 2);
  assert.equal(consume("turn-b", "session-a", "agent-a"), 1);
  assert.equal(consume("turn-a", "session-b", "agent-a"), 1);
  assert.equal(consume("turn-a", "session-a", "agent-b"), 1);
});

test("web_fetch does not consume stable turn budget", () => {
  const limiter = new TurnSearchCallLimiter();
  const identity = { turnId: "turn-fetch", sessionKey: "session-fetch", agentId: "agent-fetch" };
  assert.equal(limiter.consume({ ...identity }, "web_fetch").count, 0);
  assert.equal(limiter.consume({ ...identity }, "web_search").count, 1);
});

test("request errors still consume the stable turn budget", () => {
  const limiter = new TurnSearchCallLimiter();
  const identity = { turnId: "turn-error", sessionKey: "session-error", agentId: "agent-error" };
  let providerCalls = 0;
  const decisions = Array.from({ length: 4 }, (_unused, index) => {
    const decision = limiter.consume({ ...identity }, "web_search");
    if (decision.allowed) {
      providerCalls++;
      if (index === 0) void new Error("request_error");
    }
    return decision.allowed;
  });
  assert.deepEqual(decisions, [true, true, true, false]);
  assert.equal(providerCalls, 3);
});

test("stable turn limiter bounds memory with TTL and capacity cleanup", () => {
  const limiter = new TurnSearchCallLimiter(10, 2);
  assert.equal(limiter.consume({ turnId: "1", sessionKey: "s", agentId: "a" }, "web_search", 3, 0).allowed, true);
  assert.equal(limiter.consume({ turnId: "2", sessionKey: "s", agentId: "a" }, "web_search", 3, 0).allowed, true);
  assert.equal(limiter.consume({ turnId: "3", sessionKey: "s", agentId: "a" }, "web_search", 3, 1).allowed, true);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.consume({ turnId: "4", sessionKey: "s", agentId: "a" }, "web_search", 3, 20).allowed, true);
  assert.equal(limiter.size(), 1);
});

test("QQ lifecycle hooks can resolve trace outside AsyncLocalStorage", () => {
  runWithRequestContext({
    target: "qqbot:c2c:redacted",
    turnId: "turn-lifecycle",
    traceId: "trace-lifecycle",
    agentId: "qq-private-pro",
    sessionKey: "session-lifecycle",
    sessionLaneHash: "lane-hash",
    messageSource: "qqbot",
    chatType: "direct",
  }, () => rememberCurrentQqTurnContext());
  const resolved = resolveQqTurnContext({
    turnId: "turn-lifecycle",
    agentId: "qq-private-pro",
    sessionKey: "session-lifecycle",
  });
  assert.equal(resolved?.traceId, "trace-lifecycle");
  assert.equal(resolveQqTurnContext({
    turnId: "different-turn",
    agentId: "qq-private-pro",
    sessionKey: "session-lifecycle",
  }), undefined);
  assert.equal(OUTBOUND_SENT_AT_STATUS, "unavailable_by_design");
});

test("best-effort notify success, timeout, and error never block dispatch", async () => {
  let success = false;
  runBestEffort(Promise.resolve("ok"), () => { success = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(success, true);

  let release!: () => void;
  const hanging = new Promise<void>((resolve) => { release = resolve; });
  const started = Date.now();
  runBestEffort(hanging);
  assert.ok(Date.now() - started < 50);
  release();

  let rejected = false;
  runBestEffort(Promise.reject(new Error("notify failed")), undefined, () => { rejected = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, true);
});

test("dispatch trace record emits safe correlation fields", () => {
  const record = buildDispatchTraceRecord({
    target: "qqbot:c2c:redacted",
    traceId: "trace-1",
    agentId: "qq-private-pro",
    sessionLaneHash: "lane-hash",
    messageSource: "qqbot",
    chatType: "direct",
  }, "agentStartedAt", "2026-07-13T00:00:00.000Z");
  assert.equal(record.traceId, "trace-1");
  assert.equal(record.sessionLane, "lane-hash");
  assert.equal(record.agentStartedAt, "2026-07-13T00:00:00.000Z");
  assert.equal("sessionKey" in record, false);
});
