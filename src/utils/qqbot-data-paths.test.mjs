import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveQQBotDataRoot } from "./qqbot-data-paths.ts";

test("uses the configured OpenClaw state directory when available", () => {
  assert.equal(resolveQQBotDataRoot("C:/isolated/openclaw", "C:/users/test"), path.join("C:/isolated/openclaw", "qqbot"));
});

test("uses a portable home-relative OpenClaw directory as the fallback", () => {
  assert.equal(resolveQQBotDataRoot(undefined, "C:/users/test"), path.join("C:/users/test", ".openclaw", "qqbot"));
});
