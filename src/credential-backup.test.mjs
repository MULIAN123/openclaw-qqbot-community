import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertCredentialConfigured, isCredentialConfigured, loadCredentialBackup, saveCredentialBackup } from "./credential-backup.ts";
import { getCredentialConfigError, validateTokenFileSetupInput } from "./credential-backup.ts";

const syntheticSecret = "R2_SYNTHETIC_SECRET_MUST_NOT_BE_PERSISTED_7f3e";
const moduleSource = await readFile(new URL("./credential-backup.ts", import.meta.url), "utf8");
const channelSource = await readFile(new URL("./channel.ts", import.meta.url), "utf8");
const slashCommandsSource = await readFile(new URL("./slash-commands.ts", import.meta.url), "utf8");
const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("backup module has no filesystem or platform-path dependency", () => {
  assert.doesNotMatch(moduleSource, /from ["']node:fs["']/);
  assert.doesNotMatch(moduleSource, /utils\/platform/);
});

test("module exposes a strict config predicate and disabled backup operations", () => {
  assert.match(moduleSource, /export function isCredentialConfigured/);
  assert.match(moduleSource, /export function loadCredentialBackup/);
  assert.match(moduleSource, /export function saveCredentialBackup/);
});

test("configured startup predicate requires both app ID and secret", () => {
  assert.equal(isCredentialConfigured({ appId: "synthetic-app", clientSecret: syntheticSecret }), true);
  assert.equal(isCredentialConfigured({ appId: "synthetic-app", clientSecret: "" }), false);
  assert.equal(isCredentialConfigured({ appId: "", clientSecret: syntheticSecret }), false);
  assert.equal(isCredentialConfigured(undefined), false);
});

test("missing credentials fail closed with an actionable error that contains no secret", () => {
  assert.throws(
    () => assertCredentialConfigured({ appId: "", clientSecret: syntheticSecret }),
    (error) => {
      assert.match(error.message, /qqbot_credentials_missing/);
      assert.equal(error.message.includes(syntheticSecret), false);
      return true;
    },
  );
});

test("snapshot creation reports disabled without persisting synthetic secret", () => {
  assert.deepEqual(saveCredentialBackup("synthetic-account", "synthetic-app", syntheticSecret), {
    saved: false,
    reason: "secure_store_not_implemented",
  });
});

test("legacy backup reader never returns a credential", () => {
  assert.equal(loadCredentialBackup("synthetic-account"), null);
});

test("startup and hot-upgrade call chains do not read or write credential backups", () => {
  assert.doesNotMatch(channelSource, /loadCredentialBackup|saveCredentialBackup/);
  assert.doesNotMatch(slashCommandsSource, /preUpgradeCredentialBackup|saveCredentialBackup/);
  assert.match(channelSource, /credential_missing: configure appId and clientSecret/);
});

test("release manifest excludes operational credential recovery and upgrade scripts", () => {
  assert.equal(packageManifest.files.some((entry) => /upgrade-via|credential-backup\.json/i.test(entry)), false);
  assert.equal(packageManifest.files.some((entry) => /scripts\//.test(entry) && entry !== "scripts/link-sdk-core.cjs"), false);
});

// --- clientSecretFile / --token-file: explicitly unsupported (R3) ---
const syntheticSecretPath = "C:/synthetic/qqbot-secret-path-must-not-leak.txt";

test("file-only credential config fails with a specific, secret-free error", () => {
  const account = { appId: "synthetic-app", clientSecret: "", secretSource: "file", clientSecretFile: syntheticSecretPath };
  assert.equal(isCredentialConfigured(account), false);
  assert.throws(
    () => assertCredentialConfigured(account),
    (error) => {
      assert.match(error.message, /^qqbot_client_secret_file_unsupported:/);
      assert.match(error.message, /set clientSecret/);
      assert.equal(error.message.includes(syntheticSecretPath), false);
      return true;
    },
  );
});

test("file-only config without appId also reports the missing appId", () => {
  assert.match(getCredentialConfigError({ appId: "", clientSecret: "", secretSource: "file" }), /appId is also missing$/);
});

test("non-file missing credentials keep the generic missing error", () => {
  assert.match(getCredentialConfigError({ appId: "synthetic-app", clientSecret: "", secretSource: "none" }), /^qqbot_credentials_missing:/);
  assert.equal(getCredentialConfigError({ appId: "synthetic-app", clientSecret: syntheticSecret, secretSource: "config" }), null);
});

test("an inline clientSecret still wins when clientSecretFile is also present", () => {
  assert.equal(getCredentialConfigError({ appId: "synthetic-app", clientSecret: syntheticSecret, secretSource: "config", clientSecretFile: syntheticSecretPath }), null);
});

test("setup rejects --token-file alone but keeps --token and --use-env working", () => {
  assert.match(validateTokenFileSetupInput({ tokenFile: syntheticSecretPath }), /--token-file is not supported/);
  assert.equal(validateTokenFileSetupInput({ tokenFile: syntheticSecretPath, token: "synthetic-app:x" }), null);
  assert.equal(validateTokenFileSetupInput({ tokenFile: syntheticSecretPath, useEnv: true }), null);
  assert.equal(validateTokenFileSetupInput({ token: "synthetic-app:x" }), null);
});

test("channel keeps the upstream clientSecretFile interface and wires the explicit checks", () => {
  assert.match(channelSource, /clearBaseFields: \["appId", "clientSecret", "clientSecretFile", "name"\]/);
  assert.match(channelSource, /clientSecretFile: input\.tokenFile/);
  assert.match(channelSource, /return validateTokenFileSetupInput\(input\)/);
  assert.match(channelSource, /CLIENT_SECRET_FILE_UNSUPPORTED_ERROR : null/);
});
