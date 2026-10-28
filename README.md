<div align="center">



<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot Channel Plugin for OpenClaw



**Connect your AI assistant to QQ — private chat, group chat, and rich media, all in one plugin.**

### 🚀 Current Version: `v1.7.2`

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/tencent-connect/openclaw-qqbot)
[![Node.js](https://img.shields.io/badge/Node.js->=22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)


<br/>

**[简体中文](README.zh.md) | English**

</div>

---

This project is based on Tencent Connect's [openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot). It is an independent community remediation; no claim of official affiliation or wholly original authorship is made. Changes were reviewed against upstream v1.7.1 (commit e74be7a); the exact original fork point is not proven.

> **Release status:** Source-only GitHub repository. No npm package, no GitHub Release, and no remote hot-upgrade feature. Type checking, build and tests run in CI on Ubuntu 24.04 and Windows 2025 (Node 24) against official OpenClaw 2026.6.10; see [Compatibility](#compatibility) for the unsupported legacy host contract.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔒 **Multi-Scene** | C2C private chat, group chat (@mention / autonomous dual mode) |
| 👥 **Group Fine-Tuning** | Per-group @trigger rules, tool policies, custom prompts, message filtering |
| 🌐 **Dual Transport** | WebSocket (default) or Webhook (HTTP callback) — switch via config |
| 🖼️ **Rich Media** | Send & receive images, voice, video, and files |
| 🎙️ **Voice (STT/TTS)** | Speech-to-text transcription & text-to-speech replies |
| 🔄 **Operator-controlled updates** | The source-only first release includes no remote or in-chat updater |
| ⏰ **Scheduled Push** | Proactive message delivery via scheduled tasks |
| 🔗 **URL Support** | Public remote URLs are validated before download; private and loopback targets are rejected |
| ⌨️ **Typing Indicator** | "Bot is typing..." status shown in real-time |
| 📝 **Markdown** | Full Markdown formatting support |
| 🛠️ **Commands** | Native OpenClaw command integration |
| 💬 **Quoted Context** | Parses the original message a user is replying to and injects it into AI context, so the model always knows exactly which message is being referenced |
| 📦 **Large File Support** | Auto chunked upload for large files (parallel upload with retry), up to 100 MB |
| 🔐 **Command Execution Approval** | AI requests approval via Inline Keyboard buttons before executing commands — tap to allow or deny |

---

## 📸 Feature Showcase

> **Note:** This plugin serves as a **message channel** only — it relays messages between QQ and OpenClaw. Capabilities like image understanding, voice transcription, drawing, etc. depend on the **AI model** you configure and the **skills** installed in OpenClaw, not on this plugin itself.

### 💬 Quoted Message Context

When a user quotes a message in QQ, the plugin automatically parses the quoted message content and injects it into the AI context, so the model clearly knows "which message the user is replying to" and gives more accurate responses. Supports text and media messages (image/voice/video/file), and works across devices.


### 🎙️ Voice Messages (STT)

With STT configured, the plugin automatically transcribes voice messages to text before passing them to AI. The whole process is transparent to the user — sending voice feels as natural as sending text.

> **You**: *(send a voice message)* "What's the weather like tomorrow in Shenzhen?"
>
> **QQBot**: Tomorrow (March 7, Saturday) Shenzhen weather forecast 🌤️ ...


### 📄 File Understanding

Document text extraction is optional context enrichment. `.txt`, `.md`, and `.py` files are read locally from QQBot's downloaded-media directory (maximum input size: 10 MiB; extracted text is capped at 8,000 characters). PDF, DOCX, and XLSX require a caller-supplied `DocumentParser` adapter; the current Gateway and reference/history call sites do not configure one, so these formats report `parser_not_configured` in normal plugin flows. This package does not bundle or launch an external parser. Parsing failures do not block message handling. Synchronous adapters must return promptly and enforce their own process timeout if they launch a process.

For example, text attachments can be added to the AI context when the supported local reader can decode them.

> **You**: *(send a TXT file of "War and Peace")*
>
> **QQBot**: Got it! You uploaded the Chinese version of "War and Peace" by Leo Tolstoy. This appears to be the opening of Chapter 1...


### 🖼️ Image Understanding

If your main model supports vision (e.g. Tencent Hunyuan `hunyuan-vision`), AI can understand images too. This is a general multimodal capability, not plugin-specific.

> **You**: *(send an image)*
>
> **QQBot**: Haha, so cute! Is that a QQ penguin in a lobster costume? 🦞🐧 ...


### 🎨 Image Sending

> **You**: Draw me a cat
>
> **QQBot**: Here you go! 🐱

AI can send images directly. Supports local paths and URLs. Formats: jpg/png/gif/webp/bmp.


### 🔊 Voice Sending

> **You**: Tell me a joke in voice
>
> **QQBot**: *(sends a voice message)*

AI can send voice messages directly. Formats: mp3/wav/silk/ogg. No ffmpeg required.


### ⏰ Scheduled Reminder (Proactive Message)

> **You**: Remind me to eat in 5 minutes
>
> **QQBot**: confirms the reminder first, then proactively sends a voice + text reminder when time is up

This capability depends on OpenClaw cron scheduling and proactive messaging. If no reminder arrives, a common reason is QQ-side interception of bot proactive messages.


### 📎 File Sending

> **You**: Extract chapter 1 of War and Peace and send it as a file
>
> **QQBot**: *(sends a .txt file)*

AI can send files directly, in any format.


Since v1.6.6, large file transfer is supported: images up to 20MB, videos up to 30MB, attachments up to 100MB, with a daily transfer limit of 2GB.


### 🔐 Command Execution Approval

When the AI needs to execute a command, the plugin sends an approval request via QQ message with interactive buttons — tap **✅ Allow Once**, **⭐ Always Allow**, or **❌ Deny** to control whether the command runs. 

Use the `/bot-approve` command to manage the approval mode (allowlist / off / strict).


### 🎬 Video Sending

> **You**: Send me a demo video
>
> **QQBot**: *(sends a video)*

AI can send videos directly. Supports local files and URLs.


> **Under the hood:** Upload dedup caching, ordered queue delivery, and multi-layer audio format fallback.

### 🛠️ Slash Commands

The plugin provides built-in slash commands that are intercepted before reaching the AI queue, giving instant responses for diagnostics and management.

#### `/bot-ping` — Latency Test

> **You**: `/bot-ping`
>
> **QQBot**: ✅ pong！⏱ Latency: 602ms (network: 602ms, plugin: 0ms)

Measures end-to-end latency from QQ server push to plugin response, broken down into network transport and plugin processing time.


#### `/bot-version` — Version Info

> **You**: `/bot-version`
>
> **QQBot**: 🦞 Framework: OpenClaw 2026.3.13 (61d171a) / 🤖 Plugin: v1.6.3 / 🌟 GitHub repo

Shows locally detected framework and plugin versions.


#### `/bot-help` — Command List

> **You**: `/bot-help`
>
> **QQBot**: Lists all available slash commands with clickable shortcuts.


#### Remote Upgrade

The first release is a GitHub source repository only. Remote hot upgrade is not included. The former /bot-upgrade command is intercepted and returns a fixed disabled notice instead of reaching the agent. No automatic update check, remote script download, or script execution is present.

#### `/bot-logs` — Local Log Diagnostics

For privacy, this version never reads or exports host logs through QQ. Inspect logs locally on the OpenClaw host.

> **You**: `/bot-logs`
>
> **QQBot**: Host log export is disabled; inspect logs locally on the OpenClaw host.




#### `/bot-approve` — Approval Configuration

> **You**: `/bot-approve`
>
> **QQBot**: 🔐 Command Execution Approval — Enable / Disable / Strict mode / Reset / View current config

Manage the AI command execution approval policy. Supported subcommands:

| Subcommand | Description |
|------------|-------------|
| `/bot-approve on` | Enable approval (allowlist mode, recommended) |
| `/bot-approve off` | Disable approval — commands execute directly |
| `/bot-approve always` | Strict mode — every execution requires approval |
| `/bot-approve reset` | Restore framework defaults |
| `/bot-approve status` | View current approval config |

#### `/bot-clear-storage` — Clear files generated through QQBot conversations and downloaded resources (stored on the host running OpenClaw)

`/bot-clear-storage` lists files generated by the conversation and files in the downloaded resources directory. Use `/bot-clear-storage --force` to confirm deletion.

#### `/bot-group-allways` — Group Response Mode Toggle

> **You**: `/bot-group-allways`
>
> **QQBot**: 🤖 Group autonomous mode: ❌ @mention required

Toggle group @trigger behavior at runtime — changes persist instantly, no restart needed:

| Subcommand | Description |
|------------|-------------|
| `/bot-group-allways on` | AI decides when to speak autonomously (no @ needed) |
| `/bot-group-allways off` | Only respond when @mentioned |
| `/bot-group-allways` (no arg) | View current setting |

> ⚠️ This command modifies the account-level `defaultRequireMention`. It has lower priority than per-group `groups.{groupId}.requireMention` settings.

---

## Compatibility

- **Supported host:** official OpenClaw 2026.6.x (the lockfile pins `openclaw` 2026.6.10). Its outbound delivery queue is stored in SQLite.
- **Not supported:** the legacy custom-host contract that kept the delivery queue as JSON files and recovered entries without a reply context into a `pending_claim` state. Two tests describe that contract; they are kept unchanged but skipped by default, and CI runs them only as an informational step that is expected to fail on official OpenClaw. Details: [docs/LEGACY-HOST-CONTRACT.md](docs/LEGACY-HOST-CONTRACT.md).
- **Delivery safety (fail-closed):** a pending task is never resent without a reply context (`replyToId`), a file whose previous delivery outcome is unknown is sent to review instead of being sent again, and a batch-level success only confirms the files that were part of that attempt.

---

## 🚀 Getting Started

### Step 1 — Create a QQ Bot on the QQ Open Platform

1. Go to the [QQ Open Platform](https://q.qq.com/) and **scan the QR code with your phone QQ** to register / log in. If you haven't registered before, scanning will automatically complete the registration and bind your QQ account.


2. After scanning, tap **Agree** on your phone — you'll land on the bot configuration page.
3. Click **Create Bot** to create a new QQ bot.


> ⚠️ The bot will automatically appear in your QQ message list and send a first message. However, it will reply "The bot has gone to Mars" until you complete the configuration steps below.


4. Obtain **AppID** and **AppSecret** from the bot's page. Store them only in an access-controlled credential location; do not save them in a plaintext note, shell history, command-line transcript, or repository.


> For a step-by-step walkthrough with screenshots, see the [official guide](https://cloud.tencent.com/developer/article/2626045).

### Step 2 — Source Release

The first release is source-only. No npm package or automated install/upgrade command is provided. Do not install the Tencent Connect upstream package expecting it to contain this candidate. A reproducible install guide will be added after the repository identity and isolated build have been verified.

### Credentials and Recovery

Automatic credential backup and silent credential recovery are disabled. If the OpenClaw configuration loses QQ Bot credentials, startup fails closed; reconfigure them explicitly through the OpenClaw channel setup flow. Runtime credentials remain in the OpenClaw configuration path and this plugin does not encrypt that configuration; protect it with the host's access controls. The plugin does not support `clientSecretFile`. Existing `credential-backup.json` files are not read, migrated, or deleted automatically. Existing deployments should locate and protect historical plaintext backups themselves; do not paste their contents into logs or support reports.

Task Delivery state and artifacts are stored below the configured OpenClaw state directory (`OPENCLAW_STATE_DIR/qqbot/agent-task-delivery`) by default. Existing deployments that used an earlier custom path can set `QQBOT_AGENT_TASK_STATE_DIR` and `QQBOT_AGENT_TASK_ARTIFACT_DIR` explicitly.

Optional group-search dry-run exceptions are configured through the operator-owned, comma-separated `QQBOT_GROUP_SEARCH_ALLOWLIST`. If unset, no group receives this exception.

QQ Bot API requests use `https://api.sgroup.qq.com`, and token requests use `https://bots.qq.com`. Redirects are rejected. Configured OCR/STT/TTS provider endpoints must use HTTPS; configure only the intended provider because its API key is sent to that endpoint. Redirects are rejected there too. Tests may opt into loopback-only endpoints with `NODE_ENV=test`, `QQBOT_ALLOW_LOCAL_API_ENDPOINT_FOR_TESTS=1` plus `QQBOT_BASE_URL=http://127.0.0.1:<port>`, or `QQBOT_ALLOW_LOCAL_TOKEN_ENDPOINT_FOR_TESTS=1` plus `QQBOT_TOKEN_BASE_URL=http://127.0.0.1:<port>`. Use synthetic credentials only; do not set these exceptions in production.

PDF, DOCX, and XLSX parsing is optional and requires a caller-provided `DocumentParser`; without one, those formats report unavailable and do not block normal message handling. TXT, Markdown, and Python files use the plugin's bounded local reader.

### Step 3 — Local Tests

Run `npm test` for the offline unit suite. The suite uses synthetic data and does not connect to QQ. Full build and integration checks remain pending.

---

## ⚙️ Advanced Configuration

### Multi-Account Setup (Multi-Bot)

Run multiple QQ bots under a single OpenClaw instance.

#### Configuration

Edit `~/.openclaw/openclaw.json` and add an `accounts` field under `channels.qqbot`:

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

**Notes:**

- The top-level `appId` / `clientSecret` is the **default account** (accountId = `"default"`)
- Each key under `accounts` (e.g. `bot2`, `bot3`) is the `accountId` for that bot
- Each account can independently configure `enabled`, `name`, `allowFrom`, `systemPrompt`, etc.
- You may also skip the top-level default account and only configure bots inside `accounts`

Add a second bot via CLI (if the framework supports the `--account` parameter):

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### Sending Messages to a Specific Account's Users

When using `openclaw message send`, specify which bot to use with the `--account` parameter:

```bash
# Send with the default bot (no --account = uses "default")
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# Send with bot2
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target Formats:**

| Format | Description |
|--------|-------------|
| `qqbot:c2c:OPENID` | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat |
| `qqbot:channel:CHANNEL_ID` | Guild channel |

> ⚠️ **Important**: Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot** be used to send messages via Bot B — this will result in a 500 error. Always use the matching bot's `accountId` to send messages to its users.

#### How It Works

- When `openclaw gateway` starts, all accounts with `enabled: true` launch their own connections (WebSocket or Webhook depending on `transport` config)
- Each account maintains an independent Token cache (isolated by `appId`), preventing cross-contamination
- Incoming message logs are prefixed with `[qqbot:accountId]` for easy debugging

---

### Webhook Transport Mode

By default, the plugin connects to QQ via **WebSocket** (outbound connection, no public IP required). You can switch to **Webhook** mode where QQ platform POSTs events to your HTTP endpoint.

| | WebSocket (default) | Webhook |
|---|---|---|
| Connection | Plugin connects to QQ gateway | QQ platform POSTs to your server |
| Public IP | Not required | Required |
| Use case | Development, single instance | Production, horizontal scaling, Serverless |
| Session resume | Supported (RESUME) | Stateless, no resume needed |
| Signature | Built-in | Ed25519 auto-verified by plugin |

#### Configuration

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

| Field | Default | Description |
|-------|---------|-------------|
| `transport` | `"websocket"` | `"websocket"` or `"webhook"` |
| `webhook.path` | `"/qqbot/webhook"` | HTTP path for receiving callbacks |

#### Platform Setup

1. Go to [QQ Open Platform](https://q.qq.com/) → Bot Settings → Message Receiving
2. Select **HTTP Callback**
3. Enter your callback URL: `https://your-domain.com/qqbot/webhook`
4. The platform sends an `op:13` validation request — the plugin handles it automatically
5. Once validated, all events will be POSTed to your endpoint

---

### Group Chat Configuration

The plugin provides flexible group chat controls, allowing you to customize trigger rules, tool permissions, and AI behavior per group.

#### @Mention Trigger Mode (`requireMention`)

By default, the bot **only responds when @mentioned** in a group. You can configure it to autonomously decide when to speak:

| Mode | Config Value | Behavior |
|------|-------------|----------|
| **@ only** | `true` (default) | Only messages that @mention the bot trigger a reply |
| **Autonomous** | `false` | AI decides on its own whether each message needs a reply — no @ required |

**Priority chain** (highest to lowest):

```
groups.{groupOpenid}.requireMention
  > groups."*".requireMention
    > account-level defaultRequireMention
      > default value true
```

**Example:**

```json
{
  "channels": {
    "qqbot": {
      // Account-level default for all groups
      "defaultRequireMention": false,

      "accounts": {
        "default": {
          "groups": {
            "*": {
              // Wildcard fallback for all groups
              "requireMention": false
            },
            "GROUP_OPENID": {
              // Per-group override — this group still requires @
              "requireMention": true
            }
          }
        }
      }
    }
  }
}
```

> **Use cases:**
>
> - Work groups → `requireMention: true` — avoid AI chiming in on every casual message
> - Dedicated AI companion groups → `requireMention: false` — participate naturally like a real person
> - Use [`/bot-group-allways`](#bot-group-allways--group-response-mode-toggle) to toggle account-level defaults at runtime

#### Additional Group Config Fields

Besides `requireMention`, each group supports these settings:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ignoreOtherMentions` | `boolean` | `false` | If enabled, messages that @mention others but not the bot are silently dropped (not recorded, no AI trigger) |
| `toolPolicy` | `"full" \| "restricted" \| "none"` | `"restricted"` | Tool scope available to AI in this group. `full`=all tools; `restricted`=sensitive tools restricted (e.g., command execution, file ops); `none`=no tool calls allowed |
| `prompt` | `string` | built-in default | Group-specific system prompt, appended after global systemPrompt |
| `historyLimit` | `number` | `50` | Cached group history message count |

**Full example with multiple groups:**

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
              "prompt": "You are a work assistant. Only answer work-related questions."
            },
            "FRIEND_GROUP_OPENID": {
              "requireMention": false,
              "toolPolicy": "full",
              "prompt": "You are a friend in the group. Chat casually and naturally."
            }
          }
        }
      }
    }
  }
}
```

#### Group Access Control (`groupPolicy`)

Control which groups are allowed via `groupPolicy`:

| Policy | Description |
|--------|-------------|
| `"open"` (default) | All groups are allowed |
| `"allowlist"` | Only groups in `groupAllowFrom` are allowed |
| `"disabled"` | Group chats are disabled entirely |

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

> You can also use [**`/bot-group-allways`**](#bot-group-allways--group-response-mode-toggle) to toggle account-level defaults at runtime without restarting.

---

#### STT (Speech-to-Text) — Transcribe Incoming Voice Messages

STT supports two-level configuration with priority fallback:

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.stt` | Plugin-specific |
| 2 (fallback) | `tools.media.audio.models[0]` | Framework-level |

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

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- Set `enabled: false` to disable
- When configured, incoming voice messages are automatically converted (SILK→WAV) and transcribed

#### TTS (Text-to-Speech) — Send Voice Messages

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.tts` | Plugin-specific |
| 2 (fallback) | `messages.tts` | Framework-level |

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

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- `voice` — voice variant
- Set `enabled: false` to disable (default: `true`)
- When configured, AI can generate and send voice messages

---

## 📚 Documentation & Links


## Upstream and attribution

This project is a community remediation and integration candidate based on Tencent Connect openclaw-qqbot. See the upstream repository for upstream contributors and its MIT license. The exact source commit baseline and individual third-party asset provenance have not been established; unverified upstream media is not included in this source release.

