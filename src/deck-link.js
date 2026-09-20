/**
 * A Clash Royale deck link carries the deck IN THE URL:
 *
 *   https://link.clashroyale.com/deck/en?deck=26000007;28000015;...&slots=0;0;...&tt=159000000&id=20JJJ2CCRU
 *   clashroyale://copyDeck?deck=26000007;28000015;...
 *
 * `deck` is eight card ids; `tt` is the tower troop's id; `slots` is always
 * zero (a link does not say which cards are evolved — the one thing people
 * assume it does); `id` is the sharer's player tag. So "is this deck any
 * good for me?" needs no web access: read the ids off the text, resolve
 * them through cards_catalog, and the record does the rest. The only member
 * use case anyone pastes a link for, and it stays inside the one source.
 */

import { callTool } from "./mcp.js";

const LINK =
  /(?:link\.clashroyale\.com\/[^\s]*|clashroyale:\/\/copyDeck)[^\s]*?[?&]deck=([0-9;]+)(?:[^\s]*?[?&]tt=(\d+))?(?:[^\s]*?[?&]id=([0-9A-Z]+))?/i;

/** The deck in a message, or null. */
export function parseDeckLink(text) {
  const match = LINK.exec(String(text || ""));
  if (!match) return null;
  const cardIds = match[1]
    .split(";")
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (cardIds.length !== 8) return null;
  return { cardIds, towerTroopId: match[2] ? Number(match[2]) : null, sharerTag: match[3] ? `#${match[3]}` : null };
}

export function deckLinkTool({ resolve = callTool } = {}) {
  return {
    name: "deck_link",
    description:
      "Read a Clash Royale deck link (link.clashroyale.com/deck/... or clashroyale://copyDeck?deck=...) that someone pasted: the eight cards by name, the tower troop, and who shared it. A link never says which cards are evolved. Then cards_archetype with those cards names it, and the record (battles_decks, cards_synergy, players_collection) says anything else about it.",
    input_schema: {
      type: "object",
      properties: { link: { type: "string", description: "the link, or the whole message containing it" } },
      required: ["link"],
      additionalProperties: false,
    },
    async handler({ link }) {
      const deck = parseDeckLink(link);
      if (!deck) return { ok: false, code: "not_a_deck_link", error: "no deck link with eight card ids in that text" };
      const ids = [...deck.cardIds, ...(deck.towerTroopId ? [deck.towerTroopId] : [])];
      const catalog = await resolve("cards_catalog", { ids, verbosity: "compact" });
      const cards = catalog.ok ? catalog.body?.cards || [] : [];
      const byId = new Map(cards.map((c) => [Number(c.id ?? c.card_id), c]));
      const shape = (id) => {
        const c = byId.get(id);
        return c
          ? { id, name: c.name, rarity: c.rarity ?? undefined, elixir: c.elixir ?? c.cost ?? undefined }
          : { id, name: null };
      };
      return {
        ok: true,
        body: {
          cards: deck.cardIds.map(shape),
          tower_troop: deck.towerTroopId ? shape(deck.towerTroopId) : null,
          shared_by: deck.sharerTag,
          average_elixir: cards.length
            ? Number(
                (
                  deck.cardIds
                    .map((id) => byId.get(id)?.elixir ?? byId.get(id)?.cost)
                    .filter((n) => typeof n === "number")
                    .reduce((a, b) => a + b, 0) /
                  Math.max(
                    1,
                    deck.cardIds.filter((id) => typeof (byId.get(id)?.elixir ?? byId.get(id)?.cost) === "number")
                      .length,
                  )
                ).toFixed(1),
              )
            : null,
          note: catalog.ok
            ? "A link does not say which cards are evolved or what level they are; only the record does."
            : `cards_catalog did not answer (${catalog.error}); ids only.`,
        },
      };
    },
  };
}
