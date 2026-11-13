#!/usr/bin/env bun
/**
 * preflight.ts — SteamRecommender fast precondition check (F4).
 *
 * Validates STEAM_API_KEY presence + validity + the target profile's library visibility in ~2s,
 * BEFORE the expensive (~5-min, first-run) catalog fill in rank.ts. This converts the two most common
 * failure modes — missing/wrong key and a private profile — from late/slow crashes into an instant,
 * actionable message. On Windows it specifically calls out the env-scope trap (a key set with
 * `$env:STEAM_API_KEY` in one shell does NOT propagate to spawned tool processes).
 *
 * Usage:
 *   STEAM_API_KEY=xxxx bun preflight.ts <steamid64 | vanity | profile-url>
 *
 * Exit codes (the Recommend workflow stops on any non-zero and surfaces the message):
 *   0 ok · 2 no key · 3 private profile · 4 invalid key / resolve failure / network
 *
 * Security: STEAM_API_KEY is read from env only; never written or echoed (ISA.md ISC-14).
 *
 * @author PAI System — SteamRecommender
 * @version 0.2.0
 */

import { resolveSteamId, getPlayerSummary, getOwnedGames } from "./fetch_library.ts";

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", dim: "\x1b[2m" };
const isWin = process.platform === "win32";

function keyHelp(): string {
  const base = `STEAM_API_KEY is not visible to THIS process. Free key: https://steamcommunity.com/dev/apikey`;
  if (isWin) {
    return `${base}
  Windows: a key set with $env:STEAM_API_KEY in one shell does NOT propagate to spawned tools.
  Set it at User scope, then restart the shell / Claude:
    [Environment]::SetEnvironmentVariable('STEAM_API_KEY','<your-key>','User')`;
  }
  return `${base}
  export STEAM_API_KEY=<your-key>`;
}

async function main() {
  const input = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!input) { console.error(`${C.red}preflight: no SteamID/vanity given.${C.reset}`); process.exit(2); }

  // 1) Key presence — checked directly (NOT getApiKey, which exits with a generic message).
  const key = process.env.STEAM_API_KEY;
  if (!key) { console.error(`${C.red}✗ no-key${C.reset}\n${keyHelp()}`); process.exit(2); }

  // 2) Resolve (a 17-digit id resolves offline; a vanity hits the API → also validates the key).
  let steamid: string;
  try {
    steamid = await resolveSteamId(input, key);
  } catch (e) {
    const m = (e as Error).message;
    if (/HTTP 40[13]/.test(m)) { console.error(`${C.red}✗ invalid-key${C.reset} — Steam rejected the key (${m}). Re-check STEAM_API_KEY.`); process.exit(4); }
    console.error(`${C.red}✗ resolve-failed${C.reset} — ${m}`); process.exit(4);
  }

  // 3) Key validity + library visibility — one summary + one owned-games probe (the real privacy gate).
  try {
    const sum = await getPlayerSummary(steamid, key);
    const persona = sum?.persona ?? "(unknown)";
    const owned = await getOwnedGames(steamid, key);
    if (!owned) {
      console.error(`${C.yellow}✗ private${C.reset} — ${persona} (${steamid}) has "Game details" set to private.
  Fix: Steam → Edit Profile → Privacy Settings → Game details = Public, then retry.`);
      process.exit(3);
    }
    console.log(`${C.green}✓ ok${C.reset} ${C.bold}${persona}${C.reset} ${C.dim}(${steamid})${C.reset} — key valid, library public, ${owned.game_count} games.`);
    process.exit(0);
  } catch (e) {
    const m = (e as Error).message;
    if (/HTTP 40[13]/.test(m)) { console.error(`${C.red}✗ invalid-key${C.reset} — Steam rejected the key (${m}).`); process.exit(4); }
    console.error(`${C.red}✗ network${C.reset} — ${m}`); process.exit(4);
  }
}

main().catch((e) => { console.error(`${C.red}preflight error:${C.reset} ${(e as Error).message}`); process.exit(4); });
