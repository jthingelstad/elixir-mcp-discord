/**
 * A deck link is eight card ids in a URL. Reading it is text, not the web;
 * it is the one local tool a member's turn gets.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeckLink, deckLinkTool } from "../src/deck-link.js";

const REAL =
  "check this https://link.clashroyale.com/en?clashroyale://copyDeck?deck=26000007;28000015;26000059;26000012;28000001;26000037;27000000;26000106&slots=0;0;0;0;0;0;0;0&tt=159000000&id=20JJJ2CCRU any good?";

test("a real link yields eight cards, the tower troop and the sharer; anything less is not a deck", () => {
  const deck = parseDeckLink(REAL);
  assert.deepEqual(deck.cardIds, [26000007, 28000015, 26000059, 26000012, 28000001, 26000037, 27000000, 26000106]);
  assert.equal(deck.towerTroopId, 159000000);
  assert.equal(deck.sharerTag, "#20JJJ2CCRU");
  assert.deepEqual(
    parseDeckLink("clashroyale://copyDeck?deck=26000007;28000015;26000059;26000012;28000001;26000037;27000000;26000106")
      .cardIds.length,
    8,
  );
  assert.equal(
    parseDeckLink("https://link.clashroyale.com/deck/en?deck=26000007;28000015;26000059"),
    null,
    "a partial deck is not a deck",
  );
  assert.equal(parseDeckLink("how am I playing?"), null);
});

test("the tool resolves names through cards_catalog and says what a link cannot know", async () => {
  const calls = [];
  const tool = deckLinkTool({
    resolve: async (name, args) => {
      calls.push([name, args]);
      return {
        ok: true,
        body: {
          cards: [
            { id: 26000007, name: "Giant", rarity: "rare", elixir: 5 },
            { id: 159000000, name: "Tower Princess", rarity: "common" },
          ],
        },
      };
    },
  });
  const out = await tool.handler({ link: REAL });
  assert.equal(calls[0][0], "cards_catalog");
  assert.deepEqual(calls[0][1].ids.slice(0, 1), [26000007]);
  assert.equal(calls[0][1].ids.length, 9, "eight cards plus the tower troop");
  assert.equal(out.body.cards[0].name, "Giant");
  assert.equal(out.body.cards[1].name, null, "an unresolved id stays an id");
  assert.equal(out.body.tower_troop.name, "Tower Princess");
  assert.equal(out.body.shared_by, "#20JJJ2CCRU");
  assert.match(out.body.note, /does not say which cards are evolved/);
  const nope = await tool.handler({ link: "hello" });
  assert.equal(nope.ok, false);
  assert.equal(nope.code, "not_a_deck_link");
});
