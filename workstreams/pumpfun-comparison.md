# pump.fun vs Plugged: Advanced tab (2026-11-05)

Brief: `workstreams/briefs/pumpfun-advanced-tab-2026-11-05.md`. Owner (verbatim): "Can u go thru pumpfun now n now add
all the features they havd like call outs n shit too but in an /advance tab for feature".
Method follows `workstreams/bags-comparison.md`: public pages only, logged out, reasoning copied, pixels not.

## Sources (3 research calls, accessed 2026-11-05)

| # | Source | Kind |
|---|---|---|
| 1 | Web search results rendering https://pump.fun/, /explore, /leaderboard, /live, /go, /profile/y22, /profile/9Aoi…FppH, two /coin/ pages | public pages as text, logged out |
| 2 | https://r.jina.ai/https://pump.fun/coin/669qb7NrCiS7NRbJ6FoQ32kUG71PBPLoX34Zuatcpump | coin page text render, incl. "Latest callouts" feed |
| 3 | https://www.curvegrad.com/guides/king-of-the-hill-explained (third-party guide, 2026-09-17) | how King of the Hill is chosen |

Limits: rendered text only, no screenshots of pump.fun, nothing behind sign-in, the mobile app and Terminal were not opened.
Fewer fetches than the ~10 budget because the search results already carried the full public page text.

## What pump.fun has (observed)

| Feature | What it is (source) |
|---|---|
| Navigation | Home, Explore, Leaderboard, Live, Discover, GO, Mayhem, Holder rewards, Watchlist, $PUMP, Support, Terminal, Get the app (src 1) |
| Callouts | Short posts attached to a coin. Each shows author, text, coin, **Position $ and Profit $** of the author, counts and market cap; deep links `?highlight_callout=<uuid>`; a "Latest callouts" feed site-wide and a Callouts tab on profiles (src 1, 2) |
| Leaderboard | Top traders by profit 1W, "Load 50 more" (src 1) |
| Profiles | Followers/following, joined date, portfolio value, realized/unrealized PnL, buy volume, Open/Closed/Replies/Activity tabs, top trades, created coins, an activity heatmap ("80 of 149 days traded"), "Spam and hidden (1)" (src 1) |
| Coin page | Price, chart, market cap, title "Price, Chart & Market Cap" (src 1) |
| King of the Hill | Featured slot for the coin leading pump.fun's own activity measure; recomputed every few minutes (src 3) |
| Live | Livestreams per coin, with a separate livestream policy (src 1) |
| Watchlist, Holder rewards, Terminal, mobile app | Listed in navigation (src 1); internals need sign-in or the app |

## Feature map

| pump.fun | Plugged before | Fits Carbon? | Data | Risk | Result |
|---|---|---|---|---|---|
| Live new-coin feed | Discover list only | Yes | SQLite confirmed launches | none | **Built**: `#advanced` New launches |
| Live trades ticker | No | Yes (v4 `Swap` on PoolManager by poolId) | RPC logs, trader = `tx.from`, time = block | trader is the tx sender; relayed trades show the relayer | **Built**: `#advanced` Trades, 15 s refresh |
| King of the Hill | No | Mapped honestly: no curve, so no "progress to graduation" | swap count per pool over last 1M blocks | gameable by wash swaps, said on screen | **Built** as "Most active", labelled "not a paid or curated slot" |
| Coin chart | Dexscreener iframe if indexed | Yes | `sqrtPriceX96` after each swap | not candles; said on screen | **Built**: price-per-swap line (last 300 swaps) |
| Trades tab | No | Yes | as above | — | **Built**: per-coin tape, 12 then "Show more" |
| Holder distribution | No | Yes | replay of token `Transfer` logs since launch block | slow for old tokens: bounded, shows "still reading" | **Built**: holder count, top 20, top-10 share excl. pool, Pool/Creator tags |
| Callouts | No | Yes | new SQLite tables; position = `balanceOf` at post block | spam, phishing links, defamation, impersonation | **Built** (see below) |
| Callout feed / profile tab | No | Yes | same | same | **Built**: `#advanced/callouts`, creator page lists a wallet's callouts |
| Creator profile | No | Yes | SQLite launches by wallet + callouts | none | **Built**: `#advanced/creator/<wallet>` |
| Watchlist | No | Yes | browser `localStorage` | none | **Built**: `#advanced/watchlist` (max 50, local only) |
| Notifications / alerts | No | Partially | price from swaps | must not pretend to be push | **Built**: per-coin price alert, checked every 15 s only while the coin page is open; uses browser Notification if granted, otherwise an in-page notice |
| Replies to callouts | No | Yes | — | moderation load doubles | **Skipped** (optional in brief); table shape allows a `parent` column later |
| Profit $ on callouts, leaderboard by PnL | No | Needs cost basis per wallet and a USD price per quote | a trade indexer with USD history | misleading if partial | **Skipped**: we show token position only, no USD/PnL |
| Followers / following, activity heatmap | No | Needs accounts or signed follow lists | new store | spam | **Skipped** |
| Livestreams | No | Needs third-party video hosting + a moderation policy | external | legal, DMCA, CSAM | **Documented only**, not faked |
| Graduation / bonding-curve progress | — | **Does not apply**: Carbon launches straight into a v4 pool | — | — | **Skipped** |
| Terminal / pro trading, mobile app | No | Possible later | websockets, indexer | — | **Skipped** |
| Holder rewards | Plugged Earnings exists | Already covered by Earnings | — | — | unchanged |

## Callouts: design and abuse controls

```
browser                      server (/api/callouts/*)                    chain
  | challenge {account,token,text} -> clean text, verify token is a confirmed Plugged launch,
  |                                 per-wallet limits, issue nonce, store exact message
  | <- {nonce, message}
  | personal_sign(message)  (wallet shows the exact text)
  | post {nonce, signature}  ----> verify EIP-191 / ERC-1271 via RPC, single-use nonce (CAS),
  |                                10 min expiry, unique signature, read balanceOf ---------> RPC
  | <- callout (hidden if premoderated)
```

- **Text**: NFC, control characters removed, 1–280 code points; rejects `<`/`>`, URLs, bare domains,
  `t.me/`, `discord.gg`, and bidi/zero-width characters. Rendered with HTML escaping and `white-space: pre-wrap`.
- **Limits**: per IP (createJsonApi) 6/min and 60/day on challenge and post, 10/min and 50/day on report; per wallet
  3 per 10 min and 20 per day; at most 5 unsigned challenges per wallet. Bodies capped at 4 KB / 24 KB / 1 KB.
- **Replay/forgery**: nonce single-use with compare-and-set, signature column `UNIQUE`, message binds origin, chain,
  token, author, nonce and time; a different key's signature fails (tested).
- **Moderation**: `PLUGGED_CALLOUTS=open|premoderated|readonly|off`; report hides a post after 3 distinct reporters
  (reporter = salted hash of client IP, salt persisted); operator CLI `bun tools/callouts-moderate.mjs list|hide|show`.
  No HTTP admin route exists.
- **Not done**: no profanity filter, no per-callout permalink, no appeal flow, reports are IP-based (shared NATs count once).

## Audit notes for the new write API

`auditor-skill` was not loaded (context budget); this is a focused self-review, not an audit.

| # | Finding | Severity | Status |
|---|---|---|---|
| A1 | `createJsonApi` keyed the daily bucket on a literal space, so every `dailyLimit` route shared one global 24 h counter across all clients and routes (media uploads were effectively 30/day for the whole site) | Medium | **Fixed**: key is now `client + route` |
| A2 | Callout trader/author identity is a wallet signature only; a wallet can still post about a coin it never held (position shows 0) | Low | Accepted, position is shown |
| A3 | Trades attribute the trader as `tx.from`; account-abstraction or relayed swaps show the relayer | Low | Documented |
| A4 | Activity reads are unauthenticated GETs that can trigger RPC log scans | Low | Bounded: 40 x 1M-block chunks per refresh, one refresh per key at a time, 200 cached keys, head cached 1 s, route limits 20–30/min |

None of these touch Carbon contracts or the deployed engine, so `contracts/audit/INDEX.md` was not changed.

## Built / skipped / remaining

- **Built**: Advanced nav tab; `#advanced` (Live), `#advanced/coin/<token>`, `#advanced/creator/<wallet>`,
  `#advanced/watchlist`, `#advanced/callouts`, `#advanced/launch` (the existing advanced launch form; Create links here).
  Endpoints: `GET /api/activity/feed|trades|holders|creator`, `GET /api/callouts`, `POST /api/callouts/challenge|post|report`.
  13 locales (72 new keys each), light/dark, 390 px first.
- **Skipped (reason)**: replies (optional; moderation cost), PnL/USD on callouts and leaderboard (no cost-basis indexer),
  followers (needs accounts), livestreams (third-party hosting + policy), curve/graduation (Carbon has no curve), terminal/app.
- **Remaining**: server error strings from the new endpoints are English in every locale (not in `SERVER_ERROR_KEYS`);
  native-speaker review of the new strings; persistent log index (restarts rescan from the launch block); push
  notifications when the page is closed; live data only appears once a real Plugged launch is confirmed (none today).

## Verification (2026-11-05)

| Check | Result |
|---|---|
| `bun test test/` | 329 pass, 24 skip, 0 fail (8 new tests in `test/activity-callouts.test.mjs`) |
| `bun run build` | 348,046 JS bytes |
| `tools/advanced-browser-check.mjs` vs `test/advanced-ui-server.ts` (real services, simulated chain) | 20 checks (every hub control clicked: tabs, refresh, show more, watch/remove, connect, sign and post, link refusal, report, set/clear alert, creator link, theme, language), 8 AccessLint states, 0 violations, 0 page errors, 0 CSP violations, no target under 44 px |
| `tools/platform-browser-check.mjs` | 23 checks, 13 audits, 0 errors |
| `tools/launch-browser-check.mjs` | 12 checks, 0 errors |
| `tools/welcome-browser-check.mjs` | 12 checks, 9 audits, 0 violations |

Screenshots: `artifacts/advanced/*.png` (390x844 and 1440x1000). Data in screenshots is from the simulated chain
in `test/advanced-ui-server.ts` (names start "BROWSER TEST"); the public preview has no confirmed launches, so it shows the
empty states.
