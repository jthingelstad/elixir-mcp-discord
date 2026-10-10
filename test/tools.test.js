/**
 * What each kind of turn may DO through Elixir: the server says which tools
 * only read, and this repo decides which writes each kind of turn keeps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { disabledTools, POLICIES } from "../src/tools.js";
import { toolCatalog } from "../src/mcp.js";
import { POLICY_CONTEXT_TOOL } from "../src/eligibility.js";

const annotated = {
  ok: true,
  annotated: true,
  tools: [
    { name: "players_summary", readOnly: true },
    { name: "elixir_timeline", readOnly: true },
    { name: "elixir_send_feedback", readOnly: false },
    { name: "elixir_identify", readOnly: false },
    { name: "elixir_track_clan", readOnly: false },
    { name: "collections_edit", readOnly: false },
  ],
};

test("every policy keeps every read and only the writes it names", () => {
  for (const policy of Object.keys(POLICIES)) {
    const off = disabledTools(policy, annotated);
    assert.ok(!off.includes("players_summary") && !off.includes("elixir_timeline"), `${policy} keeps the reads`);
    for (const write of ["elixir_track_clan", "collections_edit"])
      assert.ok(off.includes(write), `${policy}: ${write}`);
  }
  assert.deepEqual(disabledTools("rehearsal", annotated).sort(), [
    POLICY_CONTEXT_TOOL,
    "collections_edit",
    "elixir_identify",
    "elixir_send_feedback",
    "elixir_track_clan",
  ]);
});

test("without annotations a live lane keeps everything but elixir_identify and a rehearsal loses the prompted writes; no catalog, only the private tool is named", () => {
  const bare = {
    ...annotated,
    annotated: false,
    tools: annotated.tools.map(({ name }) => ({ name, readOnly: false })),
  };
  assert.deepEqual(
    disabledTools("ask", bare),
    [POLICY_CONTEXT_TOOL, "elixir_identify"],
    "off in every lane, annotated or not",
  );
  assert.deepEqual(disabledTools("rehearsal", bare).sort(), [
    POLICY_CONTEXT_TOOL,
    "elixir_identify",
    "elixir_send_feedback",
  ]);
  assert.deepEqual(
    disabledTools("rehearsal", { ok: false, tools: [] }),
    [POLICY_CONTEXT_TOOL],
    "the private tool is the one name sent unpublished: the connector only warns on it",
  );
});

test("the catalog reads readOnlyHint from tools/list, and knows when the server annotates nothing", async () => {
  const list = async () => ({
    ok: true,
    tools: [
      { name: "players_summary", annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "elixir_send_feedback", annotations: { readOnlyHint: false } },
      { name: "legacy_tool" },
    ],
  });
  const catalog = await toolCatalog({ list, fresh: true });
  assert.equal(catalog.annotated, true);
  assert.deepEqual(
    catalog.tools.map((t) => [t.name, t.readOnly]),
    [
      ["players_summary", true],
      ["elixir_send_feedback", false],
      ["legacy_tool", false],
    ],
  );
  const plain = await toolCatalog({ list: async () => ({ ok: true, tools: [{ name: "x" }] }), fresh: true });
  assert.equal(plain.annotated, false);
});

test("private eligibility stays disabled in every model lane regardless of read annotations", () => {
  for (const policy of Object.keys(POLICIES)) {
    for (const annotated of [true, false]) {
      const off = disabledTools(policy, {
        ok: true,
        annotated,
        tools: [
          { name: POLICY_CONTEXT_TOOL, readOnly: true },
          { name: "public_history", readOnly: true },
        ],
      });
      assert.deepEqual(off, [POLICY_CONTEXT_TOOL]);
    }
  }
});

test("private eligibility stays disabled in every lane when the catalog is unavailable or was taken before it was published", () => {
  const stale = { ok: true, annotated: true, tools: [{ name: "public_history", readOnly: true }] };
  const staleBare = { ...stale, annotated: false };
  for (const policy of [...Object.keys(POLICIES), "nonsense"]) {
    for (const catalog of [undefined, null, { ok: false, tools: [] }, stale, staleBare]) {
      const off = disabledTools(policy, catalog);
      assert.ok(off.includes(POLICY_CONTEXT_TOOL), `${policy}, ${JSON.stringify(catalog)}`);
      assert.equal(off.filter((name) => name === POLICY_CONTEXT_TOOL).length, 1, "named once");
    }
  }
});
