import os from "node:os";
import path from "node:path";

export function resolveQQBotDataRoot(stateDir = process.env.OPENCLAW_STATE_DIR, homeDir = os.homedir()): string {
  const configuredStateDir = stateDir?.trim();
  const openClawRoot = configuredStateDir || path.join(homeDir, ".openclaw");
  return path.join(openClawRoot, "qqbot");
}
