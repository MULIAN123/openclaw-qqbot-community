import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parseImageSize, type ImageSize } from "./utils/image-size.js";
import { requestPublicUrl } from "./utils/safe-remote-request.js";
import { noRedirectRequestInit, resolveCredentialServiceBaseUrl } from "./token-endpoint.js";

export const OCR_TOOL_NAME = "ocr.extract_text";
export const OCR_SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"] as const);
export type OcrMimeType = "image/jpeg" | "image/png" | "image/webp";

export type OcrErrorCode =
  | "ocr_environment_unavailable"
  | "ocr_model_unavailable"
  | "attachment_missing"
  | "unsupported_attachment"
  | "image_too_large"
  | "invalid_image"
  | "image_download_failed"
  | "ocr_request_invalid"
  | "ocr_auth_failed"
  | "ocr_rate_limited"
  | "ocr_timeout"
  | "ocr_provider_unavailable"
  | "ocr_response_invalid"
  | "ocr_output_truncated"
  | "ocr_no_text"
  | "delivery_failed";

export class OcrToolError extends Error {
  readonly code: OcrErrorCode;
  readonly status?: number;
  constructor(code: OcrErrorCode, message: string = code, status?: number) {
    super(message);
    this.name = "OcrToolError";
    this.code = code;
    this.status = status;
  }
}

export type OcrInput = {
  taskId: string;
  imagePath: string;
  mimeType: OcrMimeType;
  timeoutMs: number;
};

export type OcrResult = {
  provider: string;
  model: string;
  text: string;
  elapsedMs: number;
  finishReason: string | null;
  httpStatus?: number | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  warnings: string[];
};

export interface OcrProvider {
  readonly name: string;
  recognize(input: OcrInput): Promise<OcrResult>;
}

export type OcrAttachment = {
  content_type?: string;
  url?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
};

export type OcrMode = "plain_text" | "markdown" | "table";

export type OcrConfig = {
  provider: "siliconflow";
  apiKey?: string;
  model: string;
  mode: OcrMode;
  baseUrl: string;
  timeoutMs: number;
  maxImageBytes: number;
  maxOutputChars: number;
  maxPixels: number;
};

export type OcrTriggerDecision = {
  shouldHandle: boolean;
  intent: boolean;
  reason?: OcrErrorCode | "not_mentioned" | "not_ocr_intent";
};

export type PreparedOcrImage = {
  taskId: string;
  imagePath: string;
  mimeType: OcrMimeType;
  bytes: number;
  dimensions: ImageSize;
  source: "current_message_attachment";
};

export type OcrExecutionResult = OcrResult & {
  normalizedText: string;
  directReply: boolean;
};
export type OcrTelemetryEventName = "ocr_started" | "ocr_completed" | "ocr_failed";

export type OcrTelemetryEvent = {
  event: OcrTelemetryEventName;
  timestamp: string;
  taskId: string;
  shortTaskId: string;
  requestIdHash: string | null;
  sourceMessageHash: string | null;
  replyToHash: string | null;
  chatType: "private" | "group";
  sourceAgent: string;
  attachmentCount: number;
  provider: string;
  model: string;
  mode: OcrMode;
  httpStatus: number | null;
  finishReason: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  resultChars: number | null;
  directReply: boolean;
  ordinaryAgentSkipped: boolean;
  deliveryState: string | null;
  errorCode: OcrErrorCode | "delivery_failed" | null;
  elapsedMs: number | null;
};

export type OcrFetch = typeof fetch;

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-OCR";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODE: OcrMode = "plain_text";
const DEFAULT_MAX_IMAGE_MB = 10;
const DEFAULT_MAX_OUTPUT_CHARS = 6000;
const DEFAULT_MAX_PIXELS = 25_000_000;
const DIRECT_REPLY_MAX_CHARS = 1800;

const OCR_INTENT_RE = /\bocr\b|\u8bc6\u522b\u56fe\u7247|\u8bc6\u522b\u56fe\u7247\u6587\u5b57|\u63d0\u53d6\u56fe\u7247\u6587\u5b57|\u56fe\u7247\u8f6c\u6587\u5b57/i;

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function modeFromEnv(raw: string | undefined): OcrMode {
  return raw === "markdown" || raw === "table" || raw === "plain_text" ? raw : DEFAULT_MODE;
}

export function resolveOcrPrompt(model: string, mode: OcrMode = DEFAULT_MODE): string {
  if (model.trim().toLowerCase() === DEFAULT_MODEL.toLowerCase()) {
    if (mode === "markdown") return "<|grounding|>Convert the document to markdown.";
    if (mode === "table") return "<|grounding|>Extract all tables and convert to markdown format.";
    return "Free OCR.";
  }
  if (mode === "markdown") return "Convert the image text to markdown.";
  if (mode === "table") return "Extract tables from the image and convert them to markdown.";
  return "Extract the visible text from the image.";
}

export function resolveOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  return {
    provider: (env.QQBOT_OCR_PROVIDER === "siliconflow" || !env.QQBOT_OCR_PROVIDER) ? "siliconflow" : "siliconflow",
    apiKey: env.SILICONFLOW_API_KEY?.trim() || undefined,
    model: env.QQBOT_OCR_MODEL?.trim() || DEFAULT_MODEL,
    mode: modeFromEnv(env.QQBOT_OCR_MODE),
    baseUrl: (env.QQBOT_OCR_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: numberFromEnv("QQBOT_OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    maxImageBytes: numberFromEnv("QQBOT_OCR_MAX_IMAGE_MB", DEFAULT_MAX_IMAGE_MB) * 1024 * 1024,
    maxOutputChars: numberFromEnv("QQBOT_OCR_MAX_OUTPUT_CHARS", DEFAULT_MAX_OUTPUT_CHARS),
    maxPixels: numberFromEnv("QQBOT_OCR_MAX_PIXELS", DEFAULT_MAX_PIXELS),
  };
}

export function shouldHandleOcrRequest(input: {
  text?: string;
  attachments?: OcrAttachment[];
  chatType: "direct" | "group";
  wasMentioned?: boolean;
}): OcrTriggerDecision {
  const text = input.text ?? "";
  const intent = OCR_INTENT_RE.test(text);
  if (!intent) return { shouldHandle: false, intent, reason: "not_ocr_intent" };
  if (input.chatType === "group" && input.wasMentioned !== true) {
    return { shouldHandle: false, intent, reason: "not_mentioned" };
  }
  if (!input.attachments?.length) {
    return { shouldHandle: true, intent, reason: "attachment_missing" };
  }
  return { shouldHandle: true, intent };
}

export function selectSingleImageAttachment(attachments: OcrAttachment[] | undefined): OcrAttachment {
  const images = (attachments ?? []).filter((att) => (att.content_type ?? "").toLowerCase().startsWith("image/"));
  if (images.length === 0) throw new OcrToolError("attachment_missing");
  if (images.length !== 1) throw new OcrToolError("unsupported_attachment", "single_image_only");
  return images[0]!;
}

export function normalizeOcrText(text: string, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let value = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (value.length > maxOutputChars) {
    value = value.slice(0, maxOutputChars);
    warnings.push("ocr_output_truncated");
  }
  return { text: value, warnings };
}

export function shouldUseDirectOcrReply(text: string): boolean {
  return text.length <= DIRECT_REPLY_MAX_CHARS;
}

export function formatOcrDirectReply(text: string): string {
  return "OCR \u8bc6\u522b\u7ed3\u679c\uff1a\n" + text;
}

export function userFacingOcrError(error: unknown): string {
  const code = error instanceof OcrToolError ? error.code : "ocr_provider_unavailable";
  switch (code) {
    case "attachment_missing":
      return "\u8bf7\u5728\u540c\u4e00\u6761\u6d88\u606f\u4e2d\u9644\u4e0a\u4e00\u5f20\u56fe\u7247\uff0c\u5e76\u660e\u786e\u8bf4\u660e\u9700\u8981 OCR\u3002";
    case "unsupported_attachment":
      return "\u5f53\u524d OCR \u53ea\u652f\u6301\u5355\u5f20 JPEG\u3001PNG \u6216 WebP \u56fe\u7247\u3002";
    case "image_too_large":
      return "\u56fe\u7247\u8fc7\u5927\uff0c\u5f53\u524d OCR \u6700\u591a\u652f\u6301 10 MB\u3002";
    case "invalid_image":
      return "\u56fe\u7247\u683c\u5f0f\u6821\u9a8c\u5931\u8d25\uff0c\u8bf7\u6362\u4e00\u5f20 JPEG\u3001PNG \u6216 WebP \u56fe\u7247\u3002";
    case "ocr_environment_unavailable":
      return "OCR \u670d\u52a1\u5c1a\u672a\u914d\u7f6e\uff0c\u6682\u65f6\u65e0\u6cd5\u8bc6\u522b\u56fe\u7247\u3002";
    case "ocr_model_unavailable":
      return "\u5f53\u524d\u914d\u7f6e\u7684 OCR \u6a21\u578b\u4e0d\u53ef\u7528\u3002";
    case "ocr_no_text":
      return "\u672a\u8bc6\u522b\u5230\u6709\u6548\u6587\u5b57\u3002";
    default:
      return "OCR \u8bc6\u522b\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002";
  }
}

function inferMimeFromMagic(buffer: Buffer): OcrMimeType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function assertInsideWorkspace(workspaceRoot: string, filePath: string): Promise<void> {
  const root = await fsp.realpath(workspaceRoot);
  const target = await fsp.realpath(filePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new OcrToolError("invalid_image", "workspace_escape");
}

async function readLimitedResponse(response: IncomingMessage, maxBytes: number): Promise<Response> {
  const status = response.statusCode;
  if (!status || status < 200 || status > 599) {
    response.destroy();
    throw new Error("Invalid remote response status");
  }
  if (status >= 300 && status < 400) {
    response.destroy();
    return new Response(null, { status });
  }

  const contentLength = response.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > maxBytes) {
    response.destroy();
    throw new OcrToolError("image_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      response.destroy();
      throw new OcrToolError("image_too_large");
    }
    chunks.push(buffer);
  }
  return new Response(Buffer.concat(chunks), { status });
}

async function requestOcrImageResponse(input: {
  url: string;
  signal: AbortSignal;
  maxBytes: number;
  fetchImpl?: OcrFetch;
}): Promise<Response> {
  // Injected fetch is used by offline unit tests; production uses the DNS-pinned request helper.
  if (input.fetchImpl) {
    return input.fetchImpl(input.url, noRedirectRequestInit({
      signal: input.signal,
      headers: { "User-Agent": "OpenClaw-QQBot-OCR/1.0" },
    }));
  }
  const response = await requestPublicUrl(input.url, {
    signal: input.signal,
    headers: { "User-Agent": "OpenClaw-QQBot-OCR/1.0" },
  });
  return readLimitedResponse(response, input.maxBytes);
}

export async function prepareOcrImageFromAttachment(input: {
  taskId: string;
  attachment: OcrAttachment;
  workspaceRoot: string;
  fetchImpl?: OcrFetch;
  config?: OcrConfig;
}): Promise<PreparedOcrImage> {
  const cfg = input.config ?? resolveOcrConfig();
  const mime = (input.attachment.content_type ?? "").toLowerCase();
  if (!OCR_SUPPORTED_MIMES.has(mime as OcrMimeType)) throw new OcrToolError("unsupported_attachment");
  const url = input.attachment.url?.startsWith("//") ? `https:${input.attachment.url}` : input.attachment.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new OcrToolError("image_download_failed");
  if (typeof input.attachment.size === "number" && input.attachment.size > cfg.maxImageBytes) throw new OcrToolError("image_too_large");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let response: Response;
  try {
    response = await requestOcrImageResponse({
      url,
      signal: controller.signal,
      maxBytes: cfg.maxImageBytes,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") throw new OcrToolError("ocr_timeout");
    throw new OcrToolError("image_download_failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new OcrToolError("image_download_failed", `http_${response.status}`, response.status);
  const length = response.headers.get("content-length");
  if (length && Number(length) > cfg.maxImageBytes) throw new OcrToolError("image_too_large");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > cfg.maxImageBytes) throw new OcrToolError("image_too_large");
  const magicMime = inferMimeFromMagic(buffer);
  if (!magicMime || magicMime !== mime) throw new OcrToolError("invalid_image");
  const dimensions = parseImageSize(buffer);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new OcrToolError("invalid_image");
  if (dimensions.width * dimensions.height > cfg.maxPixels) throw new OcrToolError("image_too_large", "image_pixels_too_large");

  const stagingRoot = path.join(input.workspaceRoot, ".ocr", input.taskId);
  await fsp.mkdir(stagingRoot, { recursive: true });
  const ext = magicMime === "image/jpeg" ? ".jpg" : magicMime === "image/png" ? ".png" : ".webp";
  const imagePath = path.join(stagingRoot, `${crypto.randomUUID()}${ext}`);
  await fsp.writeFile(imagePath, buffer, { flag: "wx" });
  const st = await fsp.lstat(imagePath);
  if (!st.isFile() || st.isSymbolicLink()) throw new OcrToolError("invalid_image");
  await assertInsideWorkspace(stagingRoot, imagePath);
  return { taskId: input.taskId, imagePath, mimeType: magicMime, bytes: buffer.length, dimensions, source: "current_message_attachment" };
}

export class SiliconFlowOcrProvider implements OcrProvider {
  readonly name = "siliconflow";
  private modelAvailable: boolean | null = null;
  private readonly serviceBaseUrl: string;
  constructor(private readonly config = resolveOcrConfig(), private readonly fetchImpl: OcrFetch = fetch) {
    try {
      this.serviceBaseUrl = resolveCredentialServiceBaseUrl(config.baseUrl);
    } catch {
      throw new OcrToolError("ocr_environment_unavailable");
    }
  }

  async ensureModelAvailable(): Promise<void> {
    if (!this.config.apiKey) throw new OcrToolError("ocr_environment_unavailable");
    if (this.modelAvailable === true) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.serviceBaseUrl}/models`, noRedirectRequestInit({
        method: "GET",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      }));
      if (response.status === 401 || response.status === 403) throw new OcrToolError("ocr_auth_failed", "models_auth_failed", response.status);
      if (!response.ok) throw mapProviderStatus(response.status);
      const body = await safeJson(response);
      const models = Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
      const exists = models.some((entry) => typeof (entry as { id?: unknown }).id === "string" && (entry as { id: string }).id === this.config.model);
      if (!exists) throw new OcrToolError("ocr_model_unavailable");
      this.modelAvailable = true;
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw new OcrToolError("ocr_timeout");
      if (error instanceof OcrToolError) throw error;
      throw new OcrToolError("ocr_provider_unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    await this.ensureModelAvailable();
    const started = Date.now();
    const buffer = await fsp.readFile(input.imagePath);
    const dataUrl = `data:${input.mimeType};base64,${buffer.toString("base64")}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serviceBaseUrl}/chat/completions`, noRedirectRequestInit({
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          temperature: 0,
          max_tokens: Math.min(this.config.maxOutputChars + 512, 8192),
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
              { type: "text", text: resolveOcrPrompt(this.config.model, this.config.mode) },
            ],
          }],
        }),
      }));
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw new OcrToolError("ocr_timeout");
      throw new OcrToolError("ocr_provider_unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw mapProviderStatus(response.status);
    const body = await safeJson(response);
    const choice = Array.isArray((body as { choices?: unknown }).choices) ? (body as { choices: unknown[] }).choices[0] : undefined;
    const content = (choice as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content !== "string") throw new OcrToolError("ocr_response_invalid");
    const normalized = normalizeOcrText(content, this.config.maxOutputChars);
    if (!normalized.text) throw new OcrToolError("ocr_no_text");
    const usage = (body as { usage?: Record<string, unknown> }).usage ?? {};
    const finishReason = (choice as { finish_reason?: unknown } | undefined)?.finish_reason;
    const warnings = [...normalized.warnings];
    if (finishReason && finishReason !== "stop") warnings.push("finish_reason_not_stop");
    return {
      provider: this.name,
      model: typeof (body as { model?: unknown }).model === "string" ? (body as { model: string }).model : this.config.model,
      text: normalized.text,
      elapsedMs: Date.now() - started,
      finishReason: typeof finishReason === "string" ? finishReason : null,
      httpStatus: response.status,
      usage: {
        promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
        completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
        totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
      },
      warnings,
    };
  }
}

export async function executeOcrExtract(input: {
  taskId: string;
  attachment: OcrAttachment;
  workspaceRoot: string;
  fetchImpl?: OcrFetch;
  provider?: OcrProvider;
  config?: OcrConfig;
}): Promise<OcrExecutionResult> {
  const cfg = input.config ?? resolveOcrConfig();
  const image = await prepareOcrImageFromAttachment(input);
  const provider = input.provider ?? new SiliconFlowOcrProvider(cfg, input.fetchImpl);
  const result = await provider.recognize({ taskId: input.taskId, imagePath: image.imagePath, mimeType: image.mimeType, timeoutMs: cfg.timeoutMs });
  const normalized = normalizeOcrText(result.text, cfg.maxOutputChars);
  if (!normalized.text || normalized.text === "\u672a\u8bc6\u522b\u5230\u6709\u6548\u6587\u5b57\u3002") throw new OcrToolError("ocr_no_text");
  return {
    ...result,
    text: normalized.text,
    normalizedText: normalized.text,
    directReply: shouldUseDirectOcrReply(normalized.text),
    warnings: [...result.warnings, ...normalized.warnings],
  };
}

export async function appendOcrTelemetryEvent(input: {
  logDir: string;
  event: OcrTelemetryEvent;
  warn?: (message: string) => void;
}): Promise<boolean> {
  try {
    await fsp.mkdir(input.logDir, { recursive: true, mode: 0o700 });
    const safeEvent: OcrTelemetryEvent = {
      ...input.event,
      timestamp: input.event.timestamp || new Date().toISOString(),
      requestIdHash: input.event.requestIdHash ?? null,
      sourceMessageHash: input.event.sourceMessageHash ?? null,
      replyToHash: input.event.replyToHash ?? null,
      httpStatus: input.event.httpStatus ?? null,
      finishReason: input.event.finishReason ?? null,
      usage: {
        promptTokens: input.event.usage?.promptTokens ?? null,
        completionTokens: input.event.usage?.completionTokens ?? null,
        totalTokens: input.event.usage?.totalTokens ?? null,
      },
      resultChars: input.event.resultChars ?? null,
      deliveryState: input.event.deliveryState ?? null,
      errorCode: input.event.errorCode ?? null,
      elapsedMs: input.event.elapsedMs ?? null,
    };
    const line = JSON.stringify(safeEvent).replace(/\r?\n/g, "") + "\n";
    await fsp.appendFile(path.join(input.logDir, "ocr-events.jsonl"), line, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (error) {
    try { input.warn?.(`ocr_telemetry_write_failed:${error instanceof Error ? error.name : "unknown"}`); } catch {}
    return false;
  }
}
export async function writeOcrResultFiles(input: {
  workspaceRoot: string;
  taskId: string;
  result: OcrExecutionResult;
}): Promise<{ textPath: string; jsonPath: string }> {
  const dir = path.join(input.workspaceRoot, ".ocr", input.taskId, "result");
  await fsp.mkdir(dir, { recursive: true });
  const textPath = path.join(dir, "ocr-result.txt");
  const jsonPath = path.join(dir, "ocr-result.json");
  await fsp.writeFile(textPath, input.result.normalizedText, "utf8");
  await fsp.writeFile(jsonPath, JSON.stringify({
    provider: input.result.provider,
    model: input.result.model,
    textLength: input.result.normalizedText.length,
    elapsedMs: input.result.elapsedMs,
    finishReason: input.result.finishReason,
    httpStatus: input.result.httpStatus ?? null,
    usage: input.result.usage,
    warnings: input.result.warnings,
  }, null, 2), "utf8");
  return { textPath, jsonPath };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new OcrToolError("ocr_response_invalid");
  }
}

function mapProviderStatus(status: number): OcrToolError {
  if (status === 400) return new OcrToolError("ocr_request_invalid", "http_400", status);
  if (status === 401 || status === 403) return new OcrToolError("ocr_auth_failed", `http_${status}`, status);
  if (status === 404) return new OcrToolError("ocr_model_unavailable", "http_404", status);
  if (status === 413) return new OcrToolError("image_too_large", "http_413", status);
  if (status === 429) return new OcrToolError("ocr_rate_limited", "http_429", status);
  if (status === 500 || status === 503 || status === 504) return new OcrToolError("ocr_provider_unavailable", `http_${status}`, status);
  return new OcrToolError("ocr_provider_unavailable", `http_${status}`, status);
}
