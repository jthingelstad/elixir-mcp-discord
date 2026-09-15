/**
 * Operator notices, by DM.
 *
 * The DM is the operator's console: channels are for members, the DM is for
 * the person who runs the bot. Until now everything operator-facing went to
 * the log — a routine file the running code could not parse, a lane at its
 * budget, a routine that failed, a channel it cannot post in, Elixir's
 * maintainer answering something it filed. The six-hour outage of
 * 2026-09-13 was six hours because the only place it was written was a file
 * nobody was reading.
 *
 * No model, no cost. One line per notice, deduplicated by fingerprint for an
 * hour so a crash loop is a log problem and not a DM problem. With no admins
 * configured, or before the client is ready, a notice is a log line and
 * nothing else — a notice must never be the thing that fails a turn.
 */

import { config } from "./config.js";
import { chunk } from "./post.js";
import { sha } from "./ledger.js";
import { log } from "./log.js";
import * as state from "./state.js";

const HOUR_MS = 60 * 60 * 1000;
const KEEP = 200;

let client = null;

/** Called once the Discord client is ready. Tests pass a fake with users.fetch. */
export function configure({ client: c }) {
  client = c;
}

function recentlySent(fingerprint, every) {
  const sent = state.get("notices") || {};
  const at = sent[fingerprint];
  return at && Date.now() - Date.parse(at) < every;
}

function remember(fingerprint) {
  const sent = { ...state.get("notices"), [fingerprint]: new Date().toISOString() };
  const keys = Object.keys(sent).sort((a, b) => (sent[a] < sent[b] ? -1 : 1)).slice(-KEEP);
  state.set({ notices: Object.fromEntries(keys.map((k) => [k, sent[k]])) });
}

/**
 * @param kind   a short label: "routine failed", "budget", "channels"
 * @param text   what happened, plainly, for a person reading on a phone
 * @param fingerprint  what makes this the SAME notice as an earlier one;
 *   defaults to kind + text. `every` is how long the same notice stays quiet.
 */
export async function notify(kind, text, { fingerprint = null, every = HOUR_MS } = {}) {
  const fp = fingerprint ?? `${kind}:${sha(text)}`;
  const admins = [...config.adminUserIds];
  if (!client || admins.length === 0) {
    log.info("notice_unsent", { kind, reason: !client ? "no client yet" : "no ADMIN_USER_IDS", text: text.slice(0, 200) });
    return 0;
  }
  if (recentlySent(fp, every)) return 0;
  const content = `-# 🔔 **${kind}** · ${text}`;
  let reached = 0;
  for (const id of admins) {
    try {
      const user = await client.users.fetch(id);
      for (const part of chunk(content, 1900)) await user.send({ content: part, allowedMentions: { parse: [] } });
      reached += 1;
    } catch (error) {
      log.warn("notice_dm_failed", { kind, user: id, error: error.message });
    }
  }
  if (reached) remember(fp);
  log.info("notice_sent", { kind, admins: reached, text: text.slice(0, 200) });
  return reached;
}
