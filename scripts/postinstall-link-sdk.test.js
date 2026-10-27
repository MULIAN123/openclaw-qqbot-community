import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSdkLink } from "./sdk-link-safety.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-sdk-link-test-"));
  const pluginRoot = path.join(root, "extensions", "openclaw-qqbot");
  const sdkRoot = path.join(root, "runtime", "openclaw");
  fs.mkdirSync(path.join(pluginRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(sdkRoot, "plugin-sdk"), { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, "plugin-sdk", "core.js"), "export {};\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, pluginRoot, sdkRoot, linkPath: path.join(pluginRoot, "node_modules", "openclaw") };
}

test("keeps a valid SDK directory unchanged", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.linkPath, { recursive: true });
  fs.mkdirSync(path.join(f.linkPath, "plugin-sdk"), { recursive: true });
  fs.writeFileSync(path.join(f.linkPath, "plugin-sdk", "core.js"), "export {};\n");
  assert.equal(ensureSdkLink(f.pluginRoot, f.sdkRoot), "already-valid");
  assert.equal(fs.lstatSync(f.linkPath).isSymbolicLink(), false);
});

test("refuses an incomplete real package without deleting its files", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.linkPath);
  const sentinel = path.join(f.linkPath, "keep.txt");
  fs.writeFileSync(sentinel, "preserve");
  assert.throws(() => ensureSdkLink(f.pluginRoot, f.sdkRoot), /incomplete package/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
});

test("refuses to operate when node_modules itself is a junction, leaving it unchanged", (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.pluginRoot, "node_modules"), { recursive: true });
  fs.symlinkSync(f.sdkRoot, path.join(f.pluginRoot, "node_modules"), "junction");
  assert.throws(() => ensureSdkLink(f.pluginRoot, f.sdkRoot), /node_modules.*link/);
  assert.equal(fs.lstatSync(path.join(f.pluginRoot, "node_modules")).isSymbolicLink(), true);
});

test("keeps a valid openclaw junction unchanged", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.sdkRoot, f.linkPath, "junction");
  assert.equal(ensureSdkLink(f.pluginRoot, f.sdkRoot), "already-valid");
  assert.equal(fs.lstatSync(f.linkPath).isSymbolicLink(), true);
});

test("does not replace a stale junction", (t) => {
  const f = fixture(t);
  const staleTarget = path.join(f.root, "stale-runtime");
  fs.mkdirSync(staleTarget);
  fs.symlinkSync(staleTarget, f.linkPath, "junction");
  assert.throws(() => ensureSdkLink(f.pluginRoot, f.sdkRoot), /stale link/);
  assert.equal(fs.lstatSync(f.linkPath).isSymbolicLink(), true);
});

test("does not operate outside the plugin node_modules boundary", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  assert.throws(() => ensureSdkLink(path.join(f.pluginRoot, "..", "..", "outside"), f.sdkRoot), /invalid plugin root/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("surfaces permission failures without deleting the target", (t) => {
  const f = fixture(t);
  const fsImpl = Object.create(fs);
  fsImpl.symlinkSync = () => { const error = new Error("denied"); error.code = "EPERM"; throw error; };
  assert.throws(() => ensureSdkLink(f.pluginRoot, f.sdkRoot, fsImpl), (error) => error.code === "EPERM");
  assert.equal(fs.existsSync(f.linkPath), false);
});
