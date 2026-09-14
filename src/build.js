/** What is running: the package version and the checkout's short commit, read
 *  from .git by hand so it works under launchd with no git on PATH. */

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";

export function buildId() {
  let version = "?";
  try {
    version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version ?? "?";
  } catch {
    /* no package.json: unusual, not fatal */
  }
  let sha = null;
  try {
    const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : null;
    const full = ref
      ? fs.readFileSync(path.join(repoRoot, ".git", ref), "utf8").trim()
      : head;
    if (/^[0-9a-f]{40}$/.test(full)) sha = full.slice(0, 7);
  } catch {
    /* not a git checkout (a container, a tarball) */
  }
  return sha ? `${version}+${sha}` : version;
}
