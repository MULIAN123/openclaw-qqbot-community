import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDeliveryQueueRuntime } from "./openclaw-delivery-queue-loader.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-delivery-runtime-loader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("loads the hashed queue module only from the supplied plugin node_modules", async (t) => {
  const pluginRoot = await fixture(t);
  const openclawRoot = path.join(pluginRoot, "node_modules", "openclaw");
  const distRoot = path.join(openclawRoot, "dist");
  await fs.mkdir(distRoot, { recursive: true });
  await fs.writeFile(path.join(openclawRoot, "package.json"), JSON.stringify({ name: "openclaw", type: "module" }));
  await fs.writeFile(path.join(distRoot, "delivery-queue-fixture.js"), "async function recoverPendingDeliveries() { return 'isolated-fixture'; }\nexport { recoverPendingDeliveries };\n");

  const runtime = await loadDeliveryQueueRuntime(pluginRoot);
  assert.equal(await runtime.recoverPendingDeliveries({}), "isolated-fixture");
});

test("rejects an OpenClaw junction escaping the supplied plugin root", async (t) => {
  const pluginRoot = await fixture(t);
  const modulesRoot = path.join(pluginRoot, "node_modules");
  const externalRoot = path.join(pluginRoot, "fixture-outside-node-modules");
  await fs.mkdir(modulesRoot, { recursive: true });
  await fs.mkdir(path.join(externalRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(externalRoot, "package.json"), JSON.stringify({ name: "openclaw", type: "module" }));
  await fs.writeFile(path.join(externalRoot, "dist", "delivery-queue-fixture.js"), "export async function i() { return 'must-not-load'; }\n");
  await fs.symlink(externalRoot, path.join(modulesRoot, "openclaw"), "junction");

  await assert.rejects(loadDeliveryQueueRuntime(pluginRoot), /unavailable or unsafe/);
});

async function packageFixture(t, files) {
  const root = await fixture(t);
  const dist = path.join(root, "node_modules", "openclaw", "dist");
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, "..", "package.json"), JSON.stringify({ name: "openclaw", type: "module" }));
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(dist, name), source);
  return { root, dist };
}

const facade = "async function recoverPendingDeliveries() { return 'recovered'; }\nexport { recoverPendingDeliveries };\n";

test("selects the named recovery facade without importing storage or runtime chunks", async (t) => {
  const { root } = await packageFixture(t, {
    "delivery-queue-storage.js": "throw new Error('storage must not be probed'); export function i() {}",
    "delivery-queue-facade.js": facade,
    "delivery-queue-runtime-hash.js": "throw new Error('runtime must not be probed'); export function t() {}",
  });
  const runtime = await loadDeliveryQueueRuntime(root);
  assert.equal(await runtime.recoverPendingDeliveries({}), "recovered");
});

test("rejects two named recovery facades before executing either", async (t) => {
  const source = "throw new Error('must not execute');\n" + facade;
  const { root } = await packageFixture(t, { "delivery-queue-one.js": source, "delivery-queue-two.js": source });
  await assert.rejects(loadDeliveryQueueRuntime(root), /unavailable or unsafe/);
});

test("does not interpret a minified i export as recovery", async (t) => {
  const { root } = await packageFixture(t, { "delivery-queue-old.js": "export function i() { throw new Error('wrong function'); }" });
  await assert.rejects(loadDeliveryQueueRuntime(root), /unavailable or unsafe/);
});

test("rejects a nonfunction recovery export", async (t) => {
  const { root } = await packageFixture(t, { "delivery-queue-invalid.js": "const recoverPendingDeliveries = 1;\nexport { recoverPendingDeliveries };\n" });
  await assert.rejects(loadDeliveryQueueRuntime(root), /unavailable or unsafe/);
});

test("rejects a recovery facade linked outside the local package", async (t) => {
  const { root, dist } = await packageFixture(t, {});
  const external = path.join(root, "external.js");
  await fs.writeFile(external, facade);
  try {
    await fs.symlink(external, path.join(dist, "delivery-queue-linked.js"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("file symlink creation requires Windows privileges");
      return;
    }
    throw error;
  }
  await assert.rejects(loadDeliveryQueueRuntime(root), /unavailable or unsafe/);
});
