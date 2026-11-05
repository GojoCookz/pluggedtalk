# Plugged — developer handoff for Merc

Updated 2026-11-03 UTC. **This is the single entry point.** It replaces the 2026-10-31 planner
handoff. `MVP-HANDOFF.md` keeps the detailed Carbon launch notes (pair approvals, economics,
fork evidence) and `PLATFORM-STATUS.md` keeps the per-feature ledger.

Plugged is a runnable, tested source handoff for a Robinhood Chain (4663) token launchpad built on
the existing Carbon engine. It is **not deployed and not production-ready**. No mainnet launch,
trade, claim, approval, deployment or ownership transfer was sent while building or testing it.

## 1. Run it

Install Bun 1.3.9 (https://bun.sh). From the extracted package:

```sh
bun run start                 # bundled backend + frozen frontend, http://localhost:4317
```

For development:

```sh
bun install --frozen-lockfile
bun test test/                # unit + service tests (Anvil suites skip unless enabled)
bun run build                 # rebuild the frozen frontend + backend bundle
bun run dev                   # server.ts from source
```

Contracts (Foundry; tested with forge 1.5.1): `cd contracts && forge test`. Fork tests need
`PLUGGED_FORK=true` and an archive RPC. Anvil integration suites need `anvil` on PATH and
`PLUGGED_VAULT_INTEGRATION=1`, `PLUGGED_ADVANCED_INTEGRATION=1` or `PLUGGED_PROGRAMS_INTEGRATION=1`.

Browser checks (`tools/platform-browser-check.mjs`, `tools/launch-browser-check.mjs`) need
playwright-core, @accesslint/core and Chromium, set via `PLAYWRIGHT_MODULE`, `ACCESSLINT_ENGINE`,
`CHROME_PATH`, `PLUGGED_URL`. On Windows run them with **Node**: under Bun 1.3.9 Playwright's
pipe launch timed out on 2026-11-03 while Node launched in 343 ms (measured).

## 2. What works (tested, not live)

| Area | State |
|---|---|
| Launch (`#create`) | Wallet-signed Carbon launches: USD-targeted opening, quote selection, simulation, approvals limited to the purchase, receipt-verified listing, restart recovery |
| ETH funding | LI.FI native-to-ERC20 route, calldata decoded and bound; **new:** output must be within 5% of the on-chain ETH/USDG v4 pool (USDG) or 1:1 (WETH) |
| Trading | Quotes, exact approvals, buy/sell, replacement/cancel recovery with compare-and-set status writes |
| Rewards, programs, fee vault, media, advanced launch | Service + UI connected with honest "unavailable" states; nothing deployed, so they fail closed |
| Advanced tab (`#advanced`) | **New 2026-11-05** (`workstreams/pumpfun-comparison.md`): live new-launch feed, trades tape and "Most active" from Robinhood RPC logs; coin pages (`#advanced/coin/<token>`) with price per swap, trades, holder distribution, wallet-signed callouts and a local price alert; creator profiles; local watchlist; the advanced launch form moved to `#advanced/launch`. Data only exists for confirmed Plugged launches, so the preview shows empty states today |
| UI | Light/dark, 13 languages (see `workstreams/i18n.md`), 0 AccessLint findings on 13 audited states, mobile 390 px |
| Ops | systemd units (hardened), Caddy, backup/restore drill, preflight, health probe |

Activation still needs: Carbon registry owner approvals for 438 of 469 pairs, deployed and
verified profiles for the advanced/rewards/program contracts, an image-pinning provider, a host
with a domain, and an Alchemy (or other dedicated) RPC.

## 3. Configuration

Copy `.env.example` to `.env` for local use; production uses `ops/service.env.example` and
`ops/secrets.env.example` under `/etc/plugged/` (Bun's dotenv loading is disabled there).

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` enables the strict origin gate (below) |
| `PORT` | default 4317, binds 127.0.0.1 only |
| `PLUGGED_PUBLIC_ORIGIN` | exact `https://` origin. **Required in production: the server exits without it** |
| `PLUGGED_RPC_URL` | Robinhood RPC; public default is rate limited, use Alchemy in production |
| `PLUGGED_DB_PATH` | SQLite path; one service instance per database |
| `PLUGGED_LAUNCH_ENABLED` | `true` allows wallet signing for launches/trades |
| `PLUGGED_PROGRAMS_ENABLED`, `PLUGGED_PROGRAMS_MANIFEST`, `PLUGGED_PROGRAMS_DB_PATH` | program signing gate and trusted deployment manifest |
| `PLUGGED_ADVANCED_PROFILE` | verified advanced deployment profile; blank = unavailable |
| `PLUGGED_PINATA_JWT` | server-only image pinning; blank disables uploads |
| `BAGS_API_KEY`, `PLUGGED_SOCIAL_RECEIPT_SECRET` | social onboarding (optional) |
| `PLUGGED_BACKUP_DIR` | private directory for the backup job |
| `PLUGGED_CALLOUTS` | `open` (default), `premoderated`, `readonly` or `off`. Moderate with `bun tools/callouts-moderate.mjs list\|hide\|show` (no HTTP admin route) |

The server never needs or accepts a wallet private key. Users sign in their own wallets.

## 4. Deploy

1. Ownership: copy `deployment-owner.example.json` to `runtime/deployment-owner.json` and fill
   **your** owner and platform-recipient public addresses. The packaged template is blank on purpose.
2. Run `bun tools/rh-chain-probe.mjs` (read-only). It must print "all pinned contracts and chain
   parameters match"; it exits 1 if any Uniswap/Carbon code hash, the chain id, the 98,304-byte code
   limit or a required opcode changed.
3. Follow `workstreams/deployment.md` for the independent engine and `contracts/ADVANCED-API.md`
   for the advanced factory. Simulate first, deploy from a hardware/keystore account, verify on
   Blockscout, then write the verified profile path into `PLUGGED_ADVANCED_PROFILE`.
4. Host: `ops/README.md` (systemd + Caddy + backups). `plugged.service` runs the production
   preflight before every start.

## 5. Standards and audit status

- Robinhood Chain / Uniswap v4 review: `workstreams/standards-2026-11.md`. Measured on 4663:
  ArbOS 61, Cancun+Prague+CLZ opcodes live, 98,304-byte code limit, 32M max tx gas, all pinned v4
  addresses match Uniswap's published table. We stay on solc 0.8.26 + `cancun` on purpose.
- Audit: `workstreams/audit-2026-11-02.md` (Fix status). All backend High/Medium items fixed;
  M2 now has an on-chain cross-check for ETH/WETH/USDG; L5, L6, L9, L10 fixed on 2026-11-03.
  Contract M-1 and L-4 fixed, L-2 reduced (50 recipients, 19.6M gas on Anvil, under the 32M cap).

- **Carbon is the master index.** Every finding that touches Carbon (contracts, the deployed engine,
  chain standards) is also recorded in the Hood workspace at `contracts/audit/` as a numbered file
  plus a line in `contracts/audit/INDEX.md`. Plugged's are in `contracts/audit/19-plugged-findings.md`.
  Keep doing this: add new Carbon-relevant findings there (append to 19 or add 20+) and update INDEX.md.
  This package ships copies of both as `carbon-audit/INDEX.md` and `carbon-audit/19-plugged-findings.md`
  (snapshot at export time; the other numbered audit files live only in the Hood workspace, ask the owner).

## 6. Remaining risks (read before going live)

- **Price**: stock-token quote assets have no independent on-chain price check yet (Chainlink
  stock feeds exist on 4663; addresses were not verified, so not wired). They rely on LI.FI plus
  a 10 ETH cap and a 1.5x jump guard.
- **Carbon trust anchors**: the existing PairRegistry owner and oracle settings are outside our control.
- **Batching**: approvals and trades are separate wallet prompts. EIP-5792 batching and Permit2
  need a server batch type and a new router respectively (see standards doc).
- **Finality**: "confirmed" means two blocks after the receipt (sequencer soft finality), not L1 finality.
- **Languages**: 13 locales at 100% key coverage, written by the agent; have native speakers review copy before marketing in a locale. Browser-drawn file-input text follows the browser language.
- **Hosting**: systemd hardening is verified by `systemd-analyze verify` and tests, not on a real host.
  Linux signal-driven shutdown is unvalidated.
- **No external audit.** The 2026-11-02 review is a single internal pass without Slither or coverage.
- **Sign-in is wallet-only.** First-time visitors land on `#welcome` (see `workstreams/landing.md`).
  Only "Connect wallet" and "Browse without signing in" work. X, TikTok, Kick, GitHub, Google, Email
  and Apple render disabled with "Soon" because `GET /api/auth/providers` reports none configured.
  `/terms` and `/privacy` (`#terms`, `#privacy`) are drafts pending legal review, not in force.

### Social sign-in: what a provider integration needs

The UI enables a provider only when `/api/auth/providers` returns `configured: true` and a same-origin
`startUrl`; the server derives that from `createPlatformServer({ authProviders: [{ id, startUrl }] })`.
Nothing registers today. To ship one:

1. **Pick the path.** A hosted provider (Privy, Dynamic, Web3Auth) bundles OAuth, email OTP and embedded
   wallets but adds a vendor and its SDK; direct OAuth needs an app per provider (X, GitHub, Google,
   TikTok, Kick, Apple Sign in, plus an email sender for magic links/OTP).
2. **Credentials** as env/secret files, never in the repo: client id/secret per provider, Apple key id +
   team id + private key, email SMTP/API key. Add them to the secret scan and `deployment-check`.
3. **Routes**: `GET /api/auth/<id>/start` (PKCE + `state`, redirect), `GET /api/auth/<id>/callback`
   (verify `state`, exchange code, fetch the stable provider user id), `POST /api/auth/logout`.
4. **Session**: server-side session row in SQLite, `HttpOnly; Secure; SameSite=Lax` cookie, rotation and
   expiry, CSRF protection on every POST that relies on the cookie, rate limits on start/callback.
5. **Bind identity to a wallet**: the user signs an EIP-4361 (SIWE) message with the wallet; store
   `(provider, providerUserId) -> wallet` with the signature. Fee claims and fee-vault containers must keep
   paying the wallet, never the session, and the social recipient resolver (`/api/recipients/resolve`)
   should prefer this verified binding over third-party lookups.
6. **Privacy/terms**: replace the draft pages with reviewed text that names what is stored (provider id,
   handle, email) and how to delete it, before enabling any provider.

## 7. Verification (2026-11-03)

Every packaged file's size and SHA-256 is listed in `PACKAGE-MANIFEST.json`. The packaged copy's
own `bun test test/` also passed (313 pass, 0 fail).

| Check | Result |
|---|---|
| `bun test test/` | 313 pass, 24 skip (Anvil), 0 fail |
| `forge test` (non-fork) | 100 pass, 0 fail, 6 skip (5 network fork tests + 1 skipped suite test) |
| Anvil suites: vault / advanced / programs | 6 / 6 / 6 pass |
| `bun run build` | 333,254 JS bytes |
| `tools/platform-browser-check.mjs` | 24 checks, 13 AccessLint states, 0 errors |
| `tools/launch-browser-check.mjs` | 12 checks, 0 errors |
| `tools/rh-chain-probe.mjs` | all 11 pinned contracts and chain parameters match |

Browser checks ran against a fresh server on port 4328 with signing off and a temp database.
Transactions in browser tests use a simulated wallet; none were broadcast.
