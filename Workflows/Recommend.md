# Workflow: Recommend

The full retrieve→rank→explain pipeline: analyze a Steam library and return ~10 explained, not-owned game
recommendations plus the Gaming DNA report. Default workflow ("recommend games", "what should I play next").

## Preconditions

- `STEAM_API_KEY` in the environment (free key: https://steamcommunity.com/dev/apikey). Env only — never
  write it to a file.
- The `claude` CLI is installed (the Explain step calls `Tools/Inference.ts`).
- Target profile's "Game details" privacy must be Public, else the run returns an actionable message.

## Steps

Run from the repo root.

1. **Resolve target.** Use the SteamID64 / vanity / profile-URL the user gave; if none, ask for it.
2. **Rank** (this also fetches the library, builds the profile, and retrieves candidates):
   ```bash
   STEAM_API_KEY=$KEY bun Tools/rank.ts <id> --n 25 2>/dev/null > shortlist.json
   ```
   First run on a new account fills the catalog cache (~1.7s × played games, one-time ~5 min) — tell the user.
3. **Explain** — LLM picks the final 10 from the shortlist and justifies each (shortlist-constrained, zero-hallucination):
   ```bash
   bun Tools/explain.ts shortlist.json --n 10
   ```
4. **Gaming DNA** — also surface the archetype report:
   ```bash
   STEAM_API_KEY=$KEY bun Tools/build_profile.ts <id> --summary 2>/dev/null
   ```
5. **Present** — lead with the Gaming DNA (archetype + taste signature + signature games), then the 10 ranked
   recommendations as a table with the one-sentence "why" for each.

## Output Requirements

- **10 recommendations**, each with a one-sentence justification that references ≥1 of the user's signature
  games or taste tags.
- **Zero owned games** in the output; **zero invented games** — every pick comes from the shortlist.
- Diverse — not ten of the same sub-genre (enforced by MMR in rank.ts).
- Lead with the Gaming DNA report. Honest caveat: tag matching is coarse on the owned side; the LLM bridges
  sub-genre nuance.
