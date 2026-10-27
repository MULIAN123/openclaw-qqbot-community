import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { evaluateCurrentGroupSearchGuard, qqbotPlugin } from "./src/channel.js";
import { setQQBotRuntime } from "./src/runtime.js";
import {
  OUTBOUND_SENT_AT_STATUS,
  buildDispatchTraceRecord,
  consumeSearchToolCall,
  consumeTurnSearchToolCall,
  getRequestContext,
  resolveQqTurnContext,
} from "./src/request-context.js";
import { registerChannelTool } from "./src/tools/channel.js";
import { registerRemindTool } from "./src/tools/remind.js";

const plugin = {
  id: "openclaw-qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQBotRuntime(api.runtime);
    api.registerChannel({ plugin: qqbotPlugin as any });
    registerChannelTool(api);
    registerRemindTool(api);
    const registerHook = (api as any).registerHook?.bind(api);
    if (registerHook) {
      registerHook("before_tool_call", (event: any) => {
        if (event?.toolName !== "web_search") return;
        const request = getRequestContext();
        if (request?.messageSource !== "qqbot") return;
        if (request.chatType === "group") {
          const guard = evaluateCurrentGroupSearchGuard("web_search");
          if (!guard.wouldAllow) {
            return { block: true, blockReason: JSON.stringify({ reason: guard.denyReason ?? "group_search_denied" }) };
          }
        }
        const limit = consumeSearchToolCall(event.toolName, 3);
        if (!limit.allowed) {
          return {
            block: true,
            blockReason: JSON.stringify({ reason: "search_call_limit_reached", maxCalls: limit.maxCalls, attemptedCall: limit.count }),
          };
        }
      });

      const logTrace = (timestampField: string) => {
        const request = getRequestContext();
        if (request?.messageSource !== "qqbot" || !request.traceId) return;
        api.logger.info?.(JSON.stringify(buildDispatchTraceRecord(request, timestampField)));
      };
      registerHook("before_agent_start", () => logTrace("agentStartedAt"));
      registerHook("agent_end", () => logTrace("agentFinishedAt"));
      registerHook("message_sent", () => logTrace("outboundSentAt"));
    }

    const onLifecycleHook = (api as any).on?.bind(api);
    if (!onLifecycleHook) return;

    onLifecycleHook("before_tool_call", (event: any, hookContext: any) => {
      if (event.toolName !== "web_search") return;
      const turnId = hookContext.runId ?? event.runId;
      const request = resolveQqTurnContext({
        turnId,
        sessionKey: hookContext.sessionKey,
        agentId: hookContext.agentId,
      });
      if (!request) return;

      const limit = consumeTurnSearchToolCall({
        turnId,
        sessionKey: hookContext.sessionKey ?? request.sessionKey,
        agentId: hookContext.agentId ?? request.agentId,
      }, event.toolName, 3);
      if (!limit.allowed) {
        const reason = limit.reason ?? "search_call_limit_reached";
        api.logger.info?.(JSON.stringify({
          event: "qqbot-search-call-limit",
          traceId: request.traceId,
          agentId: request.agentId,
          reason,
          maxCalls: limit.maxCalls,
          attemptedCall: limit.count,
        }));
        return {
          block: true,
          blockReason: JSON.stringify({ reason, maxCalls: limit.maxCalls }),
        };
      }
    });

    const logLifecycleTrace = (
      timestampField: "agentStartedAt" | "agentFinishedAt",
      hookContext: { agentId?: string; sessionKey?: string },
    ) => {
      const request = resolveQqTurnContext({
        agentId: hookContext.agentId,
        sessionKey: hookContext.sessionKey,
      });
      if (!request) return;
      api.logger.info?.(JSON.stringify({
        ...buildDispatchTraceRecord(request, timestampField),
        outboundSentAtStatus: OUTBOUND_SENT_AT_STATUS,
      }));
    };
    onLifecycleHook("before_agent_start", (_event: any, hookContext: any) => logLifecycleTrace("agentStartedAt", hookContext));
    onLifecycleHook("agent_end", (_event: any, hookContext: any) => logLifecycleTrace("agentFinishedAt", hookContext));
  },
};

export default plugin;

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export { qqbotOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
export * from "./src/transport/index.js";
