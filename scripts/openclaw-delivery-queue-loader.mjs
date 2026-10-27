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
    if (chunks.length !== 1) throw new Error("queue module unavailable");

    const packageRealRoot = await fs.realpath(openclawRoot);
    const modulePath = await fs.realpath(path.join(distRoot, chunks[0]));
    if (!isWithin(packageRealRoot, modulePath)) throw new Error("queue module escaped local package");
    const moduleStat = await fs.lstat(path.join(distRoot, chunks[0]));
    if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) throw new Error("queue module is not a regular file");

    return await import(pathToFileURL(modulePath).href);
  } catch {
    throw new Error("candidate-local OpenClaw delivery queue module is unavailable or unsafe");
  }
}
