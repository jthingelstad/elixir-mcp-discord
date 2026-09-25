/** What is running: the package version and the checkout's short commit, read
 *  from .git by hand so it works under launchd with no git on PATH — and in
 *  the container, which carries .git's HEAD and refs (not its objects) so a
 *  bot built from the checkout still says which commit it is. */

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";

/** The commit a ref names: its loose file, else its line in packed-refs
 *  (where a fresh clone and `git gc` keep most refs), else null. */
function resolveRef(gitDir, ref) {
  try {
    return fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
  } catch {
    /* packed, not loose */
  }
  try {
    const line = fs
      .readFileSync(path.join(gitDir, "packed-refs"), "utf8")
      .split("\n")
      .find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(" ")[0] : null;
  } catch {
    return null;
  }
}

export function buildId(root = repoRoot) {
  let version = "?";
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "?";
  } catch {
    /* no package.json: unusual, not fatal */
  }
  let sha = null;
  try {
    const gitDir = path.join(root, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const full = head.startsWith("ref: ") ? resolveRef(gitDir, head.slice(5)) : head;
    if (/^[0-9a-f]{40}$/.test(full ?? "")) sha = full.slice(0, 7);
  } catch {
    /* not a git checkout (a tarball); the image carries HEAD and refs, see the Dockerfile */
  }
  return sha ? `${version}+${sha}` : version;
}
