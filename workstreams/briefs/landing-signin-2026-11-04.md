# Brief: Bags-style sign-in landing (2026-11-04)

Owner said (verbatim): "can u make landing like this"
Reference screenshot: `C:\Users\shies\.kimaki\attachments\1567666362644701336\0-image.png` (Bags sign-in: centered logo, one rounded card, "Welcome to Bags." / "Sign in to launch, trade and get paid.", primary "Verify with X", "Hide options" disclosure revealing TikTok, Kick, GitHub, Google, Email, Wallet, Apple buttons, footer links Terms / Privacy / Docs / Support).

Repo: `C:\Users\shies\Documents\CodeProjects\hoodstonk\plugged`, branch `feat/trading-ui-release`, latest commit `7d83342`. Read `plugged/HANDOFF.md`, `plugged/web/app.js`, `plugged/web/style.css`, `plugged/web/locales/`, `plugged/workstreams/i18n.md`.

## Rules
- Memory-frugal: no subagents; one dev server + one headless browser at a time, closed when done. Do not stop the preview on 4317 except to restart it with the new build at the end.
- No pushes, worktrees, broadcasts. Commit `plugged/` only, message ends with `Discord: https://discord.com/channels/1530362963998015498/1565852347630887004`.
- Load `house-ui`, `frontend-design`, `lean-stack`, `lean-context`. Run the house-ui loop: 390x844 screenshot first, then desktop; critique; fix; at least one loop.
- No dead buttons, no fake sign-in. Steal the reasoning of the reference (one card, one clear primary action, progressive disclosure of more options, quiet footer), not its pixels. Keep Plugged's own mark and white/green identity in light mode; the dark theme should feel close to the reference.

## What to build
1. A welcome / sign-in screen as the landing for first-time visitors (route `#welcome`, shown on first visit; returning visitors and anyone who connected a wallet go to Discover). Plugged mark on top, one centered card: "Welcome to Plugged." + one-line subtitle (launch, trade and get paid), then buttons.
2. **Only real actions are enabled.** Plugged has no account/OAuth backend today:
   - **Connect wallet** is the primary button and must work (reuse the existing wallet connect; EIP-6963 discovery if already present).
   - X, GitHub, Google, Email, TikTok, Kick, Apple: behind a "More options" disclosure. Each one is enabled ONLY if the server reports that provider configured (add a small `/api/auth/providers` endpoint returning which are configured; today none are). Unconfigured ones render disabled with a short honest note ("Coming soon" style, localized), not clickable dead buttons. Do not implement OAuth flows in this pass; document in `HANDOFF.md` what a provider integration needs (e.g. Privy or direct OAuth app credentials, callback route, session, binding social identity to a wallet for fee claims and vault containers).
   - "Browse without signing in" secondary link to Discover.
3. Footer: Terms, Privacy, Docs (Guide route), Support. If no Terms/Privacy pages exist, add simple honest placeholder pages stating they are drafts pending legal review, or omit those links; no fake legal text.
4. All 13 locales (keys in `web/locales/*`, English fallback, i18n test passing), light/dark, keyboard and screen-reader friendly, 44px targets, reduced motion.
5. Brand icons: inline SVG paths (no icon library); ensure each provider mark is a simple monochrome glyph.

## Verify
`bun test test/`, `bun run build`, `tools/platform-browser-check.mjs`, `tools/launch-browser-check.mjs`, plus screenshots of `#welcome` at 390x844 (light EN, dark EN, dark ja) and 1440x1000 (dark EN), AccessLint 0 violations, 0 console errors, every enabled button clicked. Look at the screenshots yourself and compare to the reference.

## Finish
Commit, rebuild, restart the preview on 4317 (`PLUGGED_LAUNCH_ENABLED=true`, keep `PLUGGED_PUBLIC_ORIGIN` = the current tunnel URL https://db795e31f4f8f9b8.vqbz7kk2yfov.opentunnel.xyz if the tunnel is still up, check via `https://r.jina.ai/<url>/api/health`). Upload the 390 dark EN and 1440 dark EN screenshots with `kimaki upload-to-discord --session ses_e711b7541ffeJ9NR9Ze5E45fV5 <files>`. Record results in `plugged/workstreams/landing.md`.
