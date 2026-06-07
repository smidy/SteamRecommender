# Workflow: GamingDNA

Report-only path: the player's archetype + taste signature + signature games, with **zero recommendations**.
Use when the user asks "what kind of gamer am I", "gaming personality", or "Steam wrapped".

## Steps

Run from the repo root. `STEAM_API_KEY` must be in the environment.

1. **Resolve target** — SteamID/vanity from the user; if none, ask.
2. **Build profile, summary mode** (no recommendation pipeline runs):
   ```bash
   STEAM_API_KEY=$KEY bun Tools/build_profile.ts <id> --summary 2>/dev/null
   ```
   First run fills the catalog cache (~5 min one-time); subsequent runs are instant.
3. **Present** the report: primary archetype + the driving stat, runner-up, taste signature (top tags),
   "lately into" (recent tags), and the signature games by hours. Make it shareable.

## Output Requirements

- The archetype report **with zero recommendations** — this is identity, not suggestion.
- Include the supporting numbers (played/library count, total hours, top-title share, catalog coverage) so the
  classification is transparent.
- Honest note: the Completionist archetype needs achievement data (not yet wired) and may read as undetermined.
