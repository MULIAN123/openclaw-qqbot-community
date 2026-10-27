import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveAgentTaskDeliveryPaths } from "./utils/agent-task-delivery-paths.ts";

test("default Task Delivery state and artifacts stay below the configured OpenClaw data root", () => {
  const previous = {
    state: process.env.OPENCLAW_STATE_DIR,
    taskState: process.env.QQBOT_AGENT_TASK_STATE_DIR,
    artifacts: process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR,
  };
  const stateRoot = path.join(process.cwd(), ".validation", "synthetic-openclaw-state");
  process.env.OPENCLAW_STATE_DIR = stateRoot;
  delete process.env.QQBOT_AGENT_TASK_STATE_DIR;
  delete process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR;
  try {
    const paths = resolveAgentTaskDeliveryPaths({ openClawStateDir: process.env.OPENCLAW_STATE_DIR });
    assert.equal(paths.stateRoot, path.join(stateRoot, "qqbot", "agent-task-delivery", "state"));
    assert.equal(paths.artifactRoot, path.join(stateRoot, "qqbot", "agent-task-delivery", "artifacts"));
  } finally {
    if (previous.state === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous.state;
    if (previous.taskState === undefined) delete process.env.QQBOT_AGENT_TASK_STATE_DIR;
    else process.env.QQBOT_AGENT_TASK_STATE_DIR = previous.taskState;
    if (previous.artifacts === undefined) delete process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR;
    else process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR = previous.artifacts;
  }
});

test("operator supplied Task Delivery paths take precedence", () => {
  const previous = {
    state: process.env.QQBOT_AGENT_TASK_STATE_DIR,
    artifacts: process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR,
  };
  const state = path.join(process.cwd(), ".validation", "synthetic-state-override");
  const artifacts = path.join(process.cwd(), ".validation", "synthetic-artifacts-override");
  process.env.QQBOT_AGENT_TASK_STATE_DIR = state;
  process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR = artifacts;
  try {
    const paths = resolveAgentTaskDeliveryPaths({
      taskStateDir: process.env.QQBOT_AGENT_TASK_STATE_DIR,
      taskArtifactDir: process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR,
    });
    assert.equal(paths.stateRoot, state);
    assert.equal(paths.artifactRoot, artifacts);
  } finally {
    if (previous.state === undefined) delete process.env.QQBOT_AGENT_TASK_STATE_DIR;
    else process.env.QQBOT_AGENT_TASK_STATE_DIR = previous.state;
    if (previous.artifacts === undefined) delete process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR;
    else process.env.QQBOT_AGENT_TASK_ARTIFACT_DIR = previous.artifacts;
  }
});
