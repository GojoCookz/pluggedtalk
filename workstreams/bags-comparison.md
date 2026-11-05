# Bags vs Plugged: tuning pass (2026-11-04)

Brief: `workstreams/briefs/bags-tuning-2026-11-04.md`. Owner: "Can u go thru bags docs n ui n just fix we find tuning wise".
Earlier API study: `FEATURES.md` § Bags API study (still accurate; not repeated here).

## Sources (8 fetches, accessed 2026-11-04)

| # | Source | Kind |
|---|---|---|
| 1 | https://docs.bags.fm/llms.txt | docs index |
| 2 | https://docs.bags.fm/robinhood/overview.md | Robinhood lifecycle, fee model, address book |
| 3 | https://docs.bags.fm/robinhood/claim-fees.md | claim flow, claimable vs pending |
| 4 | https://docs.bags.fm/robinhood/launch-token.md | factory launch, claimer rules |
| 5 | https://docs.bags.fm/api-reference/get-rh-creator-roster.md | per-token roster API shape |
| 6 | https://bags.fm (via r.jina.ai text render) | home/feed, public |
| 7 | https://bags.fm/launch (via r.jina.ai text render) | launch form, public, logged out |
| 8 | llms.txt summary of `get-rh-pool-price` | "render as unavailable, never 0" |

Limits: UI was read as rendered text, logged out, no screenshots of Bags taken; token pages, profile and claim screens
need login or client JS and were **not** inspected. Nothing behind a login was accessed.

## What Bags does (verified observations)

- **Home leads with creator money**: "Creator Earnings · Lifetime", "1% of every trade, earned by creators", then Volume /
  Creators funded / Traders, then lifecycle tabs New / Soon / Bonded (src 6).
- **Launch form** order: Image, Ticker, Name, Description, Fee sharing (Holders / Creator / social and domain recipients),
  optional links, paired asset, dev buy with 1/3/5/10 SOL presets, live preview card, and "By launching, you agree to the
  Terms of Use" under the button (src 7). Headline: "Launch a coin, earn royalties forever".
- **Fee model on Robinhood**: flat 2% on the ETH leg; 1% to claimers by bps, 1% protocol of which a partner gets
  `partnerFeeBps`; creation fee read live; globals snapshotted per launch (src 2, 4).
- **Claimer rules**: 1–100 claimers, unique, nonzero, not the partner, bps sum 10,000, last absorbs dust; simulate before
  signing (src 4).
- **Claims**: check `claimable > 0` before `claim` (otherwise `NothingToClaim` wastes gas); show claimable-now separately
  from un-swept pending estimate; claimer list is mutable via `setClaimers` (src 3).
- **Token transparency**: a public roster endpoint lists every recipient, bps, claimed, claimable, pending (src 5).
- **Prices**: unavailable price renders as "unavailable", never `0` (src 8).

## Screen-by-screen comparison

| Area | Bags | Plugged before | Verdict |
|---|---|---|---|
| Token page: who earns | Public roster of recipients + bps (src 5) | Market cap, volume, cap only (`web/app.js` tokenDetail) | **Fixed**: "Who earns from trades" block: total fee, creator/holder split, creator fee wallet link. Data from the receipt-verified launch record (`lib/launch-service.mjs` markets) |
| Earnings load | Earnings shown once signed in | Blank until the user taps "Refresh balances" (`web/rewards.js`) | **Fixed**: balances read automatically on mount and after connect/account/chain change (read-only calls) |
| Zero balance | Docs: check `claimable > 0`, say "Nothing to claim yet" | Server already hides actions at 0 (`lib/rewards-service.mjs:58`) but UI showed no explanation | **Fixed**: "Nothing to claim yet. Balances grow as people trade this coin." |
| Fee wallet input | Validates address client-side before signing (src 4) | `maxlength` only; server rejected late | **Fixed**: `pattern="0x[0-9a-fA-F]{40}"` + localized hint; server check unchanged (nonzero, valid) |
| Terms near launch | "By launching, you agree to the Terms" (src 7) | No legal link on the launch form | **Fixed, deliberately different wording**: our terms are drafts not in force, so we say so and link `#terms`/`#privacy` instead of claiming agreement |
| Price unavailable | Never render 0 (src 8) | `amount()` renders `—` for null (`web/app.js:81`) | Already matches |
| Claimable vs pending | Separate claimable-now and pending estimate (src 3) | Separate "Holder claimable now" and "Unswept pool fees" | Already matches |
| Simulate before sign | Yes (src 3, 4) | Server simulates every prepare | Already matches |
| Fee bounds | Fee fixed at 2% | 101–1000 bps; UI `min=101`, server rejects ≤1% (`test/launch.test.mjs:37`) | Already consistent |
| Lifecycle tabs New/Soon/Bonded | Bonding-curve phases | Carbon has no bonding curve | **Deliberate difference** |
| Dev buy presets 1/3/5/10 | SOL presets | Opening buy in the pairing coin, capped ~$50 by Carbon | **Deliberate difference**: presets in mixed-decimal stock/USD quotes would mislead; the cap is the guard |
| Live preview card | Yes | Receipt rail with real review data | Remaining (nice-to-have, not done) |
| Home "creator earnings" hero | Lifetime earnings stat | No indexed lifetime figure exists | **Not done**: no real source; would be fake data |
| Mutable claimers | `setClaimers` by fee-share owner | Plugged splitter is immutable; fee-vault lets creators reclaim unaccepted fees | **Deliberate difference** |
| Partner / referral share | Partner gets 25% of protocol half | No referrals (Merc decision) | **Deliberate difference** |
| Social/domain recipients | X, TikTok, Kick, GitHub, domain email | GitHub/X resolver only, behind `BAGS_API_KEY` | Remaining; needs provider keys |

## Carbon impact

None. Changes are UI copy, client validation, and three extra read-only fields on `/api/markets`
(`feeBps`, `creatorBps`, `feeRecipient` from the confirmed record). No contract, engine or chain-standard finding, so
nothing added to `contracts/audit/`.

## Verification (2026-11-04)

| Check | Result |
|---|---|
| `bun test test/` | 321 pass, 24 skip, 0 fail |
| `bun run build` | 326,589 JS bytes, no new dependencies |
| `tools/platform-browser-check.mjs` (adapter :4327) | 23 checks, 13 AccessLint states, 0 errors |
| `tools/launch-browser-check.mjs` (server.ts :4328, signing off) | 12 checks, 0 errors |
| `tools/welcome-browser-check.mjs` (server.ts :4328) | 12 checks, 0 violations |
| `tools/bags-tuning-shots.mjs` | create / token (light+dark) / earnings at 390x844, create / token at 1440x1000; 6 AccessLint states, 0 violations; fee-wallet pattern rejects `0x123`; Terms link navigates; fee block and nothing-to-claim text asserted |

Screenshots use the simulated wallet and fixture market/positions (banner "BROWSER TEST ONLY" visible); they are not
real launches. Before shots came from the pre-change preview on :4317.

## Remaining

- Live preview card on the launch form.
- Lifetime creator-earnings figure on discover (needs an indexer; do not fake it).
- Fee terms for advanced launches on `#advanced-token` (separate service, not touched).
- Native-speaker review of the 8 new strings in 12 locales.
