/**
 * Every accepted change is a commit — when the instance directory is a git
 * repository.
 *
 * config.json and agent/ are the operator's configuration: what the bot
 * says, when, where, and what it has learned. .history/ keeps the prior
 * version of each file the bot changes, which answers "what was it before"
 * and nothing else. A repository answers everything: what changed, when,
 * why (the proposal's summary is the message), and how to get back.
 *
 * Zero configuration. If <instance>/.git exists, applying a proposal,
 * undoing one, or retiring a one-shot commits with the summary; if it does
 * not, nothing happens. Nothing here ever pushes, fetches or sets a remote:
 * the instance's history is local, the same as its .env. `.env` and
 * `state/` are in the .gitignore setup writes, so a commit can never carry
 * a secret or a member's words from the ledger.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { instanceDir, repoRoot } from "./config.js";
import { log } from "./log.js";

const run = promisify(execFile);

/** The author when the machine has no git identity of its own. */
const IDENTITY = ["-c", "user.name=elixir-mcp-discord", "-c", "user.email=bot@elixir-mcp-discord.local"];

/** Secrets, the ledger, and the pre-git backups (the repository IS the history). */
export const IGNORE = ".env\n.env.*\nstate/\n.history/\nagent/.history/\n";

export function isRepo(dir = instanceDir) {
  return fs.existsSync(path.join(dir, ".git"));
}

async function git(dir, args) {
  const { stdout } = await run("git", [...IDENTITY, ...args], { cwd: dir, timeout: 15_000 });
  return stdout.trim();
}

/**
 * Commit what changed under config.json and agent/. Returns the short sha,
 * or null when there is no repository or nothing changed. Never throws: a
 * commit that fails is a warning, not a failed apply.
 */
export async function commitInstance({ message, body = null, dir = instanceDir } = {}) {
  // The checkout is where the code lives, never an instance to commit —
  // a test run or `npm run try` from the checkout must not touch its git.
  if (path.resolve(dir) === path.resolve(repoRoot) || !isRepo(dir)) return null;
  try {
    await git(dir, ["add", "-A", "--", "config.json", "agent"]);
    const staged = await git(dir, ["diff", "--cached", "--name-only"]);
    if (!staged) return null;
    const args = ["commit", "-q", "-m", String(message).slice(0, 200)];
    if (body) args.push("-m", String(body).slice(0, 2000));
    await git(dir, args);
    const sha = await git(dir, ["rev-parse", "--short", "HEAD"]);
    log.info("instance_committed", { sha, files: staged.split("\n").length, message: String(message).slice(0, 80) });
    return sha;
  } catch (error) {
    log.warn("instance_commit_failed", { error: error.message.split("\n")[0].slice(0, 200) });
    return null;
  }
}

/**
 * Make an instance directory a repository: .gitignore for the secrets and
 * the ledger, one commit of everything else. Idempotent. Used by setup
 * (offered, default yes) and by hand.
 */
export async function initInstanceRepo({ dir = instanceDir } = {}) {
  const ignore = path.join(dir, ".gitignore");
  const have = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const missing = IGNORE.split("\n").filter((line) => line && !have.split("\n").includes(line));
  if (missing.length) fs.writeFileSync(ignore, `${have.replace(/\n*$/, have ? "\n" : "")}${missing.join("\n")}\n`);
  if (!isRepo(dir)) await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["add", "-A", "--", ".gitignore", "config.json", "agent"]);
  // Anything tracked that the ignore file now covers leaves the index.
  await git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "agent/.history", ".history"]);
  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (staged)
    await git(dir, ["commit", "-q", "-m", "Instance configuration as of " + new Date().toISOString().slice(0, 10)]);
  const tracked = await git(dir, ["ls-files"]);
  if (/(^|\n)\.env(\n|$)/.test(tracked) || /(^|\n)state\//.test(tracked))
    throw new Error("the instance repository tracks .env or state/; fix .gitignore before continuing");
  return { sha: await git(dir, ["rev-parse", "--short", "HEAD"]), tracked: tracked.split("\n").filter(Boolean).length };
}
