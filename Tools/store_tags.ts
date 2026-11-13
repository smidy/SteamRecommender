#!/usr/bin/env bun
/**
 * store_tags.ts — Steam's player-applied ("community") tags per appid, from the OFFICIAL store API.
 *
 * The candidate proxy already returns community tags ("Colony Sim", "Roguelite", "Deckbuilding"), but the
 * owned side only had Steam's ~30 coarse genres, so the two vocabularies overlapped on generic words like
 * Action/Indie/RPG and fit barely separated candidates. This module gives the owned side the same tags.
 *
 * Source: IStoreBrowseService/GetItems (tagids + weights, batched, no key needed) and IStoreService/GetTagList
 * (tagid → name). Both are cached next to catalog.json, so a library is fetched once.
 *
 * Usage:
 *   bun store_tags.ts <appid> [<appid> ...]     # print {appid: {tag: weight}} for these appids
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = process.env.STEAMREC_CACHE_DIR || path.join(SKILL_DIR, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "store_tags.json");
const ITEMS_API = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";
const TAGLIST_API = "https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english";
const BATCH = 100;
const TAGS_PER_GAME = 20;
const BATCH_DELAY_MS = 500;

interface Cache { tagnames: Record<string, string>; apps: Record<string, { tags: Record<string, number>; fetched_at: string }>; }

function loadCache(): Cache {
  try { const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); return { tagnames: c.tagnames ?? {}, apps: c.apps ?? {} }; }
  catch { return { tagnames: {}, apps: {} }; }
}
function saveCache(c: Cache) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadTagNames(cache: Cache): Promise<void> {
  if (Object.keys(cache.tagnames).length) return;
  const res = await fetch(TAGLIST_API);
  if (!res.ok) throw new Error(`GetTagList HTTP ${res.status}`);
  for (const t of (await res.json())?.response?.tags ?? []) cache.tagnames[String(t.tagid)] = t.name;
}

async function fetchBatch(appids: number[], dataRequest: Record<string, unknown> = { include_tag_count: TAGS_PER_GAME }): Promise<any[]> {
  const input = { ids: appids.map((appid) => ({ appid })), context: { language: "english", country_code: "US" }, data_request: dataRequest };
  const url = `${ITEMS_API}?input_json=${encodeURIComponent(JSON.stringify(input))}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) return [];
    return (await res.json())?.response?.store_items ?? [];
  }
  return [];
}

/** {appid → {tagName → weight}} for the requested appids; apps Steam has no tags for are absent. Never throws
 *  on a network failure — callers fall back to genres for anything missing. */
export async function getStoreTags(appids: number[], opts: { log?: boolean } = {}): Promise<Record<number, Record<string, number>>> {
  const cache = loadCache();
  const out: Record<number, Record<string, number>> = {};
  const missing = appids.filter((id) => !cache.apps[String(id)]);
  if (missing.length) {
    try {
      await loadTagNames(cache);
      for (let i = 0; i < missing.length; i += BATCH) {
        for (const item of await fetchBatch(missing.slice(i, i + BATCH))) {
          if (!item?.appid || !Array.isArray(item.tags)) continue;
          const tags: Record<string, number> = {};
          for (const t of item.tags) { const name = cache.tagnames[String(t.tagid)]; if (name) tags[name] = t.weight; }
          cache.apps[String(item.appid)] = { tags, fetched_at: new Date().toISOString() };
        }
        if (opts.log) process.stderr.write(`  store tags ${Math.min(i + BATCH, missing.length)}/${missing.length}\n`);
        if (i + BATCH < missing.length) await sleep(BATCH_DELAY_MS);
      }
      saveCache(cache);
    } catch (e) {
      if (opts.log) process.stderr.write(`  store tags unavailable (${(e as Error).message}) — falling back to genres\n`);
    }
  }
  for (const id of appids) { const e = cache.apps[String(id)]; if (e && Object.keys(e.tags).length) out[id] = e.tags; }
  return out;
}

/** Steam Deck compatibility per appid from the same official API (`platforms.steam_deck_compat_category`,
 *  0 Unknown · 1 Unsupported · 2 Playable · 3 Verified). Not cached: ratings change, and a pool is a few calls.
 *  The candidate proxy stopped returning its `steam_deck` field (all null, seen 2026-11-13), so this is the
 *  source of truth. Apps missing from the response are absent from the result. */
export async function getDeckCompat(appids: number[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  try {
    for (let i = 0; i < appids.length; i += BATCH) {
      for (const item of await fetchBatch(appids.slice(i, i + BATCH), { include_platforms: true })) {
        const v = item?.platforms?.steam_deck_compat_category;
        if (item?.appid && typeof v === "number") out[item.appid] = v;
      }
      if (i + BATCH < appids.length) await sleep(BATCH_DELAY_MS);
    }
  } catch { /* network failure → callers keep whatever Deck value they had */ }
  return out;
}

if (import.meta.main) {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) { console.log("Usage: bun store_tags.ts <appid> [<appid> ...]"); process.exit(0); }
  console.log(JSON.stringify(await getStoreTags(ids, { log: true }), null, 2));
}
