/**
 * QQBot 插件级斜杠指令处理器
 *
 * 设计原则：
 * 1. 在消息入队前拦截，匹配到插件级指令后直接回复，不进入 AI 处理队列
 * 2. 不匹配的 "/" 消息照常入队，交给 OpenClaw 框架处理
 * 3. 每个指令通过 SlashCommand 接口注册，易于扩展
 *
 * 时间线追踪：
 *   开平推送时间戳 → 插件收到(Date.now()) → 指令处理完成(Date.now())
 *   从而计算「开平→插件」和「插件处理」两段耗时
 */

import type { QQBotAccountConfig } from "./types.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { isWindows } from "./utils/platform.js";
import { getHomeDir } from "./utils/platform.js";
import { getPackageVersion } from "./utils/pkg-version.js";
import { getQQBotRuntime } from "./runtime.js";
import { isApprovalFeatureAvailable } from "./approval-handler.js";

let PLUGIN_VERSION = getPackageVersion(import.meta.url);

// 获取 openclaw 框架版本（不缓存，每次实时获取）
export function getFrameworkVersion(): string {
  try {
    // 先尝试 PATH 中的 CLI
    // Windows 上 npm 安装的 CLI 通常是 .cmd wrapper，execFileSync 需要 shell:true 才能执行
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      try {
        const rawOut = execFileSync(cli, ["--version"], {
          timeout: 3000, encoding: "utf8",
          ...(isWindows() ? { shell: true } : {}),
        }).trim();
        // 输出格式: "OpenClaw 2026.3.13 (61d171a)"
        // CLI 启动时可能输出 proxy 等初始化日志到 stdout，需过滤出真正的版本行
        const out = rawOut
          .split("\n")
          .find((line) => /^(OpenClaw|clawdbot|moltbot)\s/i.test(line))
          ?.trim() ?? rawOut;
        if (out) {
          return out;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fallback
  }
  return "unknown";
}

/** Extract the OpenClaw calendar version when one is present. */
export function parseFrameworkDateVersion(versionStr: string): string | null {
  const match = versionStr.match(/(\d{4}\.\d{1,2}\.\d{1,2})/);
  return match?.[1] ?? null;
}

// ============ 类型定义 ============

/** 斜杠指令上下文（消息元数据 + 运行时状态） */
export interface SlashCommandContext {
  /** 消息类型 */
  type: "c2c" | "guild" | "dm" | "group";
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderName?: string;
  /** 消息 ID（用于被动回复） */
  messageId: string;
  /** 开平推送的事件时间戳（ISO 字符串） */
  eventTimestamp: string;
  /** 插件收到消息的本地时间（ms） */
  receivedAt: number;
  /** 原始消息内容 */
  rawContent: string;
  /** 指令参数（去掉指令名后的部分） */
  args: string;
  /** 频道 ID（guild 类型） */
  channelId?: string;
  /** 群 openid（group 类型） */
  groupOpenid?: string;
  /** 账号 ID */
  accountId: string;
  /** Bot App ID */
  appId: string;
  /** 账号配置（供指令读取可配置项） */
  accountConfig?: QQBotAccountConfig;
  /** 当前用户队列状态快照 */
  queueSnapshot: QueueSnapshot;
}

/** 队列状态快照 */
export interface QueueSnapshot {
  /** 各用户队列中的消息总数 */
  totalPending: number;
  /** 正在并行处理的用户数 */
  activeUsers: number;
  /** 最大并发用户数 */
  maxConcurrentUsers: number;
  /** 当前发送者在队列中的待处理消息数 */
  senderPending: number;
}

/** 斜杠指令返回值：文本、带文件的结果、委托给模型、或 null（不处理） */
export type SlashCommandResult = string | SlashCommandFileResult | SlashCommandDelegateResult | null;

/** 带文件的指令结果（先回复文本，再发送文件） */
export interface SlashCommandFileResult {
  text: string;
  /** 要发送的本地文件路径 */
  filePath: string;
}

/** 委托给 AI 模型处理：用加工后的 prompt 替换原始消息入队 */
export interface SlashCommandDelegateResult {
  /** 替换原始消息内容的 prompt，交给 AI 模型执行 */
  delegatePrompt: string;
}

/** 斜杠指令定义 */
interface SlashCommand {
  /** 指令名（不含 /） */
  name: string;
  /** 简要描述 */
  description: string;
  /** 详细用法说明（支持多行），用于 /指令 ? 查询 */
  usage?: string;
  /** 处理函数 */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

// ============ 指令注册表 ============

const commands: Map<string, SlashCommand> = new Map();

function registerCommand(cmd: SlashCommand): void {
  commands.set(cmd.name.toLowerCase(), cmd);
}

// ============ 内置指令 ============

/**
 * /bot-ping — 测试当前 openclaw 与 QQ 连接的网络延迟
 */
registerCommand({
  name: "bot-ping",
  description: "测试当前 openclaw 与 QQ 连接的网络延迟",
  usage: [
    `/bot-ping`,
    ``,
    `测试 OpenClaw 主机与 QQ 服务器之间的网络延迟。`,
    `返回网络传输耗时和插件处理耗时。`,
  ].join("\n"),
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    if (isNaN(eventTime)) {
      return `✅ pong!`;
    }
    const totalMs = now - eventTime;
    const qqToPlugin = ctx.receivedAt - eventTime;
    const pluginProcess = now - ctx.receivedAt;
    const lines = [
      `✅ pong！`,
      ``,
      `⏱ 延迟: ${totalMs}ms`,
      `  ├ 网络传输: ${qqToPlugin}ms`,
      `  └ 插件处理: ${pluginProcess}ms`,
    ];
    return lines.join("\n");
  },
});

/**
 * /bot-version — 查看插件版本号
 */
registerCommand({
  name: "bot-version",
  description: "查看插件版本号",
  usage: [
    `/bot-version`,
    ``,
    `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`,
  ].join("\n"),
  handler: async () => {
    const frameworkVersion = getFrameworkVersion();
    const lines = [
      `🦞框架版本：${frameworkVersion}`,
      `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
    ];
    lines.push(`🌟Tencent Connect 上游代码库：[点击前往](https://github.com/tencent-connect/openclaw-qqbot/)`);
    return lines.join("\n");
  },
});

/**
 * /bot-help — 查看所有指令以及用途
 */
registerCommand({
  name: "bot-help",
  description: "查看所有指令以及用途",
  usage: [
    `/bot-help`,
    ``,
    `列出所有可用的 QQBot 插件内置指令及其简要说明。`,
    `使用 /指令名 ? 可查看某条指令的详细用法。`,
  ].join("\n"),
  handler: (ctx) => {
    // 群聊场景排除仅限私聊的指令
    const GROUP_EXCLUDED_COMMANDS = new Set(["bot-clear-storage", "bot-logs", "bot-approve", "bot-group-allways", "bot-streaming"]);
    const isGroup = ctx.type === "group";

    const lines = [`### QQBot插件内置调试指令`, ``];
    for (const [name, cmd] of commands) {
      if (isGroup && GROUP_EXCLUDED_COMMANDS.has(name)) continue;
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    lines.push(``, `> 插件版本 v${PLUGIN_VERSION}`);
    return lines.join("\n");
  },
});

registerCommand({
  name: "bot-logs",
  description: "通过 QQ 导出日志已禁用；请在主机本地诊断",
  usage: [
    `/bot-logs`,
    ``,
    `出于隐私保护，本版本不会通过 QQ 读取或导出主机日志。`,
  ].join("\n"),
  handler: () => "出于隐私保护，本版本不支持通过 QQ 导出本机日志；请在运行主机上本地检查日志。",
});

// ============ /bot-clear-storage ============

/**
 * 扫描指定目录下的所有文件，递归统计。
 * 返回按文件大小降序排列的文件列表。
 */
function scanDirectoryFiles(dirPath: string): { filePath: string; size: number }[] {
  const files: { filePath: string; size: number }[] = [];
  if (!fs.existsSync(dirPath)) return files;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({ filePath: fullPath, size: stat.size });
        } catch {
          // 跳过无法访问的文件
        }
      }
    }
  };

  walk(dirPath);
  // 按大小降序排列
  files.sort((a, b) => b.size - a.size);
  return files;
}

/** 格式化文件大小为人类可读形式 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * /bot-clear-storage — 清理通过 QQBot 对话产生的文件以及下载的资源
 *
 * 仅在私聊（c2c）中可用。
 * --force 执行时删除整个 appId 目录下的所有文件（不区分用户 openid）。
 *
 * 产品流程：
 *   /bot-clear-storage          — 扫描并列出当前 appId 下的文件，展示确认按钮
 *   /bot-clear-storage --force   — 确认执行删除
 */
registerCommand({
  name: "bot-clear-storage",
  description: "清理通过QQBot对话产生的文件以及下载的资源（保存在 OpenClaw 运行环境的主机上）",
  usage: [
    `/bot-clear-storage`,
    ``,
    `扫描当前机器人产生的下载文件并列出明细。`,
    `确认后执行删除，释放主机磁盘空间。`,
    ``,
    `/bot-clear-storage --force   确认执行清理`,
    ``,
    `⚠️ 仅在私聊中可用。`,
  ].join("\n"),
  handler: (ctx) => {
    const { appId, type } = ctx;

    // 仅私聊可用
    if (type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    const isForce = ctx.args.trim() === "--force";

    // 删除粒度为 appId 目录（不区分用户 openid）
    // 路径: downloads/{appId}/
    const targetDir = path.join(getHomeDir(), ".openclaw", "media", "qqbot", "downloads", appId);
    const displayDir = `~/.openclaw/media/qqbot/downloads/${appId}`;

    if (!isForce) {
      // ── 第一步：扫描并展示文件列表 ──
      const files = scanDirectoryFiles(targetDir);

      if (files.length === 0) {
        return [
          `✅ 当前没有需要清理的文件`,
          ``,
          `目录 \`${displayDir}\` 为空或不存在。`,
        ].join("\n");
      }

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const MAX_DISPLAY = 10;

      const lines: string[] = [
        `即将清理 \`${displayDir}\` 目录下所有文件，总共 ${files.length} 个文件，占用磁盘存储空间 ${formatBytes(totalSize)}。`,
        ``,
        `目录文件概况：`,
      ];

      // 展示前 MAX_DISPLAY 个（按大小降序）
      const displayFiles = files.slice(0, MAX_DISPLAY);
      for (const f of displayFiles) {
        const relativePath = path.relative(targetDir, f.filePath);
        // 在 Windows 上统一用 / 分隔显示
        const displayName = relativePath.replace(/\\/g, "/");
        lines.push(`${displayName} (${formatBytes(f.size)})`, ``, ``);
      }
      if (files.length > MAX_DISPLAY) {
        lines.push(`...[合计：${files.length} 个文件（${formatBytes(totalSize)}）]`, ``);
      }

      lines.push(
        ``,
        `---`,
        ``,
        `确认清理后，上述保存在 OpenClaw 运行主机磁盘上的文件将永久删除，后续对话过程中AI无法再找回相关文件。`,
        `‼️ 点击指令确认删除`,
        `<qqbot-cmd-enter text="/bot-clear-storage --force" />`,
      );

      return lines.join("\n");
    }

    // ── 第二步：--force 执行删除 ──
    const files = scanDirectoryFiles(targetDir);

    if (files.length === 0) {
      return `✅ 目录已为空，无需清理`;
    }

    let deletedCount = 0;
    let deletedSize = 0;
    let failedCount = 0;

    for (const f of files) {
      try {
        fs.unlinkSync(f.filePath);
        deletedCount++;
        deletedSize += f.size;
      } catch {
        failedCount++;
      }
    }

    // 尝试清理空目录（递归删除空子目录）
    try {
      removeEmptyDirs(targetDir);
    } catch {
      // 非关键，静默忽略
    }

    if (failedCount === 0) {
      return [
        `✅ 清理成功`,
        ``,
        `已删除 ${deletedCount} 个文件，释放 ${formatBytes(deletedSize)} 磁盘空间。`,
      ].join("\n");
    }

    return [
      `⚠️ 部分清理完成`,
      ``,
      `已删除 ${deletedCount} 个文件（${formatBytes(deletedSize)}），${failedCount} 个文件删除失败。`,
    ].join("\n");
  },
});

/** 递归删除空目录（从叶子向上清理） */
function removeEmptyDirs(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dirPath, entry.name));
    }
  }
  // 重新读取，如果目录已空则删除
  try {
    const remaining = fs.readdirSync(dirPath);
    if (remaining.length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {
    // 目录可能正在被使用，跳过
  }
}

// ============ /bot-streaming ============

/**
 * /bot-streaming on|off — 一键开关流式消息
 *
 * 直接修改当前账户的 streaming 配置项并持久化到 openclaw.json。
 * 修改后即时生效（下一条消息起按新配置处理）。
 */
registerCommand({
  name: "bot-streaming",
  description: "一键开关流式消息",
  usage: [
    `/bot-streaming on     开启流式消息`,
    `/bot-streaming off    关闭流式消息`,
    `/bot-streaming        查看当前流式消息状态`,
    ``,
    `开启后，AI 的回复会以流式形式逐步显示（打字机效果）。`,
    `注意：仅 C2C（私聊）支持流式消息。`,
  ].join("\n"),
  handler: async (ctx) => {
    // 流式消息仅支持 C2C（私聊），群/频道场景直接提示
    if (ctx.type !== "c2c") {
      return `❌ 流式消息仅支持私聊场景，请在私聊中使用 /bot-streaming 指令`;
    }

    const arg = ctx.args.trim().toLowerCase();

    // 读取当前 streaming 状态
    const currentStreaming = ctx.accountConfig?.streaming === true;

    // 无参数：查看当前状态
    if (!arg) {
      return [
        `📡 流式消息状态：${currentStreaming ? "✅ 已开启" : "❌ 已关闭"}`,
        ``,
        `使用 <qqbot-cmd-input text="/bot-streaming on" show="/bot-streaming on"/> 开启`,
        `使用 <qqbot-cmd-input text="/bot-streaming off" show="/bot-streaming off"/> 关闭`,
      ].join("\n");
    }

    if (arg !== "on" && arg !== "off") {
      return `❌ 参数错误，请使用 on 或 off\n\n示例：/bot-streaming on`;
    }

    const newStreaming = arg === "on";

    // 如果状态没变，直接返回
    if (newStreaming === currentStreaming) {
      return `📡 流式消息已经是${newStreaming ? "开启" : "关闭"}状态，无需操作`;
    }

    // 更新配置（参考 handleInteractionCreate 中的配置更新逻辑）
    try {
      const runtime = getQQBotRuntime();
      const configApi = runtime.config as {
        loadConfig: () => Record<string, unknown>;
        writeConfigFile: (cfg: unknown) => Promise<void>;
      };

      const currentCfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
      const qqbot = ((currentCfg.channels ?? {}) as Record<string, unknown>).qqbot as Record<string, unknown> | undefined;

      if (!qqbot) {
        return `❌ 配置文件中未找到 qqbot 通道配置`;
      }

      const accountId = ctx.accountId;
      const isNamedAccount = accountId !== "default" && (qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId];

      if (isNamedAccount) {
        // 命名账户：更新 accounts.{accountId}.streaming
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>>;
        const acct = accounts[accountId] ?? {};
        acct.streaming = newStreaming;
        accounts[accountId] = acct;
        qqbot.accounts = accounts;
      } else {
        // 默认账户：更新 qqbot.streaming
        qqbot.streaming = newStreaming;
      }

      await configApi.writeConfigFile(currentCfg);

      return [
        `✅ 流式消息已${newStreaming ? "开启" : "关闭"}`,
        ``,
        newStreaming
          ? `AI 的回复将以流式形式逐步显示（仅私聊生效）。`
          : `AI 的回复将恢复为完整发送。`,
      ].join("\n");
    } catch (err) {
      const fwVer = getFrameworkVersion();
      return [
        `❌ 当前版本不支持该指令`,
        ``,
        `🦞框架版本：${fwVer}`,
        `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
        ``,
        `可通过以下命令手动开启流式消息：`,
        ``,
        `\`\`\`shell`,
        `# 1. 开启流式消息`,
        `openclaw config set channels.qqbot.streaming true`,
        ``,
        `# 2. 重启网关使配置生效`,
        `openclaw gateway restart`,
        `\`\`\``,
      ].join("\n");
    }
  },
});

// ============ /bot-approve 审批配置管理 ============

/**
 * /bot-approve — 管理命令执行审批配置
 *
 * 修改 openclaw.json 中 tools.exec.security / tools.exec.ask 字段。
 *
 * security: deny | allowlist | full
 * ask: off | on-miss | always
 */
registerCommand({
  name: "bot-approve",
  description: "管理命令执行审批配置",
  usage: [
    `/bot-approve            查看操作指引`,
    `/bot-approve on         开启审批（白名单模式，推荐）`,
    `/bot-approve off        关闭审批，命令直接执行`,
    `/bot-approve always     始终审批，每次执行都需审批`,
    `/bot-approve reset      恢复框架默认值`,
    `/bot-approve status     查看当前审批配置`,
  ].join("\n"),
  handler: async (ctx) => {
    // 审批管理仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    const arg = ctx.args.trim().toLowerCase();

    // 审批功能需要 openclaw >= 3.22（gateway-runtime 模块）
    if (!isApprovalFeatureAvailable()) {
      return `❌ 当前 OpenClaw 版本不支持审批功能，请升级至最新版本后重试。`;
    }

    let runtime;
    try {
      runtime = getQQBotRuntime();
    } catch {
      // runtime 不可用，构造 prompt 委托给 AI 模型通过 CLI 完成
      const presetMap: Record<string, { security: string; ask: string; desc: string }> = {
        on: { security: "allowlist", ask: "on-miss", desc: "开启审批（白名单模式）" },
        off: { security: "full", ask: "off", desc: "关闭审批" },
        always: { security: "allowlist", ask: "always", desc: "严格模式（每次都审批）" },
        strict: { security: "allowlist", ask: "always", desc: "严格模式（每次都审批）" },
      };
      const preset = presetMap[arg];
      if (preset) {
        return {
          delegatePrompt: [
            `请帮我${preset.desc}。执行以下单条命令（不要拆开）：`,
            `openclaw config set tools.exec.security ${preset.security} && openclaw config set tools.exec.ask ${preset.ask}`,
            `执行完成后告诉用户审批配置已更新为 security=${preset.security}, ask=${preset.ask}。`,
          ].join("\n"),
        };
      }
      if (arg === "reset") {
        return {
          delegatePrompt: [
            `请帮我重置审批配置。执行以下单条命令（不要拆开）：`,
            `openclaw config unset tools.exec.security && openclaw config unset tools.exec.ask`,
            `执行完成后告诉用户审批配置已重置为框架默认值。`,
          ].join("\n"),
        };
      }
      if (arg === "status") {
        return {
          delegatePrompt: [
            `请帮我查看当前命令执行审批配置。执行以下单条命令（不要拆开）：`,
            `echo "security=$(openclaw config get tools.exec.security)" && echo "ask=$(openclaw config get tools.exec.ask)"`,
            `然后告诉用户当前 security 和 ask 的值，以及可用的操作选项：`,
            `- /bot-approve on    开启审批（白名单模式）`,
            `- /bot-approve off   关闭审批`,
            `- /bot-approve always 严格模式`,
            `- /bot-approve reset 恢复默认`,
          ].join("\n"),
        };
      }
      // 无参数或未知参数：直接返回操作指引
      return [
        `🔐 命令执行审批配置`,
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
      ].join("\n");
    }
    const configApi = runtime.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };

    const loadExecConfig = () => {
      const cfg = configApi.loadConfig() as Record<string, unknown>;
      const tools = (cfg.tools ?? {}) as Record<string, unknown>;
      const exec = (tools.exec ?? {}) as Record<string, unknown>;
      return {
        security: String(exec.security ?? "deny"),
        ask: String(exec.ask ?? "on-miss"),
      };
    };

    const writeExecConfig = async (security: string, ask: string) => {
      const cfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
      const tools = ((cfg.tools ?? {}) as Record<string, unknown>);
      const exec = ((tools.exec ?? {}) as Record<string, unknown>);
      exec.security = security;
      exec.ask = ask;
      tools.exec = exec;
      cfg.tools = tools;
      await configApi.writeConfigFile(cfg);
    };

    const formatStatus = (security: string, ask: string) => {
      const secIcon = security === "full" ? "🟢" : security === "allowlist" ? "🟡" : "🔴";
      const askIcon = ask === "off" ? "🟢" : ask === "always" ? "🔴" : "🟡";
      return [
        `🔐 当前审批配置`,
        ``,
        `${secIcon} 安全模式 (security): **${security}**`,
        `${askIcon} 审批模式 (ask): **${ask}**`,
        ``,
        security === "deny" ? `⚠️ 当前为 deny 模式，所有命令执行被拒绝` :
        security === "full" && ask === "off" ? `✅ 所有命令无需审批直接执行` :
        security === "allowlist" && ask === "on-miss" ? `🛡️ 白名单命令直接执行，其余需审批` :
        ask === "always" ? `🔒 每次命令执行都需要人工审批` :
        `ℹ️ security=${security}, ask=${ask}`,
      ].join("\n");
    };

    // 无参数：操作指引
    if (!arg) {
      return [
        `🔐 命令执行审批配置`,
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
      ].join("\n");
    }

    // status: 查看当前配置
    if (arg === "status") {
      const { security, ask } = loadExecConfig();
      return [
        formatStatus(security, ask),
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
      ].join("\n");
    }

    // on: 开启审批（白名单 + 未命中审批）
    if (arg === "on") {
      try {
        await writeExecConfig("allowlist", "on-miss");
        return [
          `✅ 审批已开启`,
          ``,
          `• security = allowlist（白名单模式）`,
          `• ask = on-miss（未命中白名单时需审批）`,
          ``,
          `已批准的命令自动加入白名单，下次直接执行。`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    // off: 关闭审批
    if (arg === "off") {
      try {
        await writeExecConfig("full", "off");
        return [
          `✅ 审批已关闭`,
          ``,
          `• security = full（允许所有命令）`,
          `• ask = off（不需要审批）`,
          ``,
          `⚠️ 所有命令将直接执行，不会弹出审批确认。`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    // always: 始终审批（每次都审批）
    if (arg === "always") {
      try {
        await writeExecConfig("allowlist", "always");
        return [
          `✅ 已切换为严格审批模式`,
          ``,
          `• security = allowlist`,
          `• ask = always（每次执行都需审批）`,
          ``,
          `每个命令都会弹出审批按钮，需手动确认。`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    // reset: 删除配置，恢复框架默认值
    if (arg === "reset") {
      try {
        const cfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
        const tools = (cfg.tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        delete exec.security;
        delete exec.ask;
        if (Object.keys(exec).length === 0) {
          delete tools.exec;
        } else {
          tools.exec = exec;
        }
        if (Object.keys(tools).length === 0) {
          delete cfg.tools;
        } else {
          cfg.tools = tools;
        }
        await configApi.writeConfigFile(cfg);
        return [
          `✅ 审批配置已重置`,
          ``,
          `已移除 tools.exec.security 和 tools.exec.ask`,
          `框架将使用默认值（security=deny, ask=on-miss）`,
          ``,
          `如需开启命令执行，请使用 /bot-approve on`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    return [
      `❌ 未知参数: ${arg}`,
      ``,
      `可用选项: on | off | always | reset`,
      `输入 /bot-approve ? 查看详细用法`,
    ].join("\n");
  },
});

// ============ /bot-group-allways ============

/**
 * /bot-group-allways on|off — 修改群消息默认响应模式
 *
 * 直接修改当前账户的 defaultRequireMention 配置项并持久化到 openclaw.json。
 * 修改后即时生效（下一条消息起按新配置处理）。
 *
 * on = AI 自主判断何时发言（无需 @），off = 仅被 @ 时回复
 */
registerCommand({
  name: "bot-group-allways",
  description: "修改群消息默认响应模式",
  usage: [
    `/bot-group-allways on   AI 自主判断何时发言（无需 @）`,
    `/bot-group-allways off  仅在被 @ 时回复`,
    `/bot-group-allways      查看当前设置`,
    ``,
    `设为 on 后，AI 会自主判断每条消息是否需要回复（无需 @）。`,
    `仍可通过 groups.{groupId}.requireMention 对单个群覆盖。`,
    ``,
    `优先级：具体群配置 > 通配符 "*" > defaultRequireMention（本指令）> 默认 true`,
  ].join("\n"),
  handler: async (ctx) => {
    // 群响应模式设置仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    const arg = ctx.args.trim().toLowerCase();

    // 读取当前 defaultRequireMention 状态
    const currentVal = ctx.accountConfig?.defaultRequireMention;
    const currentRequireMention = currentVal ?? true; // 未设置时硬编码默认为 true

    // 无参数：查看当前状态
    if (!arg) {
      return [
        `🤖 群自主发言状态：${currentRequireMention ? "❌ 仅被 @ 时回复" : "✅ 自主判断何时发言"}`,
        `使用 <qqbot-cmd-input text="/bot-group-allways on" show="/bot-group-allways on"/> 设为自主发言`,
        `使用 <qqbot-cmd-input text="/bot-group-allways off" show="/bot-group-allways off"/> 设为仅被 @ 时回复`,
      ].join("\n");
    }

    if (arg !== "on" && arg !== "off") {
      return `❌ 参数错误，请使用 on 或 off\n\n示例：/bot-group-allways on`;
    }

    const newRequireMention = arg === "off"; // on=自主发言(requireMention=false), off=仅被@时回复(requireMention=true)

    // 如果状态没变，直接返回
    if (newRequireMention === currentRequireMention) {
      return `🤖 群自主发言已经是"${arg}"状态，无需操作`;
    }

    // 更新配置
    try {
      const runtime = getQQBotRuntime();
      const configApi = runtime.config as {
        loadConfig: () => Record<string, unknown>;
        writeConfigFile: (cfg: unknown) => Promise<void>;
      };

      const currentCfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
      const qqbot = ((currentCfg.channels ?? {}) as Record<string, unknown>).qqbot as Record<string, unknown> | undefined;

      if (!qqbot) {
        return `❌ 配置文件中未找到 qqbot 通道配置`;
      }

      const accountId = ctx.accountId;
      const isNamedAccount = accountId !== "default" && (qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId];

      if (isNamedAccount) {
        // 命名账户：更新 accounts.{accountId}.defaultRequireMention
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>>;
        const acct = accounts[accountId] ?? {};
        acct.defaultRequireMention = newRequireMention;
        accounts[accountId] = acct;
        qqbot.accounts = accounts;
      } else {
        // 默认账户：更新 qqbot.defaultRequireMention
        qqbot.defaultRequireMention = newRequireMention;
      }

      await configApi.writeConfigFile(currentCfg);

      return [
        `✅ 群自主发言已设置为 ${newRequireMention ? "**off**（仅被 @ 时回复）" : "**on**（AI 自主判断何时发言）"}`,
        ``,
        newRequireMention
          ? `仅在被 @ 机器人才会回复。`
          : `AI 将自主判断群消息是否需要回复，无需被 @ 即可发言。`,
        ``,
      ].join("\n");
    } catch (err) {
      const fwVer = getFrameworkVersion();
      return [
        `❌ 当前版本不支持该指令`,
        ``,
        `🦞框架版本：${fwVer}`,
        `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
        ``,
        `可通过以下命令手动设置：`,
        ``,
        `\`\`\`shell`,
        `# 设为 AI 自主判断何时发言（defaultRequireMention=false）`,
        `openclaw config set channels.qqbot.defaultRequireMention false`,
        `# 或设为仅被 @ 时回复（defaultRequireMention=true）`,
        `openclaw config set channels.qqbot.defaultRequireMention true`,
        ``,
        `# 重启网关使配置生效`,
        `openclaw gateway restart`,
        `\`\`\``,
      ].join("\n");
    }
  },
});

// ============ 匹配入口 ============

/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) return null;

  // 解析指令名和参数
  const spaceIdx = content.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  // Reserve the former command so it cannot fall through to the agent as a tool request.
  if (cmdName === "bot-upgrade") {
    return "远程升级已从本源码版本移除；请勿通过 QQ 触发升级操作。";
  }

  const cmd = commands.get(cmdName);
  if (!cmd) return null; // 不是插件级指令，交给框架

  // /指令 ? — 返回用法说明
  if (args === "?") {
    if (cmd.usage) {
      return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
    }
    return `/${cmd.name} — ${cmd.description}`;
  }

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
