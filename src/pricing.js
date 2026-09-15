/**
 * What a turn costs, which is the thing a budget is made of.
 *
 * The model is the operator's choice — so the price has to be too. A hardcoded
 * table with three models in it silently returned $0 for anything else, which
 * meant picking a model we had not heard of turned every budget into a number
 * that never moved. An unpriced model is therefore an ERROR, at boot and at
 * call time, rather than a free one.
 *
 * `agent/models.json` extends or overrides the catalog below, and it is
 * operator-owned like everything else in agent/: prices change, this file
 * ships a snapshot, and the person paying the bill is the one who should get
 * to correct it without a deploy.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * USD per million tokens, from the Claude API reference (2026-09).
 *
 * cache_write and cache_read default to the standard multiples of input
 * (1.25x and 0.1x) and can be stated explicitly per model — Fable 5.1's cache
 * reads, for instance, are not the usual ratio.
 */
const CATALOG = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function complete(rate) {
  return {
    input: rate.input,
    output: rate.output,
    cacheWrite: rate.cacheWrite ?? rate.input * 1.25,
    cacheRead: rate.cacheRead ?? rate.input * 0.1,
  };
}

let cache = null;

export function priceBook({ dir = config.agentDir, reload = false } = {}) {
  if (cache && !reload) return cache;
  let overrides = {};
  const file = path.join(dir, "models.json");
  try {
    overrides = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`${file} is not readable JSON: ${error.message}`);
    }
  }
  const book = {};
  for (const [model, rate] of Object.entries({ ...CATALOG, ...overrides })) {
    // JSON has no comments, so an underscore key is how this file explains
    // itself. Skipped rather than validated.
    if (model.startsWith("_")) continue;
    if (typeof rate?.input !== "number" || typeof rate?.output !== "number") {
      throw new Error(`${file}: "${model}" needs numeric input and output prices per million tokens.`);
    }
    book[model] = complete(rate);
  }
  cache = book;
  return book;
}

export class UnpricedModel extends Error {
  constructor(model) {
    super(
      `No price for model "${model}". Budgets cannot be enforced against a model whose cost is unknown — add it to agent/models.json with input and output prices per million tokens.`,
    );
    this.model = model;
  }
}

export function rateFor(model) {
  const rate = priceBook()[model];
  if (!rate) throw new UnpricedModel(model);
  return rate;
}

export function costOf(model, usage) {
  const rate = rateFor(model);
  if (!usage) return 0;
  return (
    ((usage.input_tokens || 0) * rate.input +
      (usage.output_tokens || 0) * rate.output +
      (usage.cache_creation_input_tokens || 0) * rate.cacheWrite +
      (usage.cache_read_input_tokens || 0) * rate.cacheRead) /
    1_000_000
  );
}
