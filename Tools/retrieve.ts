#!/usr/bin/env bun
/**
 * retrieve.ts — SteamRecommender Retrieve feature (ISC-5, ISC-6, ISC-16).
 *
 * Candidate generation. The primary candidate source is the community Steam-store search proxy by
 * Lorenzo Stanco (https://www.lorenzostanco.com/lab/steam/) — please be courteous with request volume.
 * It is the only source that returns Steam's rich COMMUNITY TAGS for arbitrary store queries. It supports
 * only quality/date/price/sort/pagination (NO tag or text search — verified), so we pull a broad QUALITY
 * pool sorted by `sdbrating` (the SteamDB rating — surfaces beloved non-Metacritic indies like
 * Factorio/Balatro/Hades that `metascore` misses) and filter/rank by tags client-side.
 *
 * FALLBACK: if the proxy is unreachable (or its nonce can't be refreshed), retrieve degrades to Steam's
 * OFFICIAL store search (store.steampowered.com/search) for candidate appids, enriched with genres via
 * catalog_cache — fully first-party, no community tags (coarser ranking), but the skill keeps working.
 *
 * We subtract the user's owned games (ISC-6) and gate on tags + a rating (ISC-5). Nonce auto-refreshes (ISC-16).
 *
 * Usage:
 *   STEAM_API_KEY=xxxx bun retrieve.ts <steamid|vanity> [--pages N] [--min-reviews M]
 *
 * @version 0.1.0
 */

import { resolveSteamId, getOwnedGames, getApiKey } from "./fetch_library.ts";
import { getCatalog } from "./catalog_cache.ts";

const PROXY = "https://www.lorenzostanco.com/lab/steam/proxy.php";
const STORE_PAGE = "https://www.lorenzostanco.com/lab/steam/store/";
const STEAM_SEARCH = "https://store.steampowered.com/search/results/"; // official fallback
let NONCE = process.env.STEAM_PROXY_NONCE ?? "f9c59e8fdd8acb5240e64a3cc94506e4"; // static nonce in the store page; refreshed on failure
const PAGE_DELAY = 250;
const C = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" };

export interface Candidate {
  app_id: number; name: string; tags: string[];
  metascore: number | null; sdbrating: number | null; sdbrating_recent: number | null;
  platforms: string[]; release_date: string | null; free: boolean; early_access: boolean;
  steam_deck: number | null; // proxy Deck rating, official scale: 0 Unknown · 1 Unsupported · 2 Playable · 3 Verified
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function jparse<T>(s: any, fallback: T): T { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } }

/** ISC-16: re-read the static nonce from the store page when the proxy rejects the request. */
async function refreshNonce(): Promise<boolean> {
  try {
    const html = await (await fetch(STORE_PAGE)).text();
    const m = html.match(/Nonce:\s*'([a-f0-9]{8,40})'/i);
    if (m) { NONCE = m[1]; return true; }
  } catch {}
  return false;
}

function parseGame(g: any): Candidate {
  const tags = jparse<string[]>(g.tags, []);
  return {
    app_id: Number(g.app_id), name: g.app_name,
    tags: Array.isArray(tags) ? tags : [],
    metascore: g.metascore ? Number(g.metascore) : null,
    sdbrating: g.sdbrating ? Number(g.sdbrating) : null,
    sdbrating_recent: g.sdbrating_recent ? Number(g.sdbrating_recent) : null,
    platforms: jparse<string[]>(g.platforms, []),
    release_date: g.release_date || null,
    free: g.free === "1", early_access: g.early_access === "1",
    steam_deck: g.steam_deck != null && g.steam_deck !== "" ? Number(g.steam_deck) : null,
  };
}

async function fetchPage(from: number, minReviews: number): Promise<any[]> {
  const q = (n: string) => `${PROXY}?t=store_search&from=${from}&free_paid=&release_year=&min_reviews=${minReviews}&min_reviews_recent=&sortby=sdbrating&order=desc&nonce=${n}`;
  const get = async (n: string): Promise<any[] | null> => {
    const res = await fetch(q(n), { headers: { Accept: "application/json" } });
    const text = await res.text();
    // A bad/expired nonce (or abuse throttle) returns HTTP 200 with an XML body: <error type="abuse"/>.
    if (!res.ok || text.trimStart().startsWith("<")) return null;
    try { const d = JSON.parse(text); return Array.isArray(d?.games) ? d.games : []; } catch { return null; }
  };
  let games = await get(NONCE);
  if (games === null && (await refreshNonce())) games = await get(NONCE); // ISC-16: refresh nonce + retry once
  return games ?? [];
}

/** FALLBACK candidate source: Steam's official store search. Returns appid+name only (the appid is embedded
 *  in the result's logo URL); community tags are unavailable here, so callers enrich genres via catalog_cache. */
async function retrieveViaSteamSearch(count: number): Promise<{ app_id: number; name: string }[]> {
  const out: { app_id: number; name: string }[] = [];
  const seen = new Set<number>();
  for (let start = 0; start < count; start += 100) {
    const url = `${STEAM_SEARCH}?json=1&sort_by=Reviews_DESC&category1=998&start=${start}&count=100&cc=us&l=english`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) break;
    let j: any; try { j = await res.json(); } catch { break; }
    const items = Array.isArray(j) ? j : (j?.items ?? []);
    if (!items.length) break;
    for (const it of items) {
      const m = String(it.logo ?? "").match(/\/apps\/(\d+)\//);
      const id = m ? Number(m[1]) : 0;
      if (id && !seen.has(id)) { seen.add(id); out.push({ app_id: id, name: it.name ?? `app/${id}` }); }
    }
    await sleep(PAGE_DELAY);
  }
  return out;
}

export async function retrieveCandidates(steamid: string, key: string, opts: { pages?: number; minReviews?: number; fallbackCount?: number } = {}): Promise<{ candidates: Candidate[]; ownedCount: number; pooled: number; degraded: boolean }> {
  const pages = opts.pages ?? 30;
  const minReviews = opts.minReviews ?? 200;
  const owned = await getOwnedGames(steamid, key);
  const ownedSet = new Set((owned?.games ?? []).map((g) => g.appid));
  const seen = new Set<number>();
  const pool: Candidate[] = [];
  for (let p = 0; p < pages; p++) {
    const games = await fetchPage(p * 20, minReviews);
    if (!games.length) break;
    for (const g of games) { const c = parseGame(g); if (c.app_id && !seen.has(c.app_id)) { seen.add(c.app_id); pool.push(c); } }
    if (p < pages - 1) await sleep(PAGE_DELAY);
  }

  // FALLBACK: proxy yielded nothing → use official Steam search, enrich genres-as-tags via catalog_cache.
  let degraded = false;
  if (pool.length === 0) {
    degraded = true;
    const seeds = await retrieveViaSteamSearch(opts.fallbackCount ?? 150);
    const { meta } = await getCatalog(seeds.map((s) => s.app_id), { fetchMissing: true });
    for (const s of seeds) {
      const c = meta[s.app_id]; const tags = c ? Object.keys(c.tags) : [];
      if (!seen.has(s.app_id) && tags.length) {
        seen.add(s.app_id);
        // sdbrating defaulted to 75 — fallback seeds are Reviews_DESC-sorted (well-reviewed) and lack a SteamDB score.
        pool.push({ app_id: s.app_id, name: s.name, tags, metascore: null, sdbrating: 75, sdbrating_recent: null, platforms: [], release_date: null, free: false, early_access: false, steam_deck: null });
      }
    }
  }

  // ISC-6: subtract owned. ISC-5: quality gate — must have tags + a rating.
  const candidates = pool.filter((c) => !ownedSet.has(c.app_id) && c.tags.length > 0 && (c.metascore !== null || c.sdbrating !== null));
  return { candidates, ownedCount: ownedSet.size, pooled: pool.length, degraded };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) { console.log("Usage: STEAM_API_KEY=xxxx bun retrieve.ts <steamid|vanity> [--pages N] [--min-reviews M]"); return; }
  const pagesArg = argv.indexOf("--pages"); const minArg = argv.indexOf("--min-reviews");
  const pages = pagesArg !== -1 ? parseInt(argv[pagesArg + 1], 10) : 30;
  const minReviews = minArg !== -1 ? parseInt(argv[minArg + 1], 10) : 200;
  const skip = new Set<number>(); // skip the value tokens following value-flags
  argv.forEach((a, i) => { if (a === "--pages" || a === "--min-reviews") skip.add(i + 1); });
  const input = argv.find((a, i) => !a.startsWith("--") && !skip.has(i));
  if (!input) { console.error(`${C.red}No SteamID/vanity.${C.reset}`); process.exit(2); }
  const key = getApiKey();
  const steamid = await resolveSteamId(input, key);
  process.stderr.write(`${C.cyan}retrieving${C.reset} ${pages} pages (min_reviews=${minReviews}) by sdbrating…\n`);
  const { candidates, ownedCount, pooled, degraded } = await retrieveCandidates(steamid, key, { pages, minReviews });
  if (degraded) process.stderr.write(`${C.yellow}⚠ proxy unavailable — used official Steam search fallback (genres only)${C.reset}\n`);
  process.stderr.write(`${C.green}pooled=${pooled}${C.reset} owned=${ownedCount} → ${C.bold}${candidates.length} candidates${C.reset} (not-owned, tagged, rated)\n`);
  console.log(JSON.stringify({ steamid, stats: { pooled, ownedCount, candidates: candidates.length, degraded }, candidates }, null, 2));
}

if (import.meta.main) {
  main().catch((e) => { console.error(`${C.red}Error:${C.reset} ${(e as Error).message}`); process.exit(1); });
}
