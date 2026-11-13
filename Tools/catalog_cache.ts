#!/usr/bin/env bun
/**
 * catalog_cache.ts — SteamRecommender CatalogCache feature (ISA.md ISC-10, ISC-11).
 *
 * Fetches per-game genres + categories from the official Steam Store appdetails API and caches them to
 * disk keyed by appid, so a second run over an overlapping set issues strictly fewer network calls
 * (ISC-10). The store API rate-limits at ~200 req / 5 min, so we throttle to 1.7s (ISC-11) with a 429
 * backoff. (SteamSpy — the original richer-tag source — is now behind a Cloudflare bot challenge and
 * unfetchable; genres + play-mode categories are the reliable substitute. No API key needed for this API.)
 *
 * Usage:
 *   bun catalog_cache.ts <appid> [<appid> ...]              # fetch/cache specific appids → JSON
 *   bun catalog_cache.ts --stdin                            # read appids from stdin (JSON array or whitespace)
 *   STEAM_API_KEY=xxxx bun catalog_cache.ts --library <id>  # cache the played games of a Steam library
 *   bun catalog_cache.ts --library <id> --no-fetch          # report cache coverage only, fetch nothing
 *
 * Options:
 *   --library <id>   Resolve a SteamID/vanity and cache its games (played-only by default).
 *   --all-games      With --library, include 0-playtime games too (default: played-only — 0h = 0 taste weight).
 *   --no-fetch       Use cache only; do not hit SteamSpy (for ISC-10 second-run probe).
 *   --stats          Print only the {requested, hits, fetched, misses, elapsed_ms} line.
 *   --stdin          Read appids from stdin.
 *   --help           Show this help.
 *
 * Cache file: <skill>/cache/catalog.json, or $STEAMREC_CACHE_DIR/catalog.json when that is set.
 *
 * @author PAI System — SteamRecommender
 * @version 0.1.0
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveSteamId, getOwnedGames, getApiKey } from "./fetch_library.ts";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// STEAMREC_CACHE_DIR moves the cache out of the skill dir (e.g. into a private data folder); default: <skill>/cache.
const CACHE_DIR = process.env.STEAMREC_CACHE_DIR || path.join(SKILL_DIR, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "catalog.json");
const STORE_API = "https://store.steampowered.com/api/appdetails";
const THROTTLE_MS = 1700; // store appdetails ≈200 req/5min; 1.7s stays safely under (ISC-11)
const SAVE_EVERY = 10;     // incremental persistence so a long fill survives interruption
// Categories that signal multiplayer/social play (vs single-player) — a taste axis genres miss.
const MP_CATEGORIES = new Set(["Multi-player", "Co-op", "Online Co-op", "Online PvP", "PvP", "Cross-Platform Multiplayer", "MMO", "LAN Co-op", "LAN PvP", "Shared/Split Screen", "Shared/Split Screen Co-op", "Shared/Split Screen PvP"]);

const C = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" };

export interface CatalogEntry {
  appid: number;
  name: string;
  genres: string[];
  categories: string[];
  tags: Record<string, number>; // unified taste dict: genres (weight 1.0) + play-mode categories (0.5)
  type: string;                 // "game", "dlc", "demo", ...
  fetched_at: string;
}

interface Cache { [appid: string]: CatalogEntry; }

function loadCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); } catch { return {}; }
}
function saveCache(cache: Cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch genres + categories from the official Steam Store appdetails API and fold them into a taste dict. */
async function fetchAppDetails(appid: number): Promise<CatalogEntry | null> {
  const url = `${STORE_API}?appids=${appid}&filters=basic,genres,categories&cc=us&l=english`;
  let res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) { await sleep(15000); res = await fetch(url, { headers: { Accept: "application/json" } }); } // backoff
  if (!res.ok) return null;
  const j = await res.json();
  const node = j?.[String(appid)];
  if (!node || !node.success || !node.data) return null; // delisted / region-locked / invalid appid
  const d = node.data;
  const genres: string[] = (d.genres ?? []).map((g: any) => g.description).filter(Boolean);
  const categories: string[] = (d.categories ?? []).map((c: any) => c.description).filter(Boolean);
  const tags: Record<string, number> = {};
  for (const g of genres) tags[g] = 1.0;                                            // genre = strong taste axis
  for (const c of categories) if (MP_CATEGORIES.has(c) || c === "Single-player") tags[c] = 0.5; // play-mode axis
  return { appid, name: d.name ?? `app/${appid}`, genres, categories, tags, type: d.type ?? "", fetched_at: new Date().toISOString() };
}

export interface CatalogResult {
  meta: Record<number, CatalogEntry>;
  stats: { requested: number; hits: number; fetched: number; misses: number; elapsed_ms: number };
}

/** Return cached+freshly-fetched metadata for the requested appids. Throttled + incrementally saved. */
export async function getCatalog(appids: number[], opts: { fetchMissing?: boolean; log?: boolean } = {}): Promise<CatalogResult> {
  const fetchMissing = opts.fetchMissing ?? true;
  const cache = loadCache();
  const meta: Record<number, CatalogEntry> = {};
  const toFetch: number[] = [];
  let hits = 0;
  const uniq = [...new Set(appids)];

  for (const id of uniq) {
    const e = cache[String(id)];
    if (e) { meta[id] = e; hits++; } else toFetch.push(id);
  }

  let fetched = 0, misses = 0;
  const start = Date.now();
  if (fetchMissing && toFetch.length) {
    for (let i = 0; i < toFetch.length; i++) {
      const id = toFetch[i];
      try {
        const entry = await fetchAppDetails(id);
        if (entry) { cache[String(id)] = entry; meta[id] = entry; fetched++; }
        else misses++;
      } catch { misses++; }
      if (opts.log && (i + 1) % 10 === 0) process.stderr.write(`${C.dim}  cached ${i + 1}/${toFetch.length} (fetched=${fetched}, miss=${misses})${C.reset}\n`);
      if ((i + 1) % SAVE_EVERY === 0) saveCache(cache);
      if (i < toFetch.length - 1) await sleep(THROTTLE_MS); // ISC-11
    }
    saveCache(cache);
  } else {
    misses = toFetch.length;
  }

  return { meta, stats: { requested: uniq.length, hits, fetched, misses, elapsed_ms: Date.now() - start } };
}

function help() {
  console.log(`${C.bold}catalog_cache.ts${C.reset} — cache Steam store genres/categories per appid (ISC-10/11)

${C.cyan}Usage${C.reset}
  bun catalog_cache.ts <appid> [<appid> ...]
  bun catalog_cache.ts --stdin
  STEAM_API_KEY=xxxx bun catalog_cache.ts --library <steamid|vanity> [--all-games] [--no-fetch]

Cache → ${CACHE_FILE}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}
function parseAppidsText(txt: string): number[] {
  try { const j = JSON.parse(txt); if (Array.isArray(j)) return j.map(Number).filter(Boolean); } catch {}
  return txt.split(/[\s,]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) return help();
  const noFetch = argv.includes("--no-fetch");
  const statsOnly = argv.includes("--stats");

  let appids: number[] = [];
  const libIdx = argv.indexOf("--library");
  if (libIdx !== -1) {
    const input = argv[libIdx + 1];
    if (!input) { console.error(`${C.red}--library needs a SteamID/vanity.${C.reset}`); process.exit(2); }
    const key = getApiKey();
    const steamid = await resolveSteamId(input, key);
    const owned = await getOwnedGames(steamid, key);
    if (!owned) { console.error(`${C.red}Library private — cannot enumerate games.${C.reset}`); process.exit(1); }
    const playedOnly = !argv.includes("--all-games");
    appids = owned.games.filter((g) => (playedOnly ? g.playtime_forever > 0 : true)).map((g) => g.appid);
    process.stderr.write(`${C.cyan}Library ${steamid}:${C.reset} ${owned.games.length} games, ${appids.length} ${playedOnly ? "played" : "total"} to cache\n`);
  } else if (argv.includes("--stdin")) {
    appids = parseAppidsText(await readStdin());
  } else {
    appids = argv.filter((a) => !a.startsWith("--")).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
  }

  if (!appids.length) { console.error(`${C.red}No appids.${C.reset}`); process.exit(2); }
  const { meta, stats } = await getCatalog(appids, { fetchMissing: !noFetch, log: true });
  process.stderr.write(`${C.green}done:${C.reset} requested=${stats.requested} hits=${stats.hits} fetched=${stats.fetched} misses=${stats.misses} elapsed=${(stats.elapsed_ms / 1000).toFixed(1)}s\n`);
  console.log(JSON.stringify(statsOnly ? { stats } : { stats, meta }, null, 2));
}

if (import.meta.main) {
  main().catch((e) => { console.error(`${C.red}Error:${C.reset} ${(e as Error).message}`); process.exit(1); });
}
