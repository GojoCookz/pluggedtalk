# Plugged trading integration

Owned implementation and local verification complete. Independent finish verdict: **SHIP, scoped local component review**; all three material findings resolved. Parent integration remains a separate required step. Ownership: `lib/trading*.mjs`, `web/trading.js`, `test/trading*`, this report only. No shared-file edits, broadcasts, commits or new dependencies.

## API contract (parent integration)

Import `TradingService` from `./lib/trading-service.mjs`; construct once with `{launchService}`. It reuses `launchService.client`, `launchService.store.db` and the verified launch records. It creates its own `plugged_trades` table in that SQLite database. No Carbon discovery/indexer imports.

All endpoints are POST JSON under `/api/trading/`, returning the method result directly. Apply existing body/rate limits and same-origin policy. Catch errors as `{code: tradingErrorCode(error), error: error.shortMessage || error.message}` with non-2xx status; `tradingErrorCode` is exported by `trading-service.mjs`. Browser translates the stable code into specific EN/ES instructions and does not display raw RPC prose. Apply the existing `PLUGGED_LAUNCH_ENABLED` signing gate to `prepare`; reads/quote/status remain available.

| Route | Method | Body |
|---|---|---|
| `balances` | `balances(body)` | `{token,account}` |
| `quote` | `quote(body)` | `{token,account,side:'buy'|'sell',amount:string,slippageBps:integer,reviewSeconds:integer}` |
| `prepare` | `prepare(body)` | `{id,account}` |
| `submit` | `submit(body)` | `{id,txHash}` |
| `status` | `status(body)` | `{id}` (record with hash), `{id,txHash}` for recovery, or `{id,txHash,replaces}` for a wallet replacement/cancellation |

Addresses are nonzero EVM addresses. Amounts are decimal strings, never floating point. Slippage is 0–500 bps; review validity is 30–120 seconds (defaults 50 bps / 60 seconds). Unknown fields, arbitrary recipients and native-input routing are rejected.

### Response shapes

- `balances`: `{account,token:{address,symbol,decimals,balance,allowance},quote:{...},nativeBalance,blockNumber,blockHash,chainId:4663,router,capabilities}`. Balances, allowances and block numbers are decimal strings; decimals are integers.
- `quote`: `{id,status:'review',createdAt,expiresAt,preparedBlock,blockHash,token,account,side,amount,amountIn,slippageBps,reviewSeconds,key,poolId,zeroForOne,router,chainId,inputAsset,outputAsset,nativeBalance,expectedOutput,minimumOutput,approvalAmount,next,transaction:null,capabilities,notes}`. Timestamps are Unix milliseconds. Amounts are decimal raw-unit strings or `null`. `next` is `fund`, `approve` or `trade`. `approvalAmount:'0'` means reset a nonzero insufficient allowance. No unlimited approvals. Expected output is `null` until funded and approved.
- `prepare`: same review, `status:'prepared'`, plus `simulatedAt`, `simulationBlock`, `gasEstimate`, `gasCostEstimate` (wei), and EIP-1193 `transaction:{from,to,chainId:'0x1237',value:'0x0',data,gas}`. It rechecks deployment, canonical Plugged launch, balance, allowance, the original minimum, and estimated native ETH gas coverage; returned balances/allowances reflect that simulation snapshot. No quote re-pricing or automatic slippage widening. Only this method releases calldata.
- `submit` / `status`: same review with `transaction:null`; status is `submitted`, `confirmed`, `cancelled`, `reverted` or `not_found` (temporary RPC propagation). A confirmed trade adds `actualOutput`, `blockNumber`, `blockHash`; an approval has no output. Confirmation requires exact sender/chain/destination/calldata/value, canonical receipt + two additional blocks, and for swaps exactly one matching `Traded` event. Recovery remains possible after review expiry because the router has no deadline.
- `capabilities` is always `{minimumOutput:true,onchainDeadline:false}`.

Persisted records use a unique transaction hash and survive a `TradingService` restart. Only unsigned `review` records older than 24 hours are pruned. Prepared records remain for recovery. The parent can add authenticated operational retention later; do not delete prepared recovery records merely because the review expired.

Replacement recovery verifies the same sender, chain and original nonce. A speed-up must preserve the exact original calldata and destination. A cancellation must send zero value with empty calldata to the same wallet. The original must not already have a canonical mined receipt. Hash history is retained. A replacement remains `submitted` until canonical +2 blocks; only a confirmed cancellation returns `cancelled` and unlocks the UI. If the original hash was never observed by the backend and has disappeared from the RPC, its nonce cannot be independently established: replacement recovery fails closed and requires an RPC that can retrieve the original. Never claim a pending/dropped hash was cancelled without evidence.

### Concrete wiring (parent owns these edits)

```js
import { TradingService, tradingErrorCode } from './lib/trading-service.mjs';
const trading = new TradingService({launchService});
// Existing POST/body/rate-limit handler:
// /api/trading/balances -> trading.balances(body)
// /api/trading/quote    -> trading.quote(body)
// /api/trading/prepare  -> enabled gate, then trading.prepare(body)
// /api/trading/submit   -> trading.submit(body)
// /api/trading/status   -> trading.status(body)
```

Keep `submit` and `status` usable when signing is disabled so previously sent transactions remain recoverable. Permit only those five routes; do not dynamically dispatch arbitrary object method names. Use the same `LaunchService` instance and SQLite database as discovery. Browser recovery storage is scoped by account + token. Call `invalidate()` on account/chain changes and `destroy()` before removing its root. Theme uses existing global tokens automatically; when language changes, call `invalidate()` to rerender. Add the screen to confirmed-coin details only. Include the new source modules in the parent-owned frozen build/export; the browser entry import makes bundling automatic.

The router at `0xd6edcd3cc28c40b42d6fe31b054ebb93a944a3a6` exposes `swap(PoolKey,bool,uint256,uint256,address)`. **It has a minimum-output check and no deadline argument.** Review expiry is application-side only; signed calldata does not expire on-chain. Never label it an on-chain deadline. Quotes execute this exact router using `eth_call`, including hook fees. Until the wallet holds and approves the input, output is unavailable, not fabricated; approval is exact-input-sized, with a zero reset when necessary. Requote after each approval. Native ETH funding remains a separate existing workflow.

Browser: import `tradingScreen` from `./trading.js`. Instantiate with `{wallet,connect,language,esc}` (same adapters as launch screen). Call `mount(root,coin)` with a DOM element and confirmed market coin (`coin.address`). Call `invalidate()` on wallet/network changes; `destroy()` before navigating away. The module binds only within its root and consumes the routes above.

**CSP integration update:** `web/trading.js` no longer inserts a `<style>` block. The parent owns the relocated `[data-plugged-trading]` rules in `web/style.css`; include that stylesheet in the frozen frontend. The standalone harness now enforces `Content-Security-Policy: style-src 'self'` and checks for CSP violations.

## Final JSON fixtures and schema for integrated browser tests

Canonical fixture source: **`test/trading-fixtures.mjs`**, exporting `tradingFixtures(now = Date.now())`. Its return value is plain JSON, includes full route responses and real ABI-encoded swap/approval calldata, and never reads the network. These are explicitly synthetic test fixtures; do not seed the production store or submit their transactions.

```js
import { tradingFixtures } from './test/trading-fixtures.mjs';
const f = tradingFixtures(Date.now()); // fresh expiresAt; regenerate per independent test
// Mount with f.coin; mock wallet account with f.requests.quote.account.
// Mock /balances -> f.balances; /quote -> f.quote; /prepare -> f.prepare.
// /submit -> f.submitted; /status -> f.confirmed (or a state below).
// Return JSON bodies directly, not {data: ...} or {result: ...} wrappers.
```

To emit the complete final JSON fixture document: `bun test/trading-fixtures.mjs`. For a saved fixture, redirect stdout into the external test-artifact directory. Use `tradingFixtures(fixedClockMs)` with a matching browser clock for deterministic expiry tests. Millisecond timestamps are numbers; raw amounts, nonce and block numbers are strings; only the wallet transaction's chain ID/gas/value are hex quantities.

Fixture document keys and route mapping:

| Fixture key | Response / scenario |
|---|---|
| `requests` | Complete request bodies for balances, quote, prepare, submit, status, replacement |
| `coin` | Confirmed-listing-shaped test descriptor for `mount(root, coin)` |
| `balances` | Both token balances, allowances and native ETH |
| `quote`, `prepare` | Funded/approved buy; `prepare` alone exposes calldata |
| `approvalQuote`, `approvalPrepare`, `approvalConfirmed` | Exact-input approval; no output quote before approval |
| `resetQuote`, `resetPrepare` | Insufficient nonzero allowance; approve zero first |
| `fundingQuote` | Insufficient input; output/minimum null, no signable transaction |
| `submitted`, `confirmed`, `reverted`, `notFound` | Transaction lifecycle; use `notFound` with HTTP 200 |
| `replacementPending`, `cancelled` | Same-nonce replacement; only confirmed cancellation unlocks review |
| `errors.gas`, `.expired`, `.rpc`, `.replacement` | Stable error code plus diagnostic English message; return non-2xx |

Exact request fixtures (addresses and IDs are synthetic):

```json
{
  "balances": {"token":"0x2222222222222222222222222222222222222222","account":"0x1111111111111111111111111111111111111111"},
  "quote": {"token":"0x2222222222222222222222222222222222222222","account":"0x1111111111111111111111111111111111111111","side":"buy","amount":"1","slippageBps":50,"reviewSeconds":60},
  "prepare": {"id":"11111111-1111-4111-8111-111111111111","account":"0x1111111111111111111111111111111111111111"},
  "submit": {"id":"11111111-1111-4111-8111-111111111111","txHash":"0xabababababababababababababababababababababababababababababababab"},
  "status": {"id":"11111111-1111-4111-8111-111111111111"},
  "replacement": {"id":"11111111-1111-4111-8111-111111111111","txHash":"0x1212121212121212121212121212121212121212121212121212121212121212","replaces":"0xabababababababababababababababababababababababababababababababab"}
}
```

Response schema for the browser-consumed contract (JSON Schema 2020-12). Extra backend evidence fields are permitted intentionally; response evolution must not remove these required fields. Route semantics additionally require `transaction` to be non-null only for a successful `/prepare`; confirmed swaps include `actualOutput`, approvals and cancellations do not. `minimumOutput` and `expectedOutput` are null while funding/approval is required.

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "oneOf":[{"$ref":"#/$defs/balances"},{"$ref":"#/$defs/review"},{"$ref":"#/$defs/error"}],
  "$defs":{
    "address":{"type":"string","pattern":"^0x[0-9a-fA-F]{40}$"},
    "hash":{"type":"string","pattern":"^0x[0-9a-fA-F]{64}$"},
    "raw":{"type":"string","pattern":"^[0-9]+$"},
    "nullableRaw":{"anyOf":[{"$ref":"#/$defs/raw"},{"type":"null"}]},
    "asset":{
      "type":"object","required":["address","symbol","decimals","balance","allowance"],
      "properties":{"address":{"$ref":"#/$defs/address"},"symbol":{"type":"string"},"decimals":{"type":"integer","minimum":0,"maximum":255},"balance":{"$ref":"#/$defs/raw"},"allowance":{"$ref":"#/$defs/raw"}}
    },
    "capabilities":{"type":"object","required":["minimumOutput","onchainDeadline"],"properties":{"minimumOutput":{"const":true},"onchainDeadline":{"const":false}}},
    "transaction":{
      "type":"object","required":["from","to","chainId","value","data","gas"],
      "properties":{"from":{"$ref":"#/$defs/address"},"to":{"$ref":"#/$defs/address"},"chainId":{"const":"0x1237"},"value":{"const":"0x0"},"data":{"type":"string","pattern":"^0x[0-9a-fA-F]+$"},"gas":{"type":"string","pattern":"^0x[0-9a-fA-F]+$"}}
    },
    "balances":{
      "type":"object","required":["account","token","quote","nativeBalance","blockNumber","blockHash","chainId","router","capabilities"],
      "properties":{"account":{"$ref":"#/$defs/address"},"token":{"$ref":"#/$defs/asset"},"quote":{"$ref":"#/$defs/asset"},"nativeBalance":{"$ref":"#/$defs/raw"},"blockNumber":{"$ref":"#/$defs/raw"},"blockHash":{"$ref":"#/$defs/hash"},"chainId":{"const":4663},"router":{"$ref":"#/$defs/address"},"capabilities":{"$ref":"#/$defs/capabilities"}}
    },
    "review":{
      "type":"object","required":["id","status","createdAt","expiresAt","account","token","side","amountIn","slippageBps","reviewSeconds","inputAsset","outputAsset","nativeBalance","expectedOutput","minimumOutput","approvalAmount","next","transaction","router","chainId","capabilities","notes"],
      "properties":{
        "id":{"type":"string","format":"uuid"},"status":{"enum":["review","prepared","submitted","confirmed","cancelled","reverted","not_found"]},
        "createdAt":{"type":"integer"},"expiresAt":{"type":"integer"},"account":{"$ref":"#/$defs/address"},"token":{"$ref":"#/$defs/address"},"side":{"enum":["buy","sell"]},
        "amountIn":{"$ref":"#/$defs/raw"},"slippageBps":{"type":"integer","minimum":0,"maximum":500},"reviewSeconds":{"type":"integer","minimum":30,"maximum":120},
        "inputAsset":{"$ref":"#/$defs/asset"},"outputAsset":{"$ref":"#/$defs/asset"},"nativeBalance":{"$ref":"#/$defs/raw"},
        "expectedOutput":{"$ref":"#/$defs/nullableRaw"},"minimumOutput":{"$ref":"#/$defs/nullableRaw"},"approvalAmount":{"$ref":"#/$defs/nullableRaw"},
        "next":{"enum":["fund","approve","trade"]},"transaction":{"anyOf":[{"$ref":"#/$defs/transaction"},{"type":"null"}]},
        "router":{"$ref":"#/$defs/address"},"chainId":{"const":4663},"capabilities":{"$ref":"#/$defs/capabilities"},"notes":{"type":"array","items":{"type":"string"}},
        "txHash":{"$ref":"#/$defs/hash"},"actualOutput":{"$ref":"#/$defs/raw"},"gasEstimate":{"$ref":"#/$defs/raw"},"gasCostEstimate":{"$ref":"#/$defs/raw"}
      }
    },
    "error":{"type":"object","required":["code","error"],"properties":{"code":{"type":"string","pattern":"^TRADING_[A-Z_]+$"},"error":{"type":"string"}}}
  }
}
```

Mock sequencing: quote → prepare happens during Review; clicking Sign calls prepare **again**, and the second calldata/destination must match the first exactly. After wallet approval confirmation the user must Review again; switch the fixture from approval to trade then. Confirmation stays pending until the mock changes to confirmed. Parent integration tests must distinguish a mocked wallet/API run from real chain verification.

## UI direction

Operate-mode extension of Plugged's established white/green system, native system typography, existing light/dark CSS tokens. Compact buy/sell form followed by an exact-unit trade receipt; on mobile the receipt stays in normal flow. No chart, market price or synthetic output is invented. The signature is the receipt distinguishing estimated output, enforced minimum, input approval and application-only expiry. No new UI dependency.

## Verification

- `bun test test/trading.test.mjs`: **24 pass, 0 fail, 95 assertions**. Input precision, bounds, buy/sell direction, no Carbon listings, reorged launch rejection, code drift, allowance reset, exact approvals, low gas balance, stale reviews, original minimum preservation, wrong chain/sender/calldata/value/recipient, missing/duplicate/below-minimum events, two-block confirmation, restart recovery, late mined swaps, same-nonce speed-up/cancellation, adversarial replacements, and JSON fixture serialization/ABI protection consistency.
- Read-only live RPC: chain **4663**, router **2,968 bytes**, code hash `0x67867a85f9694ba856fa05c374f588fb2b293127c5576424d7e35dc09f9b3246`, selector **0x84075c2c**, manager `0x8366a39CC670B4001A1121B8F6A443A643e40951`. First check block **102735787** / hash `0x690d7dc59ddc733ed4325e277a4a69439d5708d7cbf31e9a5d2e0a270411dbc2`.
- New pinned fork **102753831**: **6 pass, 0 fail, 0 skipped**. USDG (6), cbBTC (8), WETH (18), AAPL (18) each launch locally, buy, reject minimum above quote, sell, reject sell minimum above quote, compare received balance deltas and empty router residuals. Additional tests reject missing approval and demonstrate that the exact swap calldata still executes **one week later** (no on-chain deadline). AAPL registry setup was local-fork-only.
- `node test/trading-browser.mjs`: **25 checks**, **0 runtime errors, 0 CSP violations** with `style-src 'self'`. Connect with empty amount, exact balances, buy/sell, adjustable slippage/review validity, changed-input invalidation, funding empty state, reset/exact approval, rejection, changed calldata, unavailable storage, wrong chain, expiration, localized API failure including specific Spanish gas recovery, stale-response discard, remount recovery, navigation during signing, manual hash recovery, verified cancellation, retained hash after lookup failure, restored direction-select focus, explicit unsent recovery clearing and empty/destroyed screens.
- Automated accessibility: **8 combinations × 94 rules** (390×844 and 1440×1000; light/dark; EN/ES), **0 violations, 0 skipped rules**. No horizontal overflow in any captured state. This is automated coverage, not a human screen-reader/WCAG certification.
- Actual component standalone minified browser bundle after inline-style removal: **91,634 bytes**, reusing installed viem and existing CSS; no added dependency. Parent bundle composition can differ.
- Standalone backend `bun build lib/trading-service.mjs --target=bun --minify`: successful, **418 modules**, reported bundle **142.11 KB**. Output stayed in the external evidence directory.
- Screenshot critique/fix loop corrected the stale “connect and refresh” message after successful quotes and reduced the review button to secondary once signing is available. Both changes were retested. Design detector returned `[]`.
- Initial fork attempt at 102735787 failed because public RPC had already pruned state. Capturing a new explicit pin and immediately running the cached compilation produced the passing result above. Exact historical replay needs an archive RPC. Initial Solidity address-checksum typo was fixed before verification. WSL's installed `forge` wrapper invokes Windows `forge.exe` and did not forward per-command environment assignments; the successful run invoked that same executable with PowerShell environment variables. Compiler: **Solc 0.8.26, cancun**.

Replay from `plugged/contracts`:

```powershell
$env:FOUNDRY_TEST='../test'
$env:TRADING_FORK_BLOCK='102753831'
# Set PLUGGED_RPC_URL to an archive-capable Robinhood RPC for this historical pin.
forge test --match-contract PluggedTradingForkTest -vv
```

`test/trading-live.mjs` performs read-only pin verification. `test/trading-browser.mjs` owns a temporary loopback standalone harness, bundles the actual component into the evidence directory, and writes screenshots/results outside the checkout under `%LOCALAPPDATA%/Temp/opencode/plugged-trading`. It never starts the parent server or modifies shared build outputs. Run this harness with **Node**, not Bun: Bun's Windows Playwright Chromium launch stalled on this machine; Node completed the same harness. Playwright and AccessLint paths can be supplied through `PLAYWRIGHT_MODULE`, `CHROME_PATH`, `ACCESSLINT_ENGINE`; output through `TRADING_EVIDENCE_DIR`.

Artifacts: `trading-{390,1440}-{light,dark}-{en,es}.png`, `trading-390-dark-es-approval.png`, `trading-390-dark-es-recovery-error.png`, `trading-390-dark-en-sell.png`, `browser-results.json`. Every screenshot visibly labels simulated wallet/local test fixtures. No synthetic assets or listings ship in product code. The independent finish review found missing replacement recovery, untranslated specific server errors, and recovery/focus loss. All three were implemented with focused regression tests. The verdict pass scored **all three resolved** and returned **SHIP for the scoped local component**, after inspecting all 11 updated screenshots and the changed implementation. It did not independently rerun tests or certify parent integration/mainnet/human screen-reader operation.

## External boundaries

- Parent must wire the routes, signing gate, detail-screen lifecycle and frozen export. Standalone verification does not establish parent integration.
- No mainnet trade was broadcast. Fork wallets and browser fixtures are test-only.
- The deployed router has no on-chain deadline. The UI states this explicitly; review expiration cannot revoke an already-signed transaction.
- Funding with native ETH is separate. No funding swap or bridge was added to trading.
- Trading is limited to already-confirmed Plugged records. All 469 configured quotes do not become listings or imply approval. The 438 pending registry approvals still require the actual registry owner.
- No independent third-party audit or production-readiness claim is made.

Sources: read-only `contracts/src/TradeRouter.sol`, `app/src/lib/tradeTx.ts`, existing deployment snapshot and the live fork behavior above. Explorer: https://robinhoodchain.blockscout.com/address/0xd6edcd3cc28c40b42d6fe31b054ebb93a944a3a6 . Blockscout API source retrieval returned HTTP 403; runtime hash and actual pinned-fork calls are the verification evidence, not an assumed explorer response.

Web interface guideline source reviewed: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md . Component uses native controls, scoped handlers, live status/error announcements, visible inherited focus rings, full-precision string token units, locale-aware review time, and no decorative animation. The parent owns the surrounding landmarks, navigation and route URL.
