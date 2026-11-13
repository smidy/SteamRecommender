#!/usr/bin/env bun
/**
 * build_profile.ts — SteamRecommender TasteProfile feature (ISA.md ISC-4, ISC-12).
 *
 * Composes fetch_library (history) + catalog_cache (genres/categories) into:
 *   • a taste-vector  — each played game's tags accumulated, weighted by log(1+hours) so one
 *                       2000h obsession can't drown the profile (ISC-4), times a recency decay on
 *                       the game's last-played date so current taste outweighs games you've moved on
 *                       from (12-month half-life, floor 0.25; --no-recency for the all-time view),
 *   • a Gaming DNA report — the player's archetype + supporting stats (ISC-12).
 *
 * Usage:
 *   STEAM_API_KEY=xxxx bun build_profile.ts <steamid|vanity>            # JSON profile
 *   STEAM_API_KEY=xxxx bun build_profile.ts <steamid|vanity> --summary  # human-readable Gaming DNA
 *   add --no-recency to weight all-time hours only
 *
 * @author PAI System — SteamRecommender
 * @version 0.1.0
 */

import { resolveSteamId, getOwnedGames, getRecentlyPlayed, getPlayerSummary, getApiKey, type Game } from "./fetch_library.ts";
import { getCatalog, type CatalogEntry } from "./catalog_cache.ts";
import { getStoreTags } from "./store_tags.ts";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" };

/** ISC-4: sub-linear playtime weighting. log(1001)/log(101) ≈ 1.50 < 2. */
export const playtimeWeight = (hours: number) => Math.log(1 + hours);

/** Recency decay on a game's last-played date: 1.0 today, halves every RECENCY_HALF_LIFE_DAYS, never below
 *  RECENCY_FLOOR so long-standing favourites still count. Unknown / never → the floor. */
export const RECENCY_HALF_LIFE_DAYS = 365;
export const RECENCY_FLOOR = 0.25;
export function recencyFactor(rtimeLastPlayed: number | undefined, nowSec = Date.now() / 1000): number {
  if (!rtimeLastPlayed) return RECENCY_FLOOR;
  const days = Math.max(0, (nowSec - rtimeLastPlayed) / 86400);
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

// Tag clusters over the genre + play-mode-category vocabulary (Steam store appdetails).
const CLUSTERS: Record<string, Set<string>> = {
  multiplayer: new Set(["Multi-player", "Co-op", "Online Co-op", "Online PvP", "PvP", "MMO", "Massively Multiplayer", "Cross-Platform Multiplayer", "LAN Co-op", "Shared/Split Screen"]),
  strategy: new Set(["Strategy", "Simulation"]),
  rpg: new Set(["RPG", "Massively Multiplayer"]),
  narrative: new Set(["Adventure", "RPG"]),
  action: new Set(["Action"]),
  single: new Set(["Single-player"]),
};
const NON_GAME_TYPES = new Set(["application", "tool", "music", "video", "demo", "hardware"]);

interface Profile {
  steamid: string;
  persona?: string;
  visibility?: string;
  stats: {
    library_count: number; played_count: number; tagged_count: number; catalog_coverage: number;
    store_tag_coverage: number; total_hours: number; top1_share: number; top5_share: number; avg_played_hours: number; median_played_hours: number;
  };
  recency: boolean; // taste + signature games weighted by last-played decay
  taste_vector: Record<string, number>;
  recent_tags: string[];
  signature_games: { name: string; hours: number }[];
  archetype: { primary: string; ranked: { name: string; score: number; why: string }[] };
}

function clusterShare(taste: Record<string, number>, set: Set<string>): number {
  let inSet = 0, total = 0;
  for (const [tag, w] of Object.entries(taste)) { total += w; if (set.has(tag)) inSet += w; }
  return total ? inSet / total : 0;
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function buildProfile(args: {
  steamid: string; persona?: string; visibility?: string;
  games: Game[]; recent: Game[]; catalog: Record<number, CatalogEntry>; recency?: boolean;
  /** Player tags per appid (store_tags.ts). When present they drive the taste vector, which is what rank.ts
   *  matches against the candidates' player tags; genres still drive the archetype. */
  storeTags?: Record<number, Record<string, number>>;
}): Profile {
  const { steamid, persona, visibility, games, recent, catalog } = args;
  const recency = args.recency ?? true;
  const gameWeight = (g: Game) => playtimeWeight(g.playtime_forever / 60) * (recency ? recencyFactor(g.rtime_last_played) : 1);

  // Played games only; exclude non-game apps (Wallpaper Engine, soundtracks, tools) from taste.
  const played = games.filter((g) => g.playtime_forever > 0);
  const taggable = played.filter((g) => {
    const c = catalog[g.appid];
    return c && Object.keys(c.tags).length > 0 && !NON_GAME_TYPES.has(c.type);
  });

  // Taste vector — each game contributes `gameWeight` (log hours × recency decay) total mass, spread across its tags.
  // `taste` (genres + play-mode categories) feeds the archetype clusters; `rich` (player tags where Steam has
  // them, genres otherwise) becomes the taste vector that ranking uses.
  const taste: Record<string, number> = {};
  const rich: Record<string, number> = {};
  const storeTags = args.storeTags ?? {};
  const accumulate = (into: Record<string, number>, tags: Record<string, number>, w: number) => {
    const sum = Object.values(tags).reduce((a, b) => a + b, 0) || 1;
    for (const [tag, v] of Object.entries(tags)) into[tag] = (into[tag] ?? 0) + w * (v / sum);
  };
  let richCount = 0;
  for (const g of taggable) {
    const w = gameWeight(g);
    accumulate(taste, catalog[g.appid].tags, w);
    const st = storeTags[g.appid];
    if (st && Object.keys(st).length) richCount++;
    accumulate(rich, st && Object.keys(st).length ? st : catalog[g.appid].tags, w);
  }
  const tasteTotal = Object.values(rich).reduce((a, b) => a + b, 0) || 1;
  const tasteNorm: Record<string, number> = {};
  for (const [t, w] of Object.entries(rich).sort((a, b) => b[1] - a[1]).slice(0, 60)) tasteNorm[t] = +(w / tasteTotal).toFixed(4);

  // Recent taste (last 2 weeks)
  const recentTagSet = new Set<string>();
  for (const g of recent) { const c = catalog[g.appid]; if (c) for (const t of Object.keys(c.tags)) recentTagSet.add(t); }

  // Stats
  const hoursList = played.map((g) => g.playtime_forever / 60).sort((a, b) => b - a);
  const totalHours = hoursList.reduce((a, b) => a + b, 0);
  const top1 = hoursList[0] ?? 0;
  const top5 = hoursList.slice(0, 5).reduce((a, b) => a + b, 0);
  const avgPlayed = played.length ? totalHours / played.length : 0;
  const median = hoursList.length ? hoursList[Math.floor(hoursList.length / 2)] : 0;

  // Archetype scores (transparent, deterministic). Completionist needs achievement data → flagged undetermined.
  const conc = totalHours ? top1 / totalHours : 0;
  const mpShare = clusterShare(taste, CLUSTERS.multiplayer);
  const stratShare = clusterShare(taste, CLUSTERS.strategy);
  const rpgShare = clusterShare(taste, CLUSTERS.rpg);
  const narrShare = clusterShare(taste, CLUSTERS.narrative);
  const recentShare = played.length ? recent.length / Math.min(played.length, 10) : 0;

  const scores = [
    { name: "Grinder", score: +(0.45 * conc + 0.4 * clamp01(avgPlayed / 40) + 0.3 * stratShare).toFixed(3),
      why: `top title = ${(conc * 100).toFixed(0)}% of all hours, avg ${avgPlayed.toFixed(0)}h/game, ${(stratShare * 100).toFixed(0)}% strategy/sim` },
    { name: "Social/Multiplayer", score: +(1.1 * mpShare + 0.3 * clamp01(recentShare)).toFixed(3),
      why: `${(mpShare * 100).toFixed(0)}% multiplayer tags, ${recent.length} played in last 2 weeks` },
    { name: "Narrative", score: +(0.9 * narrShare + 0.3 * rpgShare).toFixed(3),
      why: `${(narrShare * 100).toFixed(0)}% adventure/RPG tags` },
    { name: "Dabbler", score: +(clamp01(played.length / 150) * (1 - clamp01(avgPlayed / 15))).toFixed(3),
      why: `${played.length} games played, avg only ${avgPlayed.toFixed(0)}h each` },
    { name: "Completionist", score: 0, why: "needs achievement data (not yet fetched)" },
  ].sort((a, b) => b.score - a.score);

  return {
    steamid, persona, visibility, recency,
    stats: {
      library_count: games.length, played_count: played.length, tagged_count: taggable.length,
      catalog_coverage: played.length ? +(taggable.length / played.length).toFixed(3) : 0,
      store_tag_coverage: taggable.length ? +(richCount / taggable.length).toFixed(3) : 0,
      total_hours: Math.round(totalHours), top1_share: +conc.toFixed(3), top5_share: +(totalHours ? top5 / totalHours : 0).toFixed(3),
      avg_played_hours: +avgPlayed.toFixed(1), median_played_hours: +median.toFixed(1),
    },
    taste_vector: tasteNorm,
    recent_tags: [...recentTagSet],
    // Signature games follow the same weighting, so the Explain step grounds picks in what you play now.
    signature_games: [...played].sort((a, b) => gameWeight(b) - gameWeight(a)).slice(0, 8).map((g) => ({ name: g.name, hours: Math.round(g.playtime_forever / 60) })),
    archetype: { primary: scores[0].name, ranked: scores },
  };
}

function printSummary(p: Profile) {
  const topTags = Object.entries(p.taste_vector).slice(0, 8).map(([t, w]) => `${t} ${(w * 100).toFixed(0)}%`);
  console.log(`${C.bold}🎮 Gaming DNA — ${p.persona}${C.reset} ${C.dim}(${p.steamid})${C.reset}`);
  console.log(`\n${C.cyan}Archetype:${C.reset} ${C.bold}${p.archetype.primary}${C.reset}  ${C.dim}— ${p.archetype.ranked[0].why}${C.reset}`);
  console.log(`${C.dim}runner-up: ${p.archetype.ranked[1].name} (${p.archetype.ranked[1].score})${C.reset}`);
  console.log(`\n${C.cyan}Stats:${C.reset} ${p.stats.played_count}/${p.stats.library_count} games played · ${p.stats.total_hours}h total · avg ${p.stats.avg_played_hours}h · top title ${(p.stats.top1_share * 100).toFixed(0)}% of hours`);
  console.log(`${C.dim}catalog coverage: ${(p.stats.catalog_coverage * 100).toFixed(0)}% of played games tagged · player tags on ${(p.stats.store_tag_coverage * 100).toFixed(0)}%${C.reset}`);
  console.log(`\n${C.cyan}Taste signature:${C.reset} ${topTags.join(" · ")}`);
  if (p.recent_tags.length) console.log(`${C.cyan}Lately into:${C.reset} ${p.recent_tags.join(", ")}`);
  console.log(`\n${C.cyan}Signature games:${C.reset} ${C.dim}${p.recency ? "(hours × recency of last play)" : "(all-time hours)"}${C.reset}`);
  for (const g of p.signature_games) console.log(`  ${C.green}${String(g.hours).padStart(4)}h${C.reset} ${C.dim}|${C.reset} ${g.name}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log("Usage: STEAM_API_KEY=xxxx bun build_profile.ts <steamid|vanity> [--summary] [--no-recency]"); return;
  }
  const summary = argv.includes("--summary");
  const input = argv.find((a) => !a.startsWith("--"));
  if (!input) { console.error(`${C.red}No SteamID/vanity provided.${C.reset}`); process.exit(2); }

  const key = getApiKey();
  const steamid = await resolveSteamId(input, key);
  const profileMeta = await getPlayerSummary(steamid, key);
  const owned = await getOwnedGames(steamid, key);
  if (!owned) { console.log(JSON.stringify({ status: "private", steamid, message: `Library private — make "Game details" = Public.` })); process.exit(0); }
  const recent = await getRecentlyPlayed(steamid, key);

  const playedAppids = owned.games.filter((g) => g.playtime_forever > 0).map((g) => g.appid);
  process.stderr.write(`${C.dim}building profile: ${playedAppids.length} played games → catalog…${C.reset}\n`);
  const { meta, stats } = await getCatalog(playedAppids, { fetchMissing: true, log: true });
  process.stderr.write(`${C.dim}catalog: hits=${stats.hits} fetched=${stats.fetched} misses=${stats.misses}${C.reset}\n`);
  const storeTags = await getStoreTags(playedAppids, { log: true });

  const profile = buildProfile({ steamid, persona: profileMeta?.persona, visibility: profileMeta?.visibility, games: owned.games, recent, catalog: meta, recency: !argv.includes("--no-recency"), storeTags });
  if (summary) printSummary(profile);
  else console.log(JSON.stringify(profile, null, 2));
}

if (import.meta.main) {
  main().catch((e) => { console.error(`${C.red}Error:${C.reset} ${(e as Error).message}`); process.exit(1); });
}
