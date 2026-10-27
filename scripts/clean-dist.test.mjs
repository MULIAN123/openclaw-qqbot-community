import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanBuildOutput } from "./clean-dist.mjs";

const validationRoot = fileURLToPath(new URL("../../../.validation/clean-dist", import.meta.url));
fs.mkdirSync(validationRoot, { recursive: true });

test("cleanBuildOutput removes only a real dist directory inside the supplied package root", () => {
  const root = fs.mkdtempSync(path.join(validationRoot, "fixture-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "stale.js"), "synthetic");
    cleanBuildOutput(root);
    assert.equal(fs.existsSync(dist), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanBuildOutput refuses a file at the dist path", () => {
  const root = fs.mkdtempSync(path.join(validationRoot, "fixture-"));
  try {
    const dist = path.join(root, "dist");
    fs.writeFileSync(dist, "synthetic");
    assert.throws(() => cleanBuildOutput(root), /real directory/);
    assert.equal(fs.readFileSync(dist, "utf8"), "synthetic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanBuildOutput refuses a junction and preserves its target", () => {
  const root = fs.mkdtempSync(path.join(validationRoot, "fixture-"));
  try {
    const target = path.join(root, "outside-target");
    const dist = path.join(root, "dist");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "synthetic");
    fs.symlinkSync(target, dist, "junction");
    assert.throws(() => cleanBuildOutput(root), /real directory/);
    assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "synthetic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
