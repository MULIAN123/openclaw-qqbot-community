import {
  type ChannelPlugin,
  type OpenClawConfig,
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import fs from "node:fs";

import type { ResolvedQQBotAccount } from "./types.js";
import { DEFAULT_ACCOUNT_ID, listQQBotAccountIds, resolveQQBotAccount, applyQQBotAccountConfig, resolveDefaultQQBotAccountId, resolveRequireMention, resolveToolPolicy, resolveGroupConfig } from "./config.js";
import { sendText, sendMedia, resolveUserFacingMediaError } from "./outbound.js";
import { startGateway } from "./gateway.js";
import { qqbotOnboardingAdapter } from "./onboarding.js";
import { getQQBotRuntime } from "./runtime.js";
import {
  assertCredentialConfigured,
  CLIENT_SECRET_FILE_UNSUPPORTED_ERROR,
  isCredentialConfigured,
  validateTokenFileSetupInput,
} from "./credential-backup.js";
import { initApiConfig } from "./api.js";
import { getApprovalHandler } from "./approval-handler.js";
import { collectAgentTaskLocalFile } from "./agent-task-delivery.js";
import { isLocalPath as isLocalFilePath } from "./utils/platform.js";
import {
  evaluateGroupSearchGuard,
  getRequestContext,
  type GroupSearchGuardInput,
} from "./request-context.js";
import { safeError } from "./utils/log-safe.js";
import { getQQBotDataDir } from "./utils/platform.js";
import { parseGroupSearchAllowlist } from "./group-search-config.js";

/** 检查 payload 是否为审批消息（与 getExecApprovalReplyMetadata 等效，内联避免版本兼容问题） */
function isApprovalPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  // channelData.execApproval 存在 → exec/plugin approval pending/resolved
  const cd = p.channelData;
  if (cd && typeof cd === "object" && !Array.isArray(cd)) {
    const execApproval = (cd as Record<string, unknown>).execApproval;
    if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
      return true;
    }
  }
  // text 匹配兜底：框架渲染的审批纯文本通知
  const text = typeof p.text === "string" ? p.text : "";
  return /(?:Plugin|Exec) approval (?:required|allowed|denied|expired)/i.test(text);
}

/** QQ Bot 单条消息文本长度上限 */
export const TEXT_CHUNK_LIMIT = 5000;

/**
 * Markdown 感知的文本分块函数
 * 委托给 SDK 内置的 channel.text.chunkMarkdownText
 * 支持代码块自动关闭/重开、括号感知等
 */
export function chunkText(text: string, limit: number): string[] {
  const runtime = getQQBotRuntime();
  return runtime.channel.text.chunkMarkdownText(text, limit);
}

function buildChannelMediaError(result: Parameters<typeof resolveUserFacingMediaError>[0]): Error {
  const err = new Error(resolveUserFacingMediaError(result));
  if (result.errorCode) {
    (err as Error & { code?: string }).code = result.errorCode;
  }
  if (result.qqBizCode !== undefined) {
    (err as Error & { qqBizCode?: number }).qqBizCode = result.qqBizCode;
  }
  return err;
}

const GROUP_SEARCH_DRYRUN_ALLOWLIST = parseGroupSearchAllowlist(process.env.QQBOT_GROUP_SEARCH_ALLOWLIST);
const GROUP_SEARCH_AUDIT_TOOLS = ["web_search", "web_fetch", "browser", "exec"] as const;
const GROUP_SEARCH_SIDEPATH_DENY_TOOLS = ["web_search", "web_fetch", "browser", "exec"];

type GroupSearchGuardContext = GroupSearchGuardInput & {
  sessionKey?: string;
};

function maskSensitiveId(value?: string): string {
  const raw = (value ?? "").trim();
  if (raw.length <= 8) return raw ? "***" : "missing";
  return `${raw.slice(0, 4).toUpperCase()}***${raw.slice(-4).toUpperCase()}`;
}

function isPlainGroupTextMessage(ctx: GroupSearchGuardContext): boolean {
  const text = ctx.userText ?? "";
  if (!text.trim()) return false;
  return !/(<qqmedia\b|qqmedia:|\battachment\b|\bfile\b|\bimage\b|\bpdf\b|\bdocx?\b)/i.test(text);
}

function allowGroupSearchGuard(ctx: GroupSearchGuardContext, toolName: string): { wouldAllow: boolean; denyReason?: string; searchIntent: boolean; questionCountEstimate: number } {
  const groupId = (ctx.groupId ?? "").trim().toLowerCase();
  if (!GROUP_SEARCH_AUDIT_TOOLS.includes(toolName as (typeof GROUP_SEARCH_AUDIT_TOOLS)[number])) {
    return { wouldAllow: false, denyReason: "unsupported_tool", searchIntent: false, questionCountEstimate: 0 };
  }
  return evaluateGroupSearchGuard(ctx, toolName, GROUP_SEARCH_DRYRUN_ALLOWLIST.has(groupId));
}

export function evaluateCurrentGroupSearchGuard(toolName: string) {
  const request = getRequestContext();
  const groupSearch = request?.groupSearch;
  return allowGroupSearchGuard({
    agentId: request?.agentId,
    channel: request?.messageSource,
    chatType: request?.chatType,
    groupId: groupSearch?.groupId,
    wasMentioned: groupSearch?.wasMentioned,
    userText: groupSearch?.userText,
    sessionKey: request?.sessionKey,
  }, toolName);
}

function restoreGroupSearchGuardContext(ctx: any, groupId: string): GroupSearchGuardContext {
  const request = getRequestContext();
  const stored = request?.groupSearch;
  const matchesGroup = stored?.groupId?.trim().toLowerCase() === groupId.trim().toLowerCase();
  return {
    agentId: ctx.agentId ?? request?.agentId,
    channel: ctx.channel ?? request?.messageSource,
    chatType: ctx.chatType ?? request?.chatType,
    groupId,
    wasMentioned: ctx.wasMentioned ?? (matchesGroup ? stored?.wasMentioned : undefined),
    userText: ctx.userText ?? (matchesGroup ? stored?.userText : undefined),
    sessionKey: ctx.sessionKey ?? request?.sessionKey,
  };
}

function appendGroupSearchGuardAudit(line: string): void {
  try {
    fs.appendFileSync(getQQBotDataDir("logs", "openclaw-stability.log"), new Date().toISOString() + " " + line + "\n", "utf8");
  } catch {
    // Audit logging must never affect message handling.
  }
}

function withGroupSearchSidepathDeny(
  policy: { allow?: string[]; deny?: string[] } | undefined,
  ctx: GroupSearchGuardContext,
): { allow: string[]; deny: string[] } | undefined {
  if (ctx.agentId !== "qq-group-pro" || ctx.channel !== "qqbot" || ctx.chatType !== "group") return policy as { allow: string[]; deny: string[] } | undefined;
  if (!isPlainGroupTextMessage(ctx)) return policy as { allow: string[]; deny: string[] } | undefined;
  const base = policy ?? {};
  const allow = base.allow ?? [];
  const searchAllowed = allowGroupSearchGuard(ctx, "web_search").wouldAllow;
  const sidepathDeny = GROUP_SEARCH_SIDEPATH_DENY_TOOLS.filter((tool) => tool !== "web_search" || !searchAllowed);
  const deny = Array.from(new Set([...(base.deny ?? []), ...sidepathDeny]));
  return { ...base, allow, deny };
}

function logGroupSearchGuardDryRun(ctx: GroupSearchGuardContext): void {
  if (ctx.agentId !== "qq-group-pro" || ctx.channel !== "qqbot" || ctx.chatType !== "group") return;
  for (const toolName of GROUP_SEARCH_AUDIT_TOOLS) {
    const decision = allowGroupSearchGuard(ctx, toolName);
    const line = [
      "event=group-search-guard-dryrun",
      `agent=${ctx.agentId ?? "missing"}`,
      `channel=${ctx.channel ?? "missing"}`,
      `chatType=${ctx.chatType ?? "missing"}`,
      `groupOpenidMasked=${maskSensitiveId(ctx.groupId)}`,
      `wasMentioned=${ctx.wasMentioned === true}`,
      `toolName=${toolName}`,
      `searchIntent=${decision.searchIntent}`,
      `questionCountEstimate=${decision.questionCountEstimate > 2 ? ">2" : decision.questionCountEstimate}`,
      `wouldAllow=${decision.wouldAllow}`,
      `denyReason=${decision.denyReason ?? "none"}`,
      `userTextLength=${ctx.userText?.length ?? 0}`,
    ].join(" ");
    console.info(`[qqbot] ${line}`);
    appendGroupSearchGuardAudit(line);
  }
}


export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
  meta: {
    id: "qqbot",
    label: "QQ Bot",
    selectionLabel: "QQ Bot",
    docsPath: "/docs/channels/qqbot",
    blurb: "Connect to QQ via official QQ Bot API",
    order: 50,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    /**
     * blockStreaming: true 表示该 Channel 支持块流式
     * 框架会收集流式响应，然后通过 deliver 回调发送
     */
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qqbot"] },

  // ============ 群消息策略适配器 ============
  groups: {
    /** 是否需要 @机器人才响应 */
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      if (!groupId) return undefined;
      return resolveRequireMention(cfg, groupId, accountId ?? undefined);
    },

    /** 群聊工具范围 */
    resolveToolPolicy: (ctx) => {
      const { cfg, accountId, groupId } = ctx;
      if (!groupId) return undefined;
      const guardCtx = restoreGroupSearchGuardContext(ctx, groupId);
      logGroupSearchGuardDryRun(guardCtx);
      const policy = resolveToolPolicy(cfg, groupId, accountId ?? undefined);
      // 将简单字符串策略映射为 GroupToolPolicyConfig 对象
      if (policy === "full") return withGroupSearchSidepathDeny(undefined, guardCtx); // full = 默认不限制
      if (policy === "none") return { allow: [], deny: ["*"] };
      // restricted: 默认空 allow（框架会使用内置 restricted 列表）
      return withGroupSearchSidepathDeny({ allow: [] }, guardCtx);
    },

    /** QQ Bot 平台特有的群聊行为提示 */
    resolveGroupIntroHint: ({ cfg, accountId, groupId }) => {
      if (!groupId) return undefined;
      const groupCfg = resolveGroupConfig(cfg, groupId, accountId ?? undefined);
      const hints: string[] = [];
      if (groupCfg.name) {
        hints.push(`当前群: ${groupCfg.name}`);
      }
      // bot 互聊防护、@状态行为指引在 gateway.ts 动态注入
      return hints.join(" ") || undefined;
    },
  },

  // ============ @mention 检测与清理 ============
  mentions: {
    /** 清理 @mention 文本（SDK ChannelMentionAdapter 接口） */
    stripMentions: ({ text, ctx }) => {
      const mentions = (ctx as any)?.mentions as Array<{ member_openid?: string; id?: string; user_openid?: string; is_you?: boolean; nickname?: string; username?: string }> | undefined;
      return stripMentionText(text, mentions);
    },
  },
  // CLI onboarding wizard
  // @ts-ignore onboarding removed from ChannelPlugin type in 2026.3.23 but still supported at runtime
  onboarding: qqbotOnboardingAdapter,

  config: {
    listAccountIds: (cfg) => listQQBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQQBotAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultQQBotAccountId(cfg),
    // 新增：设置账户启用状态
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    // 新增：删除账户
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        clearBaseFields: ["appId", "clientSecret", "clientSecretFile", "name"],
      }),
    isConfigured: (account) => {
      return isCredentialConfigured(account);
    },
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
    }),
    // 关键：解析 allowFrom 配置，用于命令授权
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      const allowFrom = account.config?.allowFrom ?? [];
      console.log(`[qqbot] resolveAllowFrom: entries=${allowFrom.length}`);
      return allowFrom.map((entry: string | number) => String(entry)) as (string | number)[];
    },
    // 格式化 allowFrom 条目（移除 qqbot: 前缀，统一大写）
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
      allowFrom
        .map((entry: string | number) => String(entry).trim())
        .filter(Boolean)
        .map((entry: string) => entry.replace(/^qqbot:/i, ""))
        .map((entry: string) => entry.toUpperCase()), // QQ openid 是大写的
  },
  setup: {
    // 新增：规范化账户 ID
    resolveAccountId: ({ accountId }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    // 新增：应用账户名称
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qqbot",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return "QQBot requires --token (format: appId:clientSecret) or --use-env";
      }
      return validateTokenFileSetupInput(input);
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = "";
      let clientSecret = "";

      if (input.token) {
        const parts = input.token.split(":");
        if (parts.length === 2) {
          appId = parts[0];
          clientSecret = parts[1];
        }
      }

      return applyQQBotAccountConfig(cfg, accountId, {
        appId,
        clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
        imageServerBaseUrl: (input as Record<string, unknown>).imageServerBaseUrl as string | undefined,
      }) as OpenClawConfig;
    },
  },
  // Messaging 配置：用于解析目标地址
  messaging: {
    /**
     * 规范化目标地址
     * 支持以下格式：
     * - qqbot:c2c:openid -> 私聊
     * - qqbot:group:groupid -> 群聊
     * - qqbot:channel:channelid -> 频道
     * - c2c:openid -> 私聊
     * - group:groupid -> 群聊
     * - channel:channelid -> 频道
     * - 纯 openid（32位十六进制）-> 私聊
     */
    normalizeTarget: (target: string): string | undefined => {
      // 去掉 qqbot: 前缀（如果有）
      const id = target.replace(/^qqbot:/i, "");
      
      // 检查是否是已知格式
      if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
        return `qqbot:${id}`;
      }
      
      // 检查是否是纯 openid（32位十六进制，不带连字符）
      // QQ Bot OpenID 格式类似: 207A5B8339D01F6582911C014668B77B
      const openIdHexPattern = /^[0-9a-fA-F]{32}$/;
      if (openIdHexPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }

      // 检查是否是 UUID 格式的 openid（带连字符）
      const openIdUuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (openIdUuidPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }
      
      // 不认识的格式，返回 undefined 让核心使用原始值
      return undefined;
    },
    /**
     * 目标解析器配置
     * 用于判断一个目标 ID 是否看起来像 QQ Bot 的格式
     */
    targetResolver: {
      /**
       * 判断目标 ID 是否可能是 QQ Bot 格式
       * 支持以下格式：
       * - qqbot:c2c:xxx
       * - qqbot:group:xxx  
       * - qqbot:channel:xxx
       * - c2c:xxx
       * - group:xxx
       * - channel:xxx
       * - UUID 格式的 openid
       */
      looksLikeId: (id: string): boolean => {
        // 带 qqbot: 前缀的格式
        if (/^qqbot:(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 不带前缀但有类型标识
        if (/^(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 32位十六进制 openid（不带连字符）
        if (/^[0-9a-fA-F]{32}$/.test(id)) {
          return true;
        }
        // UUID 格式的 openid（带连字符）
        const openIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        return openIdPattern.test(id);
      },
      hint: "QQ Bot 目标格式: qqbot:c2c:openid (私聊) 或 qqbot:group:groupid (群聊)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 5000,
    // 3.31+ outbound 路径：dispatch-from-config → shouldSuppressLocalExecApprovalPrompt → outbound.shouldSuppressLocalPayloadPrompt
    shouldSuppressLocalPayloadPrompt: ({ accountId, payload }: any) =>
      getApprovalHandler(accountId ?? "") != null &&
      isApprovalPayload(payload),
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      console.log(`[qqbot:channel] sendText called — textLength=${text?.length ?? 0}`);
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      initApiConfig({ markdownSupport: account.markdownSupport });
      console.log(`[qqbot:channel] sendText account resolved: enabled=${account.enabled}`);
      const result = await sendText({ to, text, accountId, replyToId, account });
      console.log(`[qqbot:channel] sendText result: success=${!result.error}, errorType=${result.error ? "send_failed" : "none"}`);
      if (result.error) throw new Error(result.error);
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      console.log(`[qqbot:channel] sendMedia called — hasMedia=${Boolean(mediaUrl)}, textLength=${text?.length ?? 0}`);
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      initApiConfig({ markdownSupport: account.markdownSupport });
      const requestContext = getRequestContext();
      const isAgentLocalResult = Boolean(
        mediaUrl
        && isLocalFilePath(mediaUrl)
        && requestContext?.messageSource === "qqbot"
        && requestContext.turnId
        && requestContext.directTaskId
        && requestContext.agentId
        && requestContext.workspaceRoot,
      );
      if (isAgentLocalResult) {
        if (requestContext!.target !== to || (requestContext!.accountId && requestContext!.accountId !== account.accountId)) {
          throw new Error("agent_task_delivery_context_mismatch");
        }
        const collected = await collectAgentTaskLocalFile({
          taskId: requestContext!.directTaskId!,
          originMessageId: requestContext!.turnId!,
          turnId: requestContext!.turnId,
          filePath: mediaUrl!,
          sourceKind: "message_send_media",
          workspaceRoot: requestContext!.workspaceRoot,
          sourceAgent: requestContext!.agentId,
        });
        if (collected.handled) {
          if (!collected.accepted) throw new Error(`agent_task_delivery_rejected:${collected.reason ?? "unknown"}`);
          return {
            channel: "qqbot" as const,
            messageId: `task-${collected.shortTaskId ?? "pending"}-collected`,
          };
        }
      }
      console.log(`[qqbot:channel] sendMedia account resolved: enabled=${account.enabled}`);
      const result = await sendMedia({ to, text: text ?? "", mediaUrl: mediaUrl ?? "", accountId, replyToId, account });
      console.log(`[qqbot:channel] sendMedia result: success=${!result.error}, errorType=${result.error ? "send_failed" : "none"}`);
      // 此 sendMedia 是框架 Channel Plugin 的标准出站接口，
      // 由框架 deliver.js (deliverOutboundPayloads) 或 message-actions 调用。
      // 当 throw Error 后，框架 pi-tool-definition-adapter 会将错误转化为
      // tool 的 { status: "error" } 返回给 AI 模型，模型会自行生成错误回复给用户。
      // 因此此处不应主动发送兜底文本，否则会与模型的回复重复。
      if (result.error) {
        throw buildChannelMediaError(result);
      }
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account } = ctx;
      const { abortSignal, log, cfg } = ctx;

      try {
        assertCredentialConfigured(account);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("qqbot_client_secret_file_unsupported")) {
          log?.error(`[qqbot:${account.accountId}] ${message}`);
        } else {
          log?.error(`[qqbot:${account.accountId}] credential_missing: configure appId and clientSecret in OpenClaw config`);
        }
        throw error;
      }

      log?.info(`[qqbot:${account.accountId}] Starting gateway — appId=${account.appId}, enabled=${account.enabled}, name=${account.name ?? "unnamed"}`);
      console.log(`[qqbot:channel] startAccount: accountId=${account.accountId}, appId=${account.appId}, secretSource=${account.secretSource}`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${safeError(error)}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
    // 新增：登出账户（清除配置中的凭证）
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
      let cleared = false;
      let changed = false;

      if (nextQQBot) {
        const qqbot = nextQQBot as Record<string, unknown>;
        if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
          delete qqbot.clientSecret;
          cleared = true;
          changed = true;
        }
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId] as Record<string, unknown> | undefined;
          if (entry && "clientSecret" in entry) {
            delete entry.clientSecret;
            cleared = true;
            changed = true;
          }
          if (entry && Object.keys(entry).length === 0) {
            delete accounts[accountId];
            changed = true;
          }
        }
      }

      if (changed && nextQQBot) {
        nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as { writeConfigFile: (cfg: OpenClawConfig) => Promise<void> };
        await configApi.writeConfigFile(nextCfg);
      }

      const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { ok: true, cleared, envToken, loggedOut };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    // 新增：构建通道摘要
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
      running: Boolean(runtime?.running ?? false),
      connected: Boolean(runtime?.connected ?? false),
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError
        ?? (account?.secretSource === "file" && !account?.clientSecret ? CLIENT_SECRET_FILE_UNSUPPORTED_ERROR : null),
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  // QQBot approval-handler 通过独立 WS 连接自行处理 exec + plugin 审批消息投递（带 Inline Keyboard），
  // 完全屏蔽框架 Forwarder 的纯文本通知。
  //
  // ── 3.28 扁平结构 ──
  execApprovals: {
    // 3.28 框架通过此方法判断 channel 是否支持审批
    getInitiatingSurfaceState: ({ accountId }: { cfg: any; accountId?: string | null }) => {
      return getApprovalHandler(accountId ?? "") != null
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const };
    },
    shouldSuppressForwardingFallback: (...args: any[]) => {
      return true;
    },
    shouldSuppressLocalPrompt: ({ accountId, payload }: any) =>
      getApprovalHandler(accountId ?? "") != null &&
      isApprovalPayload(payload),
    buildPendingPayload: () => null,
    buildResolvedPayload: () => null,
  },
  // ── 3.31+ 嵌套结构 ──
  // auth 和 approvals 是 ChannelPlugin 顶层平级字段
  //
  // QQBot 审批模型：
  //   - QQBotApprovalHandler 通过独立 WS 自行投递带 Inline Keyboard 的审批消息
  //   - 用户点击按钮 → INTERACTION_CREATE → resolveApproval → gateway RPC
  //   - /approve 文本命令作为 URGENT_COMMAND 直接入队交给框架处理
  auth: {
    authorizeActorAction: () => ({ authorized: true }),
    getActionAvailabilityState: ({ accountId }: {
      cfg: any; accountId?: string | null; action: "approve";
    }) => {
      return getApprovalHandler(accountId ?? "") != null
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const };
    },
  },
  approvals: {
    delivery: {
      hasConfiguredDmRoute: () => true,
      shouldSuppressForwardingFallback: () => true,
    },
    render: {
      exec: {
        buildPendingPayload: () => null,
        buildResolvedPayload: () => null,
      },
      plugin: {
        buildPendingPayload: () => null,
        buildResolvedPayload: () => null,
      },
    },
  },
};

// ============ 独立的 mention 工具函数（供 gateway.ts 等直接调用） ============

/** 清理 @mention：替换 <@openid> 为 @用户名，去除 @机器人自身 */
export function stripMentionText(text: string, mentions?: Array<{ member_openid?: string; id?: string; user_openid?: string; is_you?: boolean; nickname?: string; username?: string }>): string {
  if (!text || !mentions?.length) return text;
  let cleaned = text;
  for (const m of mentions) {
    const openid = m.member_openid ?? m.id ?? m.user_openid;
    if (!openid) continue;
    if (m.is_you) {
      cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, "g"), "").trim();
    } else {
      const displayName = m.nickname ?? m.username;
      if (displayName) {
        cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, "g"), `@${displayName}`);
      }
    }
  }
  return cleaned;
}

/** 检测消息是否 @了机器人（mentions > eventType > mentionPatterns） */
export function detectWasMentioned({ eventType, mentions, content, mentionPatterns }: {
  eventType?: string;
  mentions?: Array<{ is_you?: boolean }>;
  content?: string;
  mentionPatterns?: string[];
}): boolean {
  if (mentions?.some((m) => m.is_you)) return true;
  if (eventType === "GROUP_AT_MESSAGE_CREATE") return true;
  if (mentionPatterns?.length && content) {
    for (const pattern of mentionPatterns) {
      try {
        if (new RegExp(pattern, "i").test(content)) return true;
      } catch {
        // 无效正则，跳过
      }
    }
  }
  return false;
}
