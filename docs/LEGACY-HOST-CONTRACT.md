# Legacy custom-host delivery-queue contract

Status: **not supported by the independent plugin release.**

## What the contract is

Two tests in `src/agent-task-delivery.test.ts` describe how a customised OpenClaw host was expected
to recover the outbound delivery queue:

- `V1.1.1 runtime queue missing replyToId is marked pending_claim without upload` — a queue entry
  without `replyToId` must be rewritten with `recoveryState: "pending_claim"` and
  `legacyIncompatibleReason: "missing_reply_to_id"`, and must not be uploaded.
- `V1.1.1 runtime queue with valid replyToId still recovers` — an entry with a valid `replyToId` is
  delivered once and its JSON file removed.

Both tests write queue entries as JSON files under `<stateDir>/delivery-queue/` and call the host's
`recoverPendingDeliveries`.

## Why it is not supported

Official OpenClaw 2026.6.10 stores the delivery queue in SQLite and has no `pending_claim`
recovery state:

- https://github.com/openclaw/openclaw/blob/v2026.6.10/src/infra/outbound/delivery-queue-storage.ts
- https://github.com/openclaw/openclaw/blob/v2026.6.10/src/infra/outbound/delivery-queue-recovery.ts

The host patch that implemented the JSON/`pending_claim` behaviour is not available as reviewable,
rebuildable source, so it cannot be shipped with this plugin.

## Evidence (official openclaw 2026.6.10 from the npm registry, Node 24)

| CI run | Ubuntu 24.04 / Windows 2025 |
|---|---|
| 40617471901 | Both tests fail before any assertion: the loader found three `delivery-queue-*.js` files and refused to guess. |
| 40684179597 | After the loader selects the single facade exporting `recoverPendingDeliveries`: 0 pass / 2 fail on both platforms. Missing-`replyToId` case: `recoveryState` is `undefined` (expected `pending_claim`). Valid-`replyToId` case: the deliver callback ran 0 times (expected 1). |

The assertions are kept unchanged as the record of this contract. They are skipped by default and
run in CI as an informational step (`continue-on-error`) that is expected to fail. To run them
against a host that claims this contract, set `QQBOT_OPENCLAW_RUNTIME_TESTS=1`.

## What is verified instead

On official OpenClaw, CI runs every other Task Delivery test (only these two may be skipped; any
other skip fails the build), the delivery-queue loader's safety tests, and the plugin's fail-closed
delivery guards (no resend without `replyToId`, no resend of a file whose outcome is unknown, and
batch success confirming only the files in the current attempt).
