# Workflow: QuickRecs

Fast path: exactly 5 ranked picks with a one-line justification each. No Gaming DNA report, smaller candidate
pool. Use when the user says "just give me 5 games", "quick recs", or "fast".

## Steps

Run from the repo root. `STEAM_API_KEY` must be in the environment.

1. **Resolve target** — SteamID/vanity from the user; if none, ask.
2. **Rank + Explain in one pipe** (smaller `--pages` for speed; `--n 5`):
   ```bash
   STEAM_API_KEY=$KEY bun Tools/rank.ts <id> --pages 15 --n 15 2>/dev/null \
     | bun Tools/explain.ts --n 5
   ```
   (rank.ts streams the shortlist JSON to stdout; explain.ts reads it from stdin.)
3. **Present** the 5 picks as a short list: `name — one-line why`.

## Output Requirements

- **Exactly 5** recommendations, each with a single-line justification grounded in the user's taste.
- Zero owned games; zero invented games — all from the shortlist.
- No archetype report, no long preamble — this is the fast path.
