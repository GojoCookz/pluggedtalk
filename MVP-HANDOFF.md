# Plugged — Carbon-backed launch MVP handoff

Updated 2026-10-31 UTC. This supersedes the earlier planner-only handoff. Plugged now
prepares and submits wallet-signed launches to the existing Carbon Robinhood engine.
No replacement launcher contract is required. No mainnet transaction was broadcast during
implementation or verification.

## 1. Start the portable package

Install Bun (tested with 1.3.9): https://bun.sh. Extract the entire archive and run:

```sh
bun run start
```

The bundled backend and frozen frontend work without dependency installation. Open
http://localhost:4317/#create. For source development:

```sh
bun install --frozen-lockfile
bun test test/
bun run build
bun run dev
```

The archive pins viem 2.56.0 and includes the three Carbon frontend helpers it reuses.
Foundry dependencies and their licenses are vendored. In the original Hood workspace,
those dependencies are reused from sibling directories instead.

Copy `.env.example` to `.env`. To permit wallet transactions, set
`PLUGGED_LAUNCH_ENABLED=true`. Configure `PLUGGED_RPC_URL` for Robinhood chain 4663.
`PLUGGED_DB_PATH` defaults to `runtime/launches.sqlite` beside the server; mount that
directory on persistent storage. A server signing key is neither needed nor accepted.
Restart the server after changing environment values or regenerating pair snapshots.

### Ownership and the Merc handoff

The separate Plugged deployment is planned under the locally configured signer for now.
That choice is stored only in `runtime/deployment-owner.json`, which is ignored by Git and
excluded from every handoff archive. This records the intended owner; it does not transfer
ownership or deploy contracts. The current preview still references the existing Carbon engine.

The package includes `deployment-owner.example.json` with **blank owner and platform-recipient
addresses**. Merc can copy it to `runtime/deployment-owner.json` and supply the public addresses
for his own deployment. The exporter refuses to package a template with either address filled.
No private key, password, populated environment file, local ownership plan or keystore is included.

Whoever controls the chosen deployment wallet can authorize deployment and pay its gas. The
original developer is not required to make Merc's deployment live. If the existing local signer
is used instead, its controller must authorize those transactions. A hosted Bun service needs
neither wallet's private key: users sign their launches in their own wallets.

An independent Plugged owner requires a separate deployment of the Carbon engine contracts and
verification of the resulting addresses and code hashes before connecting this backend to them.
The existing Carbon registry's owner cannot be replaced by editing this JSON. The owner template
is a deployment-planning input, not an executable deploy script or a runtime address override.

## 2. What works

- `#create`: live launch form, wallet connection, current USD conversion, quote selection,
  image CID, opening purchase, fee and creator/holder split, simulation and signing.
- $2,500 USD opening target; Carbon's exact tick arithmetic discloses the rounded result.
  Default milestone is $40,000; this is not a pool migration.
- Native ETH funding through LI.FI, then quote-token approval, then Carbon launch. These
  are separate transactions. A launch failure does not reverse the funding swap.
- Funding calldata is decoded and bound to chain, recipient, input, output and minimum.
  Only the pinned official native-to-ERC20 LI.FI facet is accepted, with gas simulation.
- Allowances are limited to the opening purchase. Existing insufficient nonzero allowances
  reset to zero first. Launch calldata is offered only after funded-wallet simulation.
- Durable prepared/submitted/confirmed records in SQLite; submitted launches reconcile
  after restart. Wallet transaction hashes survive browser reload.
- Listings require exact sender, engine, calldata, event economics, predicted token and
  canonical receipt with two additional blocks. Existing Carbon launches are not imported.
  Dexscreener only enriches confirmed records matching the exact pool and quote.
- Light/dark and English/Spanish. `#planner` retains post-MVP planning features separately.

## 3. Current Carbon pair setup — remaining owner action

All **469 ERC-20 addresses** are configured. Latest complete snapshot: **31 approved,
438 awaiting registry approval, zero read/decimal failures**. Native ETH is funding input,
not an additional Carbon ERC-20 quote.

- Registry: `0xdff0a6ffd11eb1494e8a57dd5ef92b23122baec0`
- Required owner: `0xeFd515Fc021f281f12Da5dF64cAafF9Aa3077868`
- `data/carbon-pairs.json`: every address, decimals, checked block and unsigned approval.
- `GET /api/engine/pairs`: the same operator manifest.

Refresh it with `bun tools/check-carbon.mjs`. The owner signs each remaining
`approvePairWithoutOracle(address,uint8)` transaction from `pairs[].setupTransaction`.
The manifest is unsigned; publishing it does not authorize any pair. Recheck owner,
network and token behavior before signing. Rerun the check afterward and restart the server.

For a Foundry keystore, a single approval has this shape (replace the placeholders):

```sh
cast send 0xdff0a6ffd11eb1494e8a57dd5ef92b23122baec0 \
  'approvePairWithoutOracle(address,uint8)' TOKEN_ADDRESS TOKEN_DECIMALS \
  --account YOUR_OWNER_KEYSTORE --rpc-url YOUR_ROBINHOOD_RPC
```

The application rechecks the selected pair at preparation time. Approval does not
guarantee a USD price, ETH route or unrestricted ERC-20 transfers. Unsupported cases fail
explicitly. The full-catalog readiness endpoint remains false until approvals are complete;
approved pairs can already use the enabled launch flow.

## 4. Existing-engine economics and limits

The live hook takes **100 bps (1% of volume)** for its platform recipient. Total trading
fee must be **above 100 and at most 1,000 bps**. The default is 200 bps (2%). Creator and
holders divide the remaining fees. These are Carbon's actual deployed rules, not the
earlier planner's proposed 30-bps platform model. The existing platform recipient is
`0x6E87800BEDf09ddA439Ae78c820c58427Ca57947`; this integration does not redirect treasury fees.

The ordinary wallet cap is 3%, with Carbon's existing exemptions. Plugged bounds the creator
purchase to at most 2% of the submitted opening FDV, below the ordinary 3% wallet limit.
It does not change Carbon bytecode. The live launcher predates the source's `minDevBuyFor`
getter; Plugged applies its own decimals-aware dust floor and relies on actual simulation.

Carbon has no launch deadline or minimum token-output argument. The UI invalidates expired
reviews and changed wallets/forms, but cannot make already-signed calldata expire on-chain.
USD values are fresh provider responses, not timestamped on-chain oracles or guaranteed pegs.

Anti-copy checks reject an already-confirmed Plugged name + ticker + economic identity;
different economics are allowed. This is application-level enforcement, not a global
on-chain prohibition. Concurrent/out-of-band transactions cannot be prevented by this
backend; duplicate confirmed identities are excluded from discovery. No referrer is sent.

One pair and one creator-fee wallet per live launch. Multi-recipient splitters, social
onboarding, hybrid pools, fundraising, refunds and cashback remain post-MVP. Image CID
input works; automatic image upload/pinning is not included. Public trading/claim controls
are not part of this launch MVP, although deployed-engine buy/sell paths were fork-tested.

## 5. API and storage map

```text
Browser → POST /api/launches/prepare → live checks / USD conversion / simulation
        → POST /api/launches/funding → decoded native ETH funding quote
        → wallet signs approval or launch
        → POST /api/launches/submit {id, txHash} → exact transaction verification
        → POST /api/launches/status {id} → receipt / confirmation
SQLite  → 15-second reconciliation worker → confirmed Plugged listings
```

`lib/carbon-abi.mjs` matches Carbon's positional launch tuple. `carbon-helpers.ts` reuses
Carbon's CID and tick code. `launch-service.mjs` is the engine adapter; `launch-store.mjs`
owns persistence; `funding-service.mjs` validates LI.FI calls. `server.ts` binds loopback,
serves frozen assets and enforces body/rate limits. Put a stable HTTPS reverse proxy in
front for deployment. Back up SQLite using its backup API (include WAL consistency), and
verify restores. Use one service instance per SQLite database.

If a wallet broadcast succeeded but browser reporting failed, retry **Check confirmation**.
For a missing hash, open **Recover a sent launch** and paste the actual wallet transaction
hash. The saved preparation ID is checked against the transaction. The equivalent API is
`POST /api/launches/submit {id, txHash}`. No replacement launch is needed.

## 6. Verification

Application, browser and automated accessibility reports are included in `evidence/`.
Browser signing tests use an explicitly simulated wallet; they are not mainnet broadcasts.
Public HTTPS launch preparation was also exercised against real RPC and LI.FI pricing.

Pinned Robinhood fork **102239693**: **five passing tests**, no skips:

- USDG (6 decimals): launch → buy → sell.
- cbBTC (8 decimals): launch → buy → sell.
- Bridged WETH (18 decimals): launch → buy → sell.
- AAPL stock: owner approval on the local fork only → launch → buy → sell.
- Native ETH → USDG: actual LI.FI calldata delivers at least its encoded minimum output.

Replay with Foundry and an archive-capable RPC. To generate a fresh pin:

```sh
bun tools/check-carbon.mjs
bun tools/carbon-fork-fixtures.mjs
cd contracts
PLUGGED_FORK=true forge test --match-contract CarbonForkTest -vv
```

On PowerShell, set `$env:PLUGGED_FORK='true'` before `forge test`. Default contract tests
skip the five network-dependent fork tests unless this flag is set. Public RPC prunes old
state; use an archive RPC to reproduce the historical pin exactly.

## Sources

- Carbon launcher: https://robinhoodchain.blockscout.com/address/0xcc491f9962ca5545163ac425210b69e24ac29a96
- LI.FI deployment: https://github.com/lifinance/contracts/blob/main/deployments/robinhood.json
- LI.FI swap ABI: https://github.com/lifinance/contracts/blob/main/src/Facets/GenericSwapFacetV3.sol
- LI.FI quotes: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer

Earlier `HANDOFF.md`, product research and program designs are historical/post-MVP context.
This document and `MVP.md` define the implemented launch scope.
