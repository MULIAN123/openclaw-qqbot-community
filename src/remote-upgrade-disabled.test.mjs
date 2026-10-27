import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");
const [slashCommands, gateway, adminResolver, pluginManifest, packageJson, englishReadme, chineseReadme] = await Promise.all([
  read("./slash-commands.ts"),
  read("./gateway.ts"),
  read("./admin-resolver.ts"),
  read("../openclaw.plugin.json"),
  read("../package.json"),
  read("../README.md"),
  read("../README.zh.md"),
]);

test("QQ command registry cannot invoke remote upgrade", () => {
  assert.equal(/name:\s*["']bot-upgrade["']/.test(slashCommands), false);
  assert.equal(/REMOTE_UPGRADE_SCRIPT_URL|downloadRemoteUpgradeScript|fireHotUpgrade/.test(slashCommands), false);
  assert.equal(/upgrade-via-npm\.(?:sh|ps1)/.test(slashCommands), false);
  const blockedCommand = slashCommands.indexOf('if (cmdName === "bot-upgrade")');
  const registryLookup = slashCommands.indexOf("const cmd = commands.get(cmdName)");
  assert.equal(blockedCommand >= 0 && blockedCommand < registryLookup, true);
  assert.equal(/return "远程升级已从本源码版本移除/.test(slashCommands), true);
});

test("gateway and metadata expose no update trigger or upgrade skill", () => {
  assert.equal(/triggerUpdateCheck/.test(gateway), false);
  assert.equal(/qqbot-upgrade/.test(pluginManifest), false);
  assert.equal(/qqbot-upgrade|upgrade-via-npm|upgrade-via-source/.test(packageJson), false);
});

test("Gateway Ready cannot read legacy upgrade targets or send upgrade greetings", () => {
  assert.equal(/upgrade-greeting-target|loadUpgradeGreetingTarget|clearUpgradeGreetingTarget/.test(adminResolver), false);
  assert.equal(/sendProactiveC2CMessage|getAccessToken/.test(adminResolver), false);
});

test("release documentation describes manual upgrades without a QQ-triggered upgrader", () => {
  assert.equal(/One-Click Hot Upgrade|\/bot-upgrade --/.test(englishReadme), false);
  assert.equal(/一键热更新|\/bot-upgrade --/.test(chineseReadme), false);
  assert.equal(/Remote hot upgrade is not included.*former \/bot-upgrade command is intercepted/is.test(englishReadme), true);
  assert.equal(/旧 \/bot-upgrade 命令会被拦截并返回固定禁用提示，不会进入 Agent 处理/.test(chineseReadme), true);
});
