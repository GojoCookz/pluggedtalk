# Programs integration contract

Owner scope: `lib/program-service*.mjs`, `lib/cashback*.mjs`, `web/programs.js`,
`test/program-service*`, `test/cashback*`, `tools/cashback*`, this document. Existing
contracts, server, app navigation, styles and packaging belong to other agents.

## Exact HTTP contract (parent wiring)

Instantiate `new ProgramService({launchService})` from `lib/program-service.mjs`.
Methods return JSON-safe objects; errors throw `Error` with `status` (default 400).
Use existing server JSON/body/rate limits; do not expose environment or stack traces.

For the integrated server's single shared connection, inject
`store: new ProgramStore(launchService.store.db)`; import `ProgramStore` from
`lib/program-service-store.mjs`. This is the preferred integrated-server construction.

| HTTP | Method | Input |
|---|---|---|
| GET `/api/programs` | `list({account})` | optional wallet query |
| GET `/api/programs/:programId` | `details(programId,{account})` | optional wallet query |
| POST `/api/programs/prepare` | `prepare(body)` | `{programId,account,action,amount?,voucher?}` |
| POST `/api/programs/submit` | `submit(body.id,body.txHash)` | `{id,txHash}` |
| POST `/api/programs/status` | `status(body.id)` | `{id}` |
| POST `/api/programs/voucher` | `voucher(body)` | `{programId,account}`; no fee/volume amounts accepted |

Actions: campaign `contribute`, `payout`, `refund`; cashback `fund`, `claim`.
`amount` is a decimal string in the program's currency, only for contribute/fund.
Refunds in this UI always target the connected account; permissionless payout always
targets the immutable beneficiary. Claim vouchers must target the connected account.

`list` returns `{status:'ready'|'undeployed',programs:[],unavailable:[],notes:[]}`.
Only verified deployments appear in programs. Unavailable entries contain id + reason.
`details` returns identity/config + on-chain amounts as raw decimal strings, currency
decimals, phase, chain timestamp/block/hash and account-specific balances.
`prepare` returns `{id,programId,action,account,next:'approve'|'reset-approval'|'send',
transaction:{from,to,data,value,chainId,gas},expected,expiresAt,status:'prepared',...}`.
Every returned transaction has passed simulation and gas estimation; approvals are
separate preparations. After an approval confirms, prepare the original action again.
`submit`/`status` return the stored preparation plus status `submitted`, `confirmed`
or `reverted`. Confirmation requires exact sender/chain/target/calldata/value, matching
contract event and canonical receipt plus two additional blocks. No server signing.

`voucher` returns `{voucher,accounting}` only with a configured attestor provider and
valid signature. The portable default explicitly reports unavailable. Imported signed
vouchers can be supplied to prepare; unsigned user fee claims are never accepted.

## Browser integration

Import `programsScreen` from `web/programs.js`; instantiate
`programsScreen({wallet,connect,language,esc})`. `wallet()` returns `{account,provider}`
(EIP-1193), `language()` returns `en` or `es`. Call `mount(rootElement)`, `invalidate()`
on account/chain/language changes, and `destroy()` before leaving. Parent owns routing,
shared styles and inclusion in the frozen build.

## Deployment gate

No production deployment exists. Empty configuration is the default and offers no
funding/signing buttons. Operator configuration is a trust root, not an API payload.
Campaign and cashback are separate contracts/funds. Fixed beneficiary is not verified
charity identity, endorsement, tax deductibility or a donation receipt.

## Implemented files

- `lib/program-service.mjs`: manifest validation, verified discovery/details, contribution,
  allowance reset/approval, payout/refund, cashback funding/claim preparation, simulation,
  exact transaction and receipt reconciliation.
- `lib/program-service-abi.mjs`: ABIs matching the existing program contracts.
- `lib/program-service-store.mjs`: durable SQLite preparations and unique transaction hashes.
- `lib/cashback.mjs`: EIP-712 verification and integer-only cumulative-fee accounting.
- `lib/cashback-index.mjs`: persistent, replay-safe finalized receipt ledger and attestation.
- `lib/cashback-provider.mjs`: injected signer/indexer → ProgramService voucher adapter.
- `tools/cashback-index.mjs`: operator-only index/scan/export/attest/verify CLI.
- `web/programs.js`: mountable EN/ES wallet UI, light/dark shared styles, review, submit,
  receipt confirmation, local recovery, explicit empty/unavailable states.

### Parent server wiring

```js
import { ProgramService } from './lib/program-service.mjs';
import { ProgramStore } from './lib/program-service-store.mjs';
const programs = new ProgramService({
  launchService, store: new ProgramStore(launchService.store.db),
});

// GET /api/programs
await programs.list({ account: url.searchParams.get('account') || undefined });
// GET /api/programs/:programId (match POST routes first)
await programs.details(programId, { account: url.searchParams.get('account') || undefined });
// POST routes in table above
await programs.prepare(body);
await programs.submit(body.id, body.txHash);
await programs.status(body.id);
await programs.voucher(body);

// Add to the existing reconciliation worker, without overlapping ticks:
await programs.reconcile();
// Shutdown:
programs.close();
```

`ProgramStore` accepts either an existing Bun `Database` instance or its original path
string. An injected database is borrowed: the instance is reused exactly, no second
connection opens, connection pragmas are preserved, and `close()` never closes it. The
launch-store owner remains responsible for final database shutdown. Path-based construction
is backward compatible and owns/closes its connection. No table data is migrated or copied.
Reconciliation failures now log a fixed diagnostic only; RPC exception text, shortMessage,
URLs, credentials and response details are never passed to the logger. Reconciliation
continues with the next pending record after a failure.

Shared-database/logging follow-up verification:
`bun test ./plugged/test/program-service-store.test.mjs ./plugged/test/program-service.test.mjs`
— **28 passed, 0 failed, 98 assertions**. Tests cover exact launch DB instance reuse,
preserved busy-timeout pragma, non-owning repeated shutdown, owner queries after shutdown,
path-backed persistence/owning close, invalid borrowed objects, and credential omission
with continued reconciliation after failures.

All endpoint bodies are ordinary JSON; amounts, block numbers, chain timestamps, goals,
deadlines and voucher uint256 fields are **decimal strings**. `chainId` is an integer
in program/record objects and a hex string in wallet transactions. `expiresAt` is Unix
milliseconds; `timestamp`, `deadline`, `validUntil` use Unix seconds. No amounts use floats.
Map thrown `status` or 400 to `{error: message}` with existing server sanitization.
No server method broadcasts. Preserve existing body limits/rate limits; large history
indexing belongs to operator tooling, not a public request body.

Runtime flags:

```text
PLUGGED_PROGRAMS_ENABLED=true
PLUGGED_PROGRAMS_MANIFEST=/absolute/private/operator/programs.json
PLUGGED_PROGRAMS_DB_PATH=/persistent/runtime/programs.sqlite
```

The manifest path is optional: absent means `[]`, never a fabricated deployment. The
default DB is `plugged/runtime/programs.sqlite`. Keep populated deployment manifests,
runtime DBs/WALs and signer modules outside portable exports. Public examples may use
blank placeholders; never package private signing material. A malformed configured
manifest throws at startup, rather than silently enabling a partial deployment.

### Manifest schema (trusted operator input)

Each entry in the JSON array contains:

```js
{
  id: 'operator-selected-id', kind: 'campaign', name: 'Display name',
  chainId: 4663, localTest: false,
  address: 'DEPLOYED_PROGRAM_ADDRESS', codeHash: 'KECCAK256_OF_RUNTIME_CODE',
  deploymentBlock: 'DECIMAL_BLOCK', deploymentBlockHash: 'CANONICAL_BLOCK_HASH',
  currency: 'ERC20_ADDRESS_OR_ZERO_ADDRESS_FOR_ETH',
  currencyCodeHash: 'KECCAK256_OF_ERC20_RUNTIME_CODE', // omitted for ETH
  decimals: 18, symbol: 'ETH',
  launchId: 'CONFIRMED_PLUGGED_LAUNCH_RECORD_ID',
  beneficiary: 'IMMUTABLE_BENEFICIARY', goal: 'RAW_UINT256', deadline: 'UNIX_SECONDS'
}
```

For cashback set `kind:'cashback'` and replace beneficiary/goal/deadline with
`attestor:'IMMUTABLE_ATTESTOR', rebateBps:'1000', budget:'RAW_UINT256'`.
For isolated local deployments use `chainId:31337, localTest:true` and omit launchId.
The supplied client must point to that local chain; an injected local client in tests
does not change the normal launch client's Robinhood configuration.

Verification checks chain ID, canonical deployment block, exact runtime hash, currency
hash/decimals, and every program immutable against the manifest on each detail/preparation.
Production additionally requires a confirmed, still-canonical Plugged launch record.
This association is operator-reviewed metadata, **not an on-chain factory registration**.
Hashes are trust roots that an operator must establish from reviewed deployments; a hash
match alone is not a security audit. Proxy bytecode pins do not pin implementation
behavior: standard non-rebasing currencies must be independently reviewed and monitored.

Detail fields common to both kinds: manifest identity/config, `verified:true`, `enabled`,
`account` or null, `blockNumber`, `blockHash`, `timestamp`, `notes`.

- Campaign: `totalContributed,totalRefunded,paid,contribution,refundable,phase`.
  Phase is `open` only while chain timestamp **< deadline**. Afterward, recorded
  contributions >= goal means `successful`, otherwise `failed`; `paid` overrides both.
  Direct transfers do not count toward the goal. `contribution` is the contract mapping;
  refunds zero it, successful payout does not. It is never labeled wallet profit.
- Cashback: `totalFunded,totalClaimed,claimed,available,fundingRemaining,phase:'cashback',
  attestationStatus:'configured'|'unconfigured'`. Available = funded − claimed. Neither
  direct transfers nor the campaign contract's balance increase cashback availability.

Preparation `expected` is `{event,args}`. Event amount/destination must match exactly
when confirming. `next:'approve'|'reset-approval'` still preserves the original action;
the transaction/expected event is only that approval. After confirmation prepare again.
An insufficient nonzero allowance resets to zero; the next approval grants exactly the
requested amount. There are no unlimited approvals. Standard bool and no-return approval
calls are simulated; final program calls must also simulate and estimate gas successfully.

`prepare` fails rather than returns executable calldata for depleted funds, invalid phase,
insufficient balance, expired/wrong-domain/wrong-signer/wrong-trader voucher or disabled
deployment. Cashback claims are **all-or-nothing**, exactly like the current contract;
the UI never silently truncates the signed cumulative fee amount to fit the budget.

### Browser integration details

```js
const screen = programsScreen({ wallet, connect, language, esc });
await screen.mount(document.querySelector('#main'));
// Wallet account/network or language changed:
screen.invalidate();
// Navigation away:
screen.destroy();
```

Uses existing `form-layout`, `form-section`, `field`, `receipt-line`, `plan-receipt`,
`rail-panel`, `address-block`, `receipt-note`, `error-list` and button styles. No new
framework, stylesheet or network font. Parent must import the module into its source
entry and include it in the frozen frontend bundle. Browser storage key is
`plugged.programTransaction`; it contains only public preparation ID, chain/program and
transaction hash. Recovery survives route changes and browser reload. Server preparations
survive restart through SQLite. The server checks attached hashes; browser storage is
never trusted as payment proof.

Before signing, chain/account/provider/expiry are rechecked. The prepared action is
consumed before opening the wallet. A known 4001 rejection requires a fresh review;
an uncertain wallet failure exposes recovery only, preventing a blind second send.
User can explicitly clear an unsent recovery record; clearing cannot cancel a transaction.
The browser shows no signing action for absent/unverified/disabled deployments. API and
wallet failures have localized summaries, known failure translations and optional raw
technical detail; imported voucher fields are escaped before display.

## Actual eligible-fee indexing and attestor integration

The indexer accepts **transaction hashes**, not claimed trade amounts. It supports one
narrow, attributable path: direct `TradeRouter.swap` ERC-20 buys with the payer receiving
the output (or zero-address recipient normalized by the router). It rejects sells,
native input, aggregators, multicalls, smart/delegated accounts, noncanonical calldata,
unapproved pools, missing/ambiguous events and unsupported settlement patterns.

Eligibility requires finalized RPC blocks plus the confirmation policy, exact chain and
runtime pins, router/hook PoolManager bindings, canonical successful transaction/receipt,
one matching `FeeAccrued`, `Traded`, PoolManager `Swap` and currency `Transfer`, exact payer,
recipient, input/output/fee relationships and settlement order. Eligible value is the
actual hook fee event, **not volume**, USD estimation, or a browser-supplied number.

```js
import { CashbackIndexer } from './lib/cashback-index.mjs';
import { createCashbackVoucherProvider } from './lib/cashback-provider.mjs';

const indexer = new CashbackIndexer({
  client, path: '/persistent/runtime/cashback.sqlite', chainId: 4663,
  startBlock: 'FIRST_ELIGIBLE_BLOCK',
  program, currency, attestor, router, hook, poolManager,
  codeHashes: { program: programHash, currency: currencyHash,
    router: routerHash, hook: hookHash, poolManager: managerHash },
  pools: [{currency0,currency1,fee,tickSpacing,hooks:hook}],
  confirmations: 12, maxValiditySeconds: 3600,
});
await indexer.indexTransaction(actualTxHash); // or operator scan({maxBlocks:1000})
const voucherProvider = createCashbackVoucherProvider({
  indexer, signer, validitySeconds: 900,
}); // signer exposes async signTypedData(typedData); no exported private keys
const programs = new ProgramService({launchService,voucherProvider});
```

Operator scanner advances a persisted block cursor; `(tx_hash)` uniqueness prevents replay.
Configuration hash binds each DB to one program/currency/chain/pool policy. Issuance
revalidates canonical receipts, rederives cumulative fees/evidence, checks on-chain
`voucherDigest`, and verifies returned signatures against the immutable attestor.
Detected changed stored evidence halts issuance. `ProgramService` rechecks signatures,
domain, account, expiry, accounting and simulation before producing claim calldata.

No signer is configured in the delivered default. The provider adapter throws if created
without one. Operator `export`/`attest` without a signer produces explicitly **unsigned**
typed data + evidence; it cannot become a browser claim voucher. A signed tool output
contains `claimVoucher` for the browser JSON field, alongside the full evidence envelope.
Never use a test key in an operator signer. The CLI accepts a trusted signer-module path,
not a private-key argument; signer storage and authorization stay with the operator.

```sh
bun tools/cashback-index.mjs --help
bun tools/cashback-index.mjs scan --config POLICY.json --db LEDGER.sqlite --max-blocks 1000
bun tools/cashback-index.mjs index --config POLICY.json --db LEDGER.sqlite --tx ACTUAL_HASH
bun tools/cashback-index.mjs export --config POLICY.json --db LEDGER.sqlite --trader WALLET --valid-until UNIX_SECONDS --out unsigned.json
bun tools/cashback-index.mjs attest --config POLICY.json --db LEDGER.sqlite --trader WALLET --valid-until UNIX_SECONDS --signer-module LOCAL_SIGNER_MODULE --out signed.json
bun tools/cashback-index.mjs verify --config POLICY.json --db LEDGER.sqlite --voucher signed.json
```

`POLICY.json` uses the constructor fields plus `rpcUrl`. Pin reviewed immutable engine
implementations, not proxies. HTTP RPC must provide honest `finalized` semantics,
historical code and historical calls; missing support fails closed. Output uses exclusive
file creation and mode 0600 where supported; the CLI never broadcasts.

## Verification results (2026-10-31)

```powershell
$env:PLUGGED_PROGRAMS_INTEGRATION='1'
bun test ./plugged/test/cashback.test.mjs ./plugged/test/cashback-provider.test.mjs ./plugged/test/cashback-index.test.mjs ./plugged/test/program-service.test.mjs ./plugged/test/program-service.integration.test.mjs
```

**95 passed, 0 failed, 411 assertions**. This includes actual isolated Anvil 31337 deployments
of the existing compiled program contracts: native contributions → deadline success →
fixed beneficiary payout; failed-goal original-contributor refunds; standard ERC-20
zero-first approval/contribution; cashback funding, cumulative signed claims, replay,
expiry/domain/signer/budget rejection. RPC adversarial tests cover undeployed/code/chain/
immutable mismatches, receipt and transaction mismatch, noncanonical receipt evidence,
database replay/configuration persistence and signer/provider boundaries. The trade
indexer's engine event-path tests use controlled RPC fixtures, not a claimed live deployment.

Anvil executable defaults to existing `~/.foundry/bin/anvil.exe` (Windows) or `anvil` on
other platforms, override `PLUGGED_ANVIL_BIN`. The harness uses an OS-selected loopback
port and stops its own process. It uses existing `contracts/out` artifacts and the existing
`PluggedFeeSplitter.t.sol/QuoteToken` test artifact; rebuild those with Foundry if sources
change. Without `PLUGGED_PROGRAMS_INTEGRATION=1`, local-chain tests are explicitly skipped.

```sh
cd plugged
bun run test/cashback-browser.mjs
```

**23 browser checks passed**, zero runtime errors. Actual undeployed service is tested;
populated screens/wallet responses are explicitly labeled local fixtures. Covers EN/ES,
390×844 mobile and 1440×1000 desktop, light/dark, exact escrow review destination,
review focus, changed-input and expiry invalidation, wrong chain, hash persistence/reload,
explicit rejection, uncertain-send recovery, failed/success campaign action visibility,
absent attestor, malformed voucher inline errors and exact Spanish network/recovery
instructions (localized UI errors are explicitly tagged, never guessed from accents).

The voucher textarea explicitly sets `tabindex="0"`. A 390px regression fills a labeled
50-line keyboard-test JSON fixture, verifies actual vertical overflow, reaches the textarea
with Shift+Tab from its submit button, and runs the 94-rule audit on that scrollable state.

### Account/remount isolation follow-up

`load()` now synchronously clears the previous list before requesting new data; `invalidate()`
also clears account-sensitive drafts, reviews, errors and busy state. No previous account's
contribution/refund values remain visible while the new account request is pending.
Each asynchronous action owns an epoch. Late preparation/confirmation errors, terminal
refresh continuations and `finally` handlers cannot mutate or unlock a newer screen.
`connect()` continuations obey the same rule. `destroy()` clears the old render state.

A wallet can finish broadcasting after an account change. That hash is still persisted
against the **captured original preparation ID**, only if that ID still owns the recovery
slot; it never overwrites a newer recovery record. Reporting the hash to the backend remains
safe, but stale completion cannot announce payment, clear recovery, focus controls or
replace the new account's list. The next refresh hydrates the saved hash for verification.

Six browser regressions exercise delayed list requests, failed preparations after remount,
confirmation after account change, terminal-result refresh after remount, stale `finally`
while a newer request is busy, and late wallet broadcasts. They use controlled Promise
barriers rather than timing-dependent sleeps.

### Final browser fixture schema

`test/cashback-browser.mjs` is the standalone Node Playwright/Bun server harness, not an
HTTP server route test. Unpopulated discovery calls an actual empty `ProgramService`.
Populated discovery and transaction responses are explicitly simulated, with visible
`LOCAL TEST FIXTURE` names. They never reach a public RPC or broadcast a transaction.

```js
// GET /api/programs[?account=ADDRESS] fixture envelope:
{ status: 'ready', programs: [program], unavailable: [] }

// Fields common to populated browser fixtures:
{
  id: 'fixture', name: 'LOCAL TEST FIXTURE — campaign',
  kind: 'campaign', address: '0x2222222222222222222222222222222222222222',
  chainId: 31337, localTest: true, verified: true, enabled: true,
  account: '0x1111111111111111111111111111111111111111',
  currency: '0x0000000000000000000000000000000000000000',
  decimals: 18, symbol: 'ETH'
}

// Campaign fields:
{
  beneficiary: '0x3333333333333333333333333333333333333333',
  goal: '1000000000000000000', deadline: String(Math.floor(Date.now()/1000)+3600),
  totalContributed: '100000000000000000', totalRefunded: '0',
  contribution: '100000000000000000', refundable: '0', phase: 'open'
}
// Failure fixture: phase:'failed', refundable: contribution.
// Success fixture: phase:'successful'. These are controlled UI states, not derived chain data.

// Cashback fields (kind:'cashback', name:'LOCAL TEST FIXTURE — cashback'):
{
  phase: 'cashback', budget: '2000000000000000000',
  totalFunded: '1000000000000000000', totalClaimed: '100000000000000000',
  available: '900000000000000000', claimed: '100000000000000000',
  fundingRemaining: '1000000000000000000', rebateBps: '1000',
  attestor: '0x2222222222222222222222222222222222222222',
  attestationStatus: 'unconfigured'
}

// POST /prepare fixture (body.action is echoed):
{
  id: 'fixture-preparation', programId: 'fixture', action: body.action,
  account: '0x1111111111111111111111111111111111111111',
  next: 'send', chainId: 31337, expiresAt: Date.now()+60000,
  expected: {event:'Contributed',args:{
    amount:'10000000000000000',
    contributor:'0x1111111111111111111111111111111111111111'
  }},
  transaction: {
    from:'0x1111111111111111111111111111111111111111',
    to:'0x2222222222222222222222222222222222222222',
    data:'0x1234', value:'0x0', chainId:'0x7a69'
  }
}
// POST /submit fixture: {status:'submitted'|'confirmed'|'reverted'}.
// API failure fixture: non-2xx + {error:'MESSAGE'}.
```

The fake calldata/value intentionally exercise wallet orchestration only; they are not
valid payment instructions. Browser fixtures omit production proof fields the component
does not read (`blockNumber`, `blockHash`, `timestamp`, manifest pins, prepared-record
status/gas). Actual `ProgramService` responses retain those fields, and Anvil/adversarial
tests validate their transaction/receipt semantics separately. Complete wire shapes remain
specified in the API and manifest sections above.

The simulated EIP-1193 provider implements `eth_chainId`, `eth_accounts` and
`eth_sendTransaction`; it returns a fixed `0x12`-repeated 32-byte hash. Explicit rejection
throws `{code:4001}`; uncertain errors expose recovery only. Race tests change accounts
to `0x44…44` / `0x55…55`, hold fetch/wallet promises, and release them after invalidation
or remount. Account B's contribution fixture is `2000000000000000000` raw ETH units.
Recovery storage fixture is `{id,programId?,chainId?,txHash?}` under
`plugged.programTransaction`; production creates the metadata before wallet submission.

**AccessLint: 7 rendered states × 94 rules, zero violations, zero skipped rules**. This is
automated evidence, not WCAG conformance or a screen-reader certification. Mechanical
design detector returned `[]`; independent UI review identified four interaction fixes
(destination, uncertain retry, focus/inline errors, localized failures), now implemented
and regression-tested. Independent review scored **all four prior findings resolved**.
That verdict covers those findings, not a whole-application certification. Source guideline
reference: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

Browser evidence is outside the repository at
`C:/Users/shies/AppData/Local/Temp/opencode/programs-review/`; seven screenshots and
`accessibility.json`. Harness runs the server/bundler with Bun and Playwright with Node
because Bun's direct Playwright Chrome startup hung on this machine; the Node path passed.

## Remaining integration / deployment blockers

1. **No production contracts or signer are configured.** Nothing is presented as live;
   no production transaction was broadcast. Operator must deploy/review/pin programs and
   independently fund cashback before enabling transaction APIs.
2. **Parent must wire the HTTP routes, reconciliation lifecycle, navigation and build/export.**
   This workstream deliberately owns no edits to server/app/styles/export. Full assembled
   application behavior must be rerun after parent integration.
3. **Contract coordination:** current cashback has no revocation mechanism for already
   signed vouchers after a finalized-chain reorg or attestor compromise. The indexer halts
   further issuance on changed canonical evidence; it cannot revoke issued signatures.
   Short validity limits exposure but do not eliminate it. Contract owner should assess
   nonce/epoch invalidation separately; no contract files were edited here.
4. **Indexing scope is intentionally exact:** direct ERC-20 buys only. Live engine code pins,
   production archive/finality support, signer operations and end-to-end real-trade
   attestation remain unverified. Unsupported transactions do not receive invented rebates.
5. Concurrent payouts/claims can change the expected event between simulation and mining.
   Contract protection remains authoritative; the service rejects an unexpected amount
   instead of claiming a matching payment. Inspect the actual receipt and refresh balances.
   Off-chain expiry never cancels already-signed calldata; only campaign/voucher contract
   deadlines apply on-chain. Available budget is not reserved by a preparation/voucher.

No commits, pushes, worktrees, unrelated file edits, contract edits or production broadcasts
were made in this workstream.

Review-link publication was attempted with every owned file filtered. This repository's
parent-root layout required an explicit scoped `git diff | critique --stdin` pipeline;
HTML conversion succeeded, but upload failed because `https://critique.work` was
unreachable (independent HTTPS fetch also failed). No review URL was produced.
