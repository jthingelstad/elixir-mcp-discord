/**
 * Every accepted change is a commit when the instance is a repository —
 * local, never the checkout, never .env or state/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initInstanceRepo, commitInstance, isRepo } from "../src/instance-git.js";
import { repoRoot } from "../src/config.js";

function instance(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-git-"));
  fs.mkdirSync(path.join(dir, "agent", "routines"), { recursive: true });
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(path.join(dir, ".env"), "ELIXIR_MCP_TOKEN=secret\n");
  fs.writeFileSync(path.join(dir, "config.json"), '{"TIMEZONE":"UTC"}\n');
  fs.writeFileSync(path.join(dir, "agent", "identity.md"), "Plain.\n");
  fs.writeFileSync(path.join(dir, "state", "state.json"), "{}");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

test("init makes a repository of config.json and agent/, ignoring .env and state/", async (t) => {
  const dir = instance(t);
  const repo = await initInstanceRepo({ dir });
  assert.equal(isRepo(dir), true);
  assert.equal(repo.tracked, 3, ".gitignore, config.json, agent/identity.md");
  fs.mkdirSync(path.join(dir, "agent", ".history"));
  fs.writeFileSync(path.join(dir, "agent", ".history", "identity.md.t"), "old");
  await initInstanceRepo({ dir });
  assert.ok(!git(dir, "ls-files").includes(".history"), "the pre-git backups are not history twice");
  const tracked = git(dir, "ls-files").split("\n");
  assert.ok(!tracked.includes(".env"));
  assert.ok(!tracked.some((f) => f.startsWith("state/")));
  assert.equal(git(dir, "remote"), "", "no remote, ever");
  assert.deepEqual(await initInstanceRepo({ dir }), await initInstanceRepo({ dir }), "idempotent");
});

test("a change is committed with its summary; nothing to commit is nothing; the checkout is never touched", async (t) => {
  const dir = instance(t);
  await initInstanceRepo({ dir });
  fs.writeFileSync(path.join(dir, "agent", "memory.md"), "- 2026-09-15 (from owner): we call war days boat days\n");
  const sha = await commitInstance({ message: "Remember: we call war days boat days", body: "file: memory.md", dir });
  assert.match(sha, /^[0-9a-f]{7,}$/);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Remember: we call war days boat days");
  assert.equal(await commitInstance({ message: "nothing", dir }), null);
  fs.writeFileSync(path.join(dir, ".env"), "ELIXIR_MCP_TOKEN=rotated\n");
  assert.equal(await commitInstance({ message: "secret?", dir }), null, ".env changing is never a commit");
  assert.equal(await commitInstance({ message: "no", dir: repoRoot }), null, "the checkout is not an instance");
});
