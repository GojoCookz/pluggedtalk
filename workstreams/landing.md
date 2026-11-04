# Landing / sign-in (`#welcome`) — 2026-11-04

Owner asks: "can u make landing like this" (Bags sign-in screenshot). Brief: `workstreams/briefs/landing-signin-2026-11-04.md`.

## What the reference does (and what we kept)

- One centered card under the logo, one clear primary action, more options behind a disclosure, quiet
  footer. Kept all four. Not copied: Bags' grey primary and its seven working social logins.

## What shipped

- `web/welcome.js`: `#welcome` sign-in screen, `#terms` and `#privacy` draft pages.
- First visit (no hash, no `plugged.welcomed` in localStorage) goes to `#welcome`. Visiting any app route
  sets the flag, so returning visitors and deep links go straight in. Connecting a wallet from the
  welcome screen goes to Discover.
- Primary: **Connect wallet** (the existing EIP-6963 chooser). Secondary: **Browse without signing in**.
- **More options** (`aria-expanded`/`aria-controls`) reveals X, TikTok, Kick, GitHub, Google, Email,
  Apple. Each is enabled only if `GET /api/auth/providers` returns `configured: true` with a same-origin
  `startUrl`; today none are, so all seven render as disabled buttons with a "Soon" pill and one shared
  note ("Social and email sign-in aren't set up yet…"). No OAuth was implemented; requirements are in
  `HANDOFF.md` → "Social sign-in".
- Footer: Terms, Privacy (draft pages stating they await legal review and are not in force; the body only
  states facts true of this build), Docs (→ Guide). Support omitted: no support channel exists.
- Header on the welcome route shows only language + theme; app nav, network strip and wallet button hidden.
- Dark theme on the welcome route uses a neutral near-black (`#0b0d0c` / `#1b1e1c`) closer to the
  reference; light keeps Plugged white/green. Brand glyphs are inline monochrome SVG, no icon library.
- 20 new keys × 13 locales. Wallet dialog wrapped in a labelled `<section>` (AccessLint flagged the open
  dialog as content outside landmarks; pre-existing, found by the new check).

## Verification (2026-11-04)

- `bun test test/`: 321 pass / 0 fail (adds `/api/auth/providers` server test).
- `bun run build`: OK, 324,884 JS bytes, no new dependencies.
- `node tools/platform-browser-check.mjs` (isolated adapter): 23 checks, 13 AccessLint states, 0 errors.
- `node tools/launch-browser-check.mjs` against `server.ts` on 4328: 12 checks, 0 errors.
- `node tools/welcome-browser-check.mjs` (new) against `server.ts`: 390×844 light EN, dark EN, dark ja;
  1440×1000 dark EN, light EN; collapsed state, Terms, Privacy, wallet dialog. 9 AccessLint audits, 0
  violations; no overflow; no target under 44 px; 0 console errors. Clicked: More/Fewer (keyboard),
  Terms, Privacy, Back, Docs, Browse, Connect wallet with no wallet (honest empty chooser) and with a
  mock EIP-6963 wallet (connects, lands on Discover), returning visitor skips welcome.
- Screenshots: `artifacts/welcome/` (gitignored), reviewed by eye. Loop fixes: "Soon" pill overlapped
  labels at 390 → inline pill; labels wrapped → tighter mobile card padding; ja subtitle broke
  mid-word → `text-wrap: balance`.

## Known limits

- Social/email sign-in is not available; the buttons say so.
- Terms/Privacy are drafts, not legal text.
- Translations written by the agent; native review recommended.
