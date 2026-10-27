import assert from "node:assert/strict";
import test from "node:test";
import { parseGroupSearchAllowlist } from "./group-search-config.ts";

test("parses an operator supplied allowlist without embedding deployment identifiers", () => {
  assert.deepEqual([...parseGroupSearchAllowlist(" group-fixture-a, ,group-fixture-b ")], ["group-fixture-a", "group-fixture-b"]);
});

test("an absent allowlist disables the optional group-search exception", () => {
  assert.equal(parseGroupSearchAllowlist(undefined).size, 0);
});
