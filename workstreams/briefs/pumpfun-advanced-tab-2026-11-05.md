# Brief: pump.fun features in an Advanced tab (2026-11-05)

Owner said (verbatim): "Can u go thru pumpfun now n now add all the features they havd like call outs n shit too but in an /advance tab for feature"

Repo: `C:\Users\shies\Documents\CodeProjects\hoodstonk\plugged`, branch `feat/trading-ui-release`, latest commit `219b8bf`. Read `plugged/HANDOFF.md`, `plugged/workstreams/bags-comparison.md` (same method), `plugged/web/app.js`, `plugged/web/advanced-launch.js`, `plugged/web/locales/`.

## Rules
- Memory-frugal: no subagents; one dev server + one headless browser at a time on a port other than 4317, closed when done.
- Public preview runs on 4317 behind tunnel https://8254312f2dbdd4e6e37f.vqbz7kk2yfov.opentunnel.xyz (tuistory session `plugged-tunnel`, leave it running). At the end restart only the app on 4317 with `PLUGGED_LAUNCH_ENABLED=true` and `PLUGGED_PUBLIC_ORIGIN=<tunnel URL>`; verify via `https://r.jina.ai/<tunnel>/api/health`.
- No pushes, worktrees, broadcasts. Commit `plugged/` only, per phase; message ends with `Discord: https://discord.com/channels/1530362963998015498/1565852347630887004`.
- Load `evidence-research`, `house-ui`, `frontend-design`, `lean-stack`, `lean-context`; `auditor-skill` for any new write API. Public pages only, no login bypass; ~10 research fetches. Steal the reasoning, not the pixels.
- No fake data, no dead buttons. Anything needing data we do not have (e.g. indexer, provider) shows an honest unavailable state.
- Carbon is the master index: anything affecting Carbon goes in `contracts/audit/` + `INDEX.md` (commit in the contracts submodule with pathspec, then parent pointer).

## Phase 1: study (`plugged/workstreams/pumpfun-comparison.md`)
pump.fun public site and docs: home/board (live ticker of new coins and trades, "king of the hill", sorting/filters), coin page (chart, trades tape, holder distribution/top holders, thread/comments/replies, livestream, creator info, socials), creator/profile pages, watchlist/favorites, notifications, callouts/alerts, advanced/terminal views, any mobile-app features. For each: what it is (cited), whether Plugged has it, whether it fits Carbon (no bonding curve: skip graduation/curve features or map them honestly), data it needs (on-chain logs via RPC, our SQLite, a new store), and risk (spam, moderation, legal).

## Phase 2: build, all under an Advanced area
- Navigation: one "Advanced" tab. The existing `#advanced` advanced-launch form becomes one section of it (keep its route working, e.g. `#advanced/launch`); new features live at `#advanced/<feature>`. Main Discover/Create stay simple.
- Build the features that fit, with real data from verified Plugged launches and on-chain events, for example: live trades tape and new-launch feed, per-coin trade history, holder distribution/top holders, simple price chart from swap events, watchlist (local), creator profile page (launches by wallet), callouts (owner wants these): wallet-signed posts per coin (EIP-191/712 sign-in-with-wallet, no account system), stored in SQLite with per-wallet and per-IP rate limits, length limits, link/HTML sanitisation, report/hide flow and an operator moderation toggle; replies optional. Price alerts/notifications only if they can be real (local browser notifications on the open page are fine).
- Livestream or anything needing third-party hosting: document only, do not fake.
- Backend: new endpoints through the existing `createJsonApi` pattern, bounded queries, caching per block, tests including abuse cases (spam, oversized posts, forged signatures, replay).
- All 13 locales (keys in `web/locales/*`), light/dark, 390x844 first, 44px targets, AccessLint 0.

## Verify
`bun test test/`, `bun run build`, `tools/platform-browser-check.mjs`, `tools/launch-browser-check.mjs`, `tools/welcome-browser-check.mjs`, plus screenshots of each new screen at 390x844 and 1440x1000 that you look at yourself; every control clicked.

## Finish
Commit, restart preview as above, upload 3-5 screenshots with `kimaki upload-to-discord --session ses_e711b7541ffeJ9NR9Ze5E45fV5 <files>`, and list built / skipped (with reason) / remaining in `pumpfun-comparison.md`; add the new features to `HANDOFF.md`.
