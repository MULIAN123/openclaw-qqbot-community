import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isRestrictedRemoteAddress, requestPublicUrl } from "./safe-remote-request.ts";

const publicAnswer = [{ address: "93.184.216.34", family: 4 }];

test("rejects DNS failures without making a request", async () => {
  let requests = 0;
  await assert.rejects(requestPublicUrl("https://images.example/a.png", {
    resolveHost: async () => { throw new Error("synthetic DNS failure"); },
    requestTransport: async () => { requests++; return {}; },
  }), /DNS resolution failed/);
  assert.equal(requests, 0);
});

test("rejects private, loopback, link-local, and mixed public/private DNS answers", async () => {
  for (const address of ["10.0.0.2", "127.0.0.1", "169.254.10.2", "::1"]) {
    await assert.rejects(requestPublicUrl("https://images.example/a.png", {
      resolveHost: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      requestTransport: async () => { throw new Error("must not connect"); },
    }), /restricted network address/);
  }
  for (const address of ["::192.168.1.2", "64:ff9b::a00:1", "2002:0a00:0001::1", "2001::1"]) {
    assert.equal(isRestrictedRemoteAddress(address), true, `${address} is a special-use IPv6 range`);
  }
  await assert.rejects(requestPublicUrl("https://images.example/a.png", {
    resolveHost: async () => [...publicAnswer, { address: "192.168.1.2", family: 4 }],
    requestTransport: async () => { throw new Error("must not connect"); },
  }), /restricted network address/);
});

test("aborting while DNS is pending rejects before any socket request", async () => {
  const controller = new AbortController();
  let requested = false;
  const request = requestPublicUrl("https://slow.example/image.png", {
    signal: controller.signal,
    resolveHost: () => new Promise((resolve) => setTimeout(() => resolve(publicAnswer), 100)),
    requestTransport: async () => { requested = true; return {}; },
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(Promise.race([
    request,
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort was not observed during DNS")), 40)),
  ]), /aborted/);
  assert.equal(requested, false);
});

test("pins the actual request lookup to the validated address and does not follow redirects", async () => {
  let calls = 0;
  const response = { statusCode: 302, headers: { location: "http://127.0.0.1/private" } };
  const result = await requestPublicUrl("https://images.example/a.png", {
    resolveHost: async () => publicAnswer,
    requestTransport: async (_url, options) => {
      calls++;
      assert.equal(options.address, "93.184.216.34");
      assert.equal(options.family, 4);
      await new Promise((resolve, reject) => options.lookup("images.example", { family: 4 }, (err, address) => {
        if (err) reject(err); else { assert.equal(address, "93.184.216.34"); resolve(); }
      }));
      return response;
    },
  });
  assert.equal(result, response);
  assert.equal(calls, 1);
});

test("rejects unsafe URL forms before DNS or transport", async () => {
  let lookups = 0;
  for (const url of ["file:///etc/passwd", "ftp://images.example/a", "https://user:pass@images.example/a"]) {
    await assert.rejects(requestPublicUrl(url, {
      resolveHost: async () => { lookups++; return publicAnswer; },
      requestTransport: async () => { throw new Error("must not connect"); },
    }));
  }
  assert.equal(lookups, 0);
});

test("legacy validation helper cannot authorize a hostname request", async () => {
  const legacyGuard = await readFile(new URL("./ssrf-guard.ts", import.meta.url), "utf8");
  assert.match(legacyGuard, /Hostname preflight is not a safe connection boundary; use requestPublicUrl/);
  assert.doesNotMatch(legacyGuard, /dns\.resolve|dns\.lookup/);
});
