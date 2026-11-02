# Robinhood quote-asset index

Run `bun run tools/index-assets.mjs`, then `bun run build` and restart the preview backend.
The index is persisted in `data/assets.json`; `data/quotes.json` is the derived, code-and-
decimals-checked draft-selection list. The frozen build and backend share this snapshot.
Nothing here populates Plugged's launch market.

## Measured snapshot

- **203** unique Robinhood issuer-listed stock deployments on chain **4663**.
- **31** Carbon quote-address references, including stock references excluded by Carbon's UI.
- **357** LI.FI token-list entries imported, excluding the native-ETH sentinel.
- **469** unique assets after address deduplication; contract code checked for all **469**.
- **365** unique provider-reported pools, after querying all **469** indexed assets.
- **193** of those pools contain at least one issuer-listed stock address.
- Source/API errors: **0** in the final run. These counts are a snapshot, not fixed constants.

## Sources and evidence

- Issuer: https://api.robinhood.com/rhj/assets — complete returned `assets[]`, selecting
  `deployments[].chainId === 4663`. No pagination fields observed. This establishes inclusion
  in the current issuer response, not every historical issuer token or live trading pool.
- Carbon: `app/src/lib/networks.ts:ROBINHOOD_DEPLOYMENT`, referencing the same source used
  by `app/scripts/index-hood-tokens.mjs`. Commented pending approvals are not imported.
- LI.FI: https://li.quest/v1/tokens?chains=4663 — candidate discovery, not bridge attestation.
- Pools: `https://api.dexscreener.com/tokens/v1/robinhood/{addresses}` — batches of 30,
  chain and token-address matching, deduplicated by pool address/ID. Provider coverage is
  not a complete factory-event index. Both quote and base addresses are retained.
- RPC: https://rpc.mainnet.chain.robinhood.com — chain checked before reads. Code, decimals
  and Carbon registry approval are separate fields. Approval does not establish issuer
  authenticity, backing or Plugged transaction authorization.

The public RPC rejected historical state at its finalized block. The final verification
therefore uses **latest-state observations over a recorded block interval**, explicitly
not an atomic/finalized snapshot. Failed reads remain unknown and generate warnings.
Final interval: **102107192–102107323**, indexed **2026-10-30T23:21:17.369Z**.
Code and expected decimals were verified for all **469** unique assets.

## Wormhole coverage is incomplete

Official documentation lists Robinhood Core at
`0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB`:
https://wormhole.com/docs/reference/contract-addresses/

Core is not Token Bridge. The inspected official SDK Token Bridge registry contained no
Robinhood entry:
https://raw.githubusercontent.com/wormhole-foundation/wormhole-sdk-ts/main/core/base/src/constants/contracts/tokenBridge.ts

No authoritative complete Robinhood Wormhole asset enumeration was established. **Zero
assets are labeled Wormhole-verified.** LI.FI entries and Carbon synth descriptions are
not substituted for proof. The interface exposes bridge-list candidates with this limit.

To close coverage, authenticate the relevant Token Bridge or NTT deployment, enumerate its
deployment/events through a recorded head, and verify origin-chain/native-contract mappings
against the bridge. Reconcile the entire scan before claiming all Wormhole assets. NTT
issuer/transceiver evidence is distinct from Wrapped Token Transfer mappings.
