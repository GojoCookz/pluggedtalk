# Rewards integration workstream

## Parent API contract (2026-10-31)

Instantiate `new RewardsService({launchService})` from `lib/rewards-service.mjs`.
All methods return JSON-safe objects. Routes below are POST, accept JSON, and never sign
or broadcast. Return thrown errors as `{error: message}` with non-2xx status. Apply the
existing same-origin, size and rate controls. Gate prepare with the launch transaction
enable flag; reads and receipt verification remain available while signing is disabled.

| Route | Method | Body | Result |
|---|---|---|---|
| `/api/rewards/positions` | `positions(body)` | `{account,chainId:4663}` | `{chainId,account,blockNumber,positions,splitters,social}` |
| `/api/rewards/prepare` | `prepare(body)` | `{account,chainId:4663,action,token?,splitter?,recipient?}` | durable preparation `{id,expiresAt,preparedBlock,account,action,transaction,expected,...}` |
| `/api/rewards/submit` | `submit(body)` | `{preparation,txHash,account,chainId:4663}` | `{status,txHash,chainId,account,verified,receipt?}` |
| `/api/rewards/status` | `submit(body)` | same as submit | same; retries are idempotent |

Actions: `sweep` (permissionless Carbon pool sweep), `holder` (Carbon distributor withdraw),
`creator` (the same sweep, offered only to the configured creator fee wallet), `splitter`
(fixed-recipient release). No arbitrary target,
redirect, calldata, amount, or approval input is accepted. Carbon creator payments normally
arrive during sweep; there is no Bags-style creator claim position. Pending pool fees are
not personal balances. Splitter release permits any gas payer but pays only its fixed recipient.
**The deployed Carbon hook has no deferred-fee recovery methods.**

`preparation` in submit/status needs only `{id}`; all other preparation data is loaded from
the separate durable `reward_preparations` table, never trusted from the browser.

Reuse existing `POST /api/recipients/resolve {kind,username}` for explicit social resolution.
Resolution may provision a wallet; it does not prove control or provide OAuth access.

## UI contract and plan

`rewardsScreen({wallet,connect,language,esc})` exports `mount(root)`, `invalidate()`,
`destroy()`. `wallet()` returns `{account,provider}` (EIP-1193). Parent must invalidate on
wallet, chain or language changes and destroy when leaving the route. Mount accepts a DOM
element (defaults to `#main`). Operate mode, inherited Plugged white/green system, native
system type, monospace addresses, existing form-section and receipt components. The
signature receipt separates pending pool fees, personal claimable funds, and fixed payout
destination. Mobile stacks sections; desktop reuses the existing form grid. No new dependencies.

## Deployed-engine findings and implementation

The fork inspection found a material source/deployment difference: the source now contains
`claimStuckFees`, `stuckFeesOf`, `stuckFees` and `stuckTotal`, but the pinned deployed hook
does not. All four selectors are absent from runtime and calls revert empty. This integration
does not encode or expose these nonexistent claims. A creator's normal payout is a transfer
during `sweep(PoolKey)`. `creatorClaimable` is **null**, not a fabricated zero or estimate.
`creatorWalletBalance` reads ERC-20 `balanceOf(configuredCreator)` and includes all funds,
not just fee earnings. The UI labels unswept balances as pool-wide funds, not personal claims.

The actual `poolConfig(bytes32)` result is 14 words / 448 bytes. Its last four fields are
`uint32 openingFeeEndsAt`, `uint32 openingWindow`, `uint16 openingFeeBps`,
`address rewardCurrency`; the older Carbon UI's 11-output declaration misreads that address.
`rewards-abi.mjs` uses the verified 14-output shape.

Reads pin one block, verify existing engine hashes through `launchService.deployment`,
restrict token discovery to locally confirmed Plugged launches, recheck canonical launch
blocks, derive and hash the exact V4 pool key, compare hook/token/distributor pointers and
distributor share/payout/controller fields. No Bags claim endpoint is called. Discovery is
bounded to the latest 100 launches with an explicit `truncated` flag. A per-token RPC failure
returns `status: 'unavailable'` and its error, never zero balances. Engine failures reject the
whole request. Amounts are raw decimal strings plus on-chain decimals; sell fees use the
launch token's fixed 18 decimals. Holder amounts are quote accounting units; conversion
events remain in the verified receipt rather than inventing an output denomination.

Preparations run `simulateContract` and `estimateContractGas` from the exact signing account.
Transactions have zero value, chain `0x1237`, fixed validated target and generated calldata,
with a 20% gas estimate buffer. There are no approval transactions, server keys or broadcasts.
Reviews expire after 120 seconds in the browser. Carbon itself has no expiry or minimum
payout argument; already-signed calldata cannot be revoked or made to expire by the UI.

`RewardsStore` creates only `reward_preparations` in the existing launch SQLite connection.
Preparation IDs and transaction hashes persist across restart. Transaction attachment is
atomic so concurrent submissions cannot replace an attached hash. Every retry reloads the
authoritative server record and revalidates sender, chain, target, value, exact calldata,
preparation block, transaction/receipt hash binding, canonical block and two additional
blocks. Claims require the expected emitter, recipient and positive payout event. Splitter
receipts additionally bind currency. Sweeps require the matching pool's `FeeTaken` event
and quote-token `Transfer` events to the configured creator and holder distributor for their
nonzero allocations; the
allocation event alone is not sufficient evidence of successful creator delivery.

### Exact response states

- `positions`: `{chainId:4663,account,blockNumber,positions,truncated,splitters,social}`.
  Carbon rows contain `token,name,symbol,poolId,distributor,quote,quoteSymbol,decimals,creator,
  creatorBps,isCreator,pendingQuote,pendingToken,creatorWalletBalance,creatorClaimable:null,
  creatorClaimMode:'sweep',deferredRecovery:'unsupported-by-deployed-hook',holderClaimable,
  holderReceived,shares,holderAmountUnit:'quote-accounting-units',actions:{sweep,holder,creator}}`.
- `splitters`: `{status:'unconfigured'|'configured',deployments:[]}`. Verified rows have
  `{kind:'splitter',address,currency,planHash,decimals,symbol,status:'verified',recipients}`;
  each recipient has `{address,bps,claimable,released}`. Failed rows have address/error/status.
- `social`: `{resolverConfigured,blockers,oauthAvailable:false}`. Missing key explicitly
  includes `BAGS_API_KEY`; wallet-control onboarding remains an independent blocker.
- `prepare`: `{id,account,chainId:4663,action,status:'prepared',createdAt,expiresAt,
  preparedBlock,transaction,expected,simulation:{result,gas},notes}`. All times are Unix ms.
  Expected fields bind recipient/currency/decimals/symbol/amount and, for Carbon,
  token/poolId/distributor/creator/creatorBps/pendingToken. For sweep/creator, `amount` is the pool quote
  balance; it is **not** the creator's net payout or an enforced minimum.
- `submit/status`: `{status,txHash,chainId:4663,account,verified,receipt?,reason?}`.
  States: `pending`, `confirming` (also confirmations/requiredConfirmations), `reorg`,
  `reverted`, `confirmed`, `no-op`, `payment-unverified`. Only `confirmed` sets verified true.
  `no-op` means a canonical successful sweep emitted no matching fee distribution, commonly
  because another sweep won the race. `payment-unverified` means a creator or holder allocation
  was emitted but its transfer was not verified. Both are terminal without a successful-payment
  claim. Verified receipt includes blockNumber/blockHash/event/args/decoded events.

### Final browser/mock schemas

The wire contract below is final for parent integration. `Raw` means an unsigned base-10
integer **string**, not a JSON number; timestamps are Unix milliseconds as numbers.
`Address` and `Hash` are full `0x`-prefixed strings. Successful Carbon rows have **no
`status` field**; unavailable rows do. Browser tests should label all simulated data.

```ts
type Raw = string;
type Address = string;
type Hash = string;
type Action = 'holder' | 'creator' | 'sweep' | 'splitter';
type Binding = { account: Address; chainId: 4663 };
type PrepareInput = Binding & (
  | { action: 'holder' | 'creator' | 'sweep'; token: Address }
  | { action: 'splitter'; splitter: Address; recipient: Address }
);
type SubmitInput = Binding & { preparation: { id: string }; txHash: Hash };

type CarbonPosition = {
  kind: 'carbon'; token: Address; name: string; symbol: string;
  poolId: Hash; distributor: Address; quote: Address; quoteSymbol: string;
  decimals: number; creator: Address; creatorBps: number; isCreator: boolean;
  pendingQuote: Raw; pendingToken: Raw; creatorWalletBalance: Raw;
  creatorClaimable: null; creatorClaimMode: 'sweep';
  deferredRecovery: 'unsupported-by-deployed-hook';
  holderClaimable: Raw; holderReceived: Raw; shares: Raw;
  holderAmountUnit: 'quote-accounting-units';
  actions: { sweep: boolean; holder: boolean; creator: boolean };
};
type UnavailableCarbon = {
  kind: 'carbon'; token: Address; name: string; symbol: string;
  status: 'unavailable'; error: string;
};
type SplitterPosition = {
  kind: 'splitter'; address: Address; currency: Address; planHash: Hash;
  decimals: number; symbol: string; status: 'verified';
  recipients: { address: Address; bps: number; claimable: Raw; released: Raw }[];
};
type PositionsResult = Binding & {
  blockNumber: Raw; positions: (CarbonPosition | UnavailableCarbon)[];
  truncated: boolean;
  splitters: {
    status: 'unconfigured' | 'configured';
    deployments: (SplitterPosition | {
      address: Address; status: 'unavailable'; error: string;
    })[];
  };
  social: { resolverConfigured: boolean; blockers: string[]; oauthAvailable: false };
};
type Expected = {
  recipient: Address; currency: Address; amount: Raw; decimals: number; symbol: string;
};
type CarbonExpected = Expected & {
  poolId: Hash; token: Address; distributor: Address; pendingToken: Raw;
  creator: Address; creatorBps: number;
};
type Preparation = Binding & {
  id: string; action: Action; status: 'prepared'; createdAt: number;
  expiresAt: number; preparedBlock: Raw;
  transaction: {
    from: Address; to: Address; chainId: '0x1237'; value: '0x0';
    data: string; gas: string; // hex quantities/calldata, not Raw decimal strings
  };
  expected: Expected | CarbonExpected; // CarbonExpected for all three Carbon actions
  simulation: { result: Raw; gas: Raw }; notes: string[];
};
```

For browser mocks, return `expiresAt: Date.now() + 120000`, matching account in both
`account` and `transaction.from`, and matching `expected.recipient`. Splitter recipient
may differ from signer; Carbon `expected.recipient` is signer, while sweep destinations
are `expected.creator` and `expected.distributor`. Use `expected.amount` in raw units
with `expected.decimals`; do not mock a formatted amount. `creator` uses sweep calldata,
not a nonexistent creator-claim selector. A successful review never opens signing by itself.

`POST /positions` takes exactly `Binding`. `POST /prepare` takes exactly `PrepareInput`.
`POST /submit` and `/status` take exactly `SubmitInput`; the preparation body can contain
only the ID because transaction/economics are recovered from SQLite. Errors use the
parent's non-2xx `{error:string}` response. Terminal and pending result variants are listed
in **Exact response states** above; only `status:'confirmed'` means `verified:true`.

### Verified splitter manifest

Default is deliberately `splitters: []`. After independent deployment verification, parent
may pass an internal manifest into the constructor; never expose manifest installation over
HTTP or take a user-entered target as a verified deployment:

```js
new RewardsService({
  launchService,
  splitters: [{
    chainId: 4663,
    address: verifiedDeploymentAddress,
    codeHash: verifiedRuntimeCodeHash,
    currency: verifiedCurrency, // zero address only for native ETH
    planHash: verifiedPlanHash,
    recipients: [{ address: verifiedRecipient, bps: 10000 }],
  }],
});
```

The service checks runtime code hash, currency, plan commitment, count, every ordered
recipient and immutable BPS allocation at each read/preparation. It accepts only configured
recipients for `release(address)`. No splitter has been deployed or configured by this work.
Native/standard ERC-20 release wiring is implemented; production deployment and source/code
verification are prerequisites. Mock-service tests cover this wiring; there is no claimed
production splitter payout evidence.

### Social onboarding boundary

Existing resolver and signed identity-to-wallet receipts are reused. It now rejects unknown
inputs (including redirect/callback/claim targets), refuses HTTP redirects carrying the server
key, and returns `walletControl:'unverified',oauthAvailable:false`. Existing planner calls
already send exactly `{kind,username}` and remain compatible. The browser clears a resolved
address when the profile changes, distinguishes a connected-address match from authenticated
control, and never substitutes an unrelated connected wallet as beneficiary. The recipient
must obtain control of the exact resolved wallet through provider-supported onboarding before
spending its funds. No third-party OAuth integration is claimed. Missing `BAGS_API_KEY` blocks
real resolution; live provider onboarding was not verified. Nonprofit/endorsement claims are
explicitly separate. No ownership-plan or Merc template address was modified.

## Precise parent integration steps

1. Import `RewardsService` in the server and instantiate it once using the same `LaunchService`
   instance/SQLite connection. Keep initialization lazy if the existing launch service is lazy.
2. Add all four routes above to the POST/body/rate/same-origin allowlists. Dispatch positions,
   prepare and submit exactly as above; status is an alias of submit, not a launch-store lookup.
   Do not pass these requests through `/api/launches/*`'s ID/body validation branch.
3. Gate `/api/rewards/prepare` with the existing transaction-enabled setting. Leave positions,
   submit and status available for reads/recovery. Preserve the existing resolver route and
   its server-only `BAGS_API_KEY`; never expose that key in configuration responses.
4. Import `rewardsScreen` in the browser entry. Instantiate using existing wallet/connect,
   `language:()=>state.language`, and escape helper callbacks. On `#rewards`, call
   `rewards.mount(document.querySelector('#main'))`. On route exit call `destroy()`.
   On account/chain/language changes call `invalidate()`; the module also attaches its own
   account/chain listeners only while mounted and removes them on destroy. Parent global
   invalidation may safely call `invalidate()` before first mount or after destroy: neither
   call attaches listeners. Remount restores the mounted subscriptions; repeated invalidation
   does not duplicate them. Parent remains the owner of global wallet invalidation.
   It requires only existing shared CSS.
5. Include the new module in the parent's frozen build/export and package the owned library
   files. Run integrated parent browser/API checks after routing and bundling. This
   workstream's isolated harness intentionally does not change server.ts/app.js/build/export.
6. Back up the existing SQLite database with its WAL consistently: the rewards table is in
   that same database. Preserve pending browser keys `plugged.rewards.pending.<account>`;
   they contain only preparation ID/account/hash. No secret or signature is stored there.
   No autonomous rewards reconciliation worker is included; `Check confirmation` resumes
   verification after reload or server restart. Never broadcast from a background worker.

## Verification evidence

Fork evidence: `test/rewards-fork.md`, `test/rewards-fork-results.json`, and isolated
test/runner files. No server/router/build integration is claimed until parent step 5.

- Scoped Bun service/social suite: **28 passed, 0 failed, 163 assertions** across
  `test/rewards.test.mjs` and existing `test/integrations.test.mjs`. Includes invalid
  amounts/redirects/claim targets, stale wallets, chain mismatches, distributor binding,
  simulation failure, canonical receipt requirements, forged preparation fields, persistence,
  atomic hash attachment, native/ERC-20 splitter claims, fixed-recipient permissions,
  unconfigured deployments, missing keys and expired/tampered social receipts.
- Pinned deployed Carbon fork **102763698**, block hash
  `0x0927ade8b58e12ba6d2be4a08c271bbcd4d6400f0b38a225da99c50ae37a5b49`:
  **4 passed, 0 failed, 0 skipped**, including an exact-pin replay. USDG creator payout
  **9964 raw units**, holder withdrawal **9962**; WETH creator **4436695709559 raw units**,
  holder **4436695709558**. Separate creator fee recipient, third-party sweep, 24-hour
  streaming, real balance/accounting deltas, conservation and duplicate withdrawal rejection.
  No claimable balances were fabricated; only local-fork quote funding and time were changed.
  Tests also verified 14-output ABI and absent deferred-claim selectors. Public RPC prunes
  older state; exact replay requires cached state or an archive endpoint. Sell-fee conversion
  and restricted-token transfer failures were not exercised on the real fork.
- Browser harness: **21 checks, 0 runtime errors**. Covers connect, review/cancel, expiry,
  provider-account drift without parent notification, wrong network, wallet rejection,
  pending reload, manual hash recovery, switching account during signing, stale RPC results,
  errors/empty state, missing social key, profile changes, fixed-recipient third-party release,
  sweep no-op, unverified delivery, reverted receipts, destroy cleanup, English/Spanish
  and mobile/desktop light/dark layouts. Lifecycle regression checks repeated inactive parent
  invalidation leaves zero wallet listeners, remount restores exactly two, and another
  destroy/invalidate returns to zero.
  All wallet/RPC responses in this browser harness are visibly labeled simulated fixtures.
- AccessLint **0.21.0**: **5 combinations × 94 rules**, **0 violations, 0 skipped rules**:
  390×844 light/dark, Spanish mobile dark, 1440×1000 desktop light/dark. Automated evidence,
  not full WCAG conformance. Initial landmark findings were fixed (review is a labeled
  section within main; test-fixture disclosure is a header landmark). Mobile and desktop
  screenshots were inspected; signing now focuses and scrolls to the receipt, address
  values use monospace, and Spanish decimals are localized without floating-point conversion.
- Impeccable scoped detector returned `[]`; Web Interface Guidelines review applied to
  `web/rewards.js`. Existing shared design tokens/CSS are inherited without edits.
- Artifacts: `C:/Users/shies/AppData/Local/Temp/opencode/rewards-evidence/` contains final
  `browser.json` and five screenshots. They are not product assets. Playwright on this
  Windows host must run under **Node**, not Bun (Bun's browser pipe launch stalled).

Replay from `plugged/`:

```sh
bun test test/rewards.test.mjs test/integrations.test.mjs
node test/rewards-browser.mjs
node test/rewards-fork-run.mjs 102763698
```

The browser runner uses installed Playwright/Chrome/AccessLint; overrides:
`PLAYWRIGHT_MODULE`, `CHROME_PATH`, `ACCESSLINT_MODULE` (browser IIFE),
`REWARDS_EVIDENCE_DIR`. No packages were added. The fork runner uses existing Foundry,
forge-std and `artifacts/carbon-fork-fixtures.json` in a temporary project without changing
the shared contract profile. `REWARDS_FORGE` and `PLUGGED_RPC_URL` override the local tools.

### Sources

- Deployed hook: https://robinhoodchain.blockscout.com/address/0xdc0244274f0b4e60ec4433bfa9d3ff0632caa0cc
- Deployed launcher: https://robinhoodchain.blockscout.com/address/0xcc491f9962ca5545163ac425210b69e24ac29a96
- Social resolver: https://docs.bags.fm/api-reference/get-fee-share-wallet.md
- UI review rules: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

Blockscout's JSON source endpoint returned HTML during inspection; deployed ABI/capability
claims above are grounded in pinned bytecode hashes and actual fork calls, not that endpoint.
