#!/usr/bin/env bun
/**
 * explain.ts — SteamRecommender Explain feature (ISA.md ISC-8, ISC-9).
 *
 * The LLM picks the final N games from the ranked shortlist and writes a one-sentence justification per
 * pick, grounded in the player's signature games / taste. Uses the bundled Inference tool
 * (Tools/Inference.ts, which wraps the Claude CLI). ISC-9 (zero hallucination) is enforced IN CODE: any returned game whose
 * app_id/name is not in the shortlist is dropped before output — the model cannot invent titles.
 *
 * Usage:
 *   bun rank.ts <id> | bun explain.ts [--n 10]        # pipe a shortlist in
 *   bun explain.ts cache/_shortlist.json [--n 10]      # or read a shortlist file
 *
 * @author PAI System — SteamRecommender
 * @version 0.1.0
 */

import { inference } from "./Inference.ts";
import fs from "fs";

// F1: Steam Deck rating labels (proxy `steam_deck` enum, official scale).
const DECK_LABEL: Record<number, string> = { 0: "Unknown", 1: "Unsupported", 2: "Playable", 3: "Verified" };

interface Shortlist {
  persona?: string; archetype?: string; taste_top?: string[];
  signature_games?: { name: string; hours: number }[];
  shortlist: { app_id: number; name: string; tags: string[]; sdbrating: number | null; primary_tag?: string; steam_deck?: number | null }[];
}

const SYSTEM = `You are an expert Steam game recommender. You receive a player's archetype, taste tags, and their most-played ("signature") games, plus a CANDIDATE SHORTLIST of games they do NOT own (each with community tags). Choose the best N games for this player and write ONE punchy sentence per pick explaining the fit.
HARD RULES:
1. Recommend ONLY games from the provided shortlist — never invent a title or use a game not listed.
2. Each "why" MUST reference at least one of their specific signature games or taste tags.
3. Favor variety across sub-genres; don't pick ten of the same thing.
Output ONLY JSON: {"recommendations":[{"app_id":<int>,"name":"<exact shortlist name>","why":"<one sentence>"}]}`;

/** Tolerant extraction: strips ```json fences, accepts a bare array or {recommendations:[…]}. */
function extractRecs(text: string): any[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  let parsed = tryParse(t);
  if (parsed === undefined) { const a = t.match(/\[[\s\S]*\]/); if (a) parsed = tryParse(a[0]); }
  if (parsed === undefined) { const o = t.match(/\{[\s\S]*\}/); if (o) parsed = tryParse(o[0]); }
  const arr = Array.isArray(parsed) ? parsed : (parsed?.recommendations ?? parsed?.games ?? []);
  return Array.isArray(arr) ? arr : [];
}

async function main() {
  const argv = process.argv.slice(2);
  const nArg = argv.indexOf("--n");
  const n = nArg !== -1 ? parseInt(argv[nArg + 1], 10) : 10;
  const fileArg = argv.find((a, i) => !a.startsWith("--") && !(nArg !== -1 && i === nArg + 1));
  const raw = fileArg ? fs.readFileSync(fileArg, "utf-8") : fs.readFileSync(0, "utf-8");
  const data: Shortlist = JSON.parse(raw);

  const byId = new Map(data.shortlist.map((g) => [g.app_id, g]));
  const byName = new Map(data.shortlist.map((g) => [g.name.toLowerCase(), g]));

  const user = `PLAYER
Persona: ${data.persona}
Archetype: ${data.archetype}
Taste: ${(data.taste_top || []).join(", ")}
Signature games: ${(data.signature_games || []).map((g) => `${g.name} (${g.hours}h)`).join(", ")}

CANDIDATE SHORTLIST — pick the ${n} best for this player:
${data.shortlist.map((g) => `- ${g.name} [${g.tags.slice(0, 8).join(", ")}] (id ${g.app_id}, sdb ${g.sdbrating})`).join("\n")}

Return the ${n} best as JSON per the system rules.`;

  const res = await inference({ systemPrompt: SYSTEM, userPrompt: user, level: "standard", expectJson: true, timeout: 120000 });
  if (!res.success) { console.error(`inference failed: ${res.error}`); process.exit(1); }

  const rawRecs = extractRecs(res.parsed ? JSON.stringify(res.parsed) : res.output);
  if (!rawRecs.length) process.stderr.write(`no recommendations parsed. raw:\n${res.output.slice(0, 600)}\n`);
  else process.stderr.write(`rec keys: ${Object.keys(rawRecs[0]).join(", ")}\n`);
  const before = rawRecs.length;
  const NAME_KEYS = new Set(["name", "title", "game"]);
  const robustWhy = (r: any): string => {
    const known = r.why ?? r.reason ?? r.explanation ?? r.pitch ?? r.justification ?? r.fit ?? r.description;
    if (known) return String(known);
    let best = ""; // fallback: longest string field that isn't the name — captures the reason whatever it's called
    for (const [k, v] of Object.entries(r)) if (typeof v === "string" && !NAME_KEYS.has(k) && v.length > best.length) best = v;
    return best;
  };
  // ISC-9: resolve each rec against the shortlist by app_id or name. Canonical name/id come FROM the
  // shortlist (not the model); anything not found is dropped — the model cannot inject a non-candidate.
  const recs = rawRecs
    .map((r: any) => {
      const e = byId.get(Number(r.app_id ?? r.appid ?? r.id)) ?? byName.get(String(r.name ?? r.title ?? r.game ?? "").toLowerCase());
      return e ? { app_id: e.app_id, name: e.name, primary_tag: e.primary_tag, steam_deck: e.steam_deck ?? null, deck: e.steam_deck != null ? (DECK_LABEL[e.steam_deck] ?? "Unknown") : "Unknown", why: robustWhy(r) } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  process.stderr.write(`explain: ${before} recs → ${recs.length} after shortlist-membership filter (ISC-9)\n`);

  console.log(JSON.stringify({ persona: data.persona, archetype: data.archetype, recommendations: recs }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
