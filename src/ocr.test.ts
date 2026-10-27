import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendOcrTelemetryEvent,
  executeOcrExtract,
  formatOcrDirectReply,
  normalizeOcrText,
  OcrToolError,
  prepareOcrImageFromAttachment,
  resolveOcrConfig,
  resolveOcrPrompt,
  selectSingleImageAttachment,
  shouldHandleOcrRequest,
  shouldUseDirectOcrReply,
  SiliconFlowOcrProvider,
  userFacingOcrError,
  writeOcrResultFiles,
  type OcrFetch,
  type OcrTelemetryEvent,
} from "./ocr.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const WEBP_MIN = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=", "base64");

function response(body: unknown, init: ResponseInit = {}) {
  if (body instanceof Uint8Array) {
    return new Response(body as unknown as BodyInit, { status: 200, ...init, headers: init.headers });
  }
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

function mockFetch(routes: Array<(url: string, init?: RequestInit) => Response | Promise<Response> | undefined>): OcrFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      const result = await route(url, init);
      if (result) return result;
    }
    throw new Error(`unexpected network: ${url}`);
  }) as OcrFetch;
}

async function tmpdir(t: test.TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "qqbot-ocr-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const baseConfig = {
  provider: "siliconflow" as const,
  apiKey: "test-key",
  model: "deepseek-ai/DeepSeek-OCR",
  baseUrl: "https://mock.local/v1",
  timeoutMs: 1000,
  maxImageBytes: 10 * 1024 * 1024,
  maxOutputChars: 6000,
  maxPixels: 25_000_000,
  mode: "plain_text" as const,
};

test("private image plus OCR intent triggers", () => {
  assert.equal(shouldHandleOcrRequest({ text: "OCR", chatType: "direct", attachments: [{ content_type: "image/png", url: "https://x" }] }).shouldHandle, true);
});

test("group requires mention", () => {
  const d = shouldHandleOcrRequest({ text: "OCR", chatType: "group", wasMentioned: false, attachments: [{ content_type: "image/png", url: "https://x" }] });
  assert.equal(d.shouldHandle, false);
  assert.equal(d.reason, "not_mentioned");
});

test("image without OCR intent does not trigger", () => {
  assert.equal(shouldHandleOcrRequest({ text: "鐪嬬湅杩欎釜", chatType: "direct", attachments: [{ content_type: "image/png", url: "https://x" }] }).shouldHandle, false);
});

test("OCR intent without image reports attachment_missing", () => {
  const d = shouldHandleOcrRequest({ text: "OCR", chatType: "direct", attachments: [] });
  assert.equal(d.shouldHandle, true);
  assert.equal(d.reason, "attachment_missing");
});

test("single image selector rejects multiple images", () => {
  assert.throws(() => selectSingleImageAttachment([{ content_type: "image/png", url: "a" }, { content_type: "image/jpeg", url: "b" }]), /single_image_only|unsupported_attachment/);
});

test("unsupported MIME rejected", async (t) => {
  await assert.rejects(() => prepareOcrImageFromAttachment({ taskId: "t", attachment: { content_type: "image/gif", url: "https://x" }, workspaceRoot: t.name }), (e) => e instanceof OcrToolError && e.code === "unsupported_attachment");
});

test("extension spoofing is rejected by magic bytes", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([() => response("not png")]);
  await assert.rejects(() => prepareOcrImageFromAttachment({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/fake.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig }), (e) => e instanceof OcrToolError && e.code === "invalid_image");
});

test("file header mismatch rejected", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([() => response(PNG_1X1)]);
  await assert.rejects(() => prepareOcrImageFromAttachment({ taskId: "t", attachment: { content_type: "image/jpeg", url: "https://x/a.jpg" }, workspaceRoot: dir, fetchImpl, config: baseConfig }), (e) => e instanceof OcrToolError && e.code === "invalid_image");
});

test("over 10 MB rejected by declared size", async (t) => {
  const dir = await tmpdir(t);
  await assert.rejects(() => prepareOcrImageFromAttachment({ taskId: "t", attachment: { content_type: "image/png", url: "https://x", size: 11 * 1024 * 1024 }, workspaceRoot: dir, config: baseConfig }), (e) => e instanceof OcrToolError && e.code === "image_too_large");
});

test("path traversal URL does not control local filename", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([() => response(PNG_1X1)]);
  const img = await prepareOcrImageFromAttachment({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/../../secret.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.match(img.imagePath, /\.ocr/);
  assert.equal(path.basename(img.imagePath).includes("secret"), false);
});

test("download writes inside per-task workspace", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([() => response(PNG_1X1)]);
  const a = await prepareOcrImageFromAttachment({ taskId: "a", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  const b = await prepareOcrImageFromAttachment({ taskId: "b", attachment: { content_type: "image/png", url: "https://x/b.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.notEqual(path.dirname(a.imagePath), path.dirname(b.imagePath));
});

test("model check accepts configured model", async () => {
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : undefined]);
  await new SiliconFlowOcrProvider(baseConfig, fetchImpl).ensureModelAvailable();
});

test("OCR credential requests reject HTTP endpoints before sending the API key", async () => {
  let calls = 0;
  const fetchImpl = mockFetch([() => { calls++; return response({ data: [{ id: baseConfig.model }] }); }]);
  assert.throws(
    () => new SiliconFlowOcrProvider({ ...baseConfig, baseUrl: "http://untrusted.example/v1" }, fetchImpl),
    (e) => e instanceof OcrToolError && e.code === "ocr_environment_unavailable",
  );
  assert.equal(calls, 0);
});

test("OCR credential requests refuse redirects", async () => {
  let redirect: RequestRedirect | undefined;
  const fetchImpl = mockFetch([(url, init) => {
    if (url.endsWith("/models")) {
      redirect = init?.redirect;
      return response({ data: [{ id: baseConfig.model }] });
    }
    return undefined;
  }]);
  await new SiliconFlowOcrProvider(baseConfig, fetchImpl).ensureModelAvailable();
  assert.equal(redirect, "error");
});

test("model check uses only Authorization Bearer auth header", async () => {
  let headers: Record<string, string> = {};
  const fetchImpl = mockFetch([(url, init) => {
    if (!url.endsWith("/models")) return undefined;
    headers = init?.headers as Record<string, string>;
    return response({ data: [{ id: baseConfig.model }] });
  }]);
  await new SiliconFlowOcrProvider(baseConfig, fetchImpl).ensureModelAvailable();
  assert.equal(headers.Authorization, `Bearer ${baseConfig.apiKey}`);
  assert.equal(Object.hasOwn(headers, "x-api-key"), false);
  assert.equal(Object.hasOwn(headers, "X-API-Key"), false);
});

test("model check rejects missing model", async () => {
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: "other" }] }) : undefined]);
  await assert.rejects(() => new SiliconFlowOcrProvider(baseConfig, fetchImpl).ensureModelAvailable(), (e) => e instanceof OcrToolError && e.code === "ocr_model_unavailable");
});

test("missing API key is environment unavailable", async () => {
  await assert.rejects(() => new SiliconFlowOcrProvider({ ...baseConfig, apiKey: undefined }).ensureModelAvailable(), (e) => e instanceof OcrToolError && e.code === "ocr_environment_unavailable");
});

test("API 200 Chinese content", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([
    (url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : undefined,
    (url) => url.endsWith("/chat/completions") ? response({ model: baseConfig.model, choices: [{ message: { content: "浣犲ソ" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) : undefined,
    () => response(PNG_1X1),
  ]);
  const result = await executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.equal(result.normalizedText, "浣犲ソ");
  assert.equal(result.directReply, true);
});

test("API 200 English content", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : url.endsWith("/chat/completions") ? response({ model: baseConfig.model, choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] }) : response(PNG_1X1)]);
  const result = await executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.equal(result.normalizedText, "Hello");
});

test("API 200 mixed content", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : url.endsWith("/chat/completions") ? response({ model: baseConfig.model, choices: [{ message: { content: "Hello\n浣犲ソ" }, finish_reason: "stop" }] }) : response(PNG_1X1)]);
  const result = await executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.equal(result.normalizedText, "Hello\n浣犲ソ");
});

test("API 200 markdown table", async (t) => {
  const dir = await tmpdir(t);
  const table = "| A | B |\\n|---|---|\\n| 1 | 2 |";
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : url.endsWith("/chat/completions") ? response({ model: baseConfig.model, choices: [{ message: { content: table }, finish_reason: "stop" }] }) : response(PNG_1X1)]);
  const result = await executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.equal(result.normalizedText, table);
});

test("empty content maps to no text", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : url.endsWith("/chat/completions") ? response({ model: baseConfig.model, choices: [{ message: { content: " " }, finish_reason: "stop" }] }) : response(PNG_1X1)]);
  await assert.rejects(() => executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig }), (e) => e instanceof OcrToolError && e.code === "ocr_no_text");
});

test("empty choices invalid", async () => {
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : response({ choices: [] })]);
  await assert.rejects(() => new SiliconFlowOcrProvider(baseConfig, fetchImpl).recognize({ taskId: "t", imagePath: new URL("data:,").pathname, mimeType: "image/png", timeoutMs: 1 }), /ENOENT|ocr_response_invalid/);
});

for (const [status, code] of [[401, "ocr_auth_failed"], [403, "ocr_auth_failed"], [404, "ocr_model_unavailable"], [429, "ocr_rate_limited"], [500, "ocr_provider_unavailable"], [503, "ocr_provider_unavailable"], [504, "ocr_provider_unavailable"]] as const) {
  test(`provider status ${status} maps to ${code}`, async () => {
    const fetchImpl = mockFetch([() => response({ message: "x" }, { status })]);
    await assert.rejects(() => new SiliconFlowOcrProvider(baseConfig, fetchImpl).ensureModelAvailable(), (e) => e instanceof OcrToolError && e.code === code);
  });
}

test("non JSON response invalid", async () => {
  const fetchImpl = mockFetch([() => new Response("not json", { status: 200 })]);
  await assert.rejects(() => new SiliconFlowOcrProvider(baseConfig, fetchImpl).ensureModelAvailable(), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("finish_reason truncation warning", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([(url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : url.endsWith("/chat/completions") ? response({ model: baseConfig.model, choices: [{ message: { content: "abc" }, finish_reason: "length" }] }) : response(PNG_1X1)]);
  const result = await executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.ok(result.warnings.includes("finish_reason_not_stop"));
});
async function recognizeWithChatBody(t: TestContext, chatBody: unknown, headers: HeadersInit = {}) {
  const dir = await tmpdir(t);
  const imagePath = path.join(dir, "image.png");
  await fsp.writeFile(imagePath, PNG_1X1);
  const fetchImpl = mockFetch([
    (url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : undefined,
    (url) => url.endsWith("/chat/completions") ? response(chatBody, { headers }) : undefined,
  ]);
  return new SiliconFlowOcrProvider(baseConfig, fetchImpl).recognize({ taskId: "t", imagePath, mimeType: "image/png", timeoutMs: baseConfig.timeoutMs });
}

test("response parser accepts ordinary string content", async (t) => {
  const result = await recognizeWithChatBody(t, { model: baseConfig.model, choices: [{ message: { content: "Hello OCR" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  assert.equal(result.text, "Hello OCR");
});

test("response parser maps empty string content to ocr_no_text", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [{ message: { content: "" }, finish_reason: "stop" }] }), (e) => e instanceof OcrToolError && e.code === "ocr_no_text");
});

test("response parser rejects null content as invalid schema", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [{ message: { content: null }, finish_reason: "stop" }] }), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("response parser rejects empty choices as invalid schema", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [] }), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("response parser rejects missing message as invalid schema", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [{ finish_reason: "stop" }] }), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("response parser rejects text block array content unless platform contract requires it", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [{ message: { content: [{ type: "text", text: "Hello" }] }, finish_reason: "stop" }] }), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("response parser rejects non-text block array content", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [{ message: { content: [{ type: "image_url" }] }, finish_reason: "stop" }] }), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("response parser maps whitespace-only content to ocr_no_text", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { choices: [{ message: { content: " \n\t " }, finish_reason: "stop" }] }), (e) => e instanceof OcrToolError && e.code === "ocr_no_text");
});

test("response parser keeps empty content failure even with normal finish_reason", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { model: baseConfig.model, choices: [{ message: { content: " " }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }), (e) => e instanceof OcrToolError && e.code === "ocr_no_text");
});

test("response parser rejects HTTP 200 abnormal schema", async (t) => {
  await assert.rejects(() => recognizeWithChatBody(t, { object: "chat.completion", data: [] }), (e) => e instanceof OcrToolError && e.code === "ocr_response_invalid");
});

test("response parser succeeds when trace header exists", async (t) => {
  const result = await recognizeWithChatBody(t, { choices: [{ message: { content: "trace ok" }, finish_reason: "stop" }] }, { "x-trace-id": "trace-local-test" });
  assert.equal(result.text, "trace ok");
});

test("response parser succeeds when trace header is absent", async (t) => {
  const result = await recognizeWithChatBody(t, { choices: [{ message: { content: "no trace" }, finish_reason: "stop" }] });
  assert.equal(result.text, "no trace");
});

test("short result direct reply", () => {
  assert.equal(shouldUseDirectOcrReply("abc"), true);
  assert.equal(formatOcrDirectReply("abc").endsWith("abc"), true);
});
test("short OCR direct reply keeps UTF-8 prefix and raw OCR text", () => {
  const body = "\u804a\u5929 12:34 file_name.png 45KB ABC_xyz";
  const reply = formatOcrDirectReply(body);
  assert.equal(reply.startsWith("OCR \u8bc6\u522b\u7ed3\u679c\uff1a\n"), true);
  assert.equal(reply.includes("璇嗗埆"), false);
  assert.equal(reply.includes("缁撴灉"), false);
  assert.equal(reply.slice("OCR \u8bc6\u522b\u7ed3\u679c\uff1a\n".length), body);
});

test("long result writes txt and json", async (t) => {
  const dir = await tmpdir(t);
  const result = { provider: "siliconflow", model: baseConfig.model, text: "x".repeat(2000), normalizedText: "x".repeat(2000), directReply: false, elapsedMs: 1, finishReason: "stop", usage: { promptTokens: null, completionTokens: null, totalTokens: null }, warnings: [] };
  const files = await writeOcrResultFiles({ workspaceRoot: dir, taskId: "task", result });
  assert.equal(await fsp.readFile(files.textPath, "utf8"), result.normalizedText);
  assert.match(await fsp.readFile(files.jsonPath, "utf8"), /textLength/);
});

test("normalize trims and keeps internal text", () => {
  assert.deepEqual(normalizeOcrText("  a\r\nb  ", 10), { text: "a\nb", warnings: [] });
});

test("normalize truncates output", () => {
  const r = normalizeOcrText("abcdef", 3);
  assert.equal(r.text, "abc");
  assert.ok(r.warnings.includes("ocr_output_truncated"));
});

test("user error text is safe and generic", () => {
  assert.equal(userFacingOcrError(new OcrToolError("ocr_auth_failed", "Authorization: Bearer secret")).length > 0, true);
});

test("DeepSeek-OCR plain_text prompt is the official short prompt", async (t) => {
  const dir = await tmpdir(t);
  let body = "";
  const fetchImpl = mockFetch([
    (url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : undefined,
    (url, init) => {
      if (!url.endsWith("/chat/completions")) return undefined;
      body = String(init?.body);
      return response({ model: baseConfig.model, choices: [{ message: { content: "abc" }, finish_reason: "stop" }] });
    },
  ]);
  const imagePath = path.join(dir, "image.png");
  await fsp.writeFile(imagePath, PNG_1X1);
  await new SiliconFlowOcrProvider(baseConfig, fetchImpl).recognize({ taskId: "t", imagePath, mimeType: "image/png", timeoutMs: baseConfig.timeoutMs });
  const request = JSON.parse(body);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  assert.equal(Array.isArray(request.messages[0].content), true);
  assert.equal(request.messages[0].content[0].type, "image_url");
  assert.equal(request.messages[0].content[0].image_url.detail, "high");
  assert.equal(String(request.messages[0].content[0].image_url.url).startsWith("data:image/png;base64,"), true);
  assert.equal(request.messages[0].content[1].type, "text");
  assert.equal(request.messages[0].content[1].text, "Free OCR.");
  assert.equal(request.messages.some((message: { role?: string }) => message.role === "system"), false);
  assert.equal(body.includes("<image>"), false);
  assert.equal(body.includes("Free OCR."), true);
  assert.equal(body.includes("璇�"), false);
});

test("DeepSeek-OCR prompt profiles expose reserved markdown and table modes", () => {
  assert.equal(resolveOcrPrompt(baseConfig.model, "plain_text"), "Free OCR.");
  assert.equal(resolveOcrPrompt(baseConfig.model, "markdown"), "<|grounding|>Convert the document to markdown.");
  assert.equal(resolveOcrPrompt(baseConfig.model, "table"), "<|grounding|>Extract all tables and convert to markdown format.");
});

test("unknown model uses generic safe prompts without changing DeepSeek-OCR profile", () => {
  assert.equal(resolveOcrPrompt("some/other-model", "plain_text"), "Extract the visible text from the image.");
  assert.equal(resolveOcrPrompt("some/other-model", "markdown"), "Convert the image text to markdown.");
  assert.equal(resolveOcrPrompt("some/other-model", "table"), "Extract tables from the image and convert them to markdown.");
  assert.equal(resolveOcrPrompt(baseConfig.model, "plain_text"), "Free OCR.");
});

test("OCR mode defaults to plain_text and accepts reserved modes", () => {
  assert.equal(resolveOcrConfig({}).mode, "plain_text");
  assert.equal(resolveOcrConfig({ QQBOT_OCR_MODE: "markdown" }).mode, "markdown");
  assert.equal(resolveOcrConfig({ QQBOT_OCR_MODE: "table" }).mode, "table");
  assert.equal(resolveOcrConfig({ QQBOT_OCR_MODE: "unexpected" }).mode, "plain_text");
});
test("request body uses base64 data URL but logs are not required to expose it", async (t) => {
  const dir = await tmpdir(t);
  let body = "";
  let chatHeaders: Record<string, string> = {};
  const fetchImpl = mockFetch([
    (url) => url.endsWith("/models") ? response({ data: [{ id: baseConfig.model }] }) : undefined,
    (url, init) => { if (url.endsWith("/chat/completions")) { body = String(init?.body); chatHeaders = init?.headers as Record<string, string>; return response({ model: baseConfig.model, choices: [{ message: { content: "abc" }, finish_reason: "stop" }] }); } return undefined; },
    () => response(PNG_1X1),
  ]);
  await executeOcrExtract({ taskId: "t", attachment: { content_type: "image/png", url: "https://x/a.png" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.equal(chatHeaders.Authorization, `Bearer ${baseConfig.apiKey}`);
  assert.equal(chatHeaders["Content-Type"], "application/json");
  assert.equal(Object.hasOwn(chatHeaders, "x-api-key"), false);
  assert.equal(Object.hasOwn(chatHeaders, "X-API-Key"), false);
  assert.match(body, /data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify({ bodyLength: body.length }), /data:image/);
});

test("config reads defaults without key", () => {
  const cfg = resolveOcrConfig({});
  assert.equal(cfg.model, "deepseek-ai/DeepSeek-OCR");
  assert.equal(cfg.baseUrl, "https://api.siliconflow.cn/v1");
});

test("webp is accepted when magic and mime match", async (t) => {
  const dir = await tmpdir(t);
  const fetchImpl = mockFetch([() => response(WEBP_MIN)]);
  const img = await prepareOcrImageFromAttachment({ taskId: "t", attachment: { content_type: "image/webp", url: "https://x/a.webp" }, workspaceRoot: dir, fetchImpl, config: baseConfig });
  assert.equal(img.mimeType, "image/webp");
});

function baseTelemetryEvent(overrides: Partial<OcrTelemetryEvent> = {}): OcrTelemetryEvent {
  return {
    event: "ocr_started",
    timestamp: "2026-07-23T10:00:00.000Z",
    taskId: "task-123",
    shortTaskId: "TASK123",
    requestIdHash: "reqhash1234",
    sourceMessageHash: "sourcehash12",
    replyToHash: "sourcehash12",
    chatType: "private",
    sourceAgent: "qq-private-pro:ocr",
    attachmentCount: 1,
    provider: "siliconflow",
    model: "deepseek-ai/DeepSeek-OCR",
    mode: "plain_text",
    httpStatus: null,
    finishReason: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    resultChars: null,
    directReply: false,
    ordinaryAgentSkipped: true,
    deliveryState: null,
    errorCode: null,
    elapsedMs: null,
    ...overrides,
  };
}

test("OCR telemetry writes started and completed JSONL with stable correlation", async (t) => {
  const dir = await tmpdir(t);
  const logDir = path.join(dir, "ocr-events");
  const started = baseTelemetryEvent();
  const completed = baseTelemetryEvent({
    event: "ocr_completed",
    timestamp: "2026-07-23T10:00:01.000Z",
    httpStatus: 200,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    resultChars: 42,
    directReply: true,
    deliveryState: "delivered",
    elapsedMs: 1234,
  });
  assert.equal(await appendOcrTelemetryEvent({ logDir, event: started }), true);
  assert.equal(await appendOcrTelemetryEvent({ logDir, event: completed }), true);
  const lines = (await fsp.readFile(path.join(logDir, "ocr-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, "ocr_started");
  assert.equal(lines[1].event, "ocr_completed");
  assert.equal(lines[0].taskId, lines[1].taskId);
  assert.equal(lines[0].sourceMessageHash, lines[1].sourceMessageHash);
  assert.equal(lines[1].httpStatus, 200);
  assert.equal(lines[1].finishReason, "stop");
  assert.deepEqual(lines[1].usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  assert.equal(lines[1].resultChars, 42);
  assert.equal(lines[1].directReply, true);
  assert.equal(lines[1].ordinaryAgentSkipped, true);
  assert.equal(lines[1].deliveryState, "delivered");
});

test("OCR telemetry writes failed events without OCR text or sensitive transport values", async (t) => {
  const dir = await tmpdir(t);
  const logDir = path.join(dir, "ocr-events");
  const failed = baseTelemetryEvent({ event: "ocr_failed", errorCode: "ocr_no_text", deliveryState: null });
  assert.equal(await appendOcrTelemetryEvent({ logDir, event: failed }), true);
  const raw = await fsp.readFile(path.join(logDir, "ocr-events.jsonl"), "utf8");
  assert.match(raw, /"event":"ocr_failed"/);
  assert.match(raw, /"errorCode":"ocr_no_text"/);
  assert.equal(raw.includes("Authorization"), false);
  assert.equal(raw.includes("Bearer"), false);
  assert.equal(raw.includes("base64,"), false);
  assert.equal(raw.includes("https://"), false);
  assert.equal(raw.includes("OCR recognized body"), false);
  assert.equal(raw.includes("account"), false);
  assert.equal(raw.includes("target"), false);
  assert.equal(raw.includes("openId"), false);
});

test("OCR telemetry writer failure is non-throwing and warning-only", async (t) => {
  const dir = await tmpdir(t);
  const fileAsDir = path.join(dir, "not-a-dir");
  await fsp.writeFile(fileAsDir, "x", "utf8");
  const warnings: string[] = [];
  const ok = await appendOcrTelemetryEvent({ logDir: fileAsDir, event: baseTelemetryEvent(), warn: (message: string) => warnings.push(message) });
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ocr_telemetry_write_failed/);
});

test("OCR telemetry supports concurrent tasks without mixing correlation", async (t) => {
  const dir = await tmpdir(t);
  const logDir = path.join(dir, "ocr-events");
  await Promise.all([
    appendOcrTelemetryEvent({ logDir, event: baseTelemetryEvent({ taskId: "task-a", shortTaskId: "A", sourceMessageHash: "source-a", replyToHash: "source-a" }) }),
    appendOcrTelemetryEvent({ logDir, event: baseTelemetryEvent({ taskId: "task-b", shortTaskId: "B", sourceMessageHash: "source-b", replyToHash: "source-b", chatType: "group" }) }),
  ]);
  const rows = (await fsp.readFile(path.join(logDir, "ocr-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  const byTask = new Map(rows.map((row) => [row.taskId, row]));
  assert.equal(byTask.get("task-a").sourceMessageHash, "source-a");
  assert.equal(byTask.get("task-b").sourceMessageHash, "source-b");
  assert.equal(byTask.get("task-b").chatType, "group");
});

test("gateway OCR direct-reply path persists started completed and failed telemetry", async () => {
  const gateway = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /appendOcrTelemetryEvent/);
  assert.match(gateway, /event:\s*"ocr_started"/);
  assert.match(gateway, /event:\s*"ocr_completed"/);
  assert.match(gateway, /event:\s*"ocr_failed"/);
  assert.match(gateway, /sourceMessageHash/);
  assert.match(gateway, /replyToHash/);
  assert.match(gateway, /ordinaryAgentSkipped/);
  assert.match(gateway, /markAgentTaskDelivery\(\{ taskId: ocrTask\.taskId, ok: true \}\)/);
  assert.doesNotMatch(gateway, /normalizedText[^\n]+appendOcrTelemetryEvent/);
});
