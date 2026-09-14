import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Read metadata directly: a busy checkout's lease helper may itself be edited.
function metadata(filename, fallback) {
  try {
    return readFileSync(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function inspectCheckout(root) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
  const reasons = [];
  const attempt = (label, ...args) => {
    try {
      return git(...args);
    } catch {
      reasons.push(label);
      return null;
    }
  };
  attempt("remote synchronization unknown", "fetch", "origin", "--prune");
  const branch = attempt(
    "detached HEAD",
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  );
  if (branch && branch !== "main") reasons.push("not on main");
  const status = attempt("worktree state unknown", "status", "--porcelain");
  if (status) reasons.push("dirty worktree");
  const upstream = attempt(
    "upstream unknown",
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  );
  if (upstream && upstream !== "origin/main") reasons.push("wrong upstream");
  const counts = attempt(
    "upstream comparison unknown",
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...origin/main",
  );
  if (counts) {
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (ahead) reasons.push("pre-existing commits ahead");
    if (behind) reasons.push("behind origin/main");
  }
  let queuedNotes = 0;
  try {
    const gitDir = path.resolve(root, git("rev-parse", "--git-dir"));
    const lease = JSON.parse(
      metadata(path.join(gitDir, "agent-team-objective-lease.json"), "null"),
    );
    if (lease !== null) reasons.push("checkout lease held");
    const notes = metadata(
      path.join(gitDir, "agent-team-queued-notes.jsonl"),
      "",
    ).trim();
    queuedNotes = notes
      ? notes.split("\n").map((line) => JSON.parse(line)).length
      : 0;
  } catch {
    reasons.push("lease or queued-note metadata unreadable");
  }
  return {
    mutation: reasons.length ? "blocked" : "eligible",
    reasons,
    queuedNotes,
  };
}

async function publicStatus() {
  // The public reads this project has: Elixir's status (every answer here
  // depends on it) and whether each instance's log moved recently. A silent
  // log is how the six-hour outage of 2026-09-13 looked from outside.
  let elixir = null;
  try {
    const r = await fetch("https://elixir.poapkings.com/api/public/status", {
      signal: AbortSignal.timeout(10000),
    });
    elixir = r.ok ? ((await r.json()).health ?? null) : null;
  } catch {
    elixir = null;
  }
  const instances = {};
  const logDir = path.join(homedir(), "Library", "Logs", "elixir-mcp-discord");
  for (const name of ["poapkings", "shipit", "elixirkings"]) {
    try {
      const file = path.join(logDir, `com.poapkings.elixir-mcp-discord.${name}.log`);
      const ageMinutes = Math.round((Date.now() - statSync(file).mtimeMs) / 60000);
      instances[name] = { logAgeMinutes: ageMinutes };
    } catch {
      instances[name] = { logAgeMinutes: null };
    }
  }
  if (elixir === null && Object.values(instances).every((i) => i.logAgeMinutes === null))
    throw new Error("nothing observable");
  return { ok: true, elixir, instances };
}

export async function preflight(root, probe = publicStatus) {
  const checkout = inspectCheckout(root);
  try {
    const health = await probe();
    return { ...checkout, observation: "available", health };
  } catch {
    return { ...checkout, observation: "unavailable", health: null };
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  try {
    const result = await preflight(root);
    console.log(
      `OBSERVATION=${result.observation} (public status only; other authorized reads may remain available)`,
    );
    console.log(
      `MUTATION=${result.mutation} (checkout eligibility only; authority and deployment readiness are separate)`,
    );
    console.log(JSON.stringify(result));
    if (result.queuedNotes)
      console.log(
        "Queued notes need review; transcribe and clear only under your own lease.",
      );
    if (result.mutation === "blocked")
      console.log(
        "Continue safe read-only review with trusted tools; do not mutate or publish pre-existing work.",
      );
    process.exitCode = result.mutation === "blocked" ? 1 : 0;
  } catch {
    console.error(
      "Preflight could not run; checkout eligibility is unknown. Remain read-only.",
    );
    process.exitCode = 2;
  }
}
