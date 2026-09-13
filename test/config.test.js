/**
 * Defaults are the part of an example project other people actually copy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";

test("the feed is polled every thirty minutes unless the operator says otherwise", () => {
  // The hub's own guidance: hourly is plenty, and five minutes was more than
  // half a member's daily call budget spent on an empty feed.
  if (!process.env.EVENT_POLL_SECONDS) assert.equal(config.eventPollSeconds, 1800);
});
