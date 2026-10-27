import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Remove only the package's own generated dist directory before a clean build. */
export function cleanBuildOutput(projectRoot, fsImpl = fs) {
  const root = path.resolve(projectRoot);
  const distPath = path.resolve(root, "dist");
  if (path.dirname(distPath) !== root || path.basename(distPath) !== "dist") {
    throw new Error("refusing build output outside the package root");
  }

  let stat;
  try { stat = fsImpl.lstatSync(distPath); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("refusing unexpected dist path; expected a real directory");
  }
  fsImpl.rmSync(distPath, { recursive: true, force: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cleanBuildOutput(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
