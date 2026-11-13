# Workflow: Recommend

The full retrieve→rank→explain pipeline: analyze a Steam library and return ~10 explained, not-owned game
recommendations plus the Gaming DNA report. Default workflow ("recommend games", "what should I play next").

## Preconditions

- `STEAM_API_KEY` in the environment (free key: https://steamcommunity.com/dev/apikey). Env only — never
  write it to a file.
- The `claude` CLI is installed (the Explain step calls `Tools/Inference.ts`).
- Target profile's "Game details" privacy must be Public, else the run returns an actionable message.
- Both of the first and last are verified fast by Step 2 (preflight) before any expensive work.

## Steps

Run from the repo root.

1. **Resolve target.** Use the SteamID64 / vanity / profile-URL the user gave; if none, ask for it.
2. **Preflight — fail fast.** Validate key + library visibility in ~2s, before the (~5-min first-run) cache fill:
   ```bash
   STEAM_API_KEY=$KEY bun Tools/preflight.ts <id>; echo "exit=$?"
   ```
   Non-zero exit → **stop** and surface the message verbatim. 2 = key not visible to the process,
   3 = private profile, 4 = invalid key / network. Proceed only on exit 0.
3. **Rank** (this also fetches the library, builds the profile, and retrieves candidates). When the user names
   games to match ("games like X and Y", "something like what I play at the gym"), add `--seed "X,Y"`: owned-game
   names or appids, and the taste comes from those games alone. Add `--deck-only`
   to keep only Steam Deck Verified/Playable games:
   ```bash
   STEAM_API_KEY=$KEY bun Tools/rank.ts <id> --n 25 2>/dev/null > shortlist.json
   ```
   First run on a new account fills the catalog cache (~1.7s × played games, one-time ~5 min) — tell the user.
4. **Explain** — LLM picks the final 10 from the shortlist and justifies each (shortlist-constrained, zero-hallucination):
   ```bash
   bun Tools/explain.ts shortlist.json --n 10 > recs.json
   ```
   Each rec already carries its Steam Deck rating (`deck` label + `steam_deck` 0–3) — no extra call.
5. **Enrich — live price/discount.** The candidate proxy has no price field, so attach it here (region-aware,
   default `ie`); add `--on-sale` to keep only currently-discounted picks:
   ```bash
   bun Tools/enrich.ts recs.json --cc ie 2>/dev/null > recs-priced.json
   ```
6. **Gaming DNA** — also surface the archetype report:
   ```bash
   STEAM_API_KEY=$KEY bun Tools/build_profile.ts <id> --summary 2>/dev/null
   ```
7. **Present** — lead with the Gaming DNA (archetype + taste signature + signature games), then the 10 ranked
   recommendations as a table with columns **Game · Deck · Price/Sale · Why**. Flag discounts and "Free".

## Output Requirements

- **10 recommendations**, each with a one-sentence justification that references ≥1 of the user's signature
  games or taste tags.
- **Zero owned games** in the output; **zero invented games** — every pick comes from the shortlist.
- Diverse — not ten of the same sub-genre (enforced by MMR in rank.ts).
- Each rec shows its **Steam Deck rating** and **live price + discount**.
- If `--on-sale` was requested and nothing is discounted, **say so honestly** — never pad with full-price picks.
- A pick whose price reads **"Not for sale"** (`price.for_sale: false`) is a listing Steam no longer sells here,
  often an original superseded by a remaster: say so, never present it as free.
- Lead with the Gaming DNA report. Honest caveat: tag matching is coarse on the owned side; the LLM bridges
  sub-genre nuance.
