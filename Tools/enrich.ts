#!/usr/bin/env bun
/**
 * enrich.ts — SteamRecommender price/discount enrichment (F2).
 *
 * The lorenzostanco candidate proxy carries NO price field, so "games on sale" cannot be answered by the
 * core pipeline. This tool reads a recommendations/shortlist JSON (the output of explain.ts or rank.ts, or
 * a bare array) and, for each app_id, attaches the live Steam Store price + discount via the official
 * `appdetails?filters=price_overview` endpoint — region-aware (default IE). `--on-sale` filters to
 * currently-discounted paid titles. Because the shortlist is small (~10–25), this is a cheap pass.
 *
 * Usage:
 *   bun explain.ts /tmp/recs.json | bun enrich.ts [--cc ie] [--on-sale]
 *   bun enrich.ts recs.json [--cc ie] [--on-sale]
 *
 * The endpoint is wrapped behind one function (fetchPrice) with a 429 backoff and graceful null, so a
 * Store-API hiccup degrades to "price unknown" rather than failing the run (SKILL.md third-party gotcha).
 *
 * @author PAI System — SteamRecommender
 * @version 0.2.0
 */

import fs from "fs";

const STORE_API = "https://store.steampowered.com/api/appdetails";
const THROTTLE_MS = 250; // shortlist is small; 250ms keeps us well under the store rate limit
const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", dim: "\x1b[2m", bold: "\x1b[1m" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Price {
  is_free: boolean;
  for_sale: boolean;               // false = listed but not purchasable here (delisted, superseded, region-locked)
  discount_percent: number;
  final: number | null;            // minor units (cents)
  initial: number | null;          // minor units (cents)
  final_formatted: string | null;
  initial_formatted: string | null;
  currency: string | null;
}

/** Live price for one app from the official Store appdetails API. null = unknown (delisted/region-locked/error). */
async function fetchPrice(appid: number, cc: string): Promise<Price | null> {
  // `basic` carries is_free; price_overview alone cannot tell a free game from one that is not for sale.
  const url = `${STORE_API}?appids=${appid}&cc=${cc}&filters=basic,price_overview`;
  let res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) { await sleep(15000); res = await fetch(url, { headers: { Accept: "application/json" } }); }
  if (!res.ok) return null;
  const j = await res.json();
  const node = j?.[String(appid)];
  if (!node || !node.success) return null;
  const po = node.data?.price_overview;
  if (!po) {
    // No price: free only when Steam says so. Otherwise the listing is not purchasable here (e.g. an original
    // superseded by a remaster). Before this check, those were mislabelled "Free".
    const free = node.data?.is_free === true;
    return { is_free: free, for_sale: free, discount_percent: 0, final: null, initial: null, final_formatted: free ? "Free" : "Not for sale", initial_formatted: null, currency: null };
  }
  return {
    is_free: false,
    for_sale: true,
    discount_percent: po.discount_percent ?? 0,
    final: po.final ?? null,
    initial: po.initial ?? null,
    final_formatted: po.final_formatted ?? null,
    initial_formatted: po.initial_formatted ?? null,
    currency: po.currency ?? null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log("Usage: bun enrich.ts [recs.json] [--cc ie] [--on-sale]   (reads stdin when no file is given)"); return; }
  const ccIdx = argv.indexOf("--cc");
  const cc = ccIdx !== -1 ? (argv[ccIdx + 1] ?? "ie") : "ie";
  const onSale = argv.includes("--on-sale");
  const fileArg = argv.find((a, i) => !a.startsWith("--") && !(ccIdx !== -1 && i === ccIdx + 1));
  const raw = fileArg ? fs.readFileSync(fileArg, "utf-8") : fs.readFileSync(0, "utf-8");
  const data = JSON.parse(raw);

  // Accept explain output ({recommendations:[…]}), rank output ({shortlist:[…]}), or a bare array.
  const list: any[] = Array.isArray(data.recommendations) ? data.recommendations
    : Array.isArray(data.shortlist) ? data.shortlist
    : Array.isArray(data) ? data : [];
  if (!list.length) { console.error(`${C.red}enrich: no recommendations/shortlist array found.${C.reset}`); process.exit(2); }

  process.stderr.write(`${C.dim}enriching ${list.length} items with prices (cc=${cc})…${C.reset}\n`);
  let onSaleCount = 0;
  for (let i = 0; i < list.length; i++) {
    const id = Number(list[i].app_id ?? list[i].appid ?? list[i].id);
    try { list[i].price = id ? await fetchPrice(id, cc) : null; } catch { list[i].price = null; }
    const p = list[i].price;
    if (p && !p.is_free && p.discount_percent > 0) onSaleCount++;
    if (i < list.length - 1) await sleep(THROTTLE_MS);
  }
  process.stderr.write(`${C.green}enriched${C.reset} ${list.length} (${C.bold}${onSaleCount} on sale${C.reset}, cc=${cc})\n`);

  const out = onSale ? list.filter((x) => x.price && !x.price.is_free && x.price.discount_percent > 0) : list;

  let result: any;
  if (Array.isArray(data.recommendations)) { data.recommendations = out; result = data; }
  else if (Array.isArray(data.shortlist)) { data.shortlist = out; result = data; }
  else { result = out; }
  result.region = cc;
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(`${C.red}enrich error:${C.reset} ${(e as Error).message}`); process.exit(1); });
