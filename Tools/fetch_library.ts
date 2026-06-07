#!/usr/bin/env bun
/**
 * fetch_library.ts — SteamRecommender data spine (pipeline phases RESOLVE + FETCH).
 *
 * Resolves a vanity URL / profile URL / SteamID64 to a canonical SteamID64, then pulls the
 * user's owned-games playtime history and recent activity from the Steam Web API.
 *
 * THIS is the taste signal everything downstream depends on. Playtime lives in IPlayerService —
 * NOT ISteamUser (which is profile + friends only). See ISA.md ISC-1, ISC-2, ISC-3.
 *
 * Usage:
 *   STEAM_API_KEY=xxxx bun fetch_library.ts <steamid64 | vanity | profile-url>
 *   STEAM_API_KEY=xxxx bun fetch_library.ts --resolve <input>     # print only the SteamID64
 *   STEAM_API_KEY=xxxx bun fetch_library.ts <input> --summary     # human-readable table
 *
 * Options:
 *   --resolve <input>   Resolve to a SteamID64 and print just the 17-digit id (ISC-1 probe).
 *   --summary           Print a human-readable summary instead of JSON.
 *   --help              Show this help.
 *
 * Output (default): JSON to stdout with { status, steamid, persona, visibility, game_count, games[], recent[] }.
 *   status: "ok" | "private" | "error". Private profiles exit 0 with an actionable message (ISC-3).
 *
 * Security: STEAM_API_KEY is read from the environment ONLY. It is never written to a file or echoed
 * into output (ISA.md ISC-14). The key is a query parameter to api.steampowered.com and nothing else.
 *
 * @author PAI System — SteamRecommender
 * @version 0.1.0
 */

const API = "https://api.steampowered.com";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m",
};

export interface Game { appid: number; name: string; playtime_forever: number; playtime_2weeks: number; }
export interface Library {
  status: "ok" | "private" | "error";
  steamid: string;
  persona?: string;
  visibility?: "public" | "private" | "unknown";
  game_count?: number;
  games?: Game[];
  recent?: Game[];
  message?: string;
}

export function getApiKey(): string {
  const k = process.env.STEAM_API_KEY;
  if (!k) {
    console.error(`${C.red}STEAM_API_KEY not set.${C.reset} Export it (free key: https://steamcommunity.com/dev/apikey):\n  STEAM_API_KEY=xxxx bun fetch_library.ts <id>`);
    process.exit(2);
  }
  return k;
}

async function steamApi(endpoint: string, key: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${API}/${endpoint}`);
  url.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Steam API ${endpoint} → HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** Resolve any common Steam identifier to a canonical SteamID64. ISC-1. */
export async function resolveSteamId(input: string, key: string): Promise<string> {
  const raw = input.trim();
  // profile URL with embedded SteamID64
  const profileMatch = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profileMatch) return profileMatch[1];
  // bare SteamID64
  if (/^\d{17}$/.test(raw)) return raw;
  // vanity URL → extract the vanity slug; otherwise treat the whole input as a vanity name
  const vanityMatch = raw.match(/steamcommunity\.com\/id\/([^/?#]+)/);
  const vanity = vanityMatch ? vanityMatch[1] : raw;
  const data = await steamApi("ISteamUser/ResolveVanityURL/v0001/", key, { vanityurl: vanity });
  if (data?.response?.success === 1 && data.response.steamid) return data.response.steamid as string;
  throw new Error(`Could not resolve "${input}" to a SteamID64 (vanity lookup failed: success=${data?.response?.success}).`);
}

export async function getPlayerSummary(steamid: string, key: string): Promise<{ persona: string; visibility: "public" | "private" | "unknown" } | null> {
  const data = await steamApi("ISteamUser/GetPlayerSummaries/v0002/", key, { steamids: steamid });
  const p = data?.response?.players?.[0];
  if (!p) return null;
  // communityvisibilitystate: 3 = public, 1 = private/friends-only
  const visibility = p.communityvisibilitystate === 3 ? "public" : p.communityvisibilitystate === undefined ? "unknown" : "private";
  return { persona: p.personaname ?? "(unknown)", visibility };
}

export async function getOwnedGames(steamid: string, key: string): Promise<{ game_count: number; games: Game[] } | null> {
  const data = await steamApi("IPlayerService/GetOwnedGames/v0001/", key, {
    steamid, include_appinfo: "1", include_played_free_games: "1", format: "json",
  });
  // Private "Game details" → response is an empty object {} with no games array.
  if (!data?.response || !Array.isArray(data.response.games)) return null;
  const games: Game[] = data.response.games.map((g: any) => ({
    appid: g.appid,
    name: g.name ?? `app/${g.appid}`,
    playtime_forever: g.playtime_forever ?? 0,
    playtime_2weeks: g.playtime_2weeks ?? 0,
  }));
  return { game_count: data.response.game_count ?? games.length, games };
}

export async function getRecentlyPlayed(steamid: string, key: string): Promise<Game[]> {
  const data = await steamApi("IPlayerService/GetRecentlyPlayedGames/v0001/", key, { steamid, format: "json" });
  if (!data?.response || !Array.isArray(data.response.games)) return [];
  return data.response.games.map((g: any) => ({
    appid: g.appid,
    name: g.name ?? `app/${g.appid}`,
    playtime_forever: g.playtime_forever ?? 0,
    playtime_2weeks: g.playtime_2weeks ?? 0,
  }));
}

function help() {
  console.log(`${C.bold}fetch_library.ts${C.reset} — SteamRecommender data spine (RESOLVE + FETCH)

${C.cyan}Usage${C.reset}
  STEAM_API_KEY=xxxx bun fetch_library.ts <steamid64 | vanity | profile-url>
  STEAM_API_KEY=xxxx bun fetch_library.ts --resolve <input>
  STEAM_API_KEY=xxxx bun fetch_library.ts <input> --summary

${C.cyan}Notes${C.reset}
  • Playtime comes from IPlayerService/GetOwnedGames (not ISteamUser).
  • Requires the target profile's "Game details" privacy = Public.
  • STEAM_API_KEY is read from env only and never written anywhere.`);
}

function printSummary(lib: Library) {
  if (lib.status !== "ok" || !lib.games) { console.log(lib.message ?? lib.status); return; }
  const top = [...lib.games].sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, 15);
  console.log(`${C.bold}${lib.persona}${C.reset} ${C.dim}(${lib.steamid})${C.reset} — ${C.green}${lib.game_count} games${C.reset}, ${lib.recent?.length ?? 0} played recently`);
  console.log(`${C.dim}Top by playtime:${C.reset}`);
  for (const g of top) console.log(`  ${C.green}${(g.playtime_forever / 60).toFixed(0).padStart(5)}h${C.reset} ${C.dim}|${C.reset} ${g.name}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) return help();
  const key = getApiKey();

  // --resolve <input>: print only the SteamID64 (ISC-1 probe).
  const resolveIdx = argv.indexOf("--resolve");
  if (resolveIdx !== -1) {
    const input = argv[resolveIdx + 1];
    if (!input) { console.error(`${C.red}--resolve needs an input.${C.reset}`); process.exit(2); }
    console.log(await resolveSteamId(input, key));
    return;
  }

  const summary = argv.includes("--summary");
  const input = argv.find((a) => !a.startsWith("--"));
  if (!input) { console.error(`${C.red}No SteamID/vanity provided.${C.reset}`); process.exit(2); }

  const steamid = await resolveSteamId(input, key);
  const profile = await getPlayerSummary(steamid, key);
  const owned = await getOwnedGames(steamid, key);

  // ISC-3: private "Game details" → actionable message, exit 0, no crash.
  if (!owned) {
    const lib: Library = {
      status: "private",
      steamid,
      persona: profile?.persona,
      visibility: profile?.visibility ?? "unknown",
      message: `Profile or game library is private. Fix: in Steam → Edit Profile → Privacy Settings, make "Game details" = Public, then retry.`,
    };
    console.log(summary ? lib.message : JSON.stringify(lib, null, 2));
    process.exit(0);
  }

  const recent = await getRecentlyPlayed(steamid, key);
  const games = owned.games.sort((a, b) => b.playtime_forever - a.playtime_forever);
  const lib: Library = {
    status: "ok",
    steamid,
    persona: profile?.persona,
    visibility: profile?.visibility ?? "unknown",
    game_count: owned.game_count,
    games,
    recent,
  };
  if (summary) printSummary(lib);
  else console.log(JSON.stringify(lib, null, 2));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`${C.red}Error:${C.reset} ${(e as Error).message}`);
    process.exit(1);
  });
}
