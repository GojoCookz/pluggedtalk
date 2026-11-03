# Reclaimable fee vault (containers) workstream

Thread: https://discord.com/channels/1530362963998015498/1566370490992296027

## Why

Bags lets a creator target a social/GitHub recipient but never lets the creator recall fees when
that recipient never claims or refuses. Plugged holds those fees in a per-recipient container that
either becomes the recipient's (on acceptance, permanently) or returns to the creator (on decline
or expiry).

## Contract: `contracts/src/PluggedFeeVault.sol`

One vault holds many containers. No owner, no upgrade, no rescue, no redirect. Each container fixes
at creation: `allocator` (= `msg.sender`), `recipient` (exact payout wallet), `currency`
(ERC-20 or `address(0)` for ETH), optional `operator`, `deadline`, `inviteRef` (off-chain label
hash, e.g. `keccak256("github:user")`, not an identity proof), and a CREATE2 `inbox`.

```
             accept (recipient tx, before deadline)
 PENDING ───────────────────────────────────────────▶ ACCEPTED ──claim──▶ recipient
   │  │                                               (terminal; never reclaimable)
   │  └─ decline (recipient tx) ─▶ DECLINED ─┐
   └─ block.timestamp >= deadline ─▶ EXPIRED ─┼─ reclaim (allocator) / operatorReturn ─▶ RECLAIMED
                                              │        (repeatable for later inbox inflows)
 operator may also return PENDING early ──────┘
```

| Function | Caller | Rule |
|---|---|---|
| `createContainer(recipient, currency, window, operator, inviteRef, salt) → (id, inbox)` | anyone (becomes allocator) | `window` 0 → 30 d; bounded [7 d, 365 d]; recipient ≠ 0/vault/self/inbox; currency must be ETH or a contract |
| `deposit(id, amount)` | anyone | ERC-20 only; exact balance delta or revert (fee-on-transfer rejected) |
| `depositNative(id)` | anyone | ETH containers only |
| `sweepInbox(id)` | anyone | pulls inbox funds into the container; exact delta check |
| `accept(id)` | recipient only | stored PENDING and `now < deadline`. The signed tx is the wallet-control proof |
| `decline(id)` | recipient only | same window as accept |
| `claim(id)` | recipient only | ACCEPTED; sweeps inbox, pays full balance to recipient |
| `reclaim(id)` | allocator only | DECLINED, EXPIRED or RECLAIMED; sweeps inbox, pays allocator |
| `operatorReturn(id)` | container operator | any unaccepted state; pays **allocator only** |
| `extendDeadline(id, newDeadline)` | allocator or operator | stored PENDING (incl. expired-not-reclaimed); `newDeadline > deadline`, `> now`, `≤ now + 365 d` |
| views | — | `getContainer`, `status` (derives EXPIRED), `claimable`, `reclaimable`, `inboxBalance`, `totalHeld/Credited/Paid(currency)`, paged `recipientContainers` / `allocatorContainers` + counts |

Events: `ContainerCreated`, `Deposited`, `InboxSwept`, `Accepted`, `Declined`, `Claimed`,
`Reclaimed` (has `caller`, so operator returns are attributable), `DeadlineExtended`.

Boundaries: accept valid at `deadline - 1`, reclaim valid from `deadline`; never both. Decline and
accept are both recipient-only and mutually exclusive by state. The operator can never touch an
ACCEPTED container, cannot choose a destination and cannot change recipient/allocator.

Safety: `ReentrancyGuardTransient` on every mutating entry; state written before external
transfers; bare ETH into the vault is accepted only from its own inboxes. Fee-on-transfer, sender
surcharge and rebasing-down tokens revert on exact delta checks. A recipient whose wallet rejects
ETH keeps its balance (claim reverts, nothing lost).

Conservation (asserted by the invariant suite): per currency
`totalHeld == Σ container.balance == vault balance` (for the handler universe; donations would
make vault balance `≥`), `totalCredited == totalHeld + totalPaid`, and per container
`credited == balance + paid`.

## Integration: splitter / advanced-feed recipient slot

`PluggedFeeSplitter` and `PluggedAdvancedSplitter` push via `release(recipient)` with no deposit
callback, so a container's **inbox address** is the value to put in a recipient slot:

1. Creator picks a fresh `salt` and may precompute the inbox with
   `vault.predictInbox(creator, resolvedWallet, splitterCurrency, salt)`, then calls
   `vault.createContainer(resolvedWallet, splitterCurrency, window, operator, ref, salt)`. The inbox is
   CREATE2 with salt `keccak256(abi.encode(caller, recipient, currency, salt))`; it never depends on the
   global container id, so nobody else can create the precomputed inbox (audit 2026-11-02 M-1).
   Do not precompute from `containerCount` - ids shift, inbox addresses do not.
2. Use `inbox` as that recipient's address in the new splitter's constructor (`recipients[i]`).
3. Anyone calls `splitter.release(inbox)`; funds wait in the inbox; `claim`/`reclaim` sweep it.

Covered by `test_splitterRecipientSlotIsContainerInbox` (ERC-20) and
`test_nativeSplitterIntoInbox` (ETH). The deployed Carbon engine/hook and existing splitters are
not modified; the vault only applies to newly deployed splitters/advanced feeds. The plan
encoder and launch flow do not yet create containers automatically (see blockers).

## Backend: `lib/fee-vault-service.mjs`

`new FeeVaultService({client, manifest, chainId=4663, symbols, confirmations=2})`. Manifest is
server-side only: `{address, codeHash, chainId}`, from `options.feeVault` or env
`PLUGGED_FEE_VAULT_ADDRESS` + `PLUGGED_FEE_VAULT_CODEHASH`.

Fail-closed: no manifest → `status().deployed=false`, `containers()` returns empty lists with
reason, `prepare/submit` throw 503. Every read pins one block, checks chain id and
`keccak256(runtime) == codeHash` (else 503), and checks `vaultBalance ≥ totalHeld` per currency
(else 503). UI amounts are exactly the on-chain `balance`, `inboxBalance`, `claimable`,
`reclaimable` at `blockNumber`.

| Route | Body | Result |
|---|---|---|
| `GET /api/vault/status` | — | `{deployed, chainId, address, reason, windows}` |
| `POST /api/vault/containers` | `{account, chainId}` | `{…status, blockNumber, recipient[], allocator[], conservation[], truncated}`; newest 100 per role |
| `POST /api/vault/prepare` | `{account, chainId, action, id, deadline?}` | preparation `{id, transaction, expected, simulation, expiresAt}`; gated by `PLUGGED_LAUNCH_ENABLED` |
| `POST /api/vault/submit` | `{txHash, account, chainId, id?}` | `{status: pending/confirming/reorg/reverted/confirmed, verified, action, containerId, receipt?}` |

Actions: `accept, decline, claim, reclaim, sweep, operatorReturn, extend`. Prepare checks the
account's role and the state, simulates, and rejects if the simulated amount ≠ the read balance.
Submit is stateless (decodes calldata from the tx itself, so it survives restarts), requires
sender/target/value match, **receipt block + 2 confirmations**, canonical block hash, success, and
exactly one matching event for the container id (and recipient = signer for accept/decline/claim).

## UI: `web/fee-vault.js`

`feeVaultScreen({wallet, connect, language, esc})` → `mount/invalidate/destroy`, mounted in the
Earnings route below rewards via a small composite in `web/app.js` (sibling roots, both
invalidated/destroyed together). EN/ES strings inline; inherits existing light/dark tokens and
form-section/receipt classes (mobile stack by default). States: checking, **not deployed** (says no
balances exist), connect wallet, recipient list ("Addressed to you"), allocator list ("Created by
you"), review receipt, sign, 3-confirmation polling. Wallet/chain change invalidates preparations.

## Test results (2026-11-01, this host)

| Suite | Result |
|---|---|
| `forge test --match-path test/PluggedFeeVault.t.sol` | 23 unit/fuzz pass (fuzz 10,000 runs each) + 2 invariants pass (256 runs × 64 depth, 16,384 calls each) |
| `forge test --no-match-contract Fork` (whole non-fork suite) | 95 passed, 0 failed (14 suites) |
| `bun test ./test/fee-vault.test.mjs` | 5 pass |
| `PLUGGED_VAULT_INTEGRATION=1 bun test ./test/fee-vault.integration.test.mjs` | 4 pass, 38 expects (private Anvil: accept→claim incl. post-accept inbox inflow, decline→reclaim, native expiry→extend→reclaim, foreign-wallet submit rejected; confirming→confirmed after +2 blocks) |
| `bun test platform-api, server, http-api, rewards` | 55 pass (no regression) |
| `bun run build` | OK, 294,294 JS bytes, no new dependencies |

Update (2026-11-01, create action + browser pass):

| Suite | Result |
|---|---|
| `bun test ./test/fee-vault.test.mjs` | 8 pass, 48 expects (+create validation, pinned simulation/prediction, id-shift and custom-error refusal, ES error mapping) |
| `PLUGGED_VAULT_INTEGRATION=1 bun test ./test/fee-vault.integration.test.mjs` | 6 pass, 55 expects (+ERC-20 create → confirming → confirmed, event inbox = predicted = stored, foreign signer rejected, inbox inflow → accept → claim 2 VQ; native ETH create) |
| `bun test test/` | 294 pass, 24 skip, 0 fail (27 files) |
| `bun run build` | OK, 326,864 JS bytes, no new dependencies |
| Chrome headless (Playwright-core via node; `createPlatformServer` on 4411 undeployed, 4412 with a stub `deployed:true` status, no RPC) | 6 pages: Earnings 390 light EN / 1280 dark ES, `#advanced` same two, `#advanced` with stub vault + seeded container row. All: 0 console/page errors, no horizontal overflow, 0 unlabeled inputs/selects, 25 Tab stops each with visible `:focus-visible` outline. First run found 2 CSP errors (inline `style=` in new rows) and non-spanning toggle/note rows; fixed. Screenshots: `C:/Users/shies/AppData/Local/Temp/opencode/vault-{earnings,advanced}-{390-light-en,1280-dark-es}[-vaultstub].png` |

Not run: AccessLint/screen reader, real-wallet container creation in the browser.

Covered properties: conservation, no double pay, no clawback after accept (unit + invariant),
expiry boundaries (unit + fuzz), decline/accept race, reentrancy (native claim, native reclaim,
token transfer hook), unauthorized callers (outsider, allocator-as-recipient/operator,
recipient-as-allocator, direct inbox forward), fee-on-transfer rejection.

## Blockers / not done

- **Not deployed.** No vault on Robinhood chain 4663; the server reports `deployed:false` until an
  operator deploys and sets `PLUGGED_FEE_VAULT_ADDRESS` + `PLUGGED_FEE_VAULT_CODEHASH`. No mainnet
  broadcast was made.
- **No external audit.** Self-tested only.
- ~~Launch/plan flow does not create containers~~ **Done for `#advanced` (single-quote only).**
  `lib/fee-vault-service.mjs` has a `create` action: `prepare {account, chainId, action:'create',
  recipient, currency, windowDays 7–365}` checks recipient ≠ signer, currency is ETH or has code,
  verifies the vault code hash, reads `containerCount` and simulates `createContainer` at the same
  pinned block (custom errors surfaced as `Vault rejected create (Name).`); the simulated
  `(id, inbox)` must equal `count+1` and is returned as `expected.predictedId/predictedInbox`.
  `submit` requires exactly one `ContainerCreated` whose allocator = signer and recipient/currency/
  operator = the signed calldata, then cross-checks `getContainer(id)` at the receipt block
  (inbox/recipient/currency/allocator), after receipt + 2 confirmations. Returns `{containerId, inbox,
  recipient, currency, deadline}`. Existing `/api/vault/prepare|submit` routes carry it; no
  server.ts change.
  UI (`web/advanced-launch.js`): per recipient row “Hold in reclaimable container” + response
  window; “Create container” prepares, signs, polls submit, then replaces the row address with the
  **confirmed event inbox** (read-only, labelled “Container inbox N”, with payout wallet + deadline).
  Unchecking restores the payout wallet (the on-chain container stays reclaimable in Earnings).
  Pending creates survive reload (“Check container confirmation”, stateless submit).
  **Currency rule:** `PluggedAdvancedFactory` deploys one `PluggedAdvancedSplitter` per quote pair
  (currency = that pair) but all share `p.recipients`. A one-currency inbox would receive other
  quotes' fees it cannot account for, so holding is allowed only with exactly one quote pool and
  container currency must equal that quote; otherwise the option is disabled with that reason and
  review refuses (also if the quote changes after creation). Disabled with the server reason when
  the vault is not deployed. The baseline Carbon launch flow is unchanged.
- Acceptance is by direct transaction from the recipient wallet; **EIP-712 relayed accept remains
  out of scope** (needs a contract change; a gasless recipient needs ETH for gas).
- Server error strings: `serverError(message, lang)` in `web/i18n.js` maps known advanced/vault/
  gate messages (and vault preparation notes) to ES with anchored patterns; unknown text falls back
  raw. Used by `web/advanced-launch.js` and `web/fee-vault.js`.
- Container creation was not exercised in a browser against a real wallet (Anvil service-level
  only); advanced launch itself is still unavailable (no factory profile).
- `server.ts` and `web/app.js` received additive edits only (import, service, 4 routes, earnings
  composite); concurrent advanced-runtime edits were not touched.

## Known limits (audit 2026-11-02)

- **I-4 operator may equal allocator.** `createContainer` accepts `operator == msg.sender`. The
  operator can only extend the deadline or return an unaccepted container to the allocator, so this
  grants no new power, but the UI should not present the operator as an independent party.
- **L-4 (campaigns, not the vault).** `PluggedCampaign` now refunds contributors when a successful
  campaign is not paid out within `PAYOUT_GRACE` (30 days) after the deadline.
