import os from "node:os";
import path from "node:path";

export type AgentTaskDeliveryPaths = { stateRoot: string; artifactRoot: string };

export function resolveAgentTaskDeliveryPaths(options: {
  openClawStateDir?: string;
  taskStateDir?: string;
  taskArtifactDir?: string;
  homeDir?: string;
} = {}): AgentTaskDeliveryPaths {
  const stateDir = options.openClawStateDir?.trim() || path.join(options.homeDir ?? os.homedir(), ".openclaw");
  const root = path.join(stateDir, "qqbot", "agent-task-delivery");
  return {
    stateRoot: options.taskStateDir || path.join(root, "state"),
    artifactRoot: options.taskArtifactDir || path.join(root, "artifacts"),
  };
}
