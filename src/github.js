/**
 * Filing a mechanics report as a GitHub issue, from the review DM.
 *
 * A review's `report_mechanics` findings are defects in this repository's
 * code, so they belong in its issue tracker, wherever the bot runs. Until
 * 2026-10-05 the DM carried them as text to paste, and the operator pasted
 * (issues #19-#23 were filed that way, one wrapped in the code fence it was
 * copied out of). With `GITHUB_ISSUES_TOKEN` in .env the DM gets a "File
 * issue" button per report instead (issue #24).
 *
 * The click is the gate, not a formality: the repository is public and the
 * report is the review model's prose about turns that carry members' words.
 * The report tool asks for no names, ids or tags; a person reads it before
 * it is published.
 *
 * No model, and nothing here is a tool: the runner calls GitHub's REST API
 * on the operator's click. The token is a fine-grained one with Issues:
 * write on this repository and nothing else.
 */

import { config } from "./config.js";
import { log } from "./log.js";

const API = "https://api.github.com";

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "elixir-mcp-discord",
  };
}

/** Is filing configured? */
export const canFileIssues = () => Boolean(config.github.issuesToken);

/**
 * Open an issue, or point at the open one that already has this title — a
 * defect two weekly reviews both noticed is one issue. Never throws: the
 * DM shows the error and the text is still there to paste.
 *
 * @returns {{ ok: true, number, url, existing: boolean } | { ok: false, error }}
 */
export async function fileIssue(
  { title, body },
  { token = config.github.issuesToken, repo = config.github.issuesRepo, fetchFn = fetch } = {},
) {
  if (!token) return { ok: false, error: "GITHUB_ISSUES_TOKEN is not set in .env" };
  try {
    const open = await fetchFn(`${API}/repos/${repo}/issues?state=open&per_page=100`, { headers: headers(token) });
    if (open.ok) {
      const same = (await open.json()).find(
        (i) => !i.pull_request && i.title.trim().toLowerCase() === title.trim().toLowerCase(),
      );
      if (same) return { ok: true, number: same.number, url: same.html_url, existing: true };
    }
    const response = await fetchFn(`${API}/repos/${repo}/issues`, {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log.warn("github_issue_failed", { repo, status: response.status, detail: detail.slice(0, 200) });
      return { ok: false, error: `GitHub answered ${response.status}${detail ? `: ${detail.slice(0, 150)}` : ""}` };
    }
    const issue = await response.json();
    log.info("github_issue_filed", { repo, number: issue.number });
    return { ok: true, number: issue.number, url: issue.html_url, existing: false };
  } catch (error) {
    log.warn("github_issue_failed", { repo, error: error.message });
    return { ok: false, error: error.message };
  }
}
