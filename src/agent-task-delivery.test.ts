import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentTaskDeliveryService, isExplicitPrivateOwner } from "./agent-task-delivery.js";
import { buildDocumentContext } from "./document-parser.js";
import { resolveQQBotAccount } from "./config.js";
import { resolveGroupMessageGate } from "./message-gating.js";
import { evaluateGroupSearchGuard, TurnSearchCallLimiter } from "./request-context.js";
import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";

const TEST_ROOT = process.env.QQBOT_AGENT_DELIVERY_TEST_ROOT ?? path.join(os.tmpdir(), "qqbot-agent-task-delivery-v1-tests");
const ACCOUNT = "account-fixture";
const SECRET = "fixture-secret-not-production";

function resolvePluginRootForTests(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    // Identify the plugin root by its files, not its folder name (checkout dirs vary).
    if (existsSync(path.join(directory, "openclaw.plugin.json"))
        && existsSync(path.join(directory, "scripts", "openclaw-delivery-queue-loader.mjs"))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error("could not resolve candidate plugin root");
}

test("default Task Delivery paths use the configured OpenClaw data root", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousTaskStateDir = process.env.QQBOT_AGENT_TASK_STATE_DIR;
  const previousTaskArtifactDir = process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR;
  const syntheticStateDir = path.join(TEST_ROOT, "configured-openclaw-state");
  process.env.OPENCLAW_STATE_DIR = syntheticStateDir;
  delete process.env.QQBOT_AGENT_TASK_STATE_DIR;
  delete process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR;
  try {
    const service = new AgentTaskDeliveryService();
    assert.equal(service.stateRoot, path.join(syntheticStateDir, "qqbot", "agent-task-delivery", "state"));
    assert.equal(service.artifactRoot, path.join(syntheticStateDir, "qqbot", "agent-task-delivery", "artifacts"));
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (previousTaskStateDir === undefined) delete process.env.QQBOT_AGENT_TASK_STATE_DIR;
    else process.env.QQBOT_AGENT_TASK_STATE_DIR = previousTaskStateDir;
    if (previousTaskArtifactDir === undefined) delete process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR;
    else process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR = previousTaskArtifactDir;
  }
});

async function loadCandidateDeliveryQueueRuntime(): Promise<{ recoverPendingDeliveries: (opts: unknown) => Promise<unknown> }> {
  const pluginRoot = resolvePluginRootForTests();
  const loaderPath = path.join(pluginRoot, "scripts", "openclaw-delivery-queue-loader.mjs");
  const loader = await import(pathToFileURL(loaderPath).href) as {
    loadDeliveryQueueRuntime(root: string): Promise<{ recoverPendingDeliveries: (opts: unknown) => Promise<unknown> }>;
  };
  return loader.loadDeliveryQueueRuntime(pluginRoot);
}

type Fixture = {
  service: AgentTaskDeliveryService;
  root: string;
  stateRoot: string;
  artifactRoot: string;
};

async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<Fixture> {
  const root = path.join(TEST_ROOT, crypto.randomUUID());
  const stateRoot = path.join(root, "state");
  const artifactRoot = path.join(root, "artifacts");
  const service = new AgentTaskDeliveryService({ stateRoot, artifactRoot });
  await service.configureAccount(ACCOUNT, SECRET);
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
  return { service, root, stateRoot, artifactRoot };
}

async function createTask(fx: Fixture, options: {
  messageId?: string;
  target?: string;
  requester?: string;
  inputFiles?: string[];
  sendInitial?: (text: string) => Promise<void>;
  childRunId?: string;
  requestedDeliveryMode?: "archive";
} = {}) {
  const messageId = options.messageId ?? `message-${crypto.randomUUID()}`;
  const target = options.target ?? "group:fixture";
  const requester = options.requester ?? "user-fixture";
  const childRunId = options.childRunId ?? `child-${crypto.randomUUID()}`;
  const registered = await fx.service.registerInbound({
    accountId: ACCOUNT,
    clientSecret: SECRET,
    targetType: "group",
    target,
    requesterId: requester,
    originMessageId: messageId,
    receivedAt: "2026-07-17T10:00:00.000Z",
    parentSessionKey: `parent-${messageId}`,
    inputFiles: options.inputFiles,
    requestedDeliveryMode: options.requestedDeliveryMode,
    sendInitial: options.sendInitial,
  });
  const prepared = await fx.service.prepareSubagent({
    originMessageId: messageId,
    accountId: ACCOUNT,
    parentSessionKey: `parent-${messageId}`,
    childSessionKey: `child-session-${childRunId}`,
  });
  assert.ok(prepared);
  await fx.service.confirmSubagentRun({ taskId: registered.taskId, childRunId, childSessionKey: `child-session-${childRunId}` });
  return { ...registered, ...prepared, messageId, target, requester, childRunId };
}

async function complete(fx: Fixture, task: Awaited<ReturnType<typeof createTask>>, resultText = "done") {
  return fx.service.prepareCompletion({
    childRunId: task.childRunId,
    channel: "qqbot",
    accountId: ACCOUNT,
    target: task.target,
    resultText,
    status: "completed",
  });
}

async function writeSource(task: Awaited<ReturnType<typeof createTask>>, name = "src/main.js", content = "console.log('ok');\n") {
  const destination = path.join(task.workspaceRoot, ...name.split("/"));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, content, "utf8");
}

async function createDirectInbound(fx: Fixture, options: {
  messageId?: string;
  target?: string;
  requester?: string;
  targetType?: "group" | "private";
  requestedDeliveryMode?: "archive";
  sourceWorkspaceRoot?: string;
} = {}) {
  const messageId = options.messageId ?? `direct-${crypto.randomUUID()}`;
  const target = options.target ?? "qqbot:group:fixture";
  const requester = options.requester ?? "direct-user";
  const sourceWorkspaceRoot = options.sourceWorkspaceRoot ?? path.join(fx.root, `agent-${crypto.randomUUID()}`);
  const sourceAgent = options.targetType === "private" ? "qq-private-pro" : "qq-group-pro";
  await fsp.mkdir(sourceWorkspaceRoot, { recursive: true });
  const registered = await fx.service.registerInbound({
    accountId: ACCOUNT,
    clientSecret: SECRET,
    targetType: options.targetType ?? "group",
    target,
    requesterId: requester,
    originMessageId: messageId,
    receivedAt: "2026-07-17T14:25:00.000Z",
    parentSessionKey: `parent-${messageId}`,
    requestedDeliveryMode: options.requestedDeliveryMode,
    sourceWorkspaceRoot,
    sourceAgent,
    traceId: crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 12),
    runId: messageId,
  });
  return { ...registered, messageId, target, requester, sourceWorkspaceRoot, sourceAgent };
}

async function writeDirectFile(task: Awaited<ReturnType<typeof createDirectInbound>>, name: string, content: string | Buffer) {
  const destination = path.join(task.sourceWorkspaceRoot, ...name.split("/"));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, content);
  return destination;
}

async function collectDirect(
  fx: Fixture,
  task: Awaited<ReturnType<typeof createDirectInbound>>,
  filePath: string,
  sourceKind: "direct_agent_file" | "qqmedia_tag" | "message_send_media" = "direct_agent_file",
) {
  return fx.service.collectDirectFile({
    taskId: task.taskId,
    originMessageId: task.messageId,
    turnId: task.messageId,
    filePath,
    sourceKind,
    workspaceRoot: task.sourceWorkspaceRoot,
    sourceAgent: task.sourceAgent,
  });
}

async function readStoredZip(filePath: string): Promise<Map<string, Buffer>> {
  const buffer = await fsp.readFile(filePath);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

const ownerCases: Array<[string, string | undefined, string, boolean]> = [
  ["exact owner", "owner-a", "owner-a", true],
  ["owner match ignores case", "OWNER-A", "owner-a", true],
  ["trims owner", " owner-a ", "owner-a", true],
  ["wildcard is never owner proof", "*", "owner-a", false],
  ["different sender is rejected", "owner-a", "owner-b", false],
  ["missing owner is rejected", undefined, "owner-a", false],
  ["blank owner is rejected", "  ", "owner-a", false],
  ["blank sender is rejected", "owner-a", "  ", false],
  ["prefix match is rejected", "owner-a", "owner-a-extra", false],
  ["suffix match is rejected", "owner-a", "extra-owner-a", false],
];

for (const [name, ownerOpenId, sender, expected] of ownerCases) {
  test(`private owner: ${name}`, () => assert.equal(isExplicitPrivateOwner(ownerOpenId, sender), expected));
}

test("dedicated ownerOpenId is resolved independently from ordinary private allowFrom", () => {
  const account = resolveQQBotAccount({ channels: { qqbot: { appId: "fixture-app", clientSecret: "fixture-secret", allowFrom: ["*"], ownerOpenId: "owner-fixture-openid" } } } as never);
  assert.equal(account.config.ownerOpenId, "owner-fixture-openid");
  assert.deepEqual(account.config.allowFrom, ["*"]);
});

test("V1.1.1 same source directory name gets per-task staging roots", async (t) => {
  const fx = await fixture(t);
  const sharedWorkspace = path.join(fx.root, "shared-agent-workspace");
  await fsp.mkdir(sharedWorkspace, { recursive: true });
  const a = await createDirectInbound(fx, { messageId: "same-dir-a", target: "qqbot:group:a", sourceWorkspaceRoot: sharedWorkspace });
  const b = await createDirectInbound(fx, { messageId: "same-dir-b", target: "qqbot:group:b", sourceWorkspaceRoot: sharedWorkspace });
  const file = await writeDirectFile(a, "hello-qqbot/index.js", "console.log('a');\n");
  await collectDirect(fx, a, file);
  await fsp.writeFile(file, "console.log('b');\n");
  await collectDirect(fx, b, file);
  const stateA = fx.service.getTaskForTest(a.taskId)!;
  const stateB = fx.service.getTaskForTest(b.taskId)!;
  assert.notEqual(stateA.stagingRoot, stateB.stagingRoot);
  assert.match(stateA.stagingRoot ?? "", /\.agent-task-delivery/);
  assert.match(stateB.stagingRoot ?? "", /\.agent-task-delivery/);
});

test("V1.1.2 concurrent group inbound immediately persists independent TaskContexts", async (t) => {
  const fx = await fixture(t);
  const sharedWorkspace = path.join(fx.root, "shared-agent-workspace");
  await fsp.mkdir(sharedWorkspace, { recursive: true });
  const [a, b] = await Promise.all([
    createDirectInbound(fx, { messageId: "v112-a", target: "qqbot:group:a", sourceWorkspaceRoot: sharedWorkspace }),
    createDirectInbound(fx, { messageId: "v112-b", target: "qqbot:group:b", sourceWorkspaceRoot: sharedWorkspace }),
  ]);
  const stateA = fx.service.getTaskForTest(a.taskId)!;
  const stateB = fx.service.getTaskForTest(b.taskId)!;
  assert.ok(stateA);
  assert.ok(stateB);
  assert.notEqual(stateA.taskId, stateB.taskId);
  assert.notEqual(stateA.conversationHash, stateB.conversationHash);
  assert.equal(stateA.status, "registered");
  assert.equal(stateB.status, "registered");
  assert.equal(stateA.collectorState, "collecting");
  assert.equal(stateB.collectorState, "collecting");
});

test("V1.1.2 collector requires matching taskId and originMessageId", async (t) => {
  const fx = await fixture(t);
  const sharedWorkspace = path.join(fx.root, "shared-agent-workspace");
  await fsp.mkdir(sharedWorkspace, { recursive: true });
  const a = await createDirectInbound(fx, { messageId: "v112-bind-a", target: "qqbot:group:a", sourceWorkspaceRoot: sharedWorkspace });
  const b = await createDirectInbound(fx, { messageId: "v112-bind-b", target: "qqbot:group:b", sourceWorkspaceRoot: sharedWorkspace });
  const file = await writeDirectFile(a, "hello-qqbot/index.js", "console.log('A');\n");
  const result = await fx.service.collectDirectFile({
    taskId: a.taskId,
    originMessageId: b.messageId,
    turnId: b.messageId,
    filePath: file,
    sourceKind: "qqmedia_tag",
    workspaceRoot: sharedWorkspace,
    sourceAgent: "qq-group-pro",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "task_origin_binding_mismatch");
  assert.equal(fx.service.getTaskForTest(a.taskId)?.deliveryState, "requires_review");
  assert.equal(fx.service.getTaskForTest(b.taskId)?.deliveryState, "not_ready");
});

test("V1.1.2 same workspace and path collect into explicit task staging only", async (t) => {
  const fx = await fixture(t);
  const sharedWorkspace = path.join(fx.root, "shared-agent-workspace");
  await fsp.mkdir(sharedWorkspace, { recursive: true });
  const a = await createDirectInbound(fx, { messageId: "v112-stage-a", target: "qqbot:group:a", sourceWorkspaceRoot: sharedWorkspace });
  const b = await createDirectInbound(fx, { messageId: "v112-stage-b", target: "qqbot:group:b", sourceWorkspaceRoot: sharedWorkspace });
  const file = await writeDirectFile(a, "hello-qqbot/index.js", "console.log('A');\n");
  await collectDirect(fx, a, file);
  await fsp.writeFile(file, "console.log('B');\n");
  await collectDirect(fx, b, file);
  const stateA = fx.service.getTaskForTest(a.taskId)!;
  const stateB = fx.service.getTaskForTest(b.taskId)!;
  assert.notEqual(stateA.stagingRoot, stateB.stagingRoot);
  assert.equal(await fsp.readFile(path.join(stateA.stagingRoot!, "hello-qqbot", "index.js"), "utf8"), "console.log('A');\n");
  assert.equal(await fsp.readFile(path.join(stateB.stagingRoot!, "hello-qqbot", "index.js"), "utf8"), "console.log('B');\n");
});

test("V1.1.2 prepareDirectTurn flushes only the explicitly bound task", async (t) => {
  const fx = await fixture(t);
  const sharedWorkspace = path.join(fx.root, "shared-agent-workspace");
  await fsp.mkdir(sharedWorkspace, { recursive: true });
  const a = await createDirectInbound(fx, { messageId: "v112-flush-a", target: "qqbot:group:a", sourceWorkspaceRoot: sharedWorkspace });
  const b = await createDirectInbound(fx, { messageId: "v112-flush-b", target: "qqbot:group:b", sourceWorkspaceRoot: sharedWorkspace });
  await collectDirect(fx, a, await writeDirectFile(a, "hello-qqbot/index.js", "const label='A';\n"));
  await collectDirect(fx, b, await writeDirectFile(b, "hello-qqbot/index.js", "const label='B';\n"));
  const wrong = await fx.service.prepareDirectTurn({ taskId: a.taskId, originMessageId: b.messageId, turnId: b.messageId });
  assert.equal(wrong.suppressDelivery, true);
  assert.equal(wrong.reason, "task_origin_binding_mismatch");
  const pa = await fx.service.prepareDirectTurn({ taskId: a.taskId, originMessageId: a.messageId, turnId: a.messageId });
  assert.equal(pa.taskId, a.taskId);
  assert.equal(fx.service.getTaskForTest(a.taskId)?.collectorState, "flushed");
  assert.equal(fx.service.getTaskForTest(b.taskId)?.collectorState, "collecting");
  const pb = await fx.service.prepareDirectTurn({ taskId: b.taskId, originMessageId: b.messageId, turnId: b.messageId });
  assert.equal(pb.taskId, b.taskId);
});

test("V1.1.1 source overwrite after registration cannot change staged ZIP", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  const index = await writeDirectFile(task, "hello-qqbot/index.js", "const u=require('./utils'); console.log(u('A'));\n");
  const utils = await writeDirectFile(task, "hello-qqbot/utils.js", "module.exports=()=> 'A';\n");
  const readme = await writeDirectFile(task, "hello-qqbot/README.md", "Run with `node index.js`.\n");
  await collectDirect(fx, task, index);
  await collectDirect(fx, task, utils);
  await collectDirect(fx, task, readme);
  const stagedBefore = await fsp.readFile(path.join(fx.service.getTaskForTest(task.taskId)!.stagingRoot!, "hello-qqbot", "index.js"), "utf8");
  await fsp.writeFile(index, "const u=require('./utils'); console.log(u('B'));\n");
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const zipPath = (plan.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl;
  const zip = await readStoredZip(zipPath);
  assert.equal(zip.get("hello-qqbot/index.js")?.toString("utf8"), stagedBefore);
  assert.equal(zip.get("hello-qqbot/index.js")?.toString("utf8").includes("B"), false);
});

test("V1.1.1 concurrent task ZIPs do not mix files", async (t) => {
  const fx = await fixture(t);
  const a = await createDirectInbound(fx, { messageId: "mix-a", target: "qqbot:group:a" });
  const b = await createDirectInbound(fx, { messageId: "mix-b", target: "qqbot:group:b" });
  for (const [task, label] of [[a, "A"], [b, "B"]] as const) {
    await collectDirect(fx, task, await writeDirectFile(task, "hello-qqbot/index.js", `const u=require('./utils'); console.log(u('${label}'));\n`));
    await collectDirect(fx, task, await writeDirectFile(task, "hello-qqbot/utils.js", `module.exports=()=> '${label}';\n`));
    await collectDirect(fx, task, await writeDirectFile(task, "hello-qqbot/README.md", `Run ${label}.\n`));
  }
  const pa = await fx.service.prepareDirectTurn({ taskId: a.taskId, originMessageId: a.messageId });
  const pb = await fx.service.prepareDirectTurn({ taskId: b.taskId, originMessageId: b.messageId });
  const za = await readStoredZip((pa.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl);
  const zb = await readStoredZip((pb.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl);
  assert.match(za.get("hello-qqbot/index.js")!.toString("utf8"), /'A'/);
  assert.doesNotMatch(za.get("hello-qqbot/index.js")!.toString("utf8"), /'B'/);
  assert.match(zb.get("hello-qqbot/index.js")!.toString("utf8"), /'B'/);
  assert.doesNotMatch(zb.get("hello-qqbot/index.js")!.toString("utf8"), /'A'/);
});

test("V1.1.1 manifest and SHA256 match per-task staging", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file);
  await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const state = fx.service.getTaskForTest(task.taskId)!;
  const staged = path.join(state.stagingRoot!, "one.txt");
  const stagedSha = crypto.createHash("sha256").update(await fsp.readFile(staged)).digest("hex");
  assert.equal(state.generatedFiles[0].sha256, stagedSha);
  const manifest = JSON.parse(await fsp.readFile(state.artifactManifest!, "utf8")) as { sourceFiles: Array<{ path: string; sha256: string }> };
  assert.equal(manifest.sourceFiles[0].path, "one.txt");
  assert.equal(manifest.sourceFiles[0].sha256, stagedSha);
});

test("V1.1.1 pending staging survives service reload", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "one.txt", "one\n"));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const media = (plan.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl;
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: media, ok: false, error: "offline" });
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "offline" });
  const reloaded = new AgentTaskDeliveryService({ stateRoot: fx.stateRoot, artifactRoot: fx.artifactRoot });
  await reloaded.configureAccount(ACCOUNT, SECRET);
  const state = reloaded.getTaskForTest(task.taskId)!;
  assert.equal(await fsp.readFile(path.join(state.stagingRoot!, "one.txt"), "utf8"), "one\n");
  let fileCalls = 0;
  await reloaded.deliverPendingWithInbound({ task: state, accountId: ACCOUNT, target: task.target, requesterId: task.requester, replyToId: "fresh", sendText: async () => {}, sendFile: async (p) => { fileCalls += 1; assert.ok(p.includes(".agent-task-delivery") || p === state.artifactZip); return {}; } });
  assert.equal(fileCalls, 1);
});

test("V1.1.1 workspace traversal remains fail-closed", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  const outside = path.join(fx.root, "outside.txt");
  await fsp.writeFile(outside, "outside\n");
  const result = await collectDirect(fx, task, outside);
  assert.equal(result.accepted, false);
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "requires_review");
});

test("V1.1.1 source and staging reparse checks stay wired", async () => {
  const source = await fsp.readFile(new URL("../../src/agent-task-delivery.ts", import.meta.url), "utf8");
  assert.match(source, /direct_file_reparse_point/);
  assert.match(source, /source_workspace_reparse_point/);
  assert.match(source, /staging_reparse_point/);
  assert.match(source, /isSymbolicLink\(\)/);
});

test("V1.1.1 duplicate path with changed content requires review", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file);
  await fsp.writeFile(file, "two\n");
  const second = await collectDirect(fx, task, file);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "direct_file_path_content_conflict");
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "requires_review");
});

// Legacy custom-host contract (JSON delivery-queue files + pending_claim recovery state).
// NOT part of the independent plugin release: official OpenClaw 2026.6.x keeps the queue in
// SQLite and has no pending_claim state, so against it both tests fail (0/2, see
// docs/LEGACY-HOST-CONTRACT.md). Assertions are kept unchanged as the contract record;
// set QQBOT_OPENCLAW_RUNTIME_TESTS=1 to run them against a host that claims this contract.
const hostRuntimeSkip = process.env.QQBOT_OPENCLAW_RUNTIME_TESTS === "1"
  ? false
  : "legacy custom-host contract, not supported by the independent release (set QQBOT_OPENCLAW_RUNTIME_TESTS=1 to run)";

test("V1.1.1 runtime queue missing replyToId is marked pending_claim without upload", { skip: hostRuntimeSkip }, async (t) => {
  const fx = await fixture(t);
  const queueDir = path.join(fx.root, "delivery-queue");
  await fsp.mkdir(queueDir, { recursive: true });
  const entry = { id: "legacy-no-reply", enqueuedAt: Date.now() - 60_000, channel: "qqbot", to: "qqbot:group:fixture", accountId: ACCOUNT, payloads: [{ text: "one" }], retryCount: 0 };
  await fsp.writeFile(path.join(queueDir, `${entry.id}.json`), JSON.stringify(entry, null, 2), "utf8");
  const runtime = await loadCandidateDeliveryQueueRuntime();
  let uploadCalls = 0;
  await runtime.recoverPendingDeliveries({ stateDir: fx.root, cfg: {}, deliver: async () => { uploadCalls += 1; }, log: { info() {}, warn() {}, error() {} } });
  const updated = JSON.parse(await fsp.readFile(path.join(queueDir, `${entry.id}.json`), "utf8")) as { recoveryState?: string; legacyIncompatibleReason?: string };
  assert.equal(uploadCalls, 0);
  assert.equal(updated.recoveryState, "pending_claim");
  assert.equal(updated.legacyIncompatibleReason, "missing_reply_to_id");
});

test("V1.1.1 runtime queue with valid replyToId still recovers", { skip: hostRuntimeSkip }, async (t) => {
  const fx = await fixture(t);
  const queueDir = path.join(fx.root, "delivery-queue");
  await fsp.mkdir(queueDir, { recursive: true });
  const entry = { id: "valid-reply", enqueuedAt: Date.now() - 60_000, channel: "qqbot", to: "qqbot:group:fixture", accountId: ACCOUNT, replyToId: "reply-ok", payloads: [{ text: "one" }], retryCount: 0 };
  await fsp.writeFile(path.join(queueDir, `${entry.id}.json`), JSON.stringify(entry, null, 2), "utf8");
  const runtime = await loadCandidateDeliveryQueueRuntime();
  let uploadCalls = 0;
  await runtime.recoverPendingDeliveries({ stateDir: fx.root, cfg: {}, deliver: async () => { uploadCalls += 1; }, log: { info() {}, warn() {}, error() {} } });
  assert.equal(uploadCalls, 1);
  await assert.rejects(fsp.stat(path.join(queueDir, `${entry.id}.json`)));
});

const statusCases: Array<[string, { kind: string; shortTaskId?: string } | null]> = [
  ["任务状态 ABCD-1234", { kind: "by_id", shortTaskId: "ABCD1234" }],
  ["查看任务 abcdef12", { kind: "by_id", shortTaskId: "ABCDEF12" }],
  ["任务状态", { kind: "by_id", shortTaskId: undefined }],
  ["我的运行中任务", { kind: "running" }],
  ["我的待交付任务", { kind: "pending" }],
  ["@机器人 我的运行中任务", { kind: "running" }],
  ["普通消息", null],
  ["任务状态 !!", null],
];

for (const [text, expected] of statusCases) {
  test(`status parser: ${text}`, () => {
    const service = new AgentTaskDeliveryService();
    assert.deepEqual(service.parseStatusQuery(text), expected);
  });
}

test("subagent preparation requires the exact inbound message id", async (t) => {
  const fx = await fixture(t);
  await fx.service.registerInbound({ accountId: ACCOUNT, clientSecret: SECRET, targetType: "group", target: "group:a", requesterId: "u", originMessageId: "m-exact", receivedAt: new Date().toISOString(), parentSessionKey: "p" });
  assert.equal(await fx.service.prepareSubagent({ originMessageId: "m-other", accountId: ACCOUNT, childSessionKey: "c" }), undefined);
});

test("initial acknowledgement is emitted once through the supplied passive closure", async (t) => {
  const fx = await fixture(t);
  const messages: string[] = [];
  const task = await createTask(fx, { messageId: "m-initial", sendInitial: async (text) => { messages.push(text); } });
  await fx.service.prepareSubagent({ originMessageId: task.messageId, accountId: ACCOUNT, childSessionKey: "second" });
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, new RegExp(task.shortTaskId));
});

test("input attachments are copied into the isolated inputs directory", async (t) => {
  const fx = await fixture(t);
  const input = path.join(fx.root, "input document.txt");
  await fsp.writeFile(input, "fixture", "utf8");
  const task = await createTask(fx, { inputFiles: [input] });
  assert.equal(await fsp.readFile(path.join(task.workspaceRoot, "inputs", "input_document.txt"), "utf8"), "fixture");
});

test("persisted state encrypts raw delivery identifiers", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx, { messageId: "raw-message-secret", target: "group:raw-target", requester: "raw-user" });
  const raw = await fsp.readFile(path.join(fx.stateRoot, `${task.taskId}.json`), "utf8");
  assert.equal(raw.includes("raw-message-secret"), false);
  assert.equal(raw.includes("group:raw-target"), false);
  assert.equal(raw.includes("raw-user"), false);
  assert.match(raw, /"retentionUntil"/);
});

test("state reload restores child-run correlation after process recreation", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const reloaded = new AgentTaskDeliveryService({ stateRoot: fx.stateRoot, artifactRoot: fx.artifactRoot });
  await reloaded.configureAccount(ACCOUNT, SECRET);
  const plan = await reloaded.prepareCompletion({ childRunId: task.childRunId, channel: "qqbot", accountId: ACCOUNT, target: task.target, resultText: "reloaded" });
  assert.equal(plan.handled, true);
  assert.equal(plan.replyToId, task.messageId);
});

test("corrupt state is skipped without preventing valid account initialization", async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(path.join(fx.stateRoot, "corrupt.json"), "{broken", "utf8");
  const service = new AgentTaskDeliveryService({ stateRoot: fx.stateRoot, artifactRoot: fx.artifactRoot });
  await service.configureAccount(ACCOUNT, SECRET);
  assert.equal((await service.queryStatuses({ accountId: ACCOUNT, target: "group:x", requesterId: "u", kind: "running" })).length, 0);
});

test("task queries isolate requesters in the same group", async (t) => {
  const fx = await fixture(t);
  await createTask(fx, { target: "group:same", requester: "user-a" });
  assert.equal((await fx.service.queryStatuses({ accountId: ACCOUNT, target: "group:same", requesterId: "user-b", kind: "running" })).length, 0);
  assert.equal((await fx.service.queryStatuses({ accountId: ACCOUNT, target: "group:same", requesterId: "user-a", kind: "running" })).length, 1);
});

test("task queries isolate conversations for the same requester", async (t) => {
  const fx = await fixture(t);
  await createTask(fx, { target: "group:a", requester: "user-a" });
  assert.equal((await fx.service.queryStatuses({ accountId: ACCOUNT, target: "group:b", requesterId: "user-a", kind: "running" })).length, 0);
});

test("concurrent inbound tasks receive unique workspaces", async (t) => {
  const fx = await fixture(t);
  const [a, b] = await Promise.all([createTask(fx), createTask(fx)]);
  assert.notEqual(a.taskId, b.taskId);
  assert.notEqual(a.workspaceRoot, b.workspaceRoot);
});

test("all registered child runs must complete before delivery", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx, { messageId: "multi-child", childRunId: "child-a" });
  const second = await fx.service.prepareSubagent({ originMessageId: task.messageId, accountId: ACCOUNT, childSessionKey: "session-b" });
  await fx.service.confirmSubagentRun({ taskId: second?.taskId, childRunId: "child-b", childSessionKey: "session-b" });
  await writeSource(task);
  const firstPlan = await fx.service.prepareCompletion({ childRunId: "child-a", channel: "qqbot", accountId: ACCOUNT, target: task.target, resultText: "first" });
  assert.equal(firstPlan.reason, "child_runs_pending");
  const finalPlan = await fx.service.prepareCompletion({ childRunId: "child-b", channel: "qqbot", accountId: ACCOUNT, target: task.target, resultText: "second" });
  assert.equal(finalPlan.replyToId, task.messageId);
});

test("completion context mismatch is retained as pending and never sent proactively", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const plan = await fx.service.prepareCompletion({ childRunId: task.childRunId, channel: "qqbot", accountId: ACCOUNT, target: "group:wrong", resultText: "done" });
  assert.equal(plan.suppressDelivery, true);
  assert.equal(plan.reason, "context_validation_failed");
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "pending_delivery");
});

test("valid completion preserves the exact original reply id", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx, { messageId: "original-reply-id" });
  await writeSource(task);
  const plan = await complete(fx, task);
  assert.equal(plan.suppressDelivery, false);
  assert.equal(plan.replyToId, "original-reply-id");
  assert.equal((plan.payloads?.[0] as { mediaType?: string }).mediaType, "application/zip");
});

test("archive excludes inputs, secrets, caches, logs, backups, and runtime state", async (t) => {
  const fx = await fixture(t);
  const input = path.join(fx.root, "original.txt");
  await fsp.writeFile(input, "input", "utf8");
  const task = await createTask(fx, { inputFiles: [input] });
  await writeSource(task);
  const excluded = [".env", "token.txt", "run.log", "cache/data.txt", "node_modules/x.js", ".git/config", "backup/old.txt", "runtime.sqlite"];
  for (const name of excluded) await writeSource(task, name, "not-a-real-secret\n");
  const plan = await complete(fx, task);
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  assert.equal([...zip.keys()].some((name) => name.startsWith("inputs/")), false);
  for (const name of excluded) assert.equal(zip.has(name), false, name);
  assert.equal(zip.has("src/main.js"), true);
});

test("archive synthesizes README and dependency guidance when absent", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const plan = await complete(fx, task);
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  assert.match(zip.get("README.md")!.toString("utf8"), /Environment and installation/);
  assert.equal(zip.has("DEPENDENCIES.md"), true);
});

test("existing README is conservatively augmented with required operational sections", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "README.md", "# Existing project\n\nOriginal details.\n");
  await writeSource(task);
  const plan = await complete(fx, task);
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  const readme = zip.get("README.md")!.toString("utf8");
  assert.match(readme, /Original details/);
  assert.match(readme, /## Limitations/);
});

test("existing package manifest is preserved and suppresses fallback dependency note", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "package.json", "{\"scripts\":{\"test\":\"node --test\"}}\n");
  const plan = await complete(fx, task);
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  assert.equal(zip.has("package.json"), true);
  assert.equal(zip.has("DEPENDENCIES.md"), false);
});

test("single DOCX uses direct_file without generating a ZIP", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await fsp.writeFile(path.join(task.workspaceRoot, "report.docx"), Buffer.from("fixture-docx"));
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "direct_file");
  assert.equal(state.artifactZip, undefined);
  assert.equal(state.deliverableCount, 1);
  assert.equal((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl, path.join(task.workspaceRoot, "report.docx"));
  assert.equal(state.generatedFiles.some((entry) => entry.path.toLowerCase() === "readme.md"), false);
});

test("single PDF uses direct_file", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await fsp.writeFile(path.join(task.workspaceRoot, "report.pdf"), Buffer.from("%PDF-fixture"));
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "direct_file");
  assert.equal((plan.payloads?.[0] as { mediaType: string }).mediaType, "application/pdf");
});

test("single source file is sent directly", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "main.cpp", "int main() { return 0; }\n");
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "direct_file");
  assert.equal(path.basename((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl), "main.cpp");
});

test("three independent small files use multiple_files", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "alpha.txt", "alpha\n");
  await writeSource(task, "beta.md", "beta\n");
  await fsp.writeFile(path.join(task.workspaceRoot, "gamma.pdf"), Buffer.from("%PDF-fixture"));
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "multiple_files");
  assert.equal(state.deliverableCount, 3);
  assert.equal(plan.payloads?.length, 4);
});

test("multi-file project uses archive", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "src/main.js", "console.log('ok');\n");
  await writeSource(task, "package.json", "{\"scripts\":{\"start\":\"node src/main.js\"}}\n");
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "archive");
  assert.equal((plan.payloads?.[0] as { mediaType: string }).mediaType, "application/zip");
});

test("project archive preserves relative directory structure", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "src/lib/main.js", "export default true;\n");
  const plan = await complete(fx, task);
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  assert.equal(zip.has("src/lib/main.js"), true);
});

test("single large file within the platform limit keeps its original format", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await fsp.writeFile(path.join(task.workspaceRoot, "large.pdf"), Buffer.alloc(2 * 1024 * 1024, 1));
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "direct_file");
  assert.equal(path.extname((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl), ".pdf");
});

test("explicit ZIP request uses archive for a single document", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx, { requestedDeliveryMode: "archive" });
  await fsp.writeFile(path.join(task.workspaceRoot, "report.docx"), Buffer.from("fixture-docx"));
  const plan = await complete(fx, task);
  const state = fx.service.getTaskForTest(task.taskId)!;
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  assert.equal(state.deliveryMode, "archive");
  assert.equal(zip.has("report.docx"), true);
  assert.equal(zip.has("README.md"), false);
});

test("README is required for a project but not for a self-explanatory single file", async (t) => {
  const directFx = await fixture(t);
  const directTask = await createTask(directFx);
  await fsp.writeFile(path.join(directTask.workspaceRoot, "report.pdf"), Buffer.from("%PDF-fixture"));
  await complete(directFx, directTask);
  assert.equal(directFx.service.getTaskForTest(directTask.taskId)!.generatedFiles.some((entry) => entry.path === "README.md"), false);

  const projectFx = await fixture(t);
  const projectTask = await createTask(projectFx);
  await writeSource(projectTask, "src/main.py", "print('ok')\n");
  const projectPlan = await complete(projectFx, projectTask);
  const zip = await readStoredZip((projectPlan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  assert.equal(zip.has("README.md"), true);
});

test("multiple_files retry sends only files that were not already delivered", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  for (const name of ["one.txt", "two.txt", "three.txt"]) await writeSource(task, name, `${name}\n`);
  const plan = await complete(fx, task);
  const filePayloads = (plan.payloads ?? []).filter((payload) => typeof (payload as { mediaUrl?: unknown }).mediaUrl === "string") as Array<{ mediaUrl: string }>;
  assert.equal(filePayloads.length, 3);
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: filePayloads[0].mediaUrl, ok: true, platformReceipt: "receipt-1" });
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "second file failed" });

  const sent: string[] = [];
  const delivered = await fx.service.deliverPendingWithInbound({
    task: fx.service.getTaskForTest(task.taskId)!, accountId: ACCOUNT, target: task.target,
    requesterId: task.requester, replyToId: "fresh-reply", sendText: async () => {},
    sendFile: async (filePath) => { sent.push(path.basename(filePath)); return {}; },
  });
  assert.equal(delivered, true);
  assert.deepEqual(sent.sort(), ["three.txt", "two.txt"]);
});

test("direct_file failure enters pending_delivery", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await fsp.writeFile(path.join(task.workspaceRoot, "report.pdf"), Buffer.from("%PDF-fixture"));
  const plan = await complete(fx, task);
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "platform denied" });
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryMode, "direct_file");
  assert.equal(state.deliveryState, "pending_delivery");
  assert.equal(state.deliverables[0].deliveryState, "failed");
});

test("all automatic delivery modes retain an exact passive reply context", async (t) => {
  const cases: Array<{ kind: string; write(task: Awaited<ReturnType<typeof createTask>>): Promise<void> }> = [
    { kind: "text_only", write: async () => {} },
    { kind: "direct_file", write: async (task) => { await writeSource(task, "one.txt", "one\n"); } },
    { kind: "multiple_files", write: async (task) => { await writeSource(task, "one.txt", "one\n"); await writeSource(task, "two.txt", "two\n"); } },
    { kind: "archive", write: async (task) => { await writeSource(task, "src/main.js", "console.log('ok');\n"); } },
  ];
  for (const entry of cases) {
    const fx = await fixture(t);
    const task = await createTask(fx, { messageId: `reply-${entry.kind}` });
    await entry.write(task);
    const plan = await complete(fx, task, "completed text");
    assert.equal(fx.service.getTaskForTest(task.taskId)!.deliveryMode, entry.kind);
    assert.equal(plan.replyToId, `reply-${entry.kind}`);
  }
});

test("suspected credentials stop automatic delivery and require review", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  const syntheticCredential = `sk-${"A".repeat(30)}`;
  await writeSource(task, "config.js", `const api_key = '${syntheticCredential}';\n`);
  const plan = await complete(fx, task);
  assert.equal(plan.suppressDelivery, true);
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "requires_review");

  const binaryFx = await fixture(t);
  const binaryTask = await createTask(binaryFx);
  await fsp.writeFile(path.join(binaryTask.workspaceRoot, "report.pdf"), Buffer.from(`%PDF ${syntheticCredential}`));
  const binaryPlan = await complete(binaryFx, binaryTask);
  assert.equal(binaryPlan.suppressDelivery, true);
  assert.equal(binaryFx.service.getTaskForTest(binaryTask.taskId)?.deliveryMode, "requires_review");
});

test("absolute host paths stop automatic delivery", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "README.md", "Use D:\\Dev\\Private\\file.txt\n");
  const plan = await complete(fx, task);
  assert.equal(plan.suppressDelivery, true);
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "requires_review");
});

test("unknown binary file types stop automatic delivery", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  await fsp.writeFile(path.join(task.workspaceRoot, "unknown.exe"), Buffer.from([0, 1, 2]));
  const plan = await complete(fx, task);
  assert.equal(plan.suppressDelivery, true);
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "requires_review");
});

test("long result text is capped in state and stored by reference", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  await complete(fx, task, "x".repeat(20_000));
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.ok((state.resultText?.length ?? 0) <= 12_000);
  assert.ok(state.resultRef);
  assert.equal((await fsp.stat(state.resultRef!)).isFile(), true);
});

test("successful delivery consumes idempotency and suppresses duplicate completion", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const plan = await complete(fx, task);
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: true });
  const duplicate = await complete(fx, task);
  assert.equal(duplicate.suppressDelivery, true);
  assert.equal(duplicate.reason, "already_delivered");
});

test("failed outbound delivery becomes pending and a duplicate completion does not retry", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const plan = await complete(fx, task);
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "platform denied" });
  const duplicate = await complete(fx, task);
  assert.equal(duplicate.reason, "awaiting_new_inbound_context");
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "pending_delivery");
});

test("uncertain delivering state is fail-closed on duplicate completion", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  await complete(fx, task);
  const duplicate = await complete(fx, task);
  assert.equal(duplicate.reason, "delivery_state_uncertain");
  assert.equal(duplicate.suppressDelivery, true);
});

test("pending artifact can be delivered only through a fresh exact inbound context", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const plan = await complete(fx, task);
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "passive window closed" });
  const state = fx.service.getTaskForTest(task.taskId)!;
  let textCalls = 0;
  let fileCalls = 0;
  const delivered = await fx.service.deliverPendingWithInbound({
    task: state,
    accountId: ACCOUNT,
    target: task.target,
    requesterId: task.requester,
    replyToId: "fresh-message-id",
    sendText: async () => { textCalls += 1; },
    sendFile: async (filePath) => { fileCalls += 1; assert.equal(filePath, state.artifactZip); return {}; },
  });
  assert.equal(delivered, true);
  assert.equal(textCalls, 1);
  assert.equal(fileCalls, 1);
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "delivered");
});

test("wrong requester cannot claim a pending artifact", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task);
  const plan = await complete(fx, task);
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "denied" });
  const state = fx.service.getTaskForTest(task.taskId)!;
  const delivered = await fx.service.deliverPendingWithInbound({ task: state, accountId: ACCOUNT, target: task.target, requesterId: "other-user", replyToId: "fresh", sendText: async () => {}, sendFile: async () => ({}) });
  assert.equal(delivered, false);
});

test("delivery manifest describes every generated deliverable with sha256", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx);
  await writeSource(task, "src/a.txt", "alpha\n");
  const plan = await complete(fx, task);
  const zip = await readStoredZip((plan.payloads?.[0] as { mediaUrl: string }).mediaUrl);
  const manifest = JSON.parse(zip.get("DELIVERY-MANIFEST.json")!.toString("utf8")) as { files: Array<{ path: string; sha256: string }> };
  const source = manifest.files.find((entry) => entry.path === "src/a.txt");
  assert.equal(source?.sha256, crypto.createHash("sha256").update("alpha\n").digest("hex"));
});

test("artifact directories use hashes rather than raw account or conversation identifiers", async (t) => {
  const fx = await fixture(t);
  const task = await createTask(fx, { target: "group:private-raw-id" });
  await writeSource(task);
  const plan = await complete(fx, task);
  const mediaUrl = (plan.payloads?.[0] as { mediaUrl: string }).mediaUrl;
  assert.equal(mediaUrl.includes(ACCOUNT), false);
  assert.equal(mediaUrl.includes("private-raw-id"), false);
});

test("source wiring keeps status queries read-only and blocks proactive text fallback", async () => {
  const moduleSource = await fsp.readFile(new URL("../../src/agent-task-delivery.ts", import.meta.url), "utf8");
  const outboundSource = await fsp.readFile(new URL("../../src/outbound.ts", import.meta.url), "utf8");
  const handler = moduleSource.slice(moduleSource.indexOf("export async function handleAgentTaskStatusQuery"), moduleSource.indexOf("const bridge:"));
  assert.equal(handler.includes("deliverPendingWithInbound"), false);
  assert.equal(handler.includes("sendFile"), false);
  assert.equal(moduleSource.includes("sendProactiveGroupMessage"), false);
  assert.equal(outboundSource.includes("replyToId = null"), false);
  assert.match(outboundSource, /proactive fallback blocked/);
});

test("existing document parser still preprocesses a downloaded text attachment offline", async (t) => {
  const fx = await fixture(t);
  const documentPath = path.join(fx.root, "document.txt");
  await fsp.writeFile(documentPath, "document-parser-fixture", "utf8");
  const context = buildDocumentContext([documentPath], undefined, { trustedRoot: fx.root });
  assert.match(context, /document-parser-fixture/);
  assert.match(context, /document\.txt/);
});

test("group task gate still requires a real mention", () => {
  const result = resolveGroupMessageGate({ ignoreOtherMentions: true, hasAnyMention: false, wasMentioned: false, implicitMention: false, allowTextCommands: false, isControlCommand: false, commandAuthorized: false, requireMention: true, canDetectMention: true });
  assert.equal(result.action, "skip_no_mention");
});

test("group task gate passes a real bot mention", () => {
  const result = resolveGroupMessageGate({ ignoreOtherMentions: true, hasAnyMention: true, wasMentioned: true, implicitMention: false, allowTextCommands: false, isControlCommand: false, commandAuthorized: false, requireMention: true, canDetectMention: true });
  assert.equal(result.action, "pass");
});

test("group task gate rejects a mention of somebody else", () => {
  const result = resolveGroupMessageGate({ ignoreOtherMentions: true, hasAnyMention: true, wasMentioned: false, implicitMention: false, allowTextCommands: false, isControlCommand: false, commandAuthorized: false, requireMention: true, canDetectMention: true });
  assert.equal(result.action, "drop_other_mention");
});

test("group task gate keeps unauthorized commands blocked", () => {
  const result = resolveGroupMessageGate({ ignoreOtherMentions: true, hasAnyMention: false, wasMentioned: false, implicitMention: false, allowTextCommands: true, isControlCommand: true, commandAuthorized: false, requireMention: true, canDetectMention: true });
  assert.equal(result.action, "block_unauthorized_command");
});

test("existing group sidepath guard remains fail-closed for browser, exec, and missing web_fetch context", () => {
  const context = { agentId: "qq-group-pro", channel: "qqbot", chatType: "group", groupId: "allowed-group", wasMentioned: true, userText: "搜索版本更新时间" };
  assert.equal(evaluateGroupSearchGuard(context, "browser", true).denyReason, "sidepath_blocked_browser");
  assert.equal(evaluateGroupSearchGuard(context, "exec", true).denyReason, "sidepath_blocked_exec");
  assert.equal(evaluateGroupSearchGuard({}, "web_fetch", true).denyReason, "missing_context");
});

test("V1.1 direct Agent single DOCX uses direct_file", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  const file = await writeDirectFile(task, "report.docx", Buffer.from("fixture-docx"));
  assert.equal((await collectDirect(fx, task, file)).accepted, true);
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId, resultText: "done" });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryMode, "direct_file");
  assert.equal(path.extname((plan.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl), ".docx");
});

test("V1.1 direct Agent single source file uses direct_file", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  const file = await writeDirectFile(task, "main.cpp", "int main(){return 0;}\n");
  await collectDirect(fx, task, file); await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryMode, "direct_file");
});

test("V1.1 three independent direct files use multiple_files", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  for (const name of ["report.txt", "data.csv", "chart.png"]) await collectDirect(fx, task, await writeDirectFile(task, name, name));
  await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryMode, "multiple_files");
});

test("V1.1 index.js utils.js README.md project uses archive", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "index.js", "const u=require('./utils'); console.log(u());\n"));
  await collectDirect(fx, task, await writeDirectFile(task, "utils.js", "module.exports=()=> 'ok';\n"));
  await collectDirect(fx, task, await writeDirectFile(task, "README.md", "Run with `node index.js`.\n"));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryMode, "archive");
  assert.equal((plan.payloads ?? []).filter((payload) => payload.mediaUrl).length, 1);
});

test("V1.1 require relationship triggers archive without README", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "index.js", "require('./utils.js');\n"));
  await collectDirect(fx, task, await writeDirectFile(task, "utils.js", "module.exports = 1;\n"));
  await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryMode, "archive");
});

test("V1.1 README unified run step conservatively triggers archive", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  for (const [name, content] of [["a.js", "console.log('a')\n"], ["b.js", "console.log('b')\n"], ["README.md", "Run with node a.js then node b.js.\n"]]) {
    await collectDirect(fx, task, await writeDirectFile(task, name, content));
  }
  await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryMode, "archive");
});

test("V1.1 local qqmedia tag never reaches legacy sender", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  const file = await writeDirectFile(task, "one.txt", "one\n"); let legacyCalls = 0;
  const result = await parseAndSendMediaTags(`<qqmedia>${file}</qqmedia>`, { type: "group", senderId: task.requester, messageId: task.messageId, groupOpenid: "fixture" }, { account: { accountId: ACCOUNT } as never, qualifiedTarget: task.target }, async () => { legacyCalls += 1; throw new Error("network forbidden"); }, () => undefined, { collect: (p, kind) => fx.service.collectDirectFile({ taskId: task.taskId, originMessageId: task.messageId, turnId: task.messageId, filePath: p, sourceKind: kind, workspaceRoot: task.sourceWorkspaceRoot }) });
  assert.equal(result.collectedLocalFiles, 1); assert.equal(legacyCalls, 0);
});

test("V1.1 qqmedia tag becomes a persisted candidate", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "one.txt", "one\n");
  await parseAndSendMediaTags(`<qqmedia>${file}</qqmedia>`, { type: "group", senderId: task.requester, messageId: task.messageId, groupOpenid: "fixture" }, { account: { accountId: ACCOUNT } as never, qualifiedTarget: task.target }, async () => { throw new Error("network forbidden"); }, () => undefined, { collect: (p, kind) => fx.service.collectDirectFile({ taskId: task.taskId, originMessageId: task.messageId, turnId: task.messageId, filePath: p, sourceKind: kind, workspaceRoot: task.sourceWorkspaceRoot }) });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.collectedCandidates?.[0]?.sourceKind, "qqmedia_tag");
});

test("V1.1 channel message send registers before legacy upload", async () => {
  const source = await fsp.readFile(new URL("../../src/channel.ts", import.meta.url), "utf8");
  const start = source.indexOf("sendMedia: async"); const section = source.slice(start, source.indexOf("gateway:", start));
  assert.ok(section.indexOf("collectAgentTaskLocalFile") < section.indexOf("const result = await sendMedia"));
});

test("V1.1 internal trusted delivery uses a lexical closure instead of a forgeable flag", async () => {
  const source = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("const deliverDirectTaskIfAny"), source.indexOf("if (isTaskEligible)"));
  assert.match(section, /sendMediaAuto/); assert.doesNotMatch(section, /trustedDeliveryContext\s*:\s*true|internalDeliveryToken\s*:\s*true/);
});

test("V1.1 duplicate qqmedia registration is idempotent", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file, "qqmedia_tag"); const second = await collectDirect(fx, task, file, "qqmedia_tag");
  assert.equal(second.duplicate, true); assert.equal(fx.service.getTaskForTest(task.taskId)?.collectedCandidates?.length, 1);
});

test("V1.1 message send and qqmedia references to one file deduplicate", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file, "message_send_media"); await collectDirect(fx, task, file, "qqmedia_tag");
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.collectedCandidates?.length, 1); assert.deepEqual(new Set(state.sourceKinds), new Set(["message_send_media", "qqmedia_tag"]));
});

test("V1.1 missing origin reply context suppresses upload", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx, { messageId: " " }); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file); const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: " " });
  assert.equal(plan.suppressDelivery, true); assert.equal(plan.reason, "missing_origin_reply_context");
});

test("V1.1 missing origin reply context becomes pending_delivery", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx, { messageId: " " }); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file); await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: " " });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "pending_delivery");
});

test("V1.1 group direct turn preserves exact inbound reply id", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx, { messageId: "group-origin-exact" }); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file); const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(plan.replyToId, "group-origin-exact");
});

test("V1.1 owner private direct turn preserves exact inbound reply id", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx, { messageId: "private-origin-exact", target: "qqbot:c2c:owner", targetType: "private" }); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file); const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(plan.replyToId, "private-origin-exact");
});

test("V1.1 concurrent groups do not cross turn context", async (t) => {
  const fx = await fixture(t); const a = await createDirectInbound(fx, { target: "qqbot:group:a" }); const b = await createDirectInbound(fx, { target: "qqbot:group:b" });
  await collectDirect(fx, a, await writeDirectFile(a, "a.txt", "a")); await collectDirect(fx, b, await writeDirectFile(b, "b.txt", "b"));
  const [pa, pb] = await Promise.all([fx.service.prepareDirectTurn({ taskId: a.taskId, originMessageId: a.messageId }), fx.service.prepareDirectTurn({ taskId: b.taskId, originMessageId: b.messageId })]);
  assert.equal(pa.replyToId, a.messageId); assert.equal(pb.replyToId, b.messageId);
});

test("V1.1 same group different requesters remain isolated", async (t) => {
  const fx = await fixture(t); const a = await createDirectInbound(fx, { target: "qqbot:group:same", requester: "user-a" }); const b = await createDirectInbound(fx, { target: "qqbot:group:same", requester: "user-b" });
  await collectDirect(fx, a, await writeDirectFile(a, "a.txt", "a")); await collectDirect(fx, b, await writeDirectFile(b, "b.txt", "b"));
  assert.notEqual(fx.service.getTaskForTest(a.taskId)?.requesterHash, fx.service.getTaskForTest(b.taskId)?.requesterHash);
});

test("V1.1 abnormal Agent turn retains candidate as pending", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file); await fx.service.failDirectTurn(task.messageId, "agent failed");
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliveryState, "pending_delivery");
});

test("V1.1 collector flushes only once", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "one.txt", "one\n");
  await collectDirect(fx, task, file); await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId }); const second = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal(second.suppressDelivery, true); assert.equal(second.reason, "collector_already_flushed");
});

test("V1.1 archive emits only one ZIP and no original files", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "index.js", "require('./utils');\n")); await collectDirect(fx, task, await writeDirectFile(task, "utils.js", "module.exports=1;\n"));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId }); const media = (plan.payloads ?? []).filter((payload) => payload.mediaUrl) as Array<{ mediaUrl: string }>;
  assert.equal(media.length, 1); assert.equal(path.extname(media[0].mediaUrl), ".zip");
});

test("V1.1 multiple_files partial failure retries only failed files", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  for (const name of ["one.txt", "two.csv", "three.pdf"]) await collectDirect(fx, task, await writeDirectFile(task, name, name));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId }); const media = (plan.payloads ?? []).filter((p) => p.mediaUrl) as Array<{ mediaUrl: string }>;
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: media[0].mediaUrl, ok: true, platformReceipt: "r1" }); await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "partial" });
  const sent: string[] = []; const state = fx.service.getTaskForTest(task.taskId)!;
  await fx.service.deliverPendingWithInbound({ task: state, accountId: ACCOUNT, target: task.target, requesterId: task.requester, replyToId: "fresh", sendText: async () => {}, sendFile: async (p) => { sent.push(path.basename(p)); return {}; } });
  assert.equal(sent.length, 2); assert.equal(sent.includes(path.basename(media[0].mediaUrl)), false);
});

test("V1.2 fail-closed: pending delivery refuses an empty replyToId", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "one.txt", "one\n"));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const media = (plan.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl;
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: media, ok: false, error: "offline" });
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "offline" });
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryState, "pending_delivery");
  let calls = 0;
  for (const replyToId of ["", "   "]) {
    const delivered = await fx.service.deliverPendingWithInbound({ task: state, accountId: ACCOUNT, target: task.target, requesterId: task.requester, replyToId, sendText: async () => { calls += 1; }, sendFile: async () => { calls += 1; return {}; } });
    assert.equal(delivered, false);
  }
  assert.equal(calls, 0);
  assert.equal(state.deliveryState, "pending_delivery");
  assert.equal(state.deliverables[0].deliveryState, "failed");
});

test("V1.2 fail-closed: a deliverable with unknown outcome is not resent", async (t) => {
  const fx = await fixture(t); const task = await createTask(fx);
  await writeSource(task);
  const plan = await complete(fx, task);
  assert.equal(plan.suppressDelivery, false);
  // Interrupted before any receipt: a duplicate completion moves the task back to
  // pending_delivery, while the deliverable stays "delivering" because nobody knows whether it was sent.
  const retry = await complete(fx, task);
  assert.equal(retry.reason, "delivery_state_uncertain");
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.equal(state.deliveryState, "pending_delivery");
  assert.equal(state.deliverables[0].deliveryState, "delivering");
  let calls = 0;
  const delivered = await fx.service.deliverPendingWithInbound({ task: state, accountId: ACCOUNT, target: task.target, requesterId: task.requester, replyToId: "fresh", sendText: async () => { calls += 1; }, sendFile: async () => { calls += 1; return {}; } });
  assert.equal(delivered, false);
  assert.equal(calls, 0);
  assert.equal(state.deliveryState, "requires_review");
  assert.equal(state.requiresReview, true);
  assert.match(state.lastError ?? "", /delivery_outcome_unknown/);
});

test("V1.2 fail-closed: markDelivery(ok) confirms only deliverables in the current attempt", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  for (const name of ["one.txt", "two.csv"]) await collectDirect(fx, task, await writeDirectFile(task, name, name));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const media = (plan.payloads ?? []).filter((p) => p.mediaUrl) as Array<{ mediaUrl: string }>;
  assert.equal(media.length, 2);
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: media[0].mediaUrl, ok: true, platformReceipt: "r1" });
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: media[1].mediaUrl, ok: false, error: "upload rejected" });
  // A batch-level success must not overwrite the explicit per-file failure.
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: true });
  const state = fx.service.getTaskForTest(task.taskId)!;
  assert.deepEqual(state.deliverables.map((d) => d.deliveryState).sort(), ["delivered", "failed"]);
  assert.equal(state.deliveryState, "pending_delivery");
  assert.equal(state.idempotencyConsumedAt, undefined);
  assert.match(state.lastError ?? "", /delivery_incomplete/);
});

test("V1.1 platform receipt is persisted per deliverable", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "one.txt", "one\n"); await collectDirect(fx, task, file);
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId }); const media = (plan.payloads?.find((p) => p.mediaUrl) as { mediaUrl: string }).mediaUrl;
  await fx.service.markDeliverable({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, mediaUrl: media, ok: true, platformReceipt: "platform-message-id" });
  assert.equal(fx.service.getTaskForTest(task.taskId)?.deliverables[0].platformReceiptHash?.length, 64);
});

test("V1.1 first-group duplicate index scenario is prevented", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "index.js", "console.log('ok');\n");
  await collectDirect(fx, task, file, "message_send_media"); await collectDirect(fx, task, file, "qqmedia_tag"); const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  assert.equal((plan.payloads ?? []).filter((payload) => payload.mediaUrl).length, 1);
});

test("V1.1 failed file cannot leave a misleading filename text receipt", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "README.md", "read me\n"); let textCalls = 0;
  await parseAndSendMediaTags(`README.md\n<qqmedia>${file}</qqmedia>`, { type: "group", senderId: task.requester, messageId: task.messageId, groupOpenid: "fixture" }, { account: { accountId: ACCOUNT } as never, qualifiedTarget: task.target }, async () => { textCalls += 1; throw new Error("network forbidden"); }, () => undefined, { collect: (p, kind) => fx.service.collectDirectFile({ taskId: task.taskId, originMessageId: task.messageId, turnId: task.messageId, filePath: p, sourceKind: kind, workspaceRoot: task.sourceWorkspaceRoot }) });
  assert.equal(textCalls, 0);
});

test("V1.1 multiple_files preflight list does not claim completion before receipts", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx);
  for (const name of ["one.txt", "two.csv", "three.pdf"]) await collectDirect(fx, task, await writeDirectFile(task, name, name));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const preflight = String(plan.payloads?.find((payload) => typeof payload.text === "string" && !payload.mediaUrl)?.text ?? "");
  assert.ok(preflight.length > 0);
  assert.doesNotMatch(preflight, /completed/i);
});

test("V1.1 subagent V1 path remains operational", async (t) => {
  const fx = await fixture(t); const task = await createTask(fx); await writeSource(task, "main.txt", "ok\n"); const plan = await complete(fx, task);
  assert.equal(plan.handled, true); assert.equal(fx.service.getTaskForTest(task.taskId)?.sourceKinds?.includes("subagent_completion"), true);
});

test("V1.1 document parsing regression remains offline", async (t) => {
  const fx = await fixture(t); const file = path.join(fx.root, "doc.md"); await fsp.writeFile(file, "offline document", "utf8");
  assert.match(buildDocumentContext([file], undefined, { trustedRoot: fx.root }), /offline document/);
});

test("V1.1 group guard remains fail-closed", () => {
  assert.equal(resolveGroupMessageGate({ ignoreOtherMentions: true, hasAnyMention: false, wasMentioned: false, implicitMention: false, allowTextCommands: false, isControlCommand: false, commandAuthorized: false, requireMention: true, canDetectMention: true }).action, "skip_no_mention");
});

test("V1.1 web_search limiter still blocks the fourth call", () => {
  const limiter = new TurnSearchCallLimiter(); const identity = { agentId: "qq-group-pro", sessionKey: "lane", turnId: "run" };
  assert.equal(limiter.consume(identity, "web_search", 3).allowed, true); assert.equal(limiter.consume(identity, "web_search", 3).allowed, true); assert.equal(limiter.consume(identity, "web_search", 3).allowed, true); const fourth = limiter.consume(identity, "web_search", 3);
  assert.equal(fourth.allowed, false); assert.equal(fourth.count, 4); assert.equal(fourth.maxCalls, 3);
});

test("V1.1 input_notify remains isolated by best-effort wiring", async () => {
  const gateway = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /runBestEffort/);
  assert.match(gateway, /sendC2CInputNotify/);
});

test("V1.1 delivery interception is scoped to QQBot", async () => {
  const files = ["agent-task-delivery.ts", "channel.ts", "outbound-deliver.ts"];
  for (const file of files) {
    const source = await fsp.readFile(new URL(`../../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*weixin/i);
    assert.doesNotMatch(source, /channels\.weixin/i);
  }
});

test("V1.1 eligible task turns cannot bypass collection through streaming media", async () => {
  const gateway = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  const streaming = await fsp.readFile(new URL("../../src/streaming.ts", import.meta.url), "utf8");
  assert.match(gateway, /localResultInterceptor/);
  assert.match(streaming, /local result collected by Agent Task Delivery V1\.1/);
  assert.match(streaming, /!collectedLocalResult\s*&&\s*this\.deps\.mediaContext/);
});

test("V1.1 ordinary text retains streaming while likely file turns stay static", async () => {
  const gateway = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /const likelyFileDeliveryTurn = isTaskEligible/);
  assert.match(gateway, /shouldUseStreaming\(account, targetType\)\s*&&\s*!likelyFileDeliveryTurn/);
});

test("V1.1 local tool media in the selected Agent workspace joins the collector", async () => {
  const gateway = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /isLocalFilePath\(mediaUrl\)\s*&&\s*isInsideSelectedAgentWorkspace\(mediaUrl\)/);
  assert.match(gateway, /collectDirectResultFile\(mediaUrl,\s*"direct_agent_file"\)/);
});

test("V1.1 block and markdown local results cannot fall back outside the Agent workspace", async () => {
  const gateway = await fsp.readFile(new URL("../../src/gateway.ts", import.meta.url), "utf8");
  const collector = gateway.slice(gateway.indexOf("const collectDirectResultFile"), gateway.indexOf("const deliverDirectTaskIfAny"));
  assert.match(collector, /collectAgentTaskLocalFile/);
  assert.doesNotMatch(collector, /handled:\s*false|not_in_selected_agent_workspace/);
});

test("V1.1 markdown local result is collected before ordinary reply text", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); const file = await writeDirectFile(task, "diagram.png", "not-a-real-image"); let textCalls = 0;
  const result = await sendPlainReply(
    { text: `done\n![diagram](${file})` },
    `done\n![diagram](${file})`,
    { type: "group", senderId: task.requester, messageId: task.messageId, groupOpenid: "fixture" },
    { account: { accountId: ACCOUNT } as never, qualifiedTarget: task.target },
    async () => { textCalls += 1; throw new Error("network forbidden"); },
    () => undefined,
    [],
    { collect: (p, kind) => fx.service.collectDirectFile({ taskId: task.taskId, originMessageId: task.messageId, turnId: task.messageId, filePath: p, sourceKind: kind, workspaceRoot: task.sourceWorkspaceRoot }) },
  );
  assert.equal(result.collectedLocalFiles, 1);
  assert.equal(textCalls, 0);
});

test("V1.1 direct task status includes mode counts and review flag", async (t) => {
  const fx = await fixture(t); const task = await createDirectInbound(fx); await collectDirect(fx, task, await writeDirectFile(task, "one.txt", "one\n")); await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const status = fx.service.formatStatus(fx.service.getTaskForTest(task.taskId)!);
  assert.match(status, /direct_file/); assert.match(status, /1/);
});

test("V1.1.2.1 state serializer preserves failed delivery errors with unsafe text", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "report.md", "hello\n"));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  const unsafe = new Error("line1\n\"quoted\" {\"json\":true} unicode=椎名日和 separator=\u2028 lone=\uD800");
  unsafe.stack = `Error: ${unsafe.message}\n${"at veryLongStack (fixture.js:1:1)\n".repeat(400)}`;
  (fx.service.getTaskForTest(task.taskId)! as unknown as { diagnosticError: Error }).diagnosticError = unsafe;
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: unsafe.message });
  const statePath = path.join(fx.stateRoot, `${task.taskId}.json`);
  const raw = await fsp.readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.deliveryState, "pending_delivery");
  assert.equal((parsed.diagnosticError as { name: string }).name, "Error");
  assert.match((parsed.diagnosticError as { message: string }).message, /quoted/);
  assert.ok(((parsed.diagnosticError as { stack: string }).stack?.length ?? 0) <= 8_050);
});

test("V1.1.2.1 pending delivery state reloads after unsafe error serialization", async (t) => {
  const fx = await fixture(t);
  const task = await createDirectInbound(fx);
  await collectDirect(fx, task, await writeDirectFile(task, "report.md", "hello\n"));
  const plan = await fx.service.prepareDirectTurn({ taskId: task.taskId, originMessageId: task.messageId });
  await fx.service.markDelivery({ taskId: plan.taskId, idempotencyKey: plan.idempotencyKey, ok: false, error: "failed\n\"passive\" {retry:true} ☕" });
  const reloaded = new AgentTaskDeliveryService({ stateRoot: fx.stateRoot, artifactRoot: fx.artifactRoot });
  await reloaded.configureAccount(ACCOUNT, SECRET);
  const restored = reloaded.getTaskForTest(task.taskId);
  assert.equal(restored?.deliveryState, "pending_delivery");
  assert.equal(restored?.status, "pending_delivery");
  assert.match(restored?.lastError ?? "", /passive/);
});

test("V1.1.2.1 corrupt state JSON is preserved and copied for recovery", async (t) => {
  const fx = await fixture(t);
  await fsp.mkdir(fx.stateRoot, { recursive: true });
  const corruptPath = path.join(fx.stateRoot, "bad-state.json");
  await fsp.writeFile(corruptPath, "{ \"schemaVersion\": 2, \"lastError\": \"unterminated }\n", "utf8");
  const warnings: string[] = [];
  const reloaded = new AgentTaskDeliveryService({
    stateRoot: fx.stateRoot,
    artifactRoot: fx.artifactRoot,
    log: { warn: (message) => { warnings.push(String(message)); } },
  });
  await reloaded.configureAccount(ACCOUNT, SECRET);
  assert.equal(await fsp.readFile(corruptPath, "utf8"), "{ \"schemaVersion\": 2, \"lastError\": \"unterminated }\n");
  const corruptCopies = await fsp.readdir(path.join(fx.stateRoot, "corrupt-state"));
  assert.equal(corruptCopies.length, 1);
  const record = await fsp.readFile(path.join(fx.stateRoot, "state.corrupt.jsonl"), "utf8");
  assert.doesNotThrow(() => JSON.parse(record.trim()));
  assert.ok(warnings.some((entry) => /recovered=true/.test(entry)));
});


