<div align="center">

**简体中文 | [English](README.md)**

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot — OpenClaw 渠道插件


**让你的 AI 助手接入 QQ — 私聊、群聊、富媒体，一个插件全搞定。**

### 🚀 当前版本： `v1.7.2`

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/tencent-connect/openclaw-qqbot)
[![Node.js](https://img.shields.io/badge/Node.js->=22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<br/>

</div>

---

本候选版本基于腾讯互联的 [openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)。它是独立整改候选，不代表官方关联或完全原创。发布前仍需核实准确的上游提交基线和第三方素材来源。

> **发布状态：** 首发仅准备独立 GitHub 源码仓库，不发布 npm 包，也不包含远程热升级。仓库身份、准确上游基线、第三方来源和隔离构建验证仍需在公开前完成。

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🔒 **多场景支持** | C2C 私聊、群聊（@提及 / 自主发言双模式） |
| 👥 **群聊精细管控** | 按群配置 @触发规则、工具权限、自定义提示词、消息过滤 |
| 🌐 **双传输模式** | WebSocket（默认）或 Webhook（HTTP 回调）— 配置切换 |
| 🖼️ **富媒体消息** | 支持图片、语音、视频、文件的收发 |
| 🎙️ **语音能力 (STT/TTS)** | 语音转文字自动转录 & 文字转语音回复 |
| 🔄 **手动更新** | 首发源码版本不包含远程或 QQ 内升级器 |
| ⏰ **定时推送** | 支持定时任务触发后主动推送消息 |
| 🔗 **URL 支持** | 下载前校验公网 URL；拒绝私网和回环目标 |
| ⌨️ **输入状态** | 实时显示"Bot 正在输入中…"状态 |
| 📝 **Markdown** | 完整支持 Markdown 格式消息 |
| 🛠️ **原生命令** | 支持 OpenClaw 原生命令 |
| 💬 **引用上下文** | 解析用户回复的原始消息内容，注入 AI 上下文，让模型准确理解"在回复哪条消息" |
| 📦 **大文件支持** | 大文件自动分片并行上传，最大支持 100 MB |
| 🔐 **命令执行审批** | AI 执行命令前通过按钮消息请求审批，点击即可允许或拒绝 |

---

## 📸 功能展示

> **说明：** 本插件仅作为**消息通道**，负责在 QQ 和 OpenClaw 之间传递消息。图片理解、语音转录、AI 画图等能力取决于你配置的 **AI 模型**以及在 OpenClaw 中安装的 **skill**，而非插件本身提供。

### 💬 引用消息上下文

用户在 QQ 中引用某条消息发送时，插件会自动解析被引用的消息内容并注入 AI 上下文，让模型清楚地知道"用户在回复哪条消息"，从而给出更准确的回复。支持文本及媒体消息（图片/语音/视频/文件），换设备后同样可用。


### 🎙️ 语音消息（STT）

配置 STT 后，插件会自动将语音转录为文字再交给 AI 处理。整个过程对用户完全透明——发语音就像发文字一样自然，AI 听得懂你在说什么。

> **你**：*（发送一段语音）*"明天深圳天气怎么样"
>
> **QQBot**：明天（3月7日 周六）深圳的天气预报 🌤️ ...


### 📄 文件理解

文档提取是可选的上下文增强：`.txt`、`.md`、`.py` 由插件从 QQBot 下载媒体目录本地读取（输入上限 10 MiB，提取文本最多 8,000 字符）。PDF、DOCX、XLSX 需要调用方传入 `DocumentParser` 适配器；当前 Gateway 和引用/历史上下文调用点没有配置该适配器，因此这些格式在常规插件流程中会返回 `parser_not_configured`。本插件不内置或启动外部解析器。解析失败不会阻断消息处理。同步适配器必须及时返回；若适配器启动进程，应由适配器自行实施真实的进程超时控制。

例如，插件可将本地读取成功的文本附件内容加入 AI 上下文。

> **你**：*（发送《战争与和平》TXT 文件）*
>
> **QQBot**：收到！你上传了列夫·托尔斯泰的《战争与和平》中文版文本。从内容来看，这是第一章的开头……你想让我做什么？


### 🖼️ 图片理解

如果主模型支持视觉（如腾讯混元 `hunyuan-vision`），用户发图片 AI 也能看懂。这是多模态模型的通用能力，非插件专属功能。

> **你**：*（发送一张图片）*
>
> **QQBot**：哈哈，好可爱！这是QQ企鹅穿上小龙虾套装吗？🦞🐧 ...


### 🎨 图片发送

> **你**：画一只猫咪
>
> **QQBot**：画好啦！一只可爱的简笔小猫咪🐱🎨

AI 可直接发送图片，支持本地文件路径和网络 URL。格式：jpg/png/gif/webp/bmp。


### 🔊 语音发送

> **你**：给我讲一个笑话
>
> **QQBot**：*（发送一条语音消息）*

AI 可直接发送语音消息。格式：mp3/wav/silk/ogg，无需安装 ffmpeg。


### ⏰ 定时提醒（主动消息）

> **你**：5分钟后提醒我吃饭
>
> **QQBot**：先确认已创建提醒，到点后再主动推送语音 + 文本提醒

该能力依赖 OpenClaw cron 调度与主动消息能力。若未收到提醒，常见原因是 QQ 侧拦截了机器人主动消息。


### 📎 文件发送

> **你**：战争与和平的第一章截取一下发文件给我
>
> **QQBot**：*（发送 .txt 文件）*

AI 可直接发送文件，任意格式均可。


v1.6.6 起支持大文件传输：图片最大 20MB，视频最大 30MB，附件最大 100MB，每日累计传输上限 2GB。


### 🔐 命令执行审批

当 AI 需要执行命令时，插件会通过 QQ 消息发送带按钮的审批请求，你可以点击 **✅ 允许一次**、**⭐ 始终允许** 或 **❌ 拒绝** 来控制命令是否执行。

通过 `/bot-approve` 指令可以管理审批模式（白名单 / 关闭 / 严格模式）。


### 🎬 视频发送

> **你**：发一个演示视频给我
>
> **QQBot**：*（发送视频）*

AI 可直接发送视频，支持本地文件和公网 URL。


> **底层细节：** 上传去重缓存、有序队列发送、音频格式多层降级。

### 🛠️ 斜杠指令

插件内置一组斜杠指令，在消息进入 AI 队列前拦截处理，即时响应，用于诊断和管理。

#### `/bot-ping` — 延迟测试

> **你**：`/bot-ping`
>
> **QQBot**：✅ pong！⏱ 延迟: 602ms（网络传输: 602ms，插件处理: 0ms）

测量从 QQ 服务器推送到插件响应的端到端延迟，细分网络传输和插件处理两段耗时。


#### `/bot-version` — 版本信息

> **你**：`/bot-version`
>
> **QQBot**：🦞框架版本：OpenClaw 2026.3.13 (61d171a) / 🤖QQBot 插件版本：v1.6.3 / 🌟官方 GitHub 仓库

一目了然查看框架版本、插件版本，并可直接跳转官方仓库。


#### `/bot-help` — 指令列表

> **你**：`/bot-help`
>
> **QQBot**：列出所有可用的斜杠指令及说明，指令可点击快速输入。


#### 远程升级

首发仅准备 GitHub 源码仓库，不包含远程热升级。旧 /bot-upgrade 命令会被拦截并返回固定禁用提示，不会进入 Agent 处理。也没有自动版本检查、远程脚本下载或脚本执行。

#### `/bot-logs` — 本地日志诊断

出于隐私保护，本候选不再通过 QQ 导出主机日志；请在 OpenClaw 运行主机上本地检查。

> **你**：`/bot-logs`
>
> **QQBot**：日志导出已禁用，请在 OpenClaw 主机本地检查。




#### `/bot-approve` — 审批配置管理

> **你**：`/bot-approve`
>
> **QQBot**：🔐 命令执行审批配置 — 开启审批 / 关闭审批 / 严格模式 / 恢复默认 / 查看当前配置

管理 AI 命令执行审批策略，支持以下子命令：

| 子命令 | 说明 |
|--------|------|
| `/bot-approve on` | 开启审批（白名单模式，推荐） |
| `/bot-approve off` | 关闭审批，命令直接执行 |
| `/bot-approve always` | 严格模式，每次执行都需审批 |
| `/bot-approve reset` | 恢复框架默认值 |
| `/bot-approve status` | 查看当前审批配置 |

#### `/bot-clear-storage` — 清理通过 QQBot 对话产生的文件以及下载的资源（保存在 OpenClaw 运行环境的主机上）

`/bot-clear-storage` 列出对话产生的文件以及下载的资源目录里的文件，使用`/bot-clear-storage -- force`确定删除。

#### `/bot-group-allways` — 群消息响应模式切换

> **你**：`/bot-group-allways`
>
> **QQBot**：🤖 群自主发言状态：❌ 仅被 @ 时回复

运行时动态切换群聊默认 @触发行为，修改即时持久化，无需重启：

| 子命令 | 说明 |
|--------|------|
| `/bot-group-allways on` | AI 自主判断何时发言（无需 @） |
| `/bot-group-allways off` | 仅在被 @ 时回复 |
| `/bot-group-allways`（无参数） | 查看当前设置 |

> ⚠️ 此指令修改账户级 `defaultRequireMention`，优先级低于具体群的 `groups.{groupId}.requireMention` 配置。

---

## 兼容性

- **支持的宿主：**官方 OpenClaw 2026.6.x（锁文件固定 `openclaw` 2026.6.10），其出站投递队列存放在 SQLite 中。
- **不支持：**旧的定制宿主契约，即用 JSON 文件保存投递队列，并把缺少回复上下文的条目恢复为 `pending_claim` 状态。描述该契约的两项测试保持原样，但默认跳过；CI 只把它们作为参考步骤运行，在官方 OpenClaw 上预期失败。详见 [docs/LEGACY-HOST-CONTRACT.md](docs/LEGACY-HOST-CONTRACT.md)。
- **投递安全（出错即拒绝）：**没有回复上下文（`replyToId`）时不会补发待投递任务；上一次投递结果不明的文件会转人工确认，不会重发；批量成功回执只确认本次实际参与投递的文件。

---

## 🚀 快速开始

### 第一步 — 在 QQ 开放平台创建机器人

1. 前往 [QQ 开放平台](https://q.qq.com/)，用**手机 QQ 扫描页面二维码**即可注册/登录。若尚未注册，扫码后系统会自动完成注册并绑定你的 QQ 账号。


2. 手机 QQ 扫码后选择**同意**，即完成注册，进入 QQ 机器人配置页。
3. 点击**创建机器人**，即可直接新建一个 QQ 机器人。


> ⚠️ 机器人创建后会自动出现在你的 QQ 消息列表中，并发送第一条消息。但在完成下面的配置之前，发消息会提示"该机器人去火星了"，属于正常现象。


4. 从机器人页面获取 **AppID** 和 **AppSecret**。仅将其保存在受访问控制的凭据位置，不要写入明文便笺、Shell 历史、命令行记录或代码仓库。


> 详细图文教程请参阅 [官方指南](https://cloud.tencent.com/developer/article/2626045)。

### 第二步 — 源码首发

首发仅准备源码仓库，不发布 npm 包，也不提供自动安装或升级命令。安装腾讯互联上游包不会得到本候选版本。待仓库身份和隔离构建验证完成后，再补充可复现的安装说明。

### 凭据与恢复

自动凭据备份和静默恢复已停用。OpenClaw 配置缺少 QQ Bot 凭据时，启动会 Fail-Closed；请通过 OpenClaw 的通道配置流程显式重新配置。运行时凭据仍由 OpenClaw 配置持有，本插件不会额外加密该配置；请用主机访问控制保护配置。本插件不支持 `clientSecretFile`。已有 `credential-backup.json` 不会被自动读取、迁移或删除。现有部署者应自行定位并保护历史明文备份，不要将其内容粘贴到日志或支持报告中。

Task Delivery 状态和产物默认保存在配置的 OpenClaw 状态目录下（`OPENCLAW_STATE_DIR/qqbot/agent-task-delivery`）。使用旧自定义路径的部署可显式设置 `QQBOT_AGENT_TASK_STATE_DIR` 和 `QQBOT_AGENT_TASK_ARTIFACT_DIR`。

可选的群搜索 dry-run 例外由操作者通过逗号分隔的 `QQBOT_GROUP_SEARCH_ALLOWLIST` 配置。未设置时不会为任何群启用该例外。

QQ Bot API 固定使用 `https://api.sgroup.qq.com`，Token 接口固定使用 `https://bots.qq.com`，请求不跟随重定向。配置的 OCR/STT/TTS 服务终点必须使用 HTTPS；API Key 会发送到该配置终点，因此只填写你信任的服务。请求同样拒绝重定向。测试可设置 `NODE_ENV=test`，并使用 `QQBOT_ALLOW_LOCAL_API_ENDPOINT_FOR_TESTS=1` 与 `QQBOT_BASE_URL=http://127.0.0.1:<port>`，或 `QQBOT_ALLOW_LOCAL_TOKEN_ENDPOINT_FOR_TESTS=1` 与 `QQBOT_TOKEN_BASE_URL=http://127.0.0.1:<port>`，显式启用仅限 loopback 的终点。只使用合成凭据，生产环境不得设置这些例外。

PDF、DOCX、XLSX 解析属于可选能力，需要调用方注入 `DocumentParser`；未配置解析器时会准确报告不可用，且不阻断正常消息处理。TXT、Markdown、Python 文件由插件本地受限读取。

### 第三步 — 本地测试

运行 `npm test` 执行离线单元测试。测试只使用合成数据，不连接 QQ。完整构建和集成回归仍待执行。

---

## ⚙️ 进阶配置

### 多账户配置（Multi-Bot）

支持在同一个 OpenClaw 实例下同时运行多个 QQ 机器人。

#### 配置方式

编辑 `~/.openclaw/openclaw.json`，在 `channels.qqbot` 下增加 `accounts` 字段：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "111111111",
      "clientSecret": "secret-of-bot-1",

      "accounts": {
        "bot2": {
          "enabled": true,
          "appId": "222222222",
          "clientSecret": "secret-of-bot-2"
        },
        "bot3": {
          "enabled": true,
          "appId": "333333333",
          "clientSecret": "secret-of-bot-3"
        }
      }
    }
  }
}
```

**说明：**

- 顶层的 `appId` / `clientSecret` 是**默认账户**（accountId = `"default"`）
- `accounts` 下的每个 key（如 `bot2`、`bot3`）就是该账户的 `accountId`
- 每个账户都可以独立配置 `enabled`、`name`、`allowFrom`、`systemPrompt` 等字段
- 也可以不配顶层默认账户，只在 `accounts` 里配置所有机器人

通过 CLI 添加第二个机器人（如果框架支持 `--account` 参数）：

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### 向指定账户的用户发送消息

使用 `openclaw message send` 发消息时，需要通过 `--account` 参数指定使用哪个机器人发送：

```bash
# 使用默认机器人发送（不指定 --account 时自动使用 default）
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# 使用 bot2 发送
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target 格式支持：**

| 格式 | 说明 |
|------|------|
| `qqbot:c2c:OPENID` | 私聊 |
| `qqbot:group:GROUP_OPENID` | 群聊 |
| `qqbot:channel:CHANNEL_ID` | 频道 |

> ⚠️ **注意**：每个机器人的用户 OpenID 是不同的。机器人 A 收到的用户 OpenID 不能用机器人 B 去发消息，否则会返回 500 错误。必须用对应机器人的 accountId 去给该机器人的用户发消息。

#### 工作原理

- 启动 `openclaw gateway` 后，所有 `enabled: true` 的账户会同时启动连接（WebSocket 或 Webhook，取决于 `transport` 配置）
- 每个账户独立维护 Token 缓存（基于 `appId` 隔离），互不干扰
- 接收消息时，日志会带上 `[qqbot:accountId]` 前缀方便排查

---

### Webhook 传输模式

默认情况下，插件通过 **WebSocket** 连接 QQ 平台（出站连接，无需公网 IP）。你也可以切换为 **Webhook** 模式，由 QQ 平台主动 POST 事件到你的 HTTP 端点。

| | WebSocket（默认） | Webhook |
|---|---|---|
| 连接方式 | 插件主动连接 QQ 网关 | QQ 平台 POST 到你的服务器 |
| 公网 IP | 不需要 | 需要 |
| 适用场景 | 开发调试、单实例部署 | 生产环境、水平扩展、Serverless |
| 会话恢复 | 支持 RESUME | 无状态，无需恢复 |
| 签名验证 | 平台内置 | 插件自动 Ed25519 验签 |

#### 配置方式

```json
{
  "channels": {
    "qqbot": {
      "appId": "111111111",
      "clientSecret": "your-secret",
      "transport": "webhook",
      "webhook": {
        "path": "/qqbot/webhook"
      }
    }
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `transport` | `"websocket"` | `"websocket"` 或 `"webhook"` |
| `webhook.path` | `"/qqbot/webhook"` | 接收回调的 HTTP 路径 |

#### 平台配置步骤

1. 登录 [QQ 开放平台](https://q.qq.com/) → 开发设置 → 消息接收方式
2. 选择 **HTTP 回调**
3. 填写回调 URL：`https://your-domain.com/qqbot/webhook`
4. 平台发送 `op:13` 验证请求，插件自动处理签名验证
5. 验证通过后，所有事件将以 POST 方式推送到该地址

---

### 群聊配置

插件提供灵活的群聊管控能力，支持按群定制触发规则、工具权限和 AI 行为策略。

#### @提及触发模式（requireMention）

默认情况下，群聊中**必须 @机器人**才会触发 AI 回复。你可以通过配置让 AI 自主判断是否需要发言：

| 模式 | 配置值 | 行为 |
|------|--------|------|
| **仅 @时回复** | `true`（默认） | 群消息中只有 @了机器人才会触发回复 |
| **自主发言** | `false` | AI 自主判断每条消息是否需要回复，无需 @ |

**优先级链**（从高到低）：

```
具体群 groups.{groupOpenid}.requireMention
  > 通配符 groups."*".requireMention
    > 账户级 defaultRequireMention
      > 默认值 true
```

**配置示例：**

```json
{
  "channels": {
    "qqbot": {
      // 账户级：所有群的默认行为
      "defaultRequireMention": false,

      "accounts": {
        "default": {
          "groups": {
            "*": {
              // 通配符：所有群的兜底规则
              "requireMention": false
            },
            "GROUP_OPENID": {
              // 单群覆盖：这个群仍然需要 @
              "requireMention": true
            }
          }
        }
      }
    }
  }
}
```

> **使用场景举例：**
>
> - 工作群设为 `requireMention: true` — 避免 AI 对每条闲聊都插嘴
> - 专属 AI 陪伴群设为 `requireMention: false` — 像真人一样自然参与对话
> - 通过 `/bot-group-allways on|off` 指令可在运行时动态切换账户级默认值

#### 其他群配置项

除 `requireMention` 外，每个群还支持以下配置：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ignoreOtherMentions` | `boolean` | `false` | 是否忽略 @了其他人但没 @机器人的消息。开启后这类消息直接丢弃，不记录历史、不触发 AI |
| `toolPolicy` | `"full" \| "restricted" \| "none"` | `"restricted"` | 群聊中 AI 可使用的工具范围。`full`=全部可用；`restricted`=限制敏感工具（如命令执行、文件操作）；`none`=禁止所有工具调用 |
| `prompt` | `string` | 内置默认提示词 | 该群专属的系统提示词，会追加到全局 systemPrompt 之后 |
| `historyLimit` | `number` | `50` | 群历史消息缓存条数 |

**完整群配置示例：**

```json
{
  "channels": {
    "qqbot": {
      "defaultRequireMention": false,
      "accounts": {
        "default": {
          "groups": {
            "*": {
              "requireMention": true,
              "toolPolicy": "restricted",
              "ignoreOtherMentions": true
            },
            "WORK_GROUP_OPENID": {
              "requireMention": true,
              "toolPolicy": "none",
              "prompt": "你是工作助手，只回答与工作相关的问题"
            },
            "FRIEND_GROUP_OPENID": {
              "requireMention": false,
              "toolPolicy": "full",
              "prompt": "你是群里的朋友，轻松随意地聊天"
            }
          }
        }
      }
    }
  }
}
```

#### 群访问控制（groupPolicy）

通过 `groupPolicy` 控制哪些群允许机器人加入并接收消息：

| 策略 | 说明 |
|------|------|
| `"open"`（默认） | 所有群均可使用 |
| `"allowlist"` | 仅 `groupAllowFrom` 白名单中的群可使用 |
| `"disabled"` | 禁止所有群聊 |

```json
{
  "channels": {
    "qqbot": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["ALLOWED_GROUP_OPENID_1", "ALLOWED_GROUP_OPENID_2"]
    }
  }
}
```

> 也可通过 [**`/bot-group-allways`** 指令](#bot-group-allways--群消息响应模式切换) 在运行时动态切换账户级默认值，无需重启。

---

#### STT（语音转文字）— 自动转录用户发来的语音消息

STT 支持两级配置，按优先级查找：

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（highest） | `channels.qqbot.stt` | 插件专属 |
| 2（fallback） | `tools.media.audio.models[0]` | 框架级 |

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model"
      }
    }
  }
}
```

- `provider` — 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`
- 设置 `enabled: false` 可禁用
- 配置后，用户发来的语音消息会自动转换（SILK→WAV）并转录为文字

#### TTS（文字转语音）— 机器人发送语音消息

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（highest） | `channels.qqbot.tts` | 插件专属 |
| 2（fallback） | `messages.tts` | 框架级 |

```json
{
  "channels": {
    "qqbot": {
      "tts": {
        "provider": "your-provider",
        "model": "your-tts-model",
        "voice": "your-voice"
      }
    }
  }
}
```

- `provider` — 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`
- `voice` — 语音音色
- 设置 `enabled: false` 可禁用（默认：`true`）
- 配置后，AI 可生成并发送语音消息

---

## 📚 文档与链接


## 上游与版权说明

本项目是基于腾讯互联 openclaw-qqbot 的社区整改与集成候选。上游贡献者和 MIT 许可证请见上游仓库。本地候选对应的上游提交基线及各项第三方素材来源尚未完整核实；首发源码不包含未核实的上游图片素材。

