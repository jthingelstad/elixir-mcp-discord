/**
 * The SKIP protocol's reading side, in a module of its own so the turn
 * reader (src/turns.js) can use it without importing config.js, whose .env
 * validation would stop `npm run turns` opening a ledger. The prompt side
 * (SKIP, SKIP_WITH_TOOL) is in src/prompt.js.
 */

/**
 * Did the model decline to post?
 *
 * Anchoring on the start of the response was wrong: told to "reply with
 * exactly SKIP", the model sometimes explains its reasoning first and puts
 * SKIP on its own line at the end. That parses as a normal answer, and the
 * channel gets "period.kind is training, not a war day" as though it were the
 * post. Accept SKIP as any line of its own.
 *
 * Since 2026-10-07 a skip carries a one-line reason (SKIP_WHY), so the
 * review can tell a judgement from a miss: a return after quiet days skipped
 * with no word was indistinguishable from one the model never weighed. A
 * model that puts the reason on the same line ("SKIP: the room has it") is
 * still declining, so an upper-case SKIP followed by a colon or a dash
 * counts too; a lower-case "skip" at the start of a line is prose.
 */
const SKIP_LINE = /^SKIP[.!]?$/i;
const SKIP_WITH_REASON = /^SKIP\s*[:—–-]\s*\S/;

export function isSkip(text) {
  const lines = (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 0 || lines.some((line) => SKIP_LINE.test(line) || SKIP_WITH_REASON.test(line));
}

/** What a skipped turn said about why, without the SKIP itself. */
export function skipReason(text) {
  return (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !SKIP_LINE.test(line))
    .map((line) => line.replace(/^SKIP\s*[:—–-]\s*/, ""))
    .join(" ")
    .trim();
}
