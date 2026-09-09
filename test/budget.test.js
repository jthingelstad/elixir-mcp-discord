/**
 * A budget nobody can exceed is a different thing from a budget that reports
 * being exceeded, and the difference only shows up in the failure.
 *
 * These pin the strict half: the check runs BEFORE the call, against the
 * largest turn the lane has actually produced, so the answer to "can it
 * overspend?" is no rather than "by at most one turn".
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import fs from "node:fs";
import * as state from "../src/state.js";
import { config } from "../src/config.js";
import * as budget from "../src/budget.js";
import { parseRoutine } from "../src/routines.js";

const STATE = process.env.STATE_PATH;
beforeEach(() => {
  fs.rmSync(STATE, { force: true });
  config.monthlyBudgetUsd = 10;
  config.askMonthlyBudgetUsd = 5;
  config.turnReserveUsd = 0.3;
});

const routine = (trigger) =>
  parseRoutine(
    "r",
    `---\ntrigger: ${trigger}\nchannel: c\n${trigger === "schedule" ? "at: 01:00\n" : ""}${trigger === "events" ? "topics: clan_pulse\n" : ""}---\nprompt`,
  );

test("who drives the cost decides which pot it comes out of", () => {
  assert.equal(budget.laneFor(routine("message")), "ask");
  assert.equal(budget.laneFor(routine("schedule")), "routines");
  assert.equal(budget.laneFor(routine("events")), "routines");
});

test("the two lanes cannot spend each other's budget", () => {
  budget.record("ask", 5);
  assert.equal(budget.check("ask").ok, false, "ask is spent");
  assert.equal(
    budget.check("routines").ok,
    true,
    "and the schedule is untouched — otherwise a chatty afternoon cancels the 01:00 post",
  );
});

test("a turn that COULD cross the line does not start", () => {
  // $9.85 spent of $10, and this lane has produced a $0.40 turn before.
  budget.record("routines", 0.4);
  budget.record("routines", 9.45);
  const verdict = budget.check("routines");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "reserve", "refused before spending, not after");
  assert.ok(
    verdict.spent < verdict.budget,
    "the budget is not even reached yet",
  );
});

test("the reserve climbs to the largest turn the lane has seen", () => {
  assert.equal(
    budget.reserveFor("routines"),
    0.3,
    "the configured floor first",
  );
  budget.record("routines", 0.42);
  assert.equal(
    budget.reserveFor("routines"),
    0.42,
    "an expensive turn permanently raises what the lane reserves",
  );
  budget.record("routines", 0.05);
  assert.equal(budget.reserveFor("routines"), 0.42, "and never drops back");
});

test("spend is per calendar month, and does not roll over", () => {
  const august = new Date("2026-08-31T23:59:00Z");
  const september = new Date("2026-09-01T00:01:00Z");
  budget.record("routines", 9.9, august);
  assert.equal(budget.check("routines", august).ok, false);
  assert.equal(
    budget.spent("routines", september),
    0,
    "a new month is a new pot",
  );
  assert.equal(budget.check("routines", september).ok, true);
});

test("no budget configured is unlimited, and says so rather than reading as zero", () => {
  config.monthlyBudgetUsd = null;
  budget.record("routines", 999);
  const verdict = budget.check("routines");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unlimited, true);
  assert.equal(budget.status()[0].state, "unlimited");
});

test("status reports what an operator needs to decide anything", () => {
  budget.record("ask", 4.5);
  const ask = budget.status().find((b) => b.lane === "ask");
  assert.equal(ask.spent, 4.5);
  assert.equal(ask.budget, 5);
  assert.equal(ask.remaining, 0.5);
  assert.equal(
    ask.state,
    "reserved",
    "half a dollar left, a $0.30 reserve — stopped",
  );
  assert.equal(ask.month, budget.monthKey());
});

test("the ledger keeps a year and no more", () => {
  for (let i = 0; i < 15; i += 1) {
    budget.record("routines", 1, new Date(Date.UTC(2025, i, 15)));
  }
  assert.equal(Object.keys(state.get("budgets")).length, 12);
});

/**
 * Pricing is the other half of a strict budget: a model with no price used to
 * cost $0, so choosing one we had not heard of turned every cap into a number
 * that could not be reached.
 */
test("an unpriced model is refused, not billed at zero", async () => {
  const { costOf, rateFor, UnpricedModel } = await import("../src/pricing.js");
  assert.ok(rateFor("claude-sonnet-5").input > 0);
  assert.throws(() => rateFor("claude-imaginary-9"), UnpricedModel);
  assert.throws(
    () => costOf("claude-imaginary-9", { input_tokens: 1e6 }),
    UnpricedModel,
    "a cost that cannot be computed must not silently be zero",
  );
});

test("a turn is priced from usage, cache reads included", async () => {
  const { costOf } = await import("../src/pricing.js");
  // Sonnet 5: $2/MTok in, $10/MTok out, cache read a tenth of input.
  const usd = costOf("claude-sonnet-5", {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    cache_read_input_tokens: 1_000_000,
  });
  assert.equal(Number(usd.toFixed(4)), 2 + 1 + 0.2);
});

/**
 * The command surface, as data. Discord interactions are not testable here
 * without a gateway, but what the commands ARE, and who may use them, is.
 */
test("slash commands are declared, gated, and describe themselves", async () => {
  const { commandDefinitions, isAdmin, budgetReply } =
    await import("../src/commands.js");
  const defs = commandDefinitions();
  assert.deepEqual(defs.map((d) => d.name).sort(), [
    "budget",
    "routines",
    "run",
  ]);
  for (const def of defs) {
    assert.ok(def.description?.length > 10, `${def.name} needs a description`);
    // Hidden from members in the picker. The id check is the real gate, but a
    // command that spends money should not be sitting in everyone's menu.
    assert.ok(def.default_member_permissions, `${def.name} must be gated`);
  }
  const run = defs.find((d) => d.name === "run");
  assert.equal(run.options[0].autocomplete, true, "routine names autocomplete");
  assert.equal(run.options[0].required, true);

  config.adminUserIds = new Set(["704062105258557511"]);
  assert.equal(isAdmin("704062105258557511"), true);
  assert.equal(isAdmin("999"), false, "an allow-list, not a role check");

  config.monthlyBudgetUsd = 40;
  config.askMonthlyBudgetUsd = 20;
  const reply = budgetReply();
  assert.match(reply, /routines/);
  assert.match(reply, /\$40\.00/);
  assert.match(reply, /\$20\.00/);
});
