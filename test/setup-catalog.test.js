/**
 * Setup's file-and-arithmetic half. The rule pinned hardest: setup ADDS
 * routine files and never overwrites or deletes one — a rewritten prompt is
 * the operator's, and losing it to a re-run would be the worst thing setup
 * could do.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  catalog,
  installRoutines,
  disabledAfter,
  rewriteAt,
  estimateMonthly,
  describeWhen,
} from "../src/setup-catalog.js";

const EXAMPLE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent");

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emd-setup-"));
  return { dir, agent: path.join(dir, "agent") };
}

test("the catalog is every shipped routine, each with a description, plus anything custom", () => {
  const { agent } = scratch();
  fs.mkdirSync(path.join(agent, "routines"), { recursive: true });
  fs.writeFileSync(
    path.join(agent, "routines", "mine.md"),
    "---\ntrigger: schedule\nchannel: pulse\nat: 09:00\n---\nSay hello.\n",
  );
  const entries = catalog({ exampleDir: EXAMPLE, instanceDir: agent });
  const shipped = entries.filter((e) => !e.custom);
  assert.ok(shipped.length >= 8);
  for (const entry of shipped) {
    assert.equal(entry.error, null, `${entry.key}: ${entry.error}`);
    assert.ok(entry.routine.description, `${entry.key} needs a description for the picker`);
    assert.equal(entry.installed, false);
  }
  const mine = entries.find((e) => e.key === "mine");
  assert.ok(mine.custom && mine.installed);
  assert.equal(describeWhen(mine.routine), "daily at 09:00");
});

test("installing copies what is missing and never touches what is there", () => {
  const { agent } = scratch();
  fs.mkdirSync(path.join(agent, "routines"), { recursive: true });
  const rewritten = "---\ntrigger: schedule\nchannel: pulse\nat: 05:00\n---\nMy own words.\n";
  fs.writeFileSync(path.join(agent, "routines", "war-deck-check.md"), rewritten);
  const result = installRoutines({ exampleDir: EXAMPLE, instanceDir: agent, keys: ["war-deck-check", "clan-feed"] });
  assert.deepEqual(result, { copied: ["clan-feed"], kept: ["war-deck-check"] });
  assert.equal(fs.readFileSync(path.join(agent, "routines", "war-deck-check.md"), "utf8"), rewritten);
  assert.ok(fs.existsSync(path.join(agent, "routines", "clan-feed.md")));
  const again = catalog({ exampleDir: EXAMPLE, instanceDir: agent });
  assert.ok(again.find((e) => e.key === "clan-feed").installed);
});

test("a routine chosen off is disabled, not deleted; chosen back on is re-enabled", () => {
  assert.equal(
    disabledAfter({ previous: "meta-report,other", installedKeys: ["meta-report", "ask", "clan-feed"], chosenKeys: ["ask"] }),
    "clan-feed,meta-report,other",
  );
  assert.equal(
    disabledAfter({ previous: "clan-feed", installedKeys: ["clan-feed"], chosenKeys: ["clan-feed"] }),
    "",
  );
});

test("moving a schedule rewrites only the at: line", () => {
  const text = "---\ndescription: x\ntrigger: schedule\nchannel: pulse\nat: 01:00\ncatch_up_hours: 3\n---\nBody with at: 01:00 in it.\n";
  const moved = rewriteAt(text, "22:30");
  assert.ok(moved.includes("\nat: 22:30\n"));
  assert.ok(moved.includes("Body with at: 01:00 in it."), "the prompt body is untouched");
  assert.ok(moved.includes("catch_up_hours: 3"));
  assert.throws(() => rewriteAt(text, "25:00"), /not HH:MM/);
  assert.throws(() => rewriteAt("---\ntrigger: events\nchannel: x\nsections: roster\n---\nb", "01:00"), /no at:/);
});

test("the monthly estimate counts schedules and events, never the ask lane", () => {
  const estimate = estimateMonthly([
    { key: "daily", trigger: "schedule" },
    { key: "weekly", trigger: "schedule", days: [0] },
    { key: "feed", trigger: "events", sections: ["roster"] },
    { key: "ask", trigger: "message" },
  ]);
  assert.equal(estimate.runs, 30 + 4 + 30);
  assert.equal(estimate.usd, estimate.runs * 0.1);
  assert.deepEqual(estimate.lines.map((l) => l.key), ["daily", "weekly", "feed"]);
});
