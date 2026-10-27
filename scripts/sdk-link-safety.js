import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SDK_CORE_RELATIVE_PATH = join("plugin-sdk", "core.js");

/** Validate or create only extensions/openclaw-qqbot/node_modules/openclaw. */
export function ensureSdkLink(pluginDirectory, sdkDirectory, fsImpl = fs) {
  const pluginPath = resolve(pluginDirectory);
  if (basename(pluginPath) !== "openclaw-qqbot" || basename(dirname(pluginPath)) !== "extensions") {
    throw new Error("invalid plugin root; expected extensions/openclaw-qqbot");
  }

  const realPluginPath = fsImpl.realpathSync(pluginPath);
  const modulesPath = join(realPluginPath, "node_modules");
  let modulesStat;
  try { modulesStat = fsImpl.lstatSync(modulesPath); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (modulesStat?.isSymbolicLink()) {
    throw new Error("node_modules is a link; refusing to operate outside the plugin boundary");
  }
  if (modulesStat && !modulesStat.isDirectory()) {
    throw new Error("node_modules is not a directory");
  }

  const expectedLink = join(modulesPath, "openclaw");
  let existing;
  try { existing = fsImpl.lstatSync(expectedLink); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }

  if (existing) {
    if (fsImpl.existsSync(join(expectedLink, SDK_CORE_RELATIVE_PATH))) return "already-valid";
    if (existing.isSymbolicLink()) throw new Error("stale link at node_modules/openclaw; left unchanged");
    if (existing.isDirectory()) throw new Error("incomplete package at node_modules/openclaw; left unchanged");
    throw new Error("unexpected file at node_modules/openclaw; left unchanged");
  }

  if (!sdkDirectory) return "missing";
  const sdkPath = fsImpl.realpathSync(resolve(sdkDirectory));
  if (!fsImpl.existsSync(join(sdkPath, SDK_CORE_RELATIVE_PATH))) {
    throw new Error("OpenClaw SDK is missing plugin-sdk/core.js; no link was created");
  }
  if (!modulesStat) fsImpl.mkdirSync(modulesPath);
  fsImpl.symlinkSync(sdkPath, expectedLink, "junction");
  return "created";
}
