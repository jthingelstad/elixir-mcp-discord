/**
 * The state file is the only thing that survives a restart — the month's
 * spend, every cursor, the run ledger — and every writer is read-modify-write
 * of the whole file. So an unreadable file must never be read as "empty" and
 * written back that way: that is how a budget gets spent twice.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import * as state from "../src/state.js";

const STATE = process.env.STATE_PATH;
const siblings = () => fs.readdirSync(path.dirname(STATE)).filter((f) => f.startsWith(`${path.basename(STATE)}.`));

beforeEach(() => {
  fs.rmSync(STATE, { force: true });
  for (const f of siblings()) fs.rmSync(path.join(path.dirname(STATE), f), { force: true });
});

test("a write lands whole and leaves no temporary file behind", () => {
  state.markRun("meta-report", "2026-09-27");
  state.set({ spendUsd: 1.5 });
  const saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
  assert.deepEqual(saved.runs, { "meta-report": "2026-09-27" });
  assert.equal(saved.spendUsd, 1.5);
  assert.deepEqual(siblings(), []);
});

test("the same timeline item carried twice is held once", () => {
  const badge = { kind: "badge_earned", subject_tag: "#A", at: "2026-09-25T10:00:00Z", text: "A earned a badge" };
  const card = { kind: "card_unlocked", subject_tag: "#B", at: "2026-09-25T10:05:00Z", text: "B unlocked a card" };
  state.addCarry("editor", [badge]);
  // A release turn failed, the cursor stayed, and the next poll re-read the window.
  state.addCarry("editor", [badge, card]);
  assert.deepEqual(state.carried("editor"), [badge, card]);
});

test("a missing file is a fresh install, read as the defaults", () => {
  assert.equal(state.get("runs"), null);
  assert.deepEqual(state.get("cursors"), {});
  assert.deepEqual(siblings(), []);
});

test("a corrupt file is moved aside, never overwritten, and the next write starts clean", () => {
  const torn = '{"budgets": {"2026-09": {"routines": 18.4';
  fs.writeFileSync(STATE, torn);

  assert.equal(state.get("runs"), null, "an unreadable file reads as the defaults");
  const kept = siblings().filter((f) => f.includes(".corrupt-"));
  assert.equal(kept.length, 1, "the bad file is kept beside the new one");
  assert.equal(fs.readFileSync(path.join(path.dirname(STATE), kept[0]), "utf8"), torn);

  state.markRun("editor", "x");
  assert.deepEqual(JSON.parse(fs.readFileSync(STATE, "utf8")).runs, { editor: "x" });
  assert.equal(
    fs.readFileSync(path.join(path.dirname(STATE), kept[0]), "utf8"),
    torn,
    "the kept copy is untouched by the next write",
  );
});

test("a state file that is there but cannot be read stops every access, and nothing is written over it", () => {
  // A directory in its place reads as EISDIR — the same branch as a file
  // this user may not read (EACCES), which root cannot reproduce here.
  fs.mkdirSync(STATE);
  try {
    assert.throws(() => state.get("runs"), /unreadable/);
    assert.throws(() => state.markRun("editor", "x"), /unreadable/, "the write never happens");
    assert.ok(fs.statSync(STATE).isDirectory(), "what was there is untouched");
  } finally {
    fs.rmSync(STATE, { recursive: true, force: true });
  }
});
