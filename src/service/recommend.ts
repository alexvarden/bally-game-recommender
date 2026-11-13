/**
 * Turns a ranker result into the player-facing response. Pure: no I/O, no clock.
 *
 * Rules: the page never gets an error for a miss. When the ranker can't fill the list, it is topped up from the
 * brand fallback list and flagged. Operator state is re-checked here even though the ranker also applies it: a game
 * suspended a moment ago must never be shown, whatever the ranker does.
 */
import type { z } from "zod";
import type { Brand, EnrichedGame } from "../catalogue/schema.ts";
import type { FallbackReason, RecommendationResponse } from "../contracts/ranking.ts";
import type { OperatorState } from "../contracts/storage.ts";
import type { Snapshot } from "./index-loader.ts";

type BrandId = z.infer<typeof Brand>;
type Item = RecommendationResponse["items"][number];

/** Live on this brand and not quarantined, according to operator state. Unknown state is never servable. */
export function isServable(state: OperatorState | undefined, brand: BrandId): boolean {
  return !!state && state.status === "live" && state.brands.includes(brand) && !state.quarantined;
}

/** Newest live in-house games on the brand: a stand-in for an editorially curated list. */
export function fallbackList(games: readonly EnrichedGame[], brand: BrandId, operator: ReadonlyMap<string, OperatorState>): EnrichedGame[] {
  return games
    .filter((g) => g.supplyChannel === "in_house" && isServable(operator.get(g.id), brand))
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.name.localeCompare(b.name));
}

function seedReason(snapshot: Snapshot, seedId: string, brand: BrandId, operator: ReadonlyMap<string, OperatorState>): FallbackReason | null {
  if (!snapshot.byId.has(seedId)) return "unknown_game";
  if (!isServable(operator.get(seedId), brand)) return "seed_unavailable";
  return null;
}

function topUp(items: Item[], seedId: string, limit: number, fallback: EnrichedGame[]): Item[] {
  const taken = new Set([seedId, ...items.map((i) => i.gameId)]);
  const extra = fallback.filter((g) => !taken.has(g.id)).slice(0, limit - items.length);
  return [...items, ...extra.map((g) => ({ gameId: g.id, name: g.name, score: null, fallback: true }))];
}

export interface RecommendInput {
  snapshot: Snapshot | null;
  operator: ReadonlyMap<string, OperatorState>;
  brand: BrandId;
  seedId: string;
  limit: number;
}

export function recommend({ snapshot, operator, brand, seedId, limit }: RecommendInput): RecommendationResponse {
  const base = { brand, gameId: seedId, indexVersion: snapshot?.index.version ?? null };
  if (!snapshot) return { ...base, fallback: true, reason: "index_unavailable", items: [] };

  const fallback = fallbackList(snapshot.games.map((g) => g.game), brand, operator);
  const blocked = seedReason(snapshot, seedId, brand, operator);
  if (blocked) return { ...base, fallback: true, reason: blocked, items: topUp([], seedId, limit, fallback) };

  const result = snapshot.ranker.rank(seedId, brand, limit, operator);
  const ranked: Item[] = result.items
    .filter((i) => i.gameId !== seedId && isServable(operator.get(i.gameId), brand) && snapshot.byId.has(i.gameId))
    .slice(0, limit)
    .map((i) => ({ gameId: i.gameId, name: snapshot.byId.get(i.gameId)!.game.name, score: i.score, fallback: false }));

  if (ranked.length >= limit) return { ...base, fallback: false, reason: result.reason, items: ranked };
  const items = topUp(ranked, seedId, limit, fallback);
  return { ...base, fallback: items.some((i) => i.fallback), reason: result.reason ?? "below_floor", items };
}
