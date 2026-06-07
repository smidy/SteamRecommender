#!/usr/bin/env bun
/**
 * rank.ts — SteamRecommender Rank feature (ISA.md ISC-7, ISC-15). Orchestrates the full pipeline:
 * fetch library → build taste profile → retrieve candidates → SCORE + MMR-diversify + franchise-dedup.
 *
 * Scoring bridges the coarse owned-side genre vocabulary to the candidates' rich community tags:
 *   score = 0.7·fit(taste∩candidate-tags, normalized) + 0.3·quality(sdbrating|metascore)
 * Then Maximal-Marginal-Relevance selection penalizes tag-overlap with already-picked games so the
 * shortlist spans many sub-genres (ISC-7), and franchise dedup drops sequels/prequels of owned-but-
 * abandoned series (ISC-15). Output is a ~25-game shortlist for the Explain stage to finalize.
 *
 * Usage:
 *   STEAM_API_KEY=xxxx bun rank.ts <steamid|vanity> [--n 25] [--pages 30] [--summary]
 *
 * @author PAI System — SteamRecommender
 * @version 0.1.0
 */

import { resolveSteamId, getOwnedGames, getRecentlyPlayed, getPlayerSummary, getApiKey, type Game } from "./fetch_library.ts";
import { getCatalog } from "./catalog_cache.ts";
import { buildProfile } from "./build_profile.ts";
import { retrieveCandidates, type Candidate } from "./retrieve.ts";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", red: "\x1b[31m", yellow: "\x1b[33m" };
const LAMBDA = 0.5;        // MMR diversity weight
const DEFAULT_N = 25;

// Tags that mark software/tools, not games — exclude from recommendations.
const SOFTWARE = new Set(["Animation & Modeling", "Audio Production", "Design & Illustration", "Photo Editing", "Software Training", "Utilities", "Video Production", "Web Publishing", "Game Development"]);
// Tokens that never indicate a franchise (articles, edition words, numerals).
const STOP = new Set(["the", "of", "and", "a", "an", "edition", "game", "year", "goty", "deluxe", "definitive", "remastered", "remaster", "complete", "collection", "bundle", "hd", "vr", "ii", "iii", "iv", "vi", "vii", "viii", "ix", "x", "online", "plus", "anniversary", "enhanced", "legacy"]);
// Long-but-generic words that shouldn't be franchise keys on their own.
const GENERIC = new Set(["simulator", "survival", "fantasy", "kingdom", "warfare", "defense", "chronicles", "legends", "dungeon", "builder", "crafting", "adventure", "shooter", "strategy", "complete", "world", "origins", "remake"]);

const tokens = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
function franchiseKeys(name: string): Set<string> {
  const t = tokens(name); const keys = new Set<string>();
  for (const w of t) if (w.length >= 6 && !GENERIC.has(w) && !/^\d+$/.test(w)) keys.add(w);           // distinctive single token
  for (let i = 0; i < t.length - 1; i++) if (t[i].length >= 4 && t[i + 1].length >= 4) keys.add(`${t[i]} ${t[i + 1]}`); // significant bigram
  return keys;
}
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b); let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter; return uni ? inter / uni : 0;
}

export interface Ranked extends Candidate { score: number; fit: number; quality: number; primary_tag: string; matched_tags: string[]; }

export function rank(taste: Record<string, number>, candidates: Candidate[], owned: Game[], opts: { n?: number } = {}): Ranked[] {
  const n = opts.n ?? DEFAULT_N;

  // ISC-15: franchise keys of owned-but-abandoned games (own an entry, 0 recent playtime).
  const ownedKeys = new Set<string>();
  for (const g of owned) if (g.playtime_2weeks === 0) for (const k of franchiseKeys(g.name)) ownedKeys.add(k);

  // Pool tag document-frequency → a game's rarest tag is its most characteristic ("primary") tag.
  const df: Record<string, number> = {};
  for (const c of candidates) for (const t of c.tags) df[t] = (df[t] ?? 0) + 1;

  // Filter: drop software + franchise-dupes; then score.
  const scored = candidates
    .filter((c) => !c.tags.some((t) => SOFTWARE.has(t)))
    .filter((c) => { for (const k of franchiseKeys(c.name)) if (ownedKeys.has(k)) return false; return true; }) // ISC-15
    .map((c) => {
      const matched = c.tags.filter((t) => taste[t]);
      const fit = matched.reduce((s, t) => s + taste[t], 0);
      const quality = (c.sdbrating ?? c.metascore ?? 70) / 100;
      const primary = [...c.tags].sort((a, b) => (df[a] - df[b]) || (b.length - a.length))[0] ?? "Game"; // rarest = most characteristic
      return { ...c, fit, quality, primary_tag: primary, matched_tags: matched, score: 0 };
    });

  const maxFit = Math.max(1e-9, ...scored.map((s) => s.fit));
  for (const s of scored) s.score = +(0.7 * (s.fit / maxFit) + 0.3 * s.quality).toFixed(4);
  scored.sort((a, b) => b.score - a.score);

  // ISC-7: MMR — greedily pick high score while penalizing tag-overlap with already-selected.
  const selected: Ranked[] = []; const pool = [...scored];
  while (selected.length < n && pool.length) {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const div = selected.length ? Math.max(...selected.map((s) => jaccard(pool[i].tags, s.tags))) : 0;
      const v = pool[i].score - LAMBDA * div;
      if (v > bv) { bv = v; bi = i; }
    }
    selected.push(pool.splice(bi, 1)[0]);
  }
  return selected;
}

function printSummary(persona: string, ranked: Ranked[]) {
  console.log(`${C.bold}Top ${ranked.length} candidates for ${persona}${C.reset} ${C.dim}(coarse rank — Explain stage finalizes)${C.reset}\n`);
  ranked.forEach((r, i) => {
    console.log(`${C.green}${String(i + 1).padStart(2)}.${C.reset} ${C.bold}${r.name}${C.reset} ${C.dim}[${r.primary_tag}] sdb=${r.sdbrating ?? "—"} score=${r.score}${C.reset}`);
    console.log(`     ${C.dim}matched: ${r.matched_tags.slice(0, 5).join(", ") || "—"} | tags: ${r.tags.slice(0, 5).join(", ")}${C.reset}`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) { console.log("Usage: STEAM_API_KEY=xxxx bun rank.ts <steamid|vanity> [--n 25] [--pages 30] [--summary]"); return; }
  const summary = argv.includes("--summary");
  const nArg = argv.indexOf("--n"); const n = nArg !== -1 ? parseInt(argv[nArg + 1], 10) : DEFAULT_N;
  const pArg = argv.indexOf("--pages"); const pages = pArg !== -1 ? parseInt(argv[pArg + 1], 10) : 30;
  const skip = new Set<number>(); argv.forEach((a, i) => { if (a === "--n" || a === "--pages") skip.add(i + 1); });
  const input = argv.find((a, i) => !a.startsWith("--") && !skip.has(i));
  if (!input) { console.error(`${C.red}No SteamID/vanity.${C.reset}`); process.exit(2); }

  const key = getApiKey();
  const steamid = await resolveSteamId(input, key);
  const profileMeta = await getPlayerSummary(steamid, key);
  const owned = await getOwnedGames(steamid, key);
  if (!owned) { console.log(JSON.stringify({ status: "private", steamid })); process.exit(0); }
  const recent = await getRecentlyPlayed(steamid, key);

  const playedAppids = owned.games.filter((g) => g.playtime_forever > 0).map((g) => g.appid);
  const { meta } = await getCatalog(playedAppids, { fetchMissing: true });
  const profile = buildProfile({ steamid, persona: profileMeta?.persona, games: owned.games, recent, catalog: meta });

  process.stderr.write(`${C.cyan}retrieving candidates…${C.reset}\n`);
  const { candidates } = await retrieveCandidates(steamid, key, { pages });
  const ranked = rank(profile.taste_vector, candidates, owned.games, { n });
  process.stderr.write(`${C.green}ranked ${ranked.length}${C.reset} from ${candidates.length} candidates (archetype: ${profile.archetype.primary})\n`);

  if (summary) printSummary(profileMeta?.persona ?? steamid, ranked);
  else console.log(JSON.stringify({ steamid, persona: profileMeta?.persona, archetype: profile.archetype.primary, taste_top: Object.keys(profile.taste_vector).slice(0, 8), signature_games: profile.signature_games, shortlist: ranked }, null, 2));
}

if (import.meta.main) {
  main().catch((e) => { console.error(`${C.red}Error:${C.reset} ${(e as Error).message}`); process.exit(1); });
}
