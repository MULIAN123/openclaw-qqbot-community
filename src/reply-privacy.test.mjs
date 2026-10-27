// Offline source-level regression: execute the real dispatcher in a VM with
// explicit dependency mocks. No production imports, disk writes or network.
// Gateway coverage executes its exact interaction handler/dispatch branch only;
// this does not claim to boot or integration-test the full Gateway.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";
import * as crypto from "node:crypto";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const strip = (text) => stripTypeScriptTypes(text);
const secret = "虚构提醒内容勿记日志甲乙";
const token = "SYNTHETIC_ONLY_TOKEN_NOT_REAL";
const payload = { type: "cron_reminder", content: secret, targetType: "c2c", targetAddress: secret };
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
const reply = (value) => `QQBOT_PAYLOAD:${JSON.stringify(value)}`;
const captured = () => {
  const lines = [];
  return { lines, log: Object.fromEntries(["info", "debug", "error"].map((level) =>
    [level, (message) => lines.push(`${level}:${message}`)])) };
};
function privateLogs(lines, expected) {
  const output = lines.join("\n");
  for (const value of [secret, token, encoded, Buffer.from(secret).toString("base64")]) {
    assert.equal(output.includes(value), false, "synthetic sensitive value reached logs");
  }
  if (expected) assert.match(output, expected);
}
async function dispatcher({ failSend = false, failRead = false, retry = false } = {}) {
  const context = vm.createContext({ Buffer, URL });
  const sent = [];
  let calls = 0;
  const send = async (...args) => {
    calls++;
    if (retry && calls === 1) throw new Error(`401 ${secret} ${token}`);
    if (failSend) throw Object.assign(new Error(`${secret} ${encoded} ${token}`),
      { name: secret, code: token });
    sent.push(args);
  };
  const apiNames = [...strip(read("./reply-dispatcher.ts"))
    .match(/import \{([^}]+)\} from "\.\/api\.js"/)[1].matchAll(/\b(\w+)\b/g)]
    .map((m) => m[1]);
  const api = Object.fromEntries(apiNames.map((name) => [name, send]));
  api.getAccessToken = async () => token;
  api.clearTokenCache = () => {};
  const sources = {
    "./utils/payload.js": read("./utils/payload.ts"),
    "./utils/log-safe.js": read("./utils/log-safe.ts"),
  };
  const mocks = {
    "node:path": { default: path },
    "node:crypto": { createHash: crypto.createHash },
    "./api.js": api,
    "./utils/audio-convert.js": {
      resolveTTSConfig: () => ({ model: secret }),
      textToSilk: async () => ({ silkPath: secret, silkBase64: encoded, duration: 1 }),
      formatDuration: () => "1s",
    },
    "./utils/file-utils.js": {
      checkFileSize: () => ({ ok: true }), getMaxUploadSize: () => 1000,
      fileExistsAsync: async () => true, formatFileSize: () => "10 B",
      readFileAsync: async () => {
        if (failRead) throw new Error(secret);
        return Buffer.from(secret);
      },
    },
    "./utils/platform.js": {
      getQQBotDataDir: () => "/synthetic-only",
      normalizePath: (p) => p, sanitizeFileName: (p) => p,
    },
  };
  const cache = new Map();
  const linker = async (specifier) => {
    if (cache.has(specifier)) return cache.get(specifier);
    let module;
    if (sources[specifier]) module = new vm.SourceTextModule(strip(sources[specifier]), { context });
    else {
      assert.ok(Object.hasOwn(mocks, specifier), `Unapproved dependency: ${specifier}`);
      const exports = mocks[specifier];
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    }
    cache.set(specifier, module);
    return module;
  };
  const module = new vm.SourceTextModule(strip(read("./reply-dispatcher.ts")), { context });
  await module.link(linker);
  await module.evaluate();
  const logs = captured();
  const ctx = { ...logs, account: { appId: "synthetic-app", clientSecret: token, accountId: "test" },
    target: { type: "c2c", senderId: "synthetic-target", messageId: "synthetic-message" }, cfg: {} };
  return { api: module.namespace, ctx, sent, lines: logs.lines };
}

for (const mode of ["success", "failure", "retry"]) {
  test(`reminder ${mode}: private logs, preserved delivery/activity`, async () => {
    const h = await dispatcher({ failSend: mode === "failure", retry: mode === "retry" });
    let activity = 0;
    assert.equal(await h.api.handleStructuredPayload(h.ctx, reply(payload), () => activity++), true);
    assert.equal(activity, 1);
    assert.equal(h.sent.length, mode === "failure" ? 0 : 1);
    if (h.sent.length) {
      assert.equal(h.sent[0][0], token);
      assert.equal(h.sent[0][1], "synthetic-target");
      assert.equal(h.sent[0][2], `⏰ 提醒已设置，将在指定时间发送: "${secret}"`);
      assert.equal(h.sent[0][3], "synthetic-message");
    }
    privateLogs(h.lines, mode === "failure" ? /cron.*failed/i : /reminder.*sent/i);
  });
}
for (const [name, text] of [
  ["malformed JSON", `QQBOT_PAYLOAD:${secret}`],
  ["unknown type", reply({ type: secret })],
  ["unknown media type", reply({ type: "media", mediaType: secret, source: "url", path: secret })],
]) {
  test(`${name}: no raw parser/type text`, async () => {
    const h = await dispatcher();
    assert.equal(await h.api.handleStructuredPayload(h.ctx, text, () => {}), true);
    assert.equal(h.sent.length, 0);
    privateLogs(h.lines, /error:/);
  });
}
test("ordinary text and activity exceptions keep original semantics", async () => {
  const h = await dispatcher();
  assert.equal(await h.api.handleStructuredPayload(h.ctx, secret, () => assert.fail()), false);
  const error = new Error(secret);
  await assert.rejects(h.api.handleStructuredPayload(h.ctx, reply(payload), () => { throw error; }),
    (actual) => actual === error);
  privateLogs(h.lines);
});
test("error-message delivery failure does not log the caught error", async () => {
  const h = await dispatcher({ failSend: true });
  await h.api.sendErrorToTarget(h.ctx, secret);
  privateLogs(h.lines, /error:/);
});
for (const mediaType of ["image", "audio", "video", "file"]) {
  for (const failSend of [false, true]) {
    test(`${mediaType} ${failSend ? "failure" : "success"} logs preserve privacy`, async () => {
      const h = await dispatcher({ failSend });
      const media = { type: "media", mediaType, source: "url",
        path: `https://example.invalid/${secret}?token=${token}`, caption: secret };
      let activity = 0;
      assert.equal(await h.api.handleStructuredPayload(h.ctx, reply(media), () => activity++), true);
      assert.equal(activity, 1);
      if (!failSend) assert.ok(h.sent.some((args) => args.includes(secret) || args.includes(media.path)));
      privateLogs(h.lines, failSend ? /error:/ : /info:/);
    });
  }
}
test("local image read exception cannot leak document names", async () => {
  const h = await dispatcher({ failRead: true });
  await h.api.handleStructuredPayload(h.ctx,
    reply({ type: "media", mediaType: "image", source: "file", path: `${secret}.png` }), () => {});
  privateLogs(h.lines, /error:/);
});

const gateway = strip(read("./gateway.ts"));
const start = gateway.indexOf("async function handleInteractionCreate(");
const end = gateway.indexOf("// /activation", start);
assert.ok(start >= 0 && end > start, "Gateway handler boundary changed; update harness");
const handlerSource = gateway.slice(start, end);
const branch = gateway.match(/else if \(t === "INTERACTION_CREATE"\) \{([\s\S]*?)\n        \}\n      \};/);
assert.ok(branch, "Gateway dispatch boundary changed; update harness");
for (const mode of ["button", "approval", "missing-handler", "ack-failure", "query", "update", "write-failure"]) {
  test(`interaction ${mode}: real handler/branch with mocked dependencies`, async () => {
    const logs = captured();
    const ack = [], approvals = [], pending = [], writes = [];
    const approvalId = "exec:12345678-abcd-1234-abcd-123456789abc";
    const button = mode === "approval" || mode === "missing-handler"
      ? `approve:${approvalId}:allow-once` : `${secret} ${encoded} ${token}`;
    const event = { id: secret, scene: secret, user_openid: secret, group_openid: secret,
      data: { type: mode === "query" ? 2001 : ["update", "write-failure"].includes(mode) ? 2002 : secret,
        resolved: { button_id: token, button_data: button, claw_cfg: { require_mention: "always" } } } };
    let config = { channels: { qqbot: {} } };
    const sandbox = {
      ...logs, d: event, account: { accountId: "test", appId: "fake", clientSecret: token }, cfg: {},
      INTERACTION_TYPE_CONFIG_QUERY: 2001, INTERACTION_TYPE_CONFIG_UPDATE: 2002,
      getAccessToken: async () => token,
      structuredClone,
      getQQBotRuntime: () => ({ config: {
        loadConfig: () => config,
        writeConfigFile: async (next) => {
          if (mode === "write-failure") throw new Error(secret);
          writes.push(next);
          config = next;
        },
      } }),
      resolveGroupConfig: () => ({ requireMention: false }),
      resolveGroupPolicy: () => "open",
      getApiPluginVersion: () => "synthetic-version",
      getFrameworkVersion: () => "synthetic-framework",
      parseFrameworkDateVersion: () => null,
      resolveMentionPatterns: () => [secret],
      acknowledgeInteraction: async (...args) => {
        if (mode === "ack-failure") throw new Error(secret);
        ack.push(args);
      },
      getApprovalHandler: () => mode === "missing-handler" ? null : {
        resolveApproval: (...args) => approvals.push(args),
      },
      redactId: () => "masked", safeError: (err) => String(err),
    };
    vm.createContext(sandbox);
    vm.runInContext(handlerSource, sandbox);
    const realHandler = sandbox.handleInteractionCreate;
    sandbox.handleInteractionCreate = (...args) => {
      assert.equal(args[0].event, event, "dispatch must preserve the original event");
      const promise = realHandler(...args);
      pending.push(promise);
      return promise;
    };
    vm.runInContext(`(async () => { ${branch[1]} })()`, sandbox);
    await Promise.allSettled(pending);
    await Promise.resolve();
    const failed = ["ack-failure", "write-failure"].includes(mode);
    assert.equal(ack.length, failed ? 0 : 1);
    if (ack.length) assert.equal(ack[0][1], secret, "ACK keeps original interaction ID");
    if (mode === "approval") assert.deepEqual(approvals[0], [approvalId, "allow-once"]);
    else assert.equal(approvals.length, 0);
    assert.equal(writes.length, mode === "update" ? 1 : 0);
    if (mode === "update") assert.equal(config.channels.qqbot.groups[secret].requireMention, false);
    if (mode === "query") assert.equal(ack[0][3].claw_cfg.mention_patterns, secret);
    privateLogs(logs.lines, failed ? /error:/ : /info:/);
    assert.equal(logs.lines.join("\n").includes(button), false);
  });
}
