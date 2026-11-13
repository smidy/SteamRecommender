# SteamRecommender

Analyze your **Steam play history** and get personalized, *explained* game recommendations — plus a shareable
"Gaming DNA" personality report. Playtime is a far stronger taste signal than a wishlist: *what you sank 200
hours into* reveals your taste; *what you bounced off in 40 minutes* reveals its boundary.

It's a two-stage recommender (the production RecSys shape): cheaply **retrieve** a broad pool of well-reviewed
games you don't own, precisely **rank** them for fit *and variety*, then have an LLM **explain** each pick in
terms of your own library — constrained to the vetted shortlist, so it can never invent a game.

```
🎮 Library of Ruina   → Slay the Spire's deckbuilding evolved into a punishing, lore-drenched beast.
🎮 Streets of Rogue    → Emergent action-roguelike chaos that echoes your Caves of Qud runs.
🎮 Bastion             → Supergiant's action-RPG — the studio behind your 100h of Hades II.
```

## Requirements

| Dependency | Why | Notes |
|---|---|---|
| [**Bun**](https://bun.sh) | TypeScript runtime | **Zero npm dependencies** — only Bun/Node built-ins. |
| [**Claude CLI**](https://docs.anthropic.com/en/docs/claude-code) | The Explain step (`Tools/Inference.ts`) shells out to `claude` | Optional if you only use the Gaming-DNA / ranking steps. Swap `Inference.ts` for a direct Anthropic-API call to remove this. |
| **Steam Web API key** | Reading your library | Free — see Setup. Read from the `STEAM_API_KEY` env var only. |

External services used: the **Steam Web API** (`api.steampowered.com`), the **Steam Store** appdetails/search
(`store.steampowered.com`, official), and a **community store-search proxy** (third-party — see Credits; an
official-Steam-search fallback kicks in if it's unavailable). No account login or OAuth — just your API key.

## Setup

1. **Install Bun:** https://bun.sh (`curl -fsSL https://bun.sh/install | bash`, or `irm bun.sh/install.ps1 | iex` on Windows).
2. **Get a free Steam Web API key:** sign in at <https://steamcommunity.com/dev/apikey>, register any domain
   (e.g. `localhost`), copy the key.
3. **Set it in your environment:**
   ```bash
   export STEAM_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx      # macOS/Linux
   $env:STEAM_API_KEY = "xxxxxxxxxxxxxxxxxxxxxxxx"    # Windows PowerShell
   ```
4. **Make your Steam profile readable:** Steam → Profile → Edit Profile → Privacy Settings → set **Game details**
   to **Public** (otherwise the API can't see your library).
5. **Find your SteamID:** open your Steam profile in a browser. If the URL is
   `steamcommunity.com/profiles/7656119…`, that number is your SteamID64. If it's `steamcommunity.com/id/<name>`,
   just pass `<name>` — the tool resolves vanity URLs automatically.

## Usage

Run from the repo root.

```bash
# Check the key and that your library is visible (~2s) before anything slow:
bun Tools/preflight.ts <steamid64|vanity>

# Full recommendations (≈10 explained picks) — first run fills the catalog cache (~5 min, one-time):
bun Tools/rank.ts <steamid64|vanity> --n 25 > shortlist.json     # --deck-only: Steam Deck Verified/Playable
bun Tools/explain.ts shortlist.json --n 10 > recs.json

# Attach live prices + discounts (region-aware; --on-sale keeps only discounted picks):
bun Tools/enrich.ts recs.json --cc ie

# Quick: 5 picks, fast (smaller pool, no report):
bun Tools/rank.ts <id> --pages 15 --n 15 | bun Tools/explain.ts --n 5

# Gaming DNA report only (no recommendations):
bun Tools/build_profile.ts <id> --summary
```

The `Workflows/` folder describes each path for an LLM agent driving the tools; the commands above are the
direct CLI equivalents.

## How it works

```
fetch_library → build_profile → retrieve → rank → explain
 (IPlayerService)  (taste+archetype)  (pool − owned)  (fit+MMR+dedup)  (LLM, shortlist-bound)
```

- **fetch_library.ts** — resolves your ID and pulls owned games + playtime + recency from `IPlayerService`
  (not `ISteamUser`, which has no playtime).
- **catalog_cache.ts** — fetches genres/categories per game from the official Steam Store API, cached to
  `cache/catalog.json` (or `$STEAMREC_CACHE_DIR/catalog.json`), throttled (~1.7s) to respect rate limits.
- **build_profile.ts** — builds a `log(1+hours)`-weighted taste-vector (so one 2000-hour obsession doesn't
  drown the profile) and classifies your player archetype.
- **retrieve.ts** — pulls a broad quality pool (sorted by SteamDB rating, which surfaces beloved non-Metacritic
  indies), subtracts games you own. Falls back to official Steam search if the proxy is down.
- **rank.ts** — scores candidates by taste-tag overlap + quality, applies **MMR** so the shortlist is diverse,
  and drops sequels of franchises you own but abandoned.
- **explain.ts** — an LLM picks the final N and writes the "why", **resolved against the shortlist in code** so
  it can never recommend a game that wasn't a candidate. Each pick carries its Steam Deck rating.
- **enrich.ts** — attaches live price + discount from the official Steam Store API (the candidate proxy has no
  price field). **preflight.ts** — a ~2s key + visibility check that fails fast with a clear exit code.

The owned-side taste vector is coarse (Steam's official genres only — community tags aren't available for
arbitrary lookups since SteamSpy went behind Cloudflare), so the LLM Explain stage does the fine sub-genre
matching ("this is a colony-sim like your RimWorld").

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `STEAM_API_KEY` | yes | Steam Web API key. |
| `STEAM_PROXY_NONCE` | no | Override the store-search proxy nonce (auto-refreshed otherwise). |

## Privacy & safety

- Your API key is read from the environment **only** — never written to any file or printed.
- The skill **never** purchases, wishlists, or mutates your account; it only reads.
- `cache/catalog.json` is **git-ignored** — it's generated at runtime and indirectly reveals which games you own.
- If a profile is private, the tools return an actionable message rather than failing silently.

## Known limitations

- **Coarse owned-side tags.** Community tags (Colony Sim, Roguelike, Deckbuilder) aren't available for owned
  games, so the taste vector uses Steam's broad genres; the LLM compensates on the candidate side.
- **Completionist archetype** is undetermined until achievement data is wired (`GetPlayerAchievements`).
- **The candidate proxy is third-party** and could change or go down; the official-Steam-search fallback keeps
  the skill working (with genre-only ranking).
- First run is slow (one-time catalog cache fill, ~1.7s per played game).

## Credits

- **`Tools/Inference.ts`** — the Claude-CLI inference wrapper is adapted from **Daniel Miessler's PAI**
  (Personal AI Infrastructure). Thank you to [Daniel Miessler](https://github.com/danielmiessler) for PAI.
- **Candidate store-search proxy** — by **[Lorenzo Stanco](https://www.lorenzostanco.com/lab/steam/)**, the
  only source that exposes Steam's rich community tags for arbitrary store queries. Please be courteous with
  request volume; consider reaching out before any high-volume or commercial use.
- Game data from the **Steam Web API** and **Steam Store**, © Valve Corporation. This project is not affiliated
  with or endorsed by Valve.

## License

No license file yet — add one (e.g. MIT) before sharing publicly. Note the Credits above for bundled/adapted code.
