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
  await fs.writeFile(path.join(distRoot, "delivery-queue-fixture.js"), "export async function i() { return 'isolated-fixture'; }\n");

  const runtime = await loadDeliveryQueueRuntime(pluginRoot);
  assert.equal(await runtime.i({}), "isolated-fixture");
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
