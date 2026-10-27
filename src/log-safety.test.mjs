import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { redactId, redactUrl, safeError, sanitizeLogText } from "./utils/log-safe.ts";
import { classify, scanDir, scanSource } from "../scripts/log-safety-scan.mjs";

const srcDir = fileURLToPath(new URL(".", import.meta.url));
const slashCommandsSource = fs.readFileSync(new URL("./slash-commands.ts", import.meta.url), "utf8");

// Synthetic values only; none of these are real credentials or users.
const syntheticOpenid = "A1B2C3D4E5F60718293A4B5C6D7E8F90";
const syntheticSecret = "SYNTHETIC_SECRET_DO_NOT_LOG_4a9c2e7f1b3d";

test("redactId is stable, short, and never returns the raw identifier", () => {
  const a = redactId(syntheticOpenid);
  assert.equal(a, redactId(syntheticOpenid));
  assert.match(a, /^#[0-9a-f]{12}$/);
  assert.equal(a.includes(syntheticOpenid.slice(0, 8)), false);
  assert.equal(redactId(""), "none");
  assert.equal(redactId(undefined), "none");
});

test("redactUrl keeps only scheme and host", () => {
  const url = `https://cos.example.com/upload/${syntheticOpenid}?sign=${syntheticSecret}#frag`;
  assert.equal(redactUrl(url), "https://cos.example.com/…");
  assert.equal(redactUrl("https://bots.qq.com"), "https://bots.qq.com");
  assert.match(redactUrl(`data:image/png;base64,${syntheticSecret}`), /^data:image\/png;len=\d+$/);
  assert.match(redactUrl(`C:\\Users\\someone\\${syntheticOpenid}.png`), /^local:#[0-9a-f]{12}$/);
});

test("safeError keeps type/code/status but drops bodies, secrets, IDs and stack", () => {
  const err = Object.assign(new Error(`API Error [/v2/users/${syntheticOpenid}/messages] token=${syntheticSecret}`), {
    name: "ApiError", status: 403, bizCode: 11241, code: "E_FORBIDDEN",
  });
  const out = safeError(err);
  assert.match(out, /^ApiError\[E_FORBIDDEN\] status=403 bizCode=11241: /);
  assert.equal(out.includes(syntheticOpenid), false);
  assert.equal(out.includes(syntheticSecret), false);
  assert.equal(out.includes("at "), false, "stack frames must not be included");
});

test("safeError handles strings and non-errors without echoing long payloads", () => {
  const text = `upstream said: ${syntheticSecret} ${"x".repeat(400)}`;
  const out = safeError(text);
  assert.equal(out.includes(syntheticSecret), false);
  assert.ok(out.length <= 125, `expected truncated output, got ${out.length} chars`);
  assert.equal(safeError(undefined), "unknown_error");
  assert.equal(safeError(42), "number");
});

test("bot-logs cannot scan and export host log contents through QQ", () => {
  const commandStart = slashCommandsSource.indexOf('name: "bot-logs"');
  const commandEnd = slashCommandsSource.indexOf("// ============ /bot-clear-storage", commandStart);
  assert.notEqual(commandStart, -1);
  assert.notEqual(commandEnd, -1);
  const command = slashCommandsSource.slice(commandStart, commandEnd);
  assert.match(command, /本版本不支持通过 QQ 导出本机日志/);
  assert.doesNotMatch(command, /readFileSync|collectCandidateLogDirs|writeFileSync/);
  assert.doesNotMatch(slashCommandsSource, /function collectCandidateLogDirs|function collectRecentLogFiles/);
});

test("sanitizeLogText removes home-directory user names and URL paths", () => {
  const out = sanitizeLogText("ENOENT: open 'C:\\Users\\alice\\.openclaw\\x.json' via https://api.example.com/v2/a?b=c");
  assert.equal(out.includes("alice"), false);
  assert.equal(out.includes("?b=c"), false);
  assert.match(out, /C:\\Users\\<user>/);
});

test("scanner flags known-unsafe log patterns (guards against a vacuous pass)", () => {
  const bad = [
    "log?.info(`got ${event.content}`);",
    "console.log(`peer=${peerId}`);",
    "log.error(`failed: ${err}`);",
    "console.error(\"failed\", err);",
    "log?.info(`url=${imageUrl}`);",
    "log?.warn?.(`payload=${JSON.stringify(d)}`);",
    "_log?.debug?.(`x ${e.message}`);",
    "appendSearchAudit(`text=${userText}`);",
  ];
  for (const sample of bad) assert.ok(scanSource(sample).length > 0, `scanner missed: ${sample}`);
});

test("scanner accepts the sanctioned safe forms", () => {
  const good = [
    "log?.info(`len=${event.content?.length ?? 0}`);",
    "console.log(`peer=${redactId(peerId)}`);",
    "log.error(`failed: ${safeError(err)}`);",
    "log?.info(`url=${redactUrl(imageUrl)}`);",
    "log?.info(`type=${payload.t}`);",
    "log?.info(`media=${isDataUrl ? \"Base64\" : \"URL\"}`);",
  ];
  for (const sample of good) assert.deepEqual(scanSource(sample), [], `false positive: ${sample}`);
  assert.equal(classify("target.type"), null);
});

// The source-only release deliberately excludes the legacy CLI directory.
// Assert that boundary instead of silently skipping arbitrary missing folders.
const scannedDirs = ["src", "scripts"].map((d) => fileURLToPath(new URL(`../${d}/`, import.meta.url)));

test("source-only release excludes legacy CLI entry points", () => {
  assert.equal(fs.existsSync(new URL("../bin/", import.meta.url)), false);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(Object.hasOwn(pkg, "bin"), false);
});

test("plugin source and scripts have no unsafe log interpolations", () => {
  const findings = scannedDirs.flatMap((dir) => scanDir(dir).map((f) => `${dir}:${f.file}:${f.line} [${f.kind}] ${f.expr}`));
  assert.deepEqual(findings, []);
});

test("every log-safe exemption states a reason", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) { if (!["node_modules", "dist"].includes(ent.name)) walk(p); continue; }
      if (!/\.(ts|mjs|js|cjs)$/.test(ent.name) || /\.test\./.test(ent.name)) continue;
      fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        const m = line.match(/\/\/\s*log-safe:(.*)$/);
        if (m && m[1].trim().length < 15) offenders.push(`${ent.name}:${i + 1}`);
      });
    }
  };
  for (const dir of scannedDirs) walk(dir.replace(/[\\/]$/, ""));
  assert.deepEqual(offenders, []);
});
