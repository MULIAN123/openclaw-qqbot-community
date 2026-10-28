// Read package code as data; never import a candidate chunk or touch host state.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve("node_modules/openclaw");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
console.log(JSON.stringify({ name: pkg.name, version: pkg.version,
  queueExports: Object.entries(pkg.exports ?? {}).filter(([key]) => /queue|outbound/.test(key)) }));
for (const name of (await fs.readdir(path.join(root, "dist"))).sort()) {
  if (!/^delivery-queue-[^/\\]+\.js$/.test(name)) continue;
  const source = await fs.readFile(path.join(root, "dist", name), "utf8");
  console.log(JSON.stringify({ name, sha256: crypto.createHash("sha256").update(source).digest("hex"),
    exports: [...source.matchAll(/export\s*\{[^}]*\}/g)].map((m) => m[0]),
    declarations: source.split("\n").filter((line) => /^(?:async )?function (?:recoverPendingDeliveries|enqueueDelivery|loadPendingDeliveries)\b/.test(line)),
    contractMarkers: { pendingClaim: source.includes("pending_claim"), missingReply: source.includes("missing_reply_to_id"),
      sqlite: source.includes("sqlite"), recovery: source.includes("recoverPendingDeliveries") } }));
}
