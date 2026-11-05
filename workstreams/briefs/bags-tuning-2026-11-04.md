# Brief: study Bags docs + UI, fix tuning gaps (2026-11-04)

Owner said (verbatim): "Can u go thru bags docs n ui n just fix we find tuning wise"

Repo: `C:\Users\shies\Documents\CodeProjects\hoodstonk\plugged`, branch `feat/trading-ui-release`, latest commit `33918a5`. Read `plugged/HANDOFF.md`, `plugged/FEATURES.md` (has an earlier Bags study), `plugged/workstreams/landing.md`.

## Rules
- Memory-frugal: no subagents; one dev server + one headless browser at a time on a port other than 4317, closed when done.
- The public preview runs on 4317 behind tunnel https://8254312f2dbdd4e6e37f.vqbz7kk2yfov.opentunnel.xyz (tuistory session `plugged-tunnel`). At the end restart only the app on 4317 with `PLUGGED_LAUNCH_ENABLED=true` and `PLUGGED_PUBLIC_ORIGIN=https://8254312f2dbdd4e6e37f.vqbz7kk2yfov.opentunnel.xyz` (Start-Process bun --no-env-file server.ts), leave the tunnel running, verify via `https://r.jina.ai/<tunnel>/api/health`.
- No pushes, worktrees, broadcasts. Commit `plugged/` only; message ends with `Discord: https://discord.com/channels/1530362963998015498/1565852347630887004`.
- Load `evidence-research`, `house-ui`, `lean-context`, `lean-stack`. Respect access controls: public pages only, no login bypass. Research budget: about 10 fetches. Steal the reasoning, not the pixels; keep Plugged's identity.
- Carbon is the master index: anything that affects Carbon goes in `contracts/audit/` (19 or new 20) + `INDEX.md`, committed inside the contracts submodule (pathspec only) plus the parent pointer.

## Phase 1: study (write `plugged/workstreams/bags-comparison.md` as you go)
- Docs: https://docs.bags.fm/llms.txt index, the Robinhood section (overview, launch-token, trade-tokens, read-state, claim-fees, partner-program, contracts), fee-share wallet, creator/claim endpoints.
- UI: public bags.fm pages (home/feed, a token page, launch form, profile/claims as far as visible without login). Note flows, information shown first, defaults, copy, trust signals, empty states, how claims and fee splits are presented, mobile behaviour.
- Compare with Plugged screen by screen and feature by feature. For each gap: what Bags does (cited), what Plugged does (file:line), why it matters, fix or deliberate difference (e.g. Plugged lets creators reclaim unaccepted fees; no referrals per Merc). Do not copy Bags features that conflict with Plugged decisions.

## Phase 2: fix
Implement the high-value, low-risk tuning gaps across UI copy, flows, defaults, discover/token pages, launch form, earnings/claims, error and empty states, plus backend API shape/validation gaps the docs reveal. Real data only, fail closed when undeployed, all 13 locales (keys in `web/locales/*`, English fallback), light/dark, 390x844 first.

## Verify
`bun test test/`, `bun run build`, `tools/platform-browser-check.mjs`, `tools/launch-browser-check.mjs`, `tools/welcome-browser-check.mjs`; screenshots of changed screens at 390x844 and 1440x1000 that you look at yourself; AccessLint 0 violations; every changed control clicked.

## Finish
Commit, restart the preview as above, upload 2-4 before/after screenshots with `kimaki upload-to-discord --session ses_e711b7541ffeJ9NR9Ze5E45fV5 <files>`, and summarise fixed / deliberately different / remaining in `bags-comparison.md`.
