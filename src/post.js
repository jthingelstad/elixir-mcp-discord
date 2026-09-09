/** Getting text into a channel, and reading back what we last said there. */

import { log } from "./log.js";

const DISCORD_LIMIT = 2000;

/** Splits on a line boundary where one is available, hard-cuts where it is not. */
export function chunk(text, limit = DISCORD_LIMIT) {
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Posts a message, splitting it if it is long. Returns the last message sent. */
export async function post(channel, text, limit = DISCORD_LIMIT) {
  let last = null;
  for (const part of chunk(text, limit)) {
    last = await channel.send(part);
  }
  return last;
}

/**
 * What this bot last said in a channel — its cheapest possible memory, and one
 * that needs no storage at all because Discord already kept it. A scheduled
 * routine with no recall reports the same three players every morning and
 * reads like a stuck record; one that can see yesterday moves on.
 */
export async function recentPosts(channel, count, { maxChars = 700 } = {}) {
  if (!count) return [];
  try {
    const fetched = await channel.messages.fetch({ limit: Math.min(50, count * 6) });
    return [...fetched.values()]
      .filter((message) => message.author?.bot && message.content && !message.content.startsWith("-#"))
      .slice(0, count)
      .map((message) => message.content.slice(0, maxChars));
  } catch (error) {
    log.warn("recall_fetch_failed", { error: error.message });
    return [];
  }
}
