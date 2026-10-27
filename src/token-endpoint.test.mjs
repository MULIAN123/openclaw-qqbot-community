import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { noRedirectRequestInit, resolveApiBaseUrl, resolveCredentialServiceBaseUrl, resolveTokenEndpoint } from "./token-endpoint.ts";

test("uses the official token endpoint by default", () => {
  assert.equal(resolveTokenEndpoint(undefined), "https://bots.qq.com/app/getAppAccessToken");
});

test("rejects HTTP, arbitrary hosts, credentials, paths, query, and fragments", () => {
  for (const value of [
    "http://bots.qq.com", "https://evil.example", "https://user@bots.qq.com",
    "https://bots.qq.com/other", "https://bots.qq.com?x=1", "https://bots.qq.com#x",
  ]) assert.throws(() => resolveTokenEndpoint(value));
});

test("allows localhost only with explicit test mode opt-in", () => {
  assert.throws(() => resolveTokenEndpoint("http://127.0.0.1:9000"));
  assert.equal(resolveTokenEndpoint("http://127.0.0.1:9000", {
    allowLocalTestEndpoint: true, nodeEnv: "test",
  }), "http://127.0.0.1:9000/app/getAppAccessToken");
  assert.throws(() => resolveTokenEndpoint("http://127.0.0.1:9000", {
    allowLocalTestEndpoint: true, nodeEnv: "production",
  }));
  assert.throws(() => resolveTokenEndpoint("http://localhost.evil:9000", {
    allowLocalTestEndpoint: true, nodeEnv: "test",
  }));
});

test("restricts QQ API requests to official origin or explicit localhost test origin", () => {
  assert.equal(resolveApiBaseUrl(undefined), "https://api.sgroup.qq.com");
  for (const value of [
    "http://api.sgroup.qq.com", "https://evil.example", "https://user@api.sgroup.qq.com",
    "https://api.sgroup.qq.com/other", "https://api.sgroup.qq.com?x=1", "https://api.sgroup.qq.com#x",
  ]) assert.throws(() => resolveApiBaseUrl(value));
  assert.throws(() => resolveApiBaseUrl("http://127.0.0.1:9000"));
  assert.equal(resolveApiBaseUrl("http://127.0.0.1:9000", {
    allowLocalTestEndpoint: true, nodeEnv: "test",
  }), "http://127.0.0.1:9000");
  assert.throws(() => resolveApiBaseUrl("http://127.0.0.1:9000", {
    allowLocalTestEndpoint: true, nodeEnv: "production",
  }));
});

test("credential-bearing QQ API requests never follow redirects", () => {
  const options = noRedirectRequestInit({ method: "POST", headers: { Authorization: "QQBot synthetic" } });
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST");
});

test("credential-bearing request call sites apply the no-redirect policy", async () => {
  const [api, channelTool, stt, audio, chunkedUpload] = await Promise.all([
    readFile(new URL("./api.ts", import.meta.url), "utf8"),
    readFile(new URL("./tools/channel.ts", import.meta.url), "utf8"),
    readFile(new URL("./stt.ts", import.meta.url), "utf8"),
    readFile(new URL("./utils/audio-convert.ts", import.meta.url), "utf8"),
    readFile(new URL("./utils/chunked-upload.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(/fetch\(url, noRedirectRequestInit\(options\)\)/.test(api), true);
  assert.equal(/redirect:\s*"error"/.test(api), true);
  assert.equal(/fetch\(url, noRedirectRequestInit\(fetchOptions\)\)/.test(channelTool), true);
  assert.equal(/fetch\(`\$\{baseUrl\}\/audio\/transcriptions`, noRedirectRequestInit\(/.test(stt), true);
  assert.equal(/fetch\(url, noRedirectRequestInit\(/.test(audio), true);
  assert.equal(/fetch\(presignedUrl, \{[\s\S]{0,80}redirect:\s*"error"/.test(chunkedUpload), true);
});

test("credential service endpoints require HTTPS and reject embedded credentials", () => {
  assert.equal(resolveCredentialServiceBaseUrl("https://api.example/v1/"), "https://api.example/v1");
  for (const url of ["http://api.example/v1", "https://user:pass@api.example/v1", "https://api.example/v1?next=other", "https://api.example/v1#fragment"]) {
    assert.throws(() => resolveCredentialServiceBaseUrl(url), /HTTPS credential endpoint/);
  }
});

test("OCR URL and Bearer request call sites use the constrained target and redirect policy", async () => {
  const ocrSource = await readFile(new URL("./ocr.ts", import.meta.url), "utf8");
  const sttSource = await readFile(new URL("./stt.ts", import.meta.url), "utf8");
  const ttsSource = await readFile(new URL("./utils/audio-convert.ts", import.meta.url), "utf8");
  assert.equal(/requestPublicUrl\(input\.url/.test(ocrSource), true);
  assert.equal(/noRedirectRequestInit\(/.test(ocrSource), true);
  assert.equal(/resolveCredentialServiceBaseUrl\(/.test(sttSource), true);
  assert.equal(/noRedirectRequestInit\(/.test(sttSource), true);
  assert.equal(/resolveCredentialServiceBaseUrl\(/.test(ttsSource), true);
  assert.equal(/noRedirectRequestInit\(/.test(ttsSource), true);
});
