---
name: SteamRecommender
description: "Analyzes a Steam user's play history and generates personalized, explained game recommendations via a retrieve→rerank→explain pipeline. Reads owned games + playtime + recency from the Steam Web API (IPlayerService), builds a log(playtime)-weighted taste-vector over Steam Store genres/categories, retrieves a not-owned candidate pool from a store-search proxy (with an official-Steam-search fallback), ranks with tag-overlap fit + MMR diversity + franchise dedup, and has an LLM explain each pick (constrained to vetted candidates, zero hallucination). Also emits a shareable 'Gaming DNA' player-archetype report. USE WHEN recommend games, what should I play next, analyze my Steam library, Steam recommendations, games like the ones I own, my gaming taste, gaming personality, Steam wrapped, games based on my playtime. NOT FOR buying/purchasing games (no checkout), reviewing one specific game, non-Steam platforms (Epic/GOG/console/itch), or building a playable game."
---

# SteamRecommender

Turn a person's **Steam play history** into **personalized, explained game recommendations**. The insight:
playtime is a far stronger taste signal than a wishlist or a star rating — *what you actually spent 200 hours
on* reveals your taste; *what you bought and abandoned in 40 minutes* reveals its boundary. This skill reads
that signal, finds the candidates the user is most likely to love but does **not** own, ranks them for fit
**and variety**, and explains every pick in terms of the user's own library. It closes with a shareable
**Gaming DNA** archetype report.

It is a **two-stage recommender** (the production RecSys shape): cheap broad **retrieval** of candidates, then
expensive precise **ranking** of the shortlist — because you cannot score all ~100k Steam games, but you can
score the few hundred the retrieval step hands you.

## Requirements

- **[Bun](https://bun.sh)** (TypeScript runtime; zero npm dependencies — only Bun/Node built-ins).
- **[Claude CLI](https://docs.anthropic.com/en/docs/claude-code)** — `explain.ts` calls `Tools/Inference.ts`,
  which shells out to the `claude` CLI. (Swap `Inference.ts` for a direct Anthropic-API call to remove this.)
- **`STEAM_API_KEY`** in the environment — free key from https://steamcommunity.com/dev/apikey.
- The target Steam profile's **"Game details" privacy must be Public**.

## The pipeline (every run)

`PREFLIGHT → RESOLVE id → FETCH history → PROFILE (taste-vector + archetype) → RETRIEVE candidates → RANK (fit + diversity + Deck) → EXPLAIN → ENRICH (live price) → OUTPUT`

`Tools/preflight.ts` checks the key and library visibility in ~2s first, so a bad key or private profile fails
before the slow first-run cache fill (exit 2 key not visible · 3 private profile · 4 invalid key / network).

| # | Phase | Does | Source |
|---|-------|------|--------|
| 1 | **Resolve** | vanity URL or SteamID64 → canonical SteamID64 | `ISteamUser/ResolveVanityURL` |
| 2 | **Fetch** | owned games + `playtime_forever` + `playtime_2weeks`; recent activity | `IPlayerService/GetOwnedGames`, `GetRecentlyPlayedGames` |
| 3 | **Profile** | log(playtime)-weighted **taste-vector** over Steam Store genres + play-mode categories + recency + **archetype** | Steam Store `appdetails` |
| 4 | **Retrieve** | broad quality pool, **not owned** (proxy → official-Steam-search fallback) | store-search proxy / Steam store search |
| 5 | **Rank** | tag-overlap fit + quality − **MMR diversity**; drop owned + abandoned-franchise sequels; `--deck-only` keeps Deck Verified/Playable | local compute over cached metadata |
| 6 | **Explain** | LLM writes per-game justification, **constrained to the step-5 list** (no invented games); each pick carries its Deck rating | `Tools/Inference.ts` (Claude CLI) |
| 7 | **Enrich** | live price + `discount_percent`, region-aware (default `ie`); `--on-sale` keeps discounted picks | Steam Store `appdetails?filters=price_overview` |
| 8 | **Output** | ranked recs with Deck · price · "why" + **Gaming DNA** archetype report | — |

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Recommend** | "recommend games", "what should I play next", "analyze my library", default | `Workflows/Recommend.md` |
| **QuickRecs** | "just give me 5 games", "quick recs", "fast" — skips archetype + deep explanation | `Workflows/QuickRecs.md` |
| **GamingDNA** | "what kind of gamer am I", "gaming personality", "Steam wrapped" — report only, no recs | `Workflows/GamingDNA.md` |

## Quick start

```bash
export STEAM_API_KEY=xxxxxxxxxxxxxxxx          # https://steamcommunity.com/dev/apikey
bun Tools/preflight.ts <steamid64|vanity>              # ~2s: key valid + library visible?
# Full recommendations (first run fills the catalog cache, ~5 min one-time):
bun Tools/rank.ts <steamid64|vanity> --n 25 > shortlist.json   # add --deck-only for Steam Deck picks
bun Tools/explain.ts shortlist.json --n 10 > recs.json
bun Tools/enrich.ts recs.json --cc ie                  # live prices; --on-sale for discounts only
# Gaming DNA report only:
bun Tools/build_profile.ts <steamid64|vanity> --summary
```

## Quick Reference — data spine

| Need | Interface / endpoint | Key fields |
|------|----------------------|-----------|
| Identity | `ISteamUser/ResolveVanityURL`, `GetPlayerSummaries` | SteamID64, persona, `communityvisibilitystate` |
| **Play history** | `IPlayerService/GetOwnedGames` (`include_appinfo=1`) | **`appid`, `playtime_forever` (min), `playtime_2weeks`**, name |
| Recency | `IPlayerService/GetRecentlyPlayedGames` | last-2-week appids + playtime |
| **Owned-game tags** | Steam Store `appdetails?appids=X` (genres+categories) | **genres** (Strategy/RPG/Sim…) + play-mode **categories** (Single/Multi/Co-op) |
| **Candidate catalog** | store-search proxy `t=store_search` (fallback: Steam store search) | broad quality pool with rich community `tags` |

> ⚠️ **`ISteamUser` does NOT contain playtime.** It is profile + friends only. All history/playtime lives in
> **`IPlayerService/GetOwnedGames`**. This is the single most common mistake when wiring this skill.

**Candidate proxy** — community Steam-store search by [Lorenzo Stanco](https://www.lorenzostanco.com/lab/steam/):
`…/proxy.php?t=store_search&from=<offset>&min_reviews=<n>&sortby=sdbrating&order=desc&nonce=<token>` returns
`{"error":false,"games":[…]}` with per-game `app_id`, `app_name`, `metascore`, `sdbrating`, `tags` (community
tags!), `platforms`, `release_date`, `free`, `early_access`, `steam_deck` (official Deck scale: 0 Unknown ·
1 Unsupported · 2 Playable · 3 Verified). It has **no price field**, which is why `enrich.ts` exists. The `nonce` is embedded in the store page and
auto-refreshed on failure. **No tag/text search** — it's a quality/date browse, so tag matching is client-side.
If the proxy is unreachable, retrieve falls back to Steam's **official** store search (genres only).

## Ranking model

```
score(g) = w_fit · taste-tag overlap(taste_vec, g.tags)  +  w_quality · (sdbrating|metascore)
         − w_div · max_tag_jaccard(g, already_selected)   # MMR: penalize similarity to picks already chosen
hard_filters: not owned · not abandoned-franchise sequel · has tags + a rating
```
Taste-vector weights raw playtime by **`log(1+hours)`** so one 2000-hour obsession does not drown the profile.
The owned-side vector is coarse (Steam genres); the LLM Explain stage does the fine sub-genre semantic match.

## Player archetypes (Gaming DNA)

Classified from playtime *shape* + recency + genre mix:
**Completionist** (needs achievement data — currently undetermined) · **Dabbler** (many games, low hours each) ·
**Social/Multiplayer** (co-op/PvP tags dominate, high recency) · **Narrative** (single-player story tags) ·
**Grinder** (sim/strategy/roguelike, enormous single-title hours).

## Gotchas (highest-density section — these kill naive builds)

- **`ISteamUser` ≠ playtime.** Use `IPlayerService/GetOwnedGames`. (Repeated because it is the #1 trap.)
- **Private profiles return empty.** `GetOwnedGames` needs "Game details" = Public. Detect and emit an
  actionable message — never crash, never silently recommend nothing.
- **Playtime ≠ enjoyment.** Fuse playtime × recency (× achievement-depth when available), not raw hours.
- **The whale skews everything.** `log(1+hours)` weighting is mandatory, not optional.
- **Constrain explanations to the candidate list.** The LLM writes the *why*; it must never name a game not in
  the ranked output. Enforced in code (explain.ts resolves recs against the shortlist) — the zero-hallucination guarantee.
- **The proxy is third-party + its nonce expires** (returns HTTP 200 + XML `<error>` on a bad nonce, not JSON).
  retrieve reads the body as text, treats a leading `<` as the refresh trigger, refreshes the nonce, and
  falls back to official Steam search if the proxy is down entirely.
- **Rate limits.** Steam Store `appdetails` ~200 req/5min → 1.7s throttle + 429 backoff. A local
  `appid → metadata` cache is mandatory — never re-fetch a known appid within a run.
- **Franchise/sequel dedup.** Don't recommend the prequel of a finished game or sequels of abandoned series.
- **Can't score the whole catalog.** This is *why* retrieve-then-rank exists; never attempt similarity over all of Steam.

## Safety / privacy gates (non-negotiable)

1. **API key from env only** (`STEAM_API_KEY`). Never write it into any file, log, or output.
2. **No purchasing.** The skill recommends; it never initiates a Steam checkout or wishlist write.
3. **No personal data committed.** Read the library at runtime; write any saved output to a path outside the
   repo (or git-ignore it). The generated `cache/catalog.json` is git-ignored — it indirectly reveals owned games.
4. **Respect profile privacy.** If a profile is private, ask the user to make it public or paste their library;
   do not attempt to scrape around the privacy setting.

## Examples

**Full recommendation** — "recommend games based on my Steam, vanity 'gabe'" → resolve → profile → retrieve
~500 candidates → rank to 25 → LLM explains the best 10, each grounded in an owned game → + Gaming DNA report.

**Quick** — "just give me 5 games, SteamID 7656119…" → QuickRecs → 5 ranked picks, one-line justification each.

**Report only** — "what kind of gamer am I?" → GamingDNA → archetype + taste signature + signature games, no recs.

## Repo layout

```
SteamRecommender/
  SKILL.md · README.md
  Tools/
    preflight.ts        # ~2s key + visibility check before any slow work
    fetch_library.ts    # Resolve + GetOwnedGames + Recent
    catalog_cache.ts    # Steam Store genres/categories, disk-cached + throttled
    build_profile.ts    # log-playtime taste-vector + archetype
    retrieve.ts         # candidate pool − owned (proxy + official-Steam fallback, nonce auto-refresh)
    rank.ts             # tag-overlap fit + MMR diversity + franchise dedup
    explain.ts          # LLM picks + justifies, shortlist-constrained (zero hallucination)
    enrich.ts           # live price/discount per pick (region-aware, --on-sale)
    Inference.ts        # Claude-CLI wrapper (bundled; credit: Daniel Miessler / PAI — see README)
  Workflows/{Recommend,QuickRecs,GamingDNA}.md
  cache/catalog.json    # generated at runtime, git-ignored
```
Deferred enhancement: wire
`GetPlayerAchievements` so the Completionist archetype scores.
