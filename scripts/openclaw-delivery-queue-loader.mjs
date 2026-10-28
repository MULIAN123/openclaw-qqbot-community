import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function requireDirectoryWithoutLinks(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("candidate OpenClaw runtime path is not a regular directory");
  }
}

export async function loadDeliveryQueueRuntime(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const modulesRoot = path.join(root, "node_modules");
  const openclawRoot = path.join(modulesRoot, "openclaw");
  const distRoot = path.join(openclawRoot, "dist");

  try {
    await requireDirectoryWithoutLinks(modulesRoot);
    await requireDirectoryWithoutLinks(openclawRoot);
    await requireDirectoryWithoutLinks(distRoot);
    const manifest = JSON.parse(await fs.readFile(path.join(openclawRoot, "package.json"), "utf8"));
    if (manifest.name !== "openclaw") throw new Error("unexpected local package");

    const chunks = (await fs.readdir(distRoot)).filter((name) => /^delivery-queue-[^/\\]+\.js$/.test(name));
    const packageRealRoot = await fs.realpath(openclawRoot);
    const candidates = [];
    for (const chunk of chunks) {
      const candidatePath = path.join(distRoot, chunk);
      const moduleStat = await fs.lstat(candidatePath);
      if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) throw new Error("queue module is not a regular file");
      const modulePath = await fs.realpath(candidatePath);
      if (!isWithin(packageRealRoot, modulePath)) throw new Error("queue module escaped local package");
      const source = await fs.readFile(modulePath, "utf8");
      // The 2026.6.10 package has a dedicated facade with this named export.
      // Other queue chunks contain storage or unrelated minified exports ("i"
      // is isPermanentDeliveryError in that version). Never guess an alias or
      // import every chunk to discover exports, which could execute side effects.
      if (/^export\s*\{\s*recoverPendingDeliveries\s*\}\s*;?\s*$/m.test(source)) {
        candidates.push(modulePath);
      }
    }
    if (candidates.length !== 1) throw new Error("queue recovery facade unavailable or ambiguous");

    const runtime = await import(pathToFileURL(candidates[0]).href);
    if (typeof runtime.recoverPendingDeliveries !== "function") throw new Error("invalid recovery export");
    return runtime;
  } catch {
    throw new Error("candidate-local OpenClaw delivery queue module is unavailable or unsafe");
  }
}
