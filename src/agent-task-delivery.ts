import crypto from "node:crypto";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentTaskDeliveryPaths } from "./utils/agent-task-delivery-paths.js";

export const AGENT_TASK_DELIVERY_BRIDGE = Symbol.for("openclaw.qqbot.agentTaskDeliveryV1");

const SCHEMA_VERSION = 2;
const RESULT_TEXT_LIMIT = 12_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DELIVERABLE_BYTES = 100 * 1024 * 1024;
const MAX_MULTIPLE_FILES = 5;

export type TaskPhase =
  | "registered"
  | "collecting"
  | "collected"
  | "flushed"
  | "received"
  | "document_parsed"
  | "planning"
  | "generating"
  | "validating"
  | "packaging"
  | "delivering"
  | "completed"
  | "pending_delivery"
  | "pending_claim"
  | "delivered"
  | "requires_review"
  | "failed";

export type TaskTargetType = "group" | "private";
export type DeliveryMode = "direct_file" | "multiple_files" | "archive" | "text_only" | "requires_review";
export type DeliverableState = "pending" | "delivering" | "delivered" | "failed" | "requires_review";
export type DeliverableSourceKind = "subagent_completion" | "direct_agent_file" | "qqmedia_tag" | "message_send_media";

export interface TaskDeliverable {
  logicalName: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
  deliveryState: DeliverableState;
  deliveryAttemptCount: number;
  platformReceiptHash?: string;
  artifactPath?: string;
  uploadState?: "pending" | "uploading" | "uploaded" | "failed";
  messageState?: "pending" | "sending" | "sent" | "failed";
  lastError?: string;
}

export interface DeliverableCandidate {
  taskId: string;
  turnId: string;
  traceId?: string;
  runId?: string;
  sourceKind: DeliverableSourceKind;
  sourceAgent?: string;
  workspaceRoot: string;
  relativePath: string;
  logicalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  relationshipGroup?: string;
  requestedFormat?: "archive";
  originReplyContext: string;
  deliveryKind: "agent_task_delivery";
}

export interface DirectCollectResult {
  handled: boolean;
  accepted: boolean;
  taskId?: string;
  shortTaskId?: string;
  duplicate?: boolean;
  reason?: string;
}

export interface TaskLog {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

type EncryptedEnvelope = {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

type DeliveryEnvelope = {
  channel: "qqbot";
  accountId: string;
  targetType: TaskTargetType;
  target: string;
  requesterId: string;
  originMessageId: string;
  receivedAt: string;
};

export interface DeliveryAttempt {
  at: string;
  state: "started" | "sent" | "failed" | "pending";
  replyContextHash: string;
  error?: string;
}

export interface PersistedTaskContext {
  schemaVersion: 2;
  taskId: string;
  shortTaskId: string;
  runIdHash: string;
  parentSessionKeyHash: string;
  childRunHashes: string[];
  completedChildRunHashes: string[];
  childSessionKeyHashes: string[];
  sourceKinds?: DeliverableSourceKind[];
  sourceAgent?: string;
  turnIdHash?: string;
  collectorState?: "collecting" | "flushed";
  collectedCandidates?: Array<{
    sourceKind: DeliverableSourceKind;
    relativePath: string;
    logicalName: string;
    mimeType: string;
    size: number;
    sha256: string;
    relationshipGroup?: string;
  }>;
  channel: "qqbot";
  accountHash: string;
  targetType: TaskTargetType;
  conversationHash: string;
  requesterHash: string;
  originMessageHash: string;
  originReceivedAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  retentionUntil?: string;
  status: TaskPhase;
  progressPhase: TaskPhase;
  progressCurrent?: number;
  progressTotal?: number;
  workspaceRoot: string;
  stagingRoot?: string;
  deliveryWorkspaceRoot?: string;
  generatedFiles: Array<{ path: string; size: number; sha256: string }>;
  requestedDeliveryMode?: "archive";
  deliveryMode?: DeliveryMode;
  deliverables: TaskDeliverable[];
  deliverableCount: number;
  resultText?: string;
  resultRef?: string;
  artifactZip?: string;
  artifactManifest?: string;
  artifactReport?: string;
  artifactSha256?: string;
  artifactSize?: number;
  deliveryState: "not_ready" | "pending_delivery" | "pending_claim" | "delivering" | "delivered" | "requires_review" | "failed";
  deliveryAttempts: DeliveryAttempt[];
  idempotencyKey: string;
  idempotencyConsumedAt?: string;
  lastError?: string;
  requiresReview: boolean;
  encryptedDelivery: EncryptedEnvelope;
}

export interface InboundTaskCandidate {
  accountId: string;
  clientSecret: string;
  targetType: TaskTargetType;
  target: string;
  requesterId: string;
  originMessageId: string;
  receivedAt: string;
  parentSessionKey: string;
  inputFiles?: string[];
  requestedDeliveryMode?: "archive";
  sendInitial?: (text: string) => Promise<void>;
  sourceWorkspaceRoot?: string;
  sourceAgent?: string;
  traceId?: string;
  runId?: string;
}

export interface TaskDeliveryServiceOptions {
  stateRoot?: string;
  artifactRoot?: string;
  now?: () => Date;
  randomUUID?: () => string;
  retentionDays?: number;
  log?: TaskLog;
}

type AccountRuntime = { clientSecret: string; log?: TaskLog; loaded: boolean };
type CandidateRuntime = InboundTaskCandidate & { taskId: string; shortTaskId: string };

type ArchiveEntry = { name: string; data: Buffer; size: number; sha256: string; sourcePath?: string };

export interface PreparedCompletion {
  handled: boolean;
  suppressDelivery: boolean;
  replyToId?: string;
  payloads?: Array<Record<string, unknown>>;
  taskId?: string;
  idempotencyKey?: string;
  reason?: string;
}

export interface AgentTaskDeliveryBridge {
  prepareSubagent(input: {
    originMessageId?: string;
    accountId?: string;
    parentSessionKey?: string;
    childSessionKey: string;
    inheritedWorkspace?: string;
  }): Promise<{ taskId: string; workspaceRoot: string; systemPromptSuffix: string } | undefined>;
  confirmSubagentRun(input: { taskId?: string; childRunId: string; childSessionKey: string }): Promise<void>;
  prepareCompletion(input: {
    childRunId: string;
    channel?: string;
    accountId?: string;
    target?: string;
    resultText?: string;
    status?: string;
    payloads?: Array<Record<string, unknown>>;
  }): Promise<PreparedCompletion>;
  markDelivery(input: { taskId?: string; idempotencyKey?: string; ok: boolean; error?: string }): Promise<void>;
  markDeliverable(input: {
    taskId?: string;
    idempotencyKey?: string;
    mediaUrl?: string;
    ok: boolean;
    error?: string;
    platformReceipt?: string;
  }): Promise<void>;
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[local-path]")
    .replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+\/[^\s"']+/g, "[local-path]")
    .slice(0, 500);
}

const STATE_STRING_LIMIT = 64_000;
const STATE_STACK_LIMIT = 8_000;

function sanitizeStateString(value: string, limit = STATE_STRING_LIMIT): string {
  const input = value.length > limit ? `${value.slice(0, limit)}...[truncated]` : value;
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
      continue;
    }
    if ((code >= 0 && code <= 0x8) || code === 0xb || code === 0xc || (code >= 0xe && code <= 0x1f)) {
      output += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (code === 0x2028) {
      output += "\\u2028";
      continue;
    }
    if (code === 0x2029) {
      output += "\\u2029";
      continue;
    }
    output += input[index];
  }
  return output;
}

function stateSafeErrorObject(error: Error & { code?: unknown }): Record<string, unknown> {
  const code = typeof error.code === "string" || typeof error.code === "number"
    ? sanitizeStateString(String(error.code), 256)
    : undefined;
  return {
    name: sanitizeStateString(error.name || "Error", 256),
    message: sanitizeStateString(error.message || ""),
    stack: error.stack ? sanitizeStateString(error.stack, STATE_STACK_LIMIT) : undefined,
    code,
  };
}

function normalizeStateValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) return stateSafeErrorObject(value);
  if (typeof value === "string") return sanitizeStateString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (Array.isArray(value)) return value.map((entry) => normalizeStateValue(entry, seen) ?? null);
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedEntry = normalizeStateValue(entry, seen);
      if (normalizedEntry !== undefined) normalized[sanitizeStateString(key, 256)] = normalizedEntry;
    }
    seen.delete(value);
    return normalized;
  }
  return String(value);
}

function safeStateStringify(value: PersistedTaskContext | Record<string, unknown>): string {
  const serialized = JSON.stringify(normalizeStateValue(value), null, 2);
  JSON.parse(serialized);
  return serialized;
}

async function writeUtf8FileSynced(filePath: string, data: string): Promise<void> {
  const handle = await fsp.open(filePath, "w", 0o600);
  try {
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await fsp.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {}
}

export function isExplicitPrivateOwner(ownerOpenId: string | undefined, senderId: string): boolean {
  const configuredOwner = ownerOpenId?.trim();
  const sender = senderId.trim();
  if (!configuredOwner || configuredOwner === "*" || !sender) return false;
  return configuredOwner.toUpperCase() === sender.toUpperCase();
}

function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update("qqbot-agent-task-delivery-v1\0").update(secret).digest();
}

function keyedHash(secret: string, value: string): string {
  return crypto.createHmac("sha256", deriveKey(secret)).update(value).digest("hex");
}

function publicHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encryptEnvelope(secret: string, value: DeliveryEnvelope): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptEnvelope(secret: string, value: EncryptedEnvelope): DeliveryEnvelope {
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as DeliveryEnvelope;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("invalid archive path");
  }
  return normalized;
}

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "cache", ".cache",
  "logs", "log", "tmp", "temp", "downloads", "backup", "backups", "dist-cache", "build-cache",
]);

function shouldExclude(relativePath: string, isDirectory: boolean): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const base = parts.at(-1)?.toLowerCase() ?? "";
  if (parts[0]?.toLowerCase() === "inputs") return true;
  if (parts.some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))) return true;
  if (isDirectory) return EXCLUDED_DIRS.has(base);
  if (base === ".env.example") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (["auth.json"].includes(base)) return true;
  if (/^(credentials|token|cookie|session)/i.test(base)) return true;
  if (/\.(key|pem|pfx|p12|bak|backup|log|tmp|db|sqlite|sqlite3|pyc)$/i.test(base)) return true;
  if (/(?:-wal|-shm)$/i.test(base)) return true;
  return false;
}

const TEXT_EXTENSIONS = new Set([
  "", ".txt", ".md", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonc",
  ".html", ".css", ".scss", ".less", ".vue", ".py", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".go", ".rs", ".rb", ".php", ".sh", ".ps1", ".bat", ".cmd", ".sql", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".properties", ".csv", ".tsv", ".env.example", ".gitignore", ".dockerignore",
]);

const SAFE_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svgz", ".woff", ".woff2", ".ttf", ".otf",
  ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
  ".mp3", ".wav", ".ogg", ".mp4", ".webm",
]);

const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".py", ".java", ".c", ".cc", ".cpp",
  ".h", ".hpp", ".go", ".rs", ".rb", ".php", ".sh", ".ps1", ".bat", ".cmd", ".sql",
]);

const PROJECT_MANIFEST_NAMES = new Set([
  "package.json", "requirements.txt", "pyproject.toml", "cargo.toml", "go.mod", "cmakelists.txt",
  "dockerfile", "compose.yaml", "compose.yml",
]);

function looksText(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  if (base === ".env.example" || base.startsWith("readme") || base.startsWith("license")) return true;
  return TEXT_EXTENSIONS.has(path.extname(base));
}

function mimeTypeFor(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  const byExtension: Record<string, string> = {
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
    ".cjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript", ".jsx": "text/javascript",
    ".json": "application/json", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".py": "text/x-python", ".c": "text/x-c", ".cc": "text/x-c++", ".cpp": "text/x-c++", ".h": "text/x-c",
    ".hpp": "text/x-c++", ".java": "text/x-java-source", ".go": "text/x-go", ".rs": "text/x-rust",
    ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".zip": "application/zip",
  };
  return byExtension[ext] ?? (looksText(relativePath) ? "text/plain" : "application/octet-stream");
}

function isProjectLayout(entries: ArchiveEntry[]): boolean {
  const names = entries.map((entry) => entry.name.toLowerCase());
  const hasNestedPath = names.some((name) => name.includes("/"));
  const hasManifest = names.some((name) => {
    const base = path.posix.basename(name);
    return PROJECT_MANIFEST_NAMES.has(base) || base.endsWith(".csproj");
  });
  const hasReadme = names.some((name) => path.posix.basename(name) === "readme.md");
  const hasSource = names.some((name) => SOURCE_EXTENSIONS.has(path.extname(name)));
  return hasNestedPath || hasManifest || (hasReadme && hasSource && entries.length > 1);
}

function hasStaticProjectRelationship(entries: ArchiveEntry[]): boolean {
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const resolveReference = (from: string, reference: string): boolean => {
    if (!reference.startsWith(".")) return false;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), reference)).toLowerCase();
    const candidates = [base, ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".css", ".html"].map((ext) => `${base}${ext}`), `${base}/index.js`, `${base}/index.ts`];
    return candidates.some((candidate) => names.has(candidate));
  };
  for (const entry of entries) {
    if (!looksText(entry.name) || entry.size > 1024 * 1024) continue;
    const text = entry.data.toString("utf8");
    const ext = path.extname(entry.name).toLowerCase();
    if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) {
      const references = [
        ...text.matchAll(/(?:from\s*|require\s*\(|import\s*\()\s*["']([^"']+)["']/g),
      ].map((match) => match[1]).filter((value): value is string => Boolean(value));
      if (references.some((reference) => resolveReference(entry.name, reference))) return true;
    }
    if (ext === ".py") {
      const modules = [...text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)].map((match) => match[1]?.replace(/\./g, "/"));
      if (modules.some((module) => module && (names.has(`${module.toLowerCase()}.py`) || names.has(`${module.toLowerCase()}/__init__.py`)))) return true;
    }
    if ([".html", ".htm"].includes(ext)) {
      const references = [...text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1]);
      if (references.some((reference) => reference && resolveReference(entry.name, reference))) return true;
    }
  }
  const readme = entries.find((entry) => path.posix.basename(entry.name).toLowerCase() === "readme.md");
  const sourceCount = entries.filter((entry) => SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).length;
  return Boolean(readme && sourceCount > 1 && /\b(?:node|python|npm|pnpm|yarn|cargo|go run|cmake|make)\b/i.test(readme.data.toString("utf8")));
}

function scanTextForSecrets(text: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, "private_key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "aws_access_key"],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "github_token"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "api_key"],
    [/(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\r\n]{16,}["']/i, "credential_assignment"],
    [/authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{16,}/i, "bearer_token"],
  ];
  for (const [pattern, reason] of patterns) if (pattern.test(text)) return reason;
  return undefined;
}

function containsHostAbsolutePath(text: string): boolean {
  return /\b[A-Za-z]:\\(?:Users|Dev|Windows|Program Files)\\/i.test(text) || /\/(?:home|Users)\/[A-Za-z0-9._-]+\//.test(text);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function writeStoredZip(output: string, entries: ArchiveEntry[], now: Date): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime(now);
  for (const entry of entries) {
    const name = Buffer.from(normalizeArchivePath(entry.name), "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await fsp.writeFile(output, Buffer.concat([...localParts, ...centralParts, end]));
}

function minimalReadme(shortTaskId: string): string {
  return [
    `# Task ${shortTaskId}`,
    "",
    "This archive contains the source files generated for this task.",
    "",
    "## Implemented functionality",
    "",
    "See the source files and project manifests in this archive.",
    "",
    "## Environment and installation",
    "",
    "Install dependencies declared by package.json, requirements.txt, or the equivalent project manifest.",
    "Copy .env.example to a local .env only when the project requires configuration; never commit real secrets.",
    "",
    "## Start, test, and stop",
    "",
    "Use the scripts documented by the project manifest. Review source comments when no manifest script is present.",
    "Stop the foreground process with Ctrl+C. Remove only generated runtime data you explicitly recognize.",
    "",
    "## Limitations",
    "",
    "No external platform, credential, database server, or hosted service is bundled in this archive.",
    "",
  ].join("\n");
}

function ensureReadmeSections(readme: string): string {
  const sections: Array<[RegExp, string]> = [
    [/^##\s+Implemented functionality\s*$/im, "## Implemented functionality\n\nSee the source files and project manifests in this archive."],
    [/^##\s+Environment and installation\s*$/im, "## Environment and installation\n\nInstall dependencies declared by the included project manifest. Never place real credentials in the archive."],
    [/^##\s+Start, test, and stop\s*$/im, "## Start, test, and stop\n\nUse the scripts declared by the project manifest and stop foreground processes with Ctrl+C."],
    [/^##\s+Limitations\s*$/im, "## Limitations\n\nExternal services, credentials, databases, and hosted infrastructure are not bundled."],
  ];
  const additions = sections.filter(([pattern]) => !pattern.test(readme)).map(([, text]) => text);
  if (additions.length === 0) return readme;
  return `${readme.trimEnd()}\n\n${additions.join("\n\n")}\n`;
}

function taskDeliveryWorkspaceRoot(agentWorkspaceRoot: string, taskId: string): string {
  return path.join(agentWorkspaceRoot, ".agent-task-delivery", taskId);
}

function taskDeliveryStagingRoot(agentWorkspaceRoot: string, taskId: string): string {
  return path.join(taskDeliveryWorkspaceRoot(agentWorkspaceRoot, taskId), "staging");
}

async function ensureTaskDeliveryWorkspace(agentWorkspaceRoot: string, taskId: string): Promise<{ deliveryRoot: string; stagingRoot: string }> {
  const deliveryRoot = taskDeliveryWorkspaceRoot(agentWorkspaceRoot, taskId);
  const stagingRoot = path.join(deliveryRoot, "staging");
  await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(deliveryRoot, "archive"), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(deliveryRoot, "manifest"), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(deliveryRoot, "state"), { recursive: true, mode: 0o700 });
  return { deliveryRoot, stagingRoot };
}

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await fsp.readFile(filePath)).digest("hex");
}

export class AgentTaskDeliveryService {
  readonly stateRoot: string;
  readonly artifactRoot: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly retentionDays: number;
  private readonly log?: TaskLog;
  private readonly accounts = new Map<string, AccountRuntime>();
  private readonly candidatesByMessage = new Map<string, CandidateRuntime>();
  private readonly tasksById = new Map<string, PersistedTaskContext>();
  private readonly taskIdByChildHash = new Map<string, string>();
  private readonly taskIdByRunHash = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TaskDeliveryServiceOptions = {}) {
    const paths = resolveAgentTaskDeliveryPaths({
      openClawStateDir: process.env.OPENCLAW_STATE_DIR,
      taskStateDir: process.env.QQBOT_AGENT_TASK_STATE_DIR,
      taskArtifactDir: process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR,
    });
    this.stateRoot = options.stateRoot ?? paths.stateRoot;
    this.artifactRoot = options.artifactRoot ?? paths.artifactRoot;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    const configuredRetention = options.retentionDays ?? Number(process.env.QQBOT_AGENT_TASK_RETENTION_DAYS ?? 30);
    this.retentionDays = Number.isFinite(configuredRetention) && configuredRetention >= 1
      ? Math.min(Math.floor(configuredRetention), 3650)
      : 30;
    this.log = options.log;
  }

  async configureAccount(accountId: string, clientSecret: string, log?: TaskLog): Promise<void> {
    if (!accountId || !clientSecret) return;
    const current = this.accounts.get(accountId);
    this.accounts.set(accountId, { clientSecret, log: log ?? current?.log, loaded: current?.loaded ?? false });
    await fsp.mkdir(this.stateRoot, { recursive: true });
    await fsp.mkdir(this.artifactRoot, { recursive: true });
    await this.loadAccount(accountId);
  }

  async registerInbound(candidate: InboundTaskCandidate): Promise<{ taskId: string; shortTaskId: string }> {
    const taskId = this.randomUUID();
    const shortTaskId = taskId.replace(/-/g, "").slice(0, 8).toUpperCase();
    const runtime = { ...candidate, taskId, shortTaskId };
    this.candidatesByMessage.set(candidate.originMessageId, runtime);
    await this.ensureDirectTask(runtime, undefined, candidate.sourceAgent);
    return { taskId, shortTaskId };
  }

  async collectDirectFile(input: {
    taskId: string;
    originMessageId: string;
    turnId?: string;
    filePath: string;
    sourceKind: Exclude<DeliverableSourceKind, "subagent_completion">;
    workspaceRoot?: string;
    sourceAgent?: string;
  }): Promise<DirectCollectResult> {
    const candidate = this.candidatesByMessage.get(input.originMessageId);
    if (!candidate) return { handled: false, accepted: false, reason: "no_eligible_inbound_candidate" };
    const account = this.accounts.get(candidate.accountId);
    if (!account) return { handled: true, accepted: false, reason: "account_not_configured" };
    const task = this.tasksById.get(input.taskId);
    if (!task) return { handled: true, accepted: false, reason: "task_context_not_found" };
    const failClosedExisting = async (reason: string): Promise<DirectCollectResult> => {
      await this.requireReview(task, reason);
      task.collectorState = "flushed";
      await this.persist(task);
      return { handled: true, accepted: false, taskId: task.taskId, shortTaskId: task.shortTaskId, reason };
    };
    if (candidate.taskId !== input.taskId) return failClosedExisting("task_origin_binding_mismatch");
    if (task.originMessageHash !== keyedHash(account.clientSecret, input.originMessageId)) return failClosedExisting("task_origin_binding_mismatch");
    if (input.turnId && task.turnIdHash && task.turnIdHash !== keyedHash(account.clientSecret, input.turnId)) return failClosedExisting("task_turn_binding_mismatch");
    if (input.sourceAgent && task.sourceAgent && input.sourceAgent !== task.sourceAgent) return failClosedExisting("source_agent_context_mismatch");
    let sourcePath: string;
    try {
      sourcePath = input.filePath.startsWith("file:") ? fileURLToPath(input.filePath) : path.resolve(input.filePath);
    } catch {
      return { handled: true, accepted: false, reason: "invalid_local_file_url" };
    }
    if ((candidate.inputFiles ?? []).some((value) => path.resolve(value) === sourcePath)) {
      return { handled: false, accepted: false, reason: "inbound_attachment_legacy_path" };
    }
    const failClosed = async (reason: string): Promise<DirectCollectResult> => {
      await this.requireReview(task, reason);
      task.collectorState = "flushed";
      await this.persist(task);
      return { handled: true, accepted: false, taskId: task.taskId, shortTaskId: task.shortTaskId, reason };
    };
    const configuredRoot = candidate.sourceWorkspaceRoot ? path.resolve(candidate.sourceWorkspaceRoot) : undefined;
    const providedRoot = input.workspaceRoot ? path.resolve(input.workspaceRoot) : undefined;
    if (!configuredRoot || !providedRoot || configuredRoot !== providedRoot) return failClosed("source_workspace_context_mismatch");
    if (!isInside(configuredRoot, sourcePath)) return failClosed("direct_file_outside_workspace");
    try {
      const rootStat = await fsp.lstat(configuredRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return failClosed("source_workspace_reparse_point");
      const relativeNative = path.relative(configuredRoot, sourcePath);
      let cursor = configuredRoot;
      for (const segment of relativeNative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        const stat = await fsp.lstat(cursor);
        if (stat.isSymbolicLink()) return failClosed("direct_file_reparse_point");
      }
      const stat = await fsp.lstat(sourcePath);
      if (!stat.isFile() || stat.size > MAX_DELIVERABLE_BYTES) return failClosed("direct_file_invalid_or_too_large");
      const relativePath = normalizeArchivePath(relativeNative);
      if (shouldExclude(relativePath, false)) return failClosed("direct_file_excluded_by_policy");
      const data = await fsp.readFile(sourcePath);
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      const deliverableCandidate: DeliverableCandidate = {
        taskId: task.taskId,
        turnId: candidate.runId ?? candidate.originMessageId,
        traceId: candidate.traceId,
        runId: candidate.runId,
        sourceKind: input.sourceKind,
        sourceAgent: input.sourceAgent ?? candidate.sourceAgent,
        workspaceRoot: configuredRoot,
        relativePath,
        logicalName: path.basename(relativePath),
        mimeType: mimeTypeFor(relativePath),
        size: stat.size,
        sha256,
        requestedFormat: candidate.requestedDeliveryMode,
        originReplyContext: candidate.originMessageId,
        deliveryKind: "agent_task_delivery",
      };
      const existing = task.collectedCandidates?.find((entry) => entry.relativePath.toLowerCase() === relativePath.toLowerCase());
      if (existing) {
        if (existing.sha256 !== sha256) return failClosed("direct_file_path_content_conflict");
        if (!task.sourceKinds?.includes(input.sourceKind)) task.sourceKinds?.push(input.sourceKind);
        await this.persist(task);
        return { handled: true, accepted: true, duplicate: true, taskId: task.taskId, shortTaskId: task.shortTaskId };
      }
      const destination = path.join(task.workspaceRoot, ...relativePath.split("/"));
      if (!isInside(task.workspaceRoot, destination)) return failClosed("staging_path_outside_workspace");
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      let stagingCursor = task.workspaceRoot;
      for (const segment of relativePath.split("/").slice(0, -1)) {
        stagingCursor = path.join(stagingCursor, segment);
        const stagingStat = await fsp.lstat(stagingCursor);
        if (stagingStat.isSymbolicLink()) return failClosed("staging_reparse_point");
      }
      await fsp.writeFile(destination, data, { flag: "wx", mode: 0o600 });
      const stagedSha256 = await sha256File(destination);
      if (stagedSha256 !== sha256) {
        try { await fsp.unlink(destination); } catch {}
        return failClosed("staging_sha256_mismatch");
      }
      task.collectedCandidates ??= [];
      task.collectedCandidates.push({
        sourceKind: deliverableCandidate.sourceKind,
        relativePath: deliverableCandidate.relativePath,
        logicalName: deliverableCandidate.logicalName,
        mimeType: deliverableCandidate.mimeType,
        size: deliverableCandidate.size,
        sha256: deliverableCandidate.sha256,
        relationshipGroup: deliverableCandidate.relationshipGroup,
      });
      task.sourceKinds ??= [];
      if (!task.sourceKinds.includes(input.sourceKind)) task.sourceKinds.push(input.sourceKind);
      task.status = "collecting";
      task.progressPhase = "collected";
      task.deliveryState = "not_ready";
      await this.persist(task);
      return { handled: true, accepted: true, taskId: task.taskId, shortTaskId: task.shortTaskId };
    } catch (error) {
      return failClosed(`direct_file_collection_failed:${safeError(error)}`);
    }
  }

  async prepareDirectTurn(input: { taskId: string; originMessageId: string; turnId?: string; resultText?: string }): Promise<PreparedCompletion> {
    const candidate = this.candidatesByMessage.get(input.originMessageId);
    if (!candidate) return { handled: false, suppressDelivery: false };
    const account = this.accounts.get(candidate.accountId);
    if (!account) return { handled: true, suppressDelivery: true, reason: "account_not_configured" };
    if (candidate.taskId !== input.taskId) return { handled: true, suppressDelivery: true, reason: "task_origin_binding_mismatch" };
    const task = this.findByOrigin(account.clientSecret, input.originMessageId);
    if (!task || task.sourceKinds?.every((kind) => kind === "subagent_completion")) return { handled: false, suppressDelivery: false };
    if (task.taskId !== input.taskId) return { handled: true, suppressDelivery: true, reason: "task_origin_binding_mismatch" };
    if (task.originMessageHash !== keyedHash(account.clientSecret, input.originMessageId)) return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "task_origin_binding_mismatch" };
    if (input.turnId && task.turnIdHash && task.turnIdHash !== keyedHash(account.clientSecret, input.turnId)) return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "task_turn_binding_mismatch" };
    if (task.collectorState === "flushed") return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "collector_already_flushed" };
    task.collectorState = "flushed";
    task.status = "flushed";
    task.progressPhase = "flushed";
    await this.saveResult(task, input.resultText ?? "");
    if ((task.collectedCandidates?.length ?? 0) === 0 && !(input.resultText ?? "").trim()) {
      await this.markPending(task, "no_deliverables_collected");
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "no_deliverables_collected" };
    }
    if (task.deliveryState === "requires_review") {
      await this.persist(task);
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "requires_review" };
    }
    let envelope: DeliveryEnvelope;
    try {
      envelope = decryptEnvelope(account.clientSecret, task.encryptedDelivery);
    } catch (error) {
      await this.requireReview(task, `delivery_context_decrypt_failed:${safeError(error)}`);
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "invalid_delivery_context" };
    }
    if (!envelope.originMessageId.trim()) {
      await this.markPending(task, "missing_origin_reply_context");
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "missing_origin_reply_context" };
    }
    const packaged = await this.packageTask(task);
    if (!packaged.ok) {
      if (packaged.requiresReview) await this.requireReview(task, packaged.error);
      else await this.markPending(task, packaged.error);
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: packaged.error };
    }
    const pendingDeliverables = task.deliverables.filter((entry) => entry.deliveryState !== "delivered");
    for (const deliverable of pendingDeliverables) {
      deliverable.deliveryState = "delivering";
      deliverable.deliveryAttemptCount += 1;
      deliverable.uploadState = "uploading";
      deliverable.messageState = "sending";
    }
    task.status = "delivering";
    task.progressPhase = "delivering";
    task.deliveryState = "delivering";
    task.deliveryAttempts.push({ at: iso(this.now), state: "started", replyContextHash: keyedHash(account.clientSecret, envelope.originMessageId) });
    await this.persist(task);
    return {
      handled: true,
      suppressDelivery: false,
      taskId: task.taskId,
      idempotencyKey: task.idempotencyKey,
      replyToId: envelope.originMessageId,
      payloads: this.deliveryPayloads(task, pendingDeliverables),
    };
  }

  async failDirectTurn(originMessageId: string, error: string): Promise<void> {
    const candidate = this.candidatesByMessage.get(originMessageId);
    if (!candidate) return;
    const account = this.accounts.get(candidate.accountId);
    if (!account) return;
    const task = this.findByOrigin(account.clientSecret, originMessageId);
    if (!task || task.collectorState === "flushed") return;
    task.collectorState = "flushed";
    await this.markPending(task, `direct_turn_aborted:${safeError(error)}`);
  }

  formatCompletionForTask(taskId: string): string | undefined {
    const task = this.tasksById.get(taskId);
    if (!task) return undefined;
    const delivered = task.deliverables.filter((entry) => entry.deliveryState === "delivered").length;
    const pending = task.deliverables.length - delivered;
    const outcome = pending === 0 && task.deliveryState === "delivered" ? "delivered" : "pending_delivery";
    return [`Task ${task.shortTaskId} ${outcome}.`, `Delivery mode: ${task.deliveryMode ?? "requires_review"}.`, `Files delivered: ${delivered}/${task.deliverableCount}; pending: ${pending}.`].join("\n");
  }

  async prepareSubagent(input: {
    originMessageId?: string;
    accountId?: string;
    parentSessionKey?: string;
    childSessionKey: string;
  }): Promise<{ taskId: string; workspaceRoot: string; systemPromptSuffix: string } | undefined> {
    const originMessageId = input.originMessageId?.trim();
    if (!originMessageId) return undefined;
    const candidate = this.candidatesByMessage.get(originMessageId);
    if (!candidate || (input.accountId && input.accountId !== candidate.accountId)) return undefined;
    const account = this.accounts.get(candidate.accountId);
    if (!account) return undefined;

    let task = this.findByOrigin(account.clientSecret, originMessageId);
    if (!task) {
      const now = iso(this.now);
      const retentionUntil = new Date(this.now().getTime() + this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const workspaceRoot = path.join(this.stateRoot, "workspaces", candidate.taskId);
      await fsp.mkdir(path.join(workspaceRoot, "inputs"), { recursive: true });
      await this.copyInputs(candidate.inputFiles ?? [], workspaceRoot);
      const envelope: DeliveryEnvelope = {
        channel: "qqbot",
        accountId: candidate.accountId,
        targetType: candidate.targetType,
        target: candidate.target,
        requesterId: candidate.requesterId,
        originMessageId: candidate.originMessageId,
        receivedAt: candidate.receivedAt,
      };
      task = {
        schemaVersion: SCHEMA_VERSION,
        taskId: candidate.taskId,
        shortTaskId: candidate.shortTaskId,
        runIdHash: keyedHash(account.clientSecret, candidate.originMessageId),
        parentSessionKeyHash: keyedHash(account.clientSecret, input.parentSessionKey || candidate.parentSessionKey),
        childRunHashes: [],
        completedChildRunHashes: [],
        childSessionKeyHashes: [keyedHash(account.clientSecret, input.childSessionKey)],
        sourceKinds: ["subagent_completion"],
        sourceAgent: candidate.sourceAgent,
        turnIdHash: keyedHash(account.clientSecret, candidate.runId ?? candidate.originMessageId),
        channel: "qqbot",
        accountHash: publicHash(candidate.accountId),
        targetType: candidate.targetType,
        conversationHash: keyedHash(account.clientSecret, candidate.target),
        requesterHash: keyedHash(account.clientSecret, candidate.requesterId),
        originMessageHash: keyedHash(account.clientSecret, candidate.originMessageId),
        originReceivedAt: candidate.receivedAt,
        createdAt: now,
        updatedAt: now,
        retentionUntil,
        status: "planning",
        progressPhase: "planning",
        workspaceRoot,
        generatedFiles: [],
        requestedDeliveryMode: candidate.requestedDeliveryMode,
        deliverables: [],
        deliverableCount: 0,
        deliveryState: "not_ready",
        deliveryAttempts: [],
        idempotencyKey: publicHash(`qqbot-task:${candidate.taskId}`),
        requiresReview: false,
        encryptedDelivery: encryptEnvelope(account.clientSecret, envelope),
      };
      this.indexTask(task);
      await this.persist(task);
      if (candidate.sendInitial) {
        try {
          await candidate.sendInitial(`任务 ${task.shortTaskId} 已接收，当前阶段：planning。完成后会自动回复原消息并发送文件。查询：任务状态 ${task.shortTaskId}`);
        } catch (error) {
          this.taskLog(candidate.accountId).warn?.(`[qqbot-task] initial reply failed task=${task.shortTaskId}: ${safeError(error)}`);
        }
      }
    } else {
      const childHash = keyedHash(account.clientSecret, input.childSessionKey);
      if (!task.childSessionKeyHashes.includes(childHash)) task.childSessionKeyHashes.push(childHash);
      task.sourceKinds ??= [];
      const firstSubagentBinding = !task.sourceKinds.includes("subagent_completion");
      if (firstSubagentBinding) task.sourceKinds.push("subagent_completion");
      task.status = "planning";
      task.progressPhase = "planning";
      task.updatedAt = iso(this.now);
      await this.persist(task);
      if (firstSubagentBinding && candidate.sendInitial) {
        try {
          await candidate.sendInitial(`浠诲姟 ${task.shortTaskId} 宸叉帴鏀讹紝褰撳墠闃舵锛歱lanning銆傚畬鎴愬悗浼氳嚜鍔ㄥ洖澶嶅師娑堟伅骞跺彂閫佹枃浠躲€傛煡璇細浠诲姟鐘舵€?${task.shortTaskId}`);
        } catch (error) {
          this.taskLog(candidate.accountId).warn?.(`[qqbot-task] initial reply failed task=${task.shortTaskId}: ${safeError(error)}`);
        }
      }
    }
    return {
      taskId: task.taskId,
      workspaceRoot: task.workspaceRoot,
      systemPromptSuffix: [
        `[QQ Agent Task ${task.shortTaskId}] Work only inside the assigned task workspace.`,
        "Treat inputs/ as the only authorized imported files.",
        "Write all generated source and documentation into this workspace using relative paths.",
        "Do not read or copy files from the parent workspace or other host directories.",
        "Do not include credentials, runtime databases, caches, logs, backups, or absolute host paths in deliverables.",
      ].join("\n"),
    };
  }

  async confirmSubagentRun(input: { taskId?: string; childRunId: string; childSessionKey: string }): Promise<void> {
    if (!input.taskId) return;
    const task = this.tasksById.get(input.taskId);
    if (!task) return;
    const account = this.accountForTask(task);
    if (!account) return;
    const childRunHash = keyedHash(account.clientSecret, input.childRunId);
    const childSessionHash = keyedHash(account.clientSecret, input.childSessionKey);
    if (!task.childRunHashes.includes(childRunHash)) task.childRunHashes.push(childRunHash);
    if (!task.childSessionKeyHashes.includes(childSessionHash)) task.childSessionKeyHashes.push(childSessionHash);
    task.status = "generating";
    task.progressPhase = "generating";
    task.updatedAt = iso(this.now);
    this.taskIdByChildHash.set(childRunHash, task.taskId);
    await this.persist(task);
  }

  async prepareCompletion(input: {
    childRunId: string;
    channel?: string;
    accountId?: string;
    target?: string;
    resultText?: string;
    status?: string;
    payloads?: Array<Record<string, unknown>>;
  }): Promise<PreparedCompletion> {
    const located = this.findByChildRun(input.childRunId);
    if (!located) return { handled: false, suppressDelivery: false };
    const { task, account } = located;
    const childHash = keyedHash(account.clientSecret, input.childRunId);
    if (!task.completedChildRunHashes.includes(childHash)) task.completedChildRunHashes.push(childHash);
    task.updatedAt = iso(this.now);
    task.completedAt = task.completedAt ?? task.updatedAt;
    await this.saveResult(task, input.resultText ?? "");

    if (task.childRunHashes.some((hash) => !task.completedChildRunHashes.includes(hash))) {
      task.status = "generating";
      task.progressPhase = "generating";
      await this.persist(task);
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "child_runs_pending" };
    }
    if (task.deliveryState === "delivered" || task.idempotencyConsumedAt) {
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "already_delivered" };
    }
    if (task.deliveryState === "delivering") {
      await this.markPending(task, "delivery_state_uncertain_after_retry");
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "delivery_state_uncertain" };
    }
    if (task.deliveryState === "pending_delivery" && task.deliveryAttempts.some((attempt) => attempt.state === "failed")) {
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "awaiting_new_inbound_context" };
    }

    let envelope: DeliveryEnvelope;
    try {
      envelope = decryptEnvelope(account.clientSecret, task.encryptedDelivery);
    } catch (error) {
      await this.requireReview(task, `delivery_context_decrypt_failed:${safeError(error)}`);
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "invalid_delivery_context" };
    }
    const contextValid = input.channel === "qqbot"
      && (!input.accountId || input.accountId === envelope.accountId)
      && (!input.target || input.target === envelope.target)
      && envelope.originMessageId.trim() !== "";
    if (!contextValid) {
      task.status = "pending_delivery";
      task.progressPhase = "pending_delivery";
      task.deliveryState = "pending_delivery";
      task.lastError = "completion_reply_context_validation_failed";
      await this.persist(task);
      return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: "context_validation_failed" };
    }

    if (!task.deliveryMode) {
      const packaged = await this.packageTask(task);
      if (!packaged.ok) {
        if (packaged.requiresReview) await this.requireReview(task, packaged.error);
        else await this.markPending(task, packaged.error);
        return { handled: true, suppressDelivery: true, taskId: task.taskId, reason: packaged.error };
      }
    }

    const pendingDeliverables = task.deliverables.filter((entry) => entry.deliveryState !== "delivered");
    for (const deliverable of pendingDeliverables) {
      deliverable.deliveryState = "delivering";
      deliverable.deliveryAttemptCount += 1;
    }
    task.status = "delivering";
    task.progressPhase = "delivering";
    task.deliveryState = "delivering";
    task.deliveryAttempts.push({
      at: iso(this.now),
      state: "started",
      replyContextHash: keyedHash(account.clientSecret, envelope.originMessageId),
    });
    task.deliveryAttempts = task.deliveryAttempts.slice(-20);
    await this.persist(task);

    const payloads = this.deliveryPayloads(task, pendingDeliverables);
    return {
      handled: true,
      suppressDelivery: false,
      taskId: task.taskId,
      idempotencyKey: task.idempotencyKey,
      replyToId: envelope.originMessageId,
      payloads,
    };
  }

  async markDelivery(input: { taskId?: string; idempotencyKey?: string; ok: boolean; error?: string }): Promise<void> {
    if (!input.taskId) return;
    const task = this.tasksById.get(input.taskId);
    if (!task || input.idempotencyKey !== task.idempotencyKey) return;
    const account = this.accountForTask(task);
    if (!account) return;
    if (input.ok) {
      for (const deliverable of task.deliverables) {
        if (deliverable.deliveryState !== "delivered") deliverable.deliveryState = "delivered";
        deliverable.uploadState = "uploaded";
        deliverable.messageState = "sent";
        deliverable.lastError = undefined;
      }
      task.status = "delivered";
      task.progressPhase = "delivered";
      task.deliveryState = "delivered";
      task.idempotencyConsumedAt = iso(this.now);
      task.lastError = undefined;
      task.deliveryAttempts.push({ at: iso(this.now), state: "sent", replyContextHash: task.originMessageHash });
    } else {
      for (const deliverable of task.deliverables) {
        if (deliverable.deliveryState === "delivering") {
          deliverable.deliveryState = "failed";
          deliverable.uploadState = deliverable.uploadState === "uploaded" ? "uploaded" : "failed";
          deliverable.messageState = "failed";
          deliverable.lastError = safeError(input.error ?? "delivery_failed");
        }
      }
      task.status = "pending_delivery";
      task.progressPhase = "pending_delivery";
      task.deliveryState = "pending_delivery";
      task.lastError = safeError(input.error ?? "delivery_failed");
      task.deliveryAttempts.push({ at: iso(this.now), state: "failed", replyContextHash: task.originMessageHash, error: task.lastError });
    }
    task.deliveryAttempts = task.deliveryAttempts.slice(-20);
    task.updatedAt = iso(this.now);
    await this.persist(task);
  }

  async markDeliverable(input: {
    taskId?: string;
    idempotencyKey?: string;
    mediaUrl?: string;
    ok: boolean;
    error?: string;
    platformReceipt?: string;
  }): Promise<void> {
    if (!input.taskId || !input.mediaUrl) return;
    const task = this.tasksById.get(input.taskId);
    if (!task || input.idempotencyKey !== task.idempotencyKey) return;
    const normalizedMedia = path.resolve(input.mediaUrl);
    const deliverable = task.deliverables.find((entry) => path.resolve(this.deliverablePath(task, entry)) === normalizedMedia);
    if (!deliverable || deliverable.deliveryState === "delivered") return;
    deliverable.deliveryState = input.ok ? "delivered" : "failed";
    deliverable.uploadState = input.ok ? "uploaded" : "failed";
    deliverable.messageState = input.ok ? "sent" : "failed";
    deliverable.lastError = input.ok ? undefined : safeError(input.error ?? "deliverable_delivery_failed");
    if (input.ok && input.platformReceipt) deliverable.platformReceiptHash = publicHash(input.platformReceipt);
    if (!input.ok) task.lastError = deliverable.lastError;
    task.updatedAt = iso(this.now);
    await this.persist(task);
  }

  parseStatusQuery(text: string): { kind: "by_id" | "running" | "pending"; shortTaskId?: string } | null {
    const normalized = text.trim().replace(/^@[^\s]+\s*/, "");
    const byId = normalized.match(/^(?:任务状态|查看任务)(?:\s+([A-Za-z0-9-]{6,64}))?\s*$/i);
    if (byId) return { kind: "by_id", shortTaskId: byId[1]?.replace(/-/g, "").toUpperCase() };
    if (/^我的运行中任务\s*$/.test(normalized)) return { kind: "running" };
    if (/^我的待交付任务\s*$/.test(normalized)) return { kind: "pending" };
    return null;
  }

  async queryStatus(input: { accountId: string; target: string; requesterId: string; shortTaskId?: string }): Promise<PersistedTaskContext | undefined> {
    const account = this.accounts.get(input.accountId);
    if (!account) return undefined;
    await this.loadAccount(input.accountId);
    const conversationHash = keyedHash(account.clientSecret, input.target);
    const requesterHash = keyedHash(account.clientSecret, input.requesterId);
    const candidates = [...this.tasksById.values()].filter((task) =>
      task.accountHash === publicHash(input.accountId)
      && task.conversationHash === conversationHash
      && task.requesterHash === requesterHash
      && (!input.shortTaskId || task.shortTaskId === input.shortTaskId),
    );
    return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  async queryStatuses(input: {
    accountId: string;
    target: string;
    requesterId: string;
    kind: "running" | "pending";
  }): Promise<PersistedTaskContext[]> {
    const account = this.accounts.get(input.accountId);
    if (!account) return [];
    await this.loadAccount(input.accountId);
    const conversationHash = keyedHash(account.clientSecret, input.target);
    const requesterHash = keyedHash(account.clientSecret, input.requesterId);
    const running = new Set<TaskPhase>(["received", "document_parsed", "planning", "generating", "validating", "packaging", "delivering"]);
    return [...this.tasksById.values()]
      .filter((task) => task.accountHash === publicHash(input.accountId)
        && task.conversationHash === conversationHash
        && task.requesterHash === requesterHash
        && (input.kind === "running" ? running.has(task.status) : task.deliveryState === "pending_delivery"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);
  }

  formatStatus(task: PersistedTaskContext): string {
    const progress = task.progressCurrent != null && task.progressTotal != null && task.progressTotal > 0
      ? `（${task.progressCurrent}/${task.progressTotal}）`
      : "";
    const delivery = task.deliveryState === "delivered" ? "文件已投递"
      : task.deliveryState === "pending_delivery" ? "结果已保留，等待新的合法入站上下文投递"
      : task.deliveryState === "requires_review" ? "需要安全复核，未自动投递"
      : "尚未完成投递";
    const deliveredCount = task.deliverables.filter((entry) => entry.deliveryState === "delivered").length;
    const pendingCount = Math.max(0, task.deliverableCount - deliveredCount);
    return [
      `任务 ${task.shortTaskId}`,
      `状态：${task.status}`,
      `阶段：${task.progressPhase}${progress}`,
      `交付模式：${task.deliveryMode ?? "尚未选择"}`,
      `文件：${task.deliverableCount}；已成功：${deliveredCount}；待交付：${pendingCount}`,
      `需要复核：${task.requiresReview ? "是" : "否"}`,
      delivery,
    ].join("\n");
  }

  private deliverablePath(task: PersistedTaskContext, deliverable: TaskDeliverable): string {
    if (deliverable.artifactPath) {
      const artifact = path.resolve(deliverable.artifactPath);
      const deliveryRoot = task.deliveryWorkspaceRoot ? path.resolve(task.deliveryWorkspaceRoot) : undefined;
      if (!isInside(this.artifactRoot, artifact) && !(deliveryRoot && isInside(deliveryRoot, artifact))) {
        throw new Error("artifact_path_outside_root");
      }
      return artifact;
    }
    const candidate = path.resolve(task.workspaceRoot, deliverable.relativePath);
    if (!isInside(task.workspaceRoot, candidate)) throw new Error("deliverable_path_outside_workspace");
    return candidate;
  }

  private deliveryPayloads(task: PersistedTaskContext, deliverables: TaskDeliverable[]): Array<Record<string, unknown>> {
    const summary = this.adaptiveCompletionSummary(task);
    if (task.deliveryMode === "text_only") return [{ text: summary }];
    if (task.deliveryMode === "multiple_files") {
      const list = deliverables.map((entry, index) => `${index + 1}. ${entry.logicalName} (${entry.size} bytes)`).join("\n");
      return [
        { text: `待发送文件：\n${list}` },
        ...deliverables.map((entry) => ({ text: "", mediaUrl: this.deliverablePath(task, entry), mediaType: entry.mimeType })),
      ];
    }
    const deliverable = deliverables[0];
    return deliverable
      ? [{ text: summary, mediaUrl: this.deliverablePath(task, deliverable), mediaType: deliverable.mimeType }]
      : [{ text: summary }];
  }

  async deliverPendingWithInbound(input: {
    task: PersistedTaskContext;
    accountId: string;
    target: string;
    requesterId: string;
    replyToId: string;
    sendText: (text: string) => Promise<void>;
    sendFile: (filePath: string) => Promise<{ error?: string }>;
  }): Promise<boolean> {
    const task = input.task;
    const account = this.accounts.get(input.accountId);
    if (!account || task.deliveryState !== "pending_delivery" || !task.deliveryMode || task.idempotencyConsumedAt) return false;
    if (task.conversationHash !== keyedHash(account.clientSecret, input.target) || task.requesterHash !== keyedHash(account.clientSecret, input.requesterId)) return false;
    task.status = "delivering";
    task.progressPhase = "delivering";
    task.deliveryState = "delivering";
    task.deliveryAttempts.push({ at: iso(this.now), state: "started", replyContextHash: keyedHash(account.clientSecret, input.replyToId) });
    await this.persist(task);
    try {
      const pending = task.deliverables.filter((entry) => entry.deliveryState !== "delivered");
      if (task.deliveryMode === "multiple_files" && pending.length > 0) {
        await input.sendText(`待发送文件：\n${pending.map((entry, index) => `${index + 1}. ${entry.logicalName} (${entry.size} bytes)`).join("\n")}`);
      }
      for (const deliverable of pending) {
        deliverable.deliveryState = "delivering";
        deliverable.deliveryAttemptCount += 1;
        await this.persist(task);
        const filePath = this.deliverablePath(task, deliverable);
        const result = await input.sendFile(filePath);
        if (result.error) {
          await this.markDeliverable({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, mediaUrl: filePath, ok: false, error: result.error });
          throw new Error(result.error);
        }
        await this.markDeliverable({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, mediaUrl: filePath, ok: true });
      }
      await this.markDelivery({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, ok: true });
      await input.sendText(this.adaptiveCompletionSummary(task));
      return true;
    } catch (error) {
      await this.markDelivery({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, ok: false, error: safeError(error) });
      return false;
    }
  }

  getTaskForTest(taskId: string): PersistedTaskContext | undefined {
    return this.tasksById.get(taskId);
  }

  private async ensureDirectTask(
    candidate: CandidateRuntime,
    sourceKind?: Exclude<DeliverableSourceKind, "subagent_completion">,
    sourceAgent?: string,
  ): Promise<PersistedTaskContext> {
    const account = this.accounts.get(candidate.accountId);
    if (!account) throw new Error("account_not_configured");
    const existing = this.findByOrigin(account.clientSecret, candidate.originMessageId);
    if (existing) return existing;
    const now = iso(this.now);
    const agentWorkspaceRoot = candidate.sourceWorkspaceRoot ? path.resolve(candidate.sourceWorkspaceRoot) : path.join(this.stateRoot, "workspaces", candidate.taskId);
    const directWorkspace = candidate.sourceWorkspaceRoot ? await ensureTaskDeliveryWorkspace(agentWorkspaceRoot, candidate.taskId) : undefined;
    const workspaceRoot = directWorkspace?.stagingRoot ?? agentWorkspaceRoot;
    await fsp.mkdir(path.join(workspaceRoot, "inputs"), { recursive: true });
    await this.copyInputs(candidate.inputFiles ?? [], workspaceRoot);
    const task: PersistedTaskContext = {
      schemaVersion: SCHEMA_VERSION,
      taskId: candidate.taskId,
      shortTaskId: candidate.shortTaskId,
      runIdHash: keyedHash(account.clientSecret, candidate.runId ?? candidate.originMessageId),
      parentSessionKeyHash: keyedHash(account.clientSecret, candidate.parentSessionKey),
      childRunHashes: [],
      completedChildRunHashes: [],
      childSessionKeyHashes: [],
      sourceKinds: sourceKind ? [sourceKind] : [],
      sourceAgent: sourceAgent ?? candidate.sourceAgent,
      turnIdHash: keyedHash(account.clientSecret, candidate.runId ?? candidate.originMessageId),
      collectorState: "collecting",
      collectedCandidates: [],
      channel: "qqbot",
      accountHash: publicHash(candidate.accountId),
      targetType: candidate.targetType,
      conversationHash: keyedHash(account.clientSecret, candidate.target),
      requesterHash: keyedHash(account.clientSecret, candidate.requesterId),
      originMessageHash: keyedHash(account.clientSecret, candidate.originMessageId),
      originReceivedAt: candidate.receivedAt,
      createdAt: now,
      updatedAt: now,
      retentionUntil: new Date(this.now().getTime() + this.retentionDays * 24 * 60 * 60 * 1000).toISOString(),
      status: "registered",
      progressPhase: "registered",
      workspaceRoot,
      stagingRoot: directWorkspace?.stagingRoot,
      deliveryWorkspaceRoot: directWorkspace?.deliveryRoot,
      generatedFiles: [],
      requestedDeliveryMode: candidate.requestedDeliveryMode,
      deliverables: [],
      deliverableCount: 0,
      deliveryState: "not_ready",
      deliveryAttempts: [],
      idempotencyKey: publicHash(`qqbot-task:${candidate.taskId}`),
      requiresReview: false,
      encryptedDelivery: encryptEnvelope(account.clientSecret, {
        channel: "qqbot",
        accountId: candidate.accountId,
        targetType: candidate.targetType,
        target: candidate.target,
        requesterId: candidate.requesterId,
        originMessageId: candidate.originMessageId,
        receivedAt: candidate.receivedAt,
      }),
    };
    this.indexTask(task);
    await this.persist(task);
    return task;
  }

  private taskLog(accountId: string): TaskLog {
    return this.accounts.get(accountId)?.log ?? this.log ?? {};
  }

  private accountForTask(task: PersistedTaskContext): AccountRuntime | undefined {
    for (const [accountId, account] of this.accounts) if (publicHash(accountId) === task.accountHash) return account;
    return undefined;
  }

  private findByOrigin(secret: string, originMessageId: string): PersistedTaskContext | undefined {
    return this.tasksById.get(this.taskIdByRunHash.get(keyedHash(secret, originMessageId)) ?? "");
  }

  private findByChildRun(childRunId: string): { task: PersistedTaskContext; account: AccountRuntime } | undefined {
    for (const account of this.accounts.values()) {
      const taskId = this.taskIdByChildHash.get(keyedHash(account.clientSecret, childRunId));
      if (taskId) {
        const task = this.tasksById.get(taskId);
        if (task) return { task, account };
      }
    }
    return undefined;
  }

  private indexTask(task: PersistedTaskContext): void {
    this.tasksById.set(task.taskId, task);
    this.taskIdByRunHash.set(task.runIdHash, task.taskId);
    for (const childHash of task.childRunHashes) this.taskIdByChildHash.set(childHash, task.taskId);
  }

  private async loadAccount(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account || account.loaded) return;
    account.loaded = true;
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(this.stateRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const statePath = path.join(this.stateRoot, entry.name);
        const parsed = JSON.parse(await fsp.readFile(statePath, "utf8")) as PersistedTaskContext;
        if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.accountHash !== publicHash(accountId)) continue;
        decryptEnvelope(account.clientSecret, parsed.encryptedDelivery);
        this.indexTask(parsed);
      } catch (error) {
        await this.recoverCorruptStateFile(accountId, path.join(this.stateRoot, entry.name), entry.name, error);
      }
    }
  }

  private async persist(task: PersistedTaskContext): Promise<void> {
    task.updatedAt = iso(this.now);
    const destination = path.join(this.stateRoot, `${task.taskId}.json`);
    const temp = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    let serialized: string;
    try {
      serialized = safeStateStringify(task);
    } catch (error) {
      await this.writeStateFailureRecord(task, destination, error);
      throw error;
    }
    const operation = this.writeChain.then(async () => {
      await fsp.mkdir(this.stateRoot, { recursive: true });
      try {
        await writeUtf8FileSynced(temp, serialized);
        await fsp.rename(temp, destination);
        await fsyncDirectoryBestEffort(this.stateRoot);
      } catch (error) {
        try { await fsp.unlink(temp); } catch {}
        await this.writeStateFailureRecord(task, destination, error);
        throw error;
      }
    });
    this.writeChain = operation.catch(() => {});
    await operation;
  }

  private async writeStateFailureRecord(task: PersistedTaskContext, destination: string, error: unknown): Promise<void> {
    try {
      await fsp.mkdir(this.stateRoot, { recursive: true });
      const record = safeStateStringify({
        at: iso(this.now),
        kind: "state.write-failed",
        taskId: task.taskId,
        shortTaskId: task.shortTaskId,
        destinationHash: publicHash(destination).slice(0, 16),
        error: error instanceof Error ? stateSafeErrorObject(error) : sanitizeStateString(String(error)),
      });
      await fsp.appendFile(path.join(this.stateRoot, "state.write-failed.jsonl"), `${record.replace(/\r?\n/g, "")}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (recordError) {
      this.taskLog(task.accountHash).warn?.(`[qqbot-task] failed to record state.write-failed task=${task.shortTaskId} error=${safeError(recordError)}`);
    }
  }

  private async recoverCorruptStateFile(accountId: string, statePath: string, fileName: string, error: unknown): Promise<void> {
    const hash = publicHash(fileName).slice(0, 12);
    try {
      const corruptDir = path.join(this.stateRoot, "corrupt-state");
      await fsp.mkdir(corruptDir, { recursive: true });
      const copyName = `${path.basename(fileName)}.${hash}.${Date.now()}.corrupt`;
      await fsp.copyFile(statePath, path.join(corruptDir, copyName), fs.constants.COPYFILE_EXCL);
    } catch (copyError) {
      this.taskLog(accountId).warn?.(`[qqbot-task] corrupt state copy failed hash=${hash} error=${safeError(copyError)}`);
    }
    try {
      const record = safeStateStringify({
        at: iso(this.now),
        kind: "state.corrupt",
        fileHash: hash,
        error: error instanceof Error ? stateSafeErrorObject(error) : sanitizeStateString(String(error)),
      });
      await fsp.appendFile(path.join(this.stateRoot, "state.corrupt.jsonl"), `${record.replace(/\r?\n/g, "")}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {}
    this.taskLog(accountId).warn?.(`[qqbot-task] skipped corrupt state file hash=${hash} recovered=true error=${safeError(error)}`);
  }

  private async copyInputs(files: string[], workspaceRoot: string): Promise<void> {
    const inputsRoot = path.join(workspaceRoot, "inputs");
    const used = new Set<string>();
    for (const source of files) {
      try {
        const stat = await fsp.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_FILE_BYTES) continue;
        let base = path.basename(source).replace(/[^A-Za-z0-9._()\-\u4e00-\u9fff]/g, "_") || "input.bin";
        let index = 1;
        while (used.has(base.toLowerCase())) base = `${path.parse(base).name}-${index++}${path.extname(base)}`;
        used.add(base.toLowerCase());
        await fsp.copyFile(source, path.join(inputsRoot, base), fs.constants.COPYFILE_EXCL);
      } catch {}
    }
  }

  private async saveResult(task: PersistedTaskContext, resultText: string): Promise<void> {
    const sanitized = resultText
      .replace(/[A-Za-z]:\\[^\s"']+/g, "[local-path]")
      .replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+\/[^\s"']+/g, "[local-path]");
    if (Buffer.byteLength(sanitized, "utf8") <= RESULT_TEXT_LIMIT) {
      task.resultText = sanitized;
      task.resultRef = undefined;
      return;
    }
    const resultDir = path.join(this.stateRoot, "results");
    await fsp.mkdir(resultDir, { recursive: true });
    const resultPath = path.join(resultDir, `${task.taskId}.txt`);
    await fsp.writeFile(resultPath, sanitized, { encoding: "utf8", mode: 0o600 });
    task.resultText = sanitized.slice(0, RESULT_TEXT_LIMIT);
    task.resultRef = resultPath;
  }

  private async packageTask(task: PersistedTaskContext): Promise<{ ok: true } | { ok: false; error: string; requiresReview: boolean }> {
    task.status = "packaging";
    task.progressPhase = "packaging";
    await this.persist(task);
    try {
      const rootStat = await fsp.lstat(task.workspaceRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("workspace_root_invalid");
      const entries: ArchiveEntry[] = [];
      const generatedFiles: PersistedTaskContext["generatedFiles"] = [];
      let totalBytes = 0;
      const visit = async (directory: string): Promise<void> => {
        const children = await fsp.readdir(directory, { withFileTypes: true });
        for (const child of children) {
          const absolute = path.join(directory, child.name);
          if (!isInside(task.workspaceRoot, absolute)) throw new Error("path_traversal_detected");
          const relative = normalizeArchivePath(path.relative(task.workspaceRoot, absolute));
          const stat = await fsp.lstat(absolute);
          if (stat.isSymbolicLink()) throw new Error("reparse_point_detected");
          if (shouldExclude(relative, stat.isDirectory())) continue;
          if (stat.isDirectory()) { await visit(absolute); continue; }
          if (!stat.isFile()) throw new Error("unknown_file_type");
          if (stat.size > MAX_DELIVERABLE_BYTES) throw new Error("deliverable_size_limit_exceeded");
          const ext = path.extname(child.name).toLowerCase();
          if (!looksText(relative) && !SAFE_BINARY_EXTENSIONS.has(ext)) throw new Error(`unknown_binary:${relative}`);
          const data = await fsp.readFile(absolute);
          const inspectableText = data.toString("utf8");
          const secret = scanTextForSecrets(inspectableText);
          if (secret) throw new Error(`suspected_secret:${secret}:${relative}`);
          if (containsHostAbsolutePath(inspectableText)) throw new Error(`host_absolute_path:${relative}`);
          totalBytes += data.length;
          const sha256 = crypto.createHash("sha256").update(data).digest("hex");
          entries.push({ name: relative, data, size: data.length, sha256, sourcePath: absolute });
          generatedFiles.push({ path: relative, size: data.length, sha256 });
        }
      };
      await visit(task.workspaceRoot);
      if (entries.length === 0) {
        if (!(task.resultText ?? "").trim()) throw new Error("workspace_has_no_deliverable_files");
        task.generatedFiles = [];
        task.deliveryMode = "text_only";
        task.deliverables = [];
        task.deliverableCount = 0;
        task.status = "completed";
        task.progressPhase = "completed";
        task.deliveryState = "pending_delivery";
        task.requiresReview = false;
        task.lastError = undefined;
        await this.persist(task);
        return { ok: true };
      }

      const projectLayout = isProjectLayout(entries) || hasStaticProjectRelationship(entries);
      const explicitArchive = task.requestedDeliveryMode === "archive";
      const shouldArchive = explicitArchive || projectLayout || entries.length > MAX_MULTIPLE_FILES || totalBytes > MAX_ARCHIVE_BYTES;
      let deliveryMode: DeliveryMode = entries.length === 1 ? "direct_file" : "multiple_files";
      if (shouldArchive) deliveryMode = "archive";
      if (deliveryMode === "multiple_files" && (entries.length > MAX_MULTIPLE_FILES || totalBytes > MAX_ARCHIVE_BYTES)) {
        deliveryMode = "archive";
      }

      const accountPart = task.accountHash.slice(0, 12);
      const conversationPart = task.conversationHash.slice(0, 12);
      const deliveryWorkspaceRoot = task.deliveryWorkspaceRoot ? path.resolve(task.deliveryWorkspaceRoot) : undefined;
      const artifactDir = deliveryWorkspaceRoot
        ? path.join(deliveryWorkspaceRoot, "archive")
        : path.join(this.artifactRoot, accountPart, conversationPart, task.taskId);
      const manifestDir = deliveryWorkspaceRoot ? path.join(deliveryWorkspaceRoot, "manifest") : artifactDir;
      await fsp.mkdir(artifactDir, { recursive: true });
      await fsp.mkdir(manifestDir, { recursive: true });
      let deliverables: TaskDeliverable[];
      let readmeIncluded = entries.some((entry) => path.basename(entry.name).toLowerCase() === "readme.md");
      if (deliveryMode === "archive") {
        if (projectLayout && !readmeIncluded) {
          const data = Buffer.from(minimalReadme(task.shortTaskId), "utf8");
          const sha256 = crypto.createHash("sha256").update(data).digest("hex");
          entries.push({ name: "README.md", data, size: data.length, sha256 });
          generatedFiles.push({ path: "README.md", size: data.length, sha256 });
          totalBytes += data.length;
          readmeIncluded = true;
        } else if (projectLayout && readmeIncluded) {
          const readmeEntry = entries.find((entry) => path.basename(entry.name).toLowerCase() === "readme.md");
          if (readmeEntry) {
            const data = Buffer.from(ensureReadmeSections(readmeEntry.data.toString("utf8")), "utf8");
            if (!data.equals(readmeEntry.data)) {
              totalBytes += data.length - readmeEntry.data.length;
              readmeEntry.data = data;
              readmeEntry.size = data.length;
              readmeEntry.sha256 = crypto.createHash("sha256").update(data).digest("hex");
              const generated = generatedFiles.find((entry) => entry.path === readmeEntry.name);
              if (generated) { generated.size = readmeEntry.size; generated.sha256 = readmeEntry.sha256; }
            }
          }
        }
        const hasDependencyDeclaration = entries.some((entry) => /(^|\/)(?:package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|cmakelists\.txt|[^/]+\.csproj)$/i.test(entry.name));
        if (projectLayout && !hasDependencyDeclaration) {
          const data = Buffer.from("# Dependencies\n\nNo package-manager dependency declaration was generated. Review the source and add one if external packages are required.\n", "utf8");
          const sha256 = crypto.createHash("sha256").update(data).digest("hex");
          entries.push({ name: "DEPENDENCIES.md", data, size: data.length, sha256 });
          generatedFiles.push({ path: "DEPENDENCIES.md", size: data.length, sha256 });
          totalBytes += data.length;
        }
        if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error("archive_size_limit_exceeded");
        const contentManifest = {
          schemaVersion: SCHEMA_VERSION,
          taskId: task.taskId,
          shortTaskId: task.shortTaskId,
          createdAt: iso(this.now),
          fileCount: generatedFiles.length,
          totalBytes,
          files: generatedFiles,
        };
        const contentManifestData = Buffer.from(JSON.stringify(contentManifest, null, 2), "utf8");
        entries.push({ name: "DELIVERY-MANIFEST.json", data: contentManifestData, size: contentManifestData.length, sha256: crypto.createHash("sha256").update(contentManifestData).digest("hex") });
        const zipPath = path.join(artifactDir, `task-${task.shortTaskId}.zip`);
        if (totalBytes + contentManifestData.length > MAX_ARCHIVE_BYTES) throw new Error("archive_size_limit_exceeded");
        await writeStoredZip(zipPath, entries, this.now());
        const zipStat = await fsp.stat(zipPath);
        if (zipStat.size > MAX_ARCHIVE_BYTES) { await fsp.unlink(zipPath); throw new Error("archive_size_limit_exceeded"); }
        const zipSha = crypto.createHash("sha256").update(await fsp.readFile(zipPath)).digest("hex");
        task.artifactZip = zipPath;
        task.artifactSha256 = zipSha;
        task.artifactSize = zipStat.size;
        deliverables = [{
          logicalName: path.basename(zipPath), relativePath: path.basename(zipPath), mimeType: "application/zip",
          size: zipStat.size, sha256: zipSha, deliveryState: "pending", deliveryAttemptCount: 0, artifactPath: zipPath,
          uploadState: "pending", messageState: "pending",
        }];
      } else {
        task.artifactZip = undefined;
        task.artifactSha256 = entries.length === 1 ? entries[0].sha256 : undefined;
        task.artifactSize = entries.length === 1 ? entries[0].size : undefined;
        deliverables = entries.map((entry) => ({
          logicalName: path.basename(entry.name), relativePath: entry.name, mimeType: mimeTypeFor(entry.name),
          size: entry.size, sha256: entry.sha256, deliveryState: "pending", deliveryAttemptCount: 0,
          uploadState: "pending" as const, messageState: "pending" as const,
        }));
      }

      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        taskId: task.taskId,
        shortTaskId: task.shortTaskId,
        createdAt: iso(this.now),
        deliveryMode,
        deliverableCount: deliverables.length,
        deliverables: deliverables.map(({ artifactPath: _artifactPath, ...entry }) => entry),
        sourceFiles: generatedFiles,
      };
      const manifestData = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
      const manifestPath = path.join(manifestDir, `task-${task.shortTaskId}-manifest.json`);
      const reportPath = path.join(manifestDir, `task-${task.shortTaskId}-report.md`);
      await fsp.writeFile(manifestPath, manifestData);
      await fsp.writeFile(reportPath, [
        `# Task ${task.shortTaskId} delivery report`, "",
        `- Delivery mode: ${deliveryMode}`,
        `- Deliverables: ${deliverables.length}`,
        `- Source files: ${generatedFiles.length}`,
        `- README.md: ${readmeIncluded ? "included" : "not required"}`,
        "- Secrets and host absolute paths: scanned",
        "",
      ].join("\n"), "utf8");
      task.generatedFiles = generatedFiles;
      task.artifactManifest = manifestPath;
      task.artifactReport = reportPath;
      task.deliveryMode = deliveryMode;
      task.deliverables = deliverables;
      task.deliverableCount = deliverables.length;
      task.status = "completed";
      task.progressPhase = "completed";
      task.deliveryState = "pending_delivery";
      task.requiresReview = false;
      task.lastError = undefined;
      await this.persist(task);
      return { ok: true };
    } catch (error) {
      const message = safeError(error);
      const requiresReview = /secret|absolute_path|reparse|traversal|unknown_binary|unknown_file_type|size_limit/i.test(message);
      if (requiresReview) {
        task.deliveryMode = "requires_review";
        task.deliverables = task.deliverables.map((entry) => ({ ...entry, deliveryState: "requires_review" }));
        task.deliverableCount = task.deliverables.length;
      }
      return { ok: false, error: message, requiresReview };
    }
  }

  private adaptiveCompletionSummary(task: PersistedTaskContext): string {
    const result = (task.resultText ?? "Task completed.").replace(/\s+/g, " ").slice(0, 240);
    const mode = task.deliveryMode ?? "requires_review";
    const delivered = task.deliverables.filter((entry) => entry.deliveryState === "delivered").length;
    const details = mode === "text_only"
      ? "Text result is included in this passive reply."
      : `Delivery mode: ${mode}; files: ${task.deliverableCount}; already delivered: ${delivered}.`;
    return [`Task ${task.shortTaskId} completed.`, `Result: ${result}`, details].join("\n");
  }

  private completionSummary(task: PersistedTaskContext): string {
    const result = (task.resultText ?? "任务已完成").replace(/\s+/g, " ").slice(0, 240);
    const sha = task.artifactSha256?.slice(0, 12) ?? "unavailable";
    return [
      `任务 ${task.shortTaskId} 已完成。`,
      `结果：${result}`,
      `文件数：${task.generatedFiles.length}；ZIP：${task.artifactSize ?? 0} bytes；SHA256：${sha}…`,
      "ZIP 已附上，README.md 包含运行说明。",
    ].join("\n");
  }

  private async markPending(task: PersistedTaskContext, error: string): Promise<void> {
    task.status = "pending_delivery";
    task.progressPhase = "pending_delivery";
    task.deliveryState = "pending_delivery";
    task.lastError = safeError(error);
    await this.persist(task);
  }

  private async requireReview(task: PersistedTaskContext, error: string): Promise<void> {
    task.status = "requires_review";
    task.progressPhase = "requires_review";
    task.deliveryState = "requires_review";
    task.requiresReview = true;
    task.lastError = safeError(error);
    await this.persist(task);
  }
}

const defaultService = new AgentTaskDeliveryService();

export async function configureAgentTaskDelivery(accountId: string, clientSecret: string, log?: TaskLog): Promise<void> {
  await defaultService.configureAccount(accountId, clientSecret, log);
}

export function registerAgentTaskInbound(candidate: InboundTaskCandidate): Promise<{ taskId: string; shortTaskId: string }> {
  return defaultService.registerInbound(candidate);
}

export function collectAgentTaskLocalFile(input: {
  taskId: string;
  originMessageId: string;
  turnId?: string;
  filePath: string;
  sourceKind: Exclude<DeliverableSourceKind, "subagent_completion">;
  workspaceRoot?: string;
  sourceAgent?: string;
}): Promise<DirectCollectResult> {
  return defaultService.collectDirectFile(input);
}

export function prepareAgentTaskDirectTurn(input: { taskId: string; originMessageId: string; turnId?: string; resultText?: string }): Promise<PreparedCompletion> {
  return defaultService.prepareDirectTurn(input);
}

export function failAgentTaskDirectTurn(originMessageId: string, error: string): Promise<void> {
  return defaultService.failDirectTurn(originMessageId, error);
}

export function markAgentTaskDeliverable(input: {
  taskId?: string;
  idempotencyKey?: string;
  mediaUrl?: string;
  ok: boolean;
  error?: string;
  platformReceipt?: string;
}): Promise<void> {
  return defaultService.markDeliverable(input);
}

export function markAgentTaskDelivery(input: { taskId?: string; idempotencyKey?: string; ok: boolean; error?: string }): Promise<void> {
  return defaultService.markDelivery(input);
}

export function formatAgentTaskCompletion(taskId: string): string | undefined {
  return defaultService.formatCompletionForTask(taskId);
}

export async function handleAgentTaskStatusQuery(input: {
  text: string;
  accountId: string;
  target: string;
  requesterId: string;
  replyToId: string;
  sendText: (text: string) => Promise<void>;
}): Promise<boolean> {
  const query = defaultService.parseStatusQuery(input.text);
  if (query === null) return false;
  if (query.kind === "running" || query.kind === "pending") {
    const tasks = await defaultService.queryStatuses({
      accountId: input.accountId,
      target: input.target,
      requesterId: input.requesterId,
      kind: query.kind,
    });
    if (tasks.length === 0) {
      await input.sendText(query.kind === "running" ? "没有可见的运行中任务。" : "没有可见的待交付任务。");
      return true;
    }
    await input.sendText(tasks.map((task) => defaultService.formatStatus(task)).join("\n\n"));
    return true;
  }
  const task = await defaultService.queryStatus({
    accountId: input.accountId,
    target: input.target,
    requesterId: input.requesterId,
    shortTaskId: query.shortTaskId,
  });
  if (!task) {
    await input.sendText(query.shortTaskId ? `未找到可见的任务 ${query.shortTaskId}。` : "未找到可见的任务。");
    return true;
  }
  await input.sendText(defaultService.formatStatus(task));
  return true;
}

const bridge: AgentTaskDeliveryBridge = {
  prepareSubagent: (input) => defaultService.prepareSubagent(input),
  confirmSubagentRun: (input) => defaultService.confirmSubagentRun(input),
  prepareCompletion: (input) => defaultService.prepareCompletion(input),
  markDelivery: (input) => defaultService.markDelivery(input),
  markDeliverable: (input) => defaultService.markDeliverable(input),
};

Object.defineProperty(globalThis, AGENT_TASK_DELIVERY_BRIDGE, {
  value: bridge,
  configurable: true,
  enumerable: false,
  writable: false,
});
