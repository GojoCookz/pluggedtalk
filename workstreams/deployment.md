# Independent deployment workstream

## Profile loader API (integration contract)

`plugged/lib/deployment-profile.mjs` exports:

- `loadDeploymentProfile({ profilePath, baselinePath } = {})`: async; omitted `profilePath`
  loads the current pinned `data/carbon-deployment.json` as `carbon-baseline-v1`. An explicit
  profile must have schemaVersion 1, status `deployed`, chainId 4663, valid nonzero owner and
  platform addresses, complete deployment addresses and runtime code hashes. Simulation and
  template files cannot activate runtime. Returns normalized profile with `verified: false`.
- `validateDeploymentProfile(input, { allowSimulation = false } = {})`: synchronous schema
  validation; capabilities are derived from engine ID, never accepted as arbitrary flags.
- `verifyDeploymentProfile(profile, { client, blockNumber } )`: async, read-only viem public
  client; checks chain, all code hashes, immutable links, hook flags, fees, registry owner and
  platform recipient at one pinned block. Returns a verified copy plus `verifiedBlock`.
- `deploymentCapabilities(engine)`: returns immutable capability description. Baseline is
  Carbon ABI/legacy wallet exemptions; enhanced is a separate factory ABI with strict token
  policy and atomic canonical identity. Never point the baseline launch encoder at enhanced.
  Includes `maxPools` (1/4), `poolAllocation` (`single-pool`/`equal-supply`), `maxRecipients`
  (1/100), `creatorNamespacedSalt`, `strictWalletCap`, `atomicDuplicateRejection`, `multiPool`,
  `multiRecipient`, `maxWalletBps` and the exact `launchAbi` identifier.
- `validateDeploymentOwner(input)`: validates owner-plan public addresses and chain; accepts
  `ownerAddress` / `platformRecipientAddress`, rejects missing/zero/known-compromised addresses.

Runtime integration must await verification before allowing transactions. Verification does
not write the pinned baseline manifest. A JSON edit cannot change any existing immutable link.
Pass the loader's returned object directly to verification: the legacy fallback's trusted
in-memory identity intentionally does not survive arbitrary spread/JSON round trips. Explicit
independent profiles are ordinary serializable manifests and always receive the full checks.

## Implementation scope

Existing Carbon sources are read-only dependencies. Independent baseline deploys a fresh
registry, token implementation, mined hook, launcher and router. No referrals are configured;
the hook pays the chosen platform recipient directly. Owner is supplied to the registry's
constructor, so deployer and registry owner may differ without any transfer transaction.

Enhanced contracts are separate new `PluggedAdvanced*` sources. Program contracts and `CarbonFork.t.sol`
remain unchanged. Local intended-owner plan is never rewritten; Merc templates stay blank.

### Advanced integration API

Select `--engine plugged-advanced-v1` for independent advanced preflight/simulation. Its
entrypoint is `script/DeployPluggedAdvanced.s.sol:DeployPluggedAdvanced` with the same
`run(address,address,address)` signature. The nonce sequence is registry `n`, strict token
implementation `n+1`, MultiDeployer satellites `n+2`, CREATE2 hook transaction `n+3`, factory
`n+4`, trade router `n+5`. The factory constructs its identity registry internally at nonce 1.
Profiles add `factory` (equal to `launcher`), `launchRegistry` and `satellites` addresses/hashes.
Verification binds `factory.registry()`, `factory.deployer()` and `launchRegistry.FACTORY()`.
CREATE nonce provenance is also validated when present. Scripts now emit the hook init-code
hash so verification can reconstruct the CREATE2 address from its salt and canonical proxy.

The enhanced launch ABI and contract semantics are in `contracts/ADVANCED-API.md`.
`launch(LaunchParams)` returns `(address token,uint8 priceableMarkets)`, **not** Carbon's
`(address token,bytes32 poolId)`. Use `poolsOf(token)` for all pool IDs. Salt prediction is
creator-namespaced: `predictTokenAddressFor(address creator,bytes32 salt)` is the third-party
preparation view. Quote allowances target the factory. The factory computes the economics
hash itself; planned off-chain program metadata is not an arbitrary on-chain hash input.
The deployed token's name and symbol are canonicalized too (ASCII uppercase, collapsed name
whitespace), so receipt/display reconciliation must not expect the original input casing.

Each approved quote receives an equal supply slice; one to four unique quotes are supported.
This is not arbitrary weighted multi-pool allocation. Creator-fee shares use a separate
immutable splitter per quote; holder dividends remain balance-weighted streaming ledgers.
Raw supply must divide evenly by the selected market count. Each market's
`openingMarketCap`/`graduationThreshold` is denominated in that quote's base units against
the **slice supply**, not full token supply. For a shared full-token FDV target, derive each
slice target before quote conversion; do not submit the full FDV independently to every pool.
The strict cap is 300 BPS, including creator and vesting holdings, with only fixed protocol
addresses exempt. The advanced ledger is local and separate; no existing Carbon bytecode changes.

The advanced factory currently exceeds Ethereum's 24,576-byte EIP-170 ceiling but fits
Robinhood Nitro's 98,304-byte runtime ceiling. This is a Robinhood-specific deployment, not
an Ethereum-ready artifact. Foundry 1.5.1's `forge build --sizes` still exits nonzero against
EIP-170 despite `code_size_limit = 98304`. Use `forge build` followed by
`bun tools/deployment-sizes.mjs` for the explicit Robinhood runtime/init-code gate; the report
also flags Ethereum incompatibility rather than concealing it.

Parent packaging integration: these contracts import the existing Carbon source through
`carbon/=../../contracts/`, plus its current v4/OpenZeppelin/forge-std dependencies. A portable
Foundry package must vendor that source and adjust remappings, not include only Plugged's
`src/` and dependency libraries. The runtime profile loader itself uses the existing viem
dependency path, matching the rest of Plugged's bundled backend.

## Baseline operator commands

Run from `plugged/` with Bun and Foundry available. No package installation is required.
Use public addresses, never a signing key. `runtime/deployment-owner.json` is read only.
The current local file retains its intended owner and a blank platform recipient; the latter
must be explicitly supplied before preflight succeeds. Example variables below are inputs,
not addresses selected on the operator's behalf.

```sh
bun tools/deployment.mjs plan --owner-plan runtime/deployment-owner.json \
  --deployer "$DEPLOYER_ADDRESS" --platform-recipient "$PLATFORM_RECIPIENT"
bun tools/deployment.mjs simulate --owner-plan runtime/deployment-owner.json \
  --deployer "$DEPLOYER_ADDRESS" --platform-recipient "$PLATFORM_RECIPIENT" \
  --out runtime/baseline-simulation-NEW.json
bun tools/deployment.mjs verify --profile runtime/baseline-simulation-NEW.json \
  --out runtime/baseline-deployed-NEW.json
bun tools/deployment.mjs pairs --profile runtime/baseline-deployed-NEW.json \
  --pairs data/carbon-pairs.json --out runtime/pair-approvals-NEW.json
```

The `verify` command will fail for a simulated deployment until those exact contracts actually
exist on the chosen chain. It promotes a simulation into a separate runtime file only after
all live checks pass. Output paths must be new files under ignored `runtime/`; overwrite and
owner-plan destinations are refused. Neither the pinned Carbon manifest nor owner plan is an
output. `pairs` rechecks the owner, bytecode, quote decimals and registry cache at one pinned
block, then produces unsigned `approvePairWithoutOracle` transactions. It never signs them.

`simulate` uses Foundry's normal RPC simulation, pinned to the preflight block. It reserves
the launcher at `n+3`: registry `n`, implementation `n+1`, CREATE2 transaction `n+2`, launcher
`n+3`, router `n+4`. Carbon's original referral-vault deployment used `n+4`; copying that
offset after removing the vault would be incorrect. Every predicted address is asserted.
The canonical PoolManager hash and exact CREATE2 proxy runtime are checked before deployment.

For a later separately authorized deployment, the executable entrypoint is
`contracts/script/DeployPlugged.s.sol:DeployPlugged`, signature
`run(address owner,address platform,address deployer)`. Use Foundry's encrypted keystore or
hardware wallet with `--sender` matching the third argument. Simulate and inspect first; adding
Foundry's `--broadcast` is a separate operator action. This workstream does not perform it.
Never reuse an old nonce reservation after another deployer transaction. The script emits a
`simulated` manifest even when an operator later broadcasts, requiring independent verification.

Baseline is a fresh deployment of the repository's current Carbon source, not a claim that
its bytecode equals the older live deployment. The deployer retains Carbon's one-shot optional
referral/converter initializer authority; runtime verification rejects any such wiring for
this independent profile. The registry owner controls only admission of future quote assets.
Source hash manifests are operator trust inputs: comparing live bytes to a manifest proves
the match, not the trustworthiness of a manifest supplied by an arbitrary third party.

### Toolchain coverage limitation

The installed WSL `forge` command wraps Windows `forge.exe` 1.5.1 rather than a Linux binary.
Builds, tests and deployment simulations execute successfully through it. Coverage currently
fails: including the deployment script hits a minimum-IR Yul stack limit; excluding that script
gets past compilation but Foundry's Solar coverage resolver fails on mixed Windows path
separators in dependency imports. No coverage percentage is claimed from those failed runs.
Use native Linux Foundry for the coverage release gate; no toolchain replacement was installed.

## Executable baseline checks already run

- `bun test tools/deployment.test.mjs`: 11 passed, including malformed owners, wrong chain,
  altered code/address/permission manifests, all immutable links, pending ownership, unsupported
  optional wiring, quote-decimal mismatch, duplicate quotes and forbidden CLI switches.
  A follow-up read-only reviewer found a manifest-controlled legacy-exemption bypass, missing
  denylist checks and dropped deployment provenance. All three were fixed and regression-tested.
  Legacy exceptions now require the loader's in-memory identity and exact pinned Carbon addresses;
  copying a manifest and setting `independent:false` cannot disable checks. Promoted profiles retain
  deployer address, starting nonce and hook salt. Denied quotes fail explicitly; approval alone
  cannot remove registry denial.
- The advanced verifier additionally checks both factory/token `MAX_WALLET_BPS() == 300`,
  the factory's identity registry and satellite deployer, and the registry's immutable factory.
- `DeploymentOwnershipTest`: 6 passed in the final full run,
  including 10,000 unauthorized-caller fuzz runs. These ownership transitions are local tests.
- Baseline regression excluding the network-only historical `CarbonForkTest` and the parallel
  enhanced work: 41 tests passed, zero failures/skips. Existing splitter, cashback and campaign
  stateful invariants each executed 256 runs × 64 calls (16,384 calls per invariant).
- `bun tools/deployment-check.mjs`: live read-only verification at Robinhood block 102755124;
  all six pinned code hashes and their immutable links matched. Registry owner remained
  `0xeFd515Fc021f281f12Da5dF64cAafF9Aa3077868`; no existing ownership was changed.
- Baseline CLI simulation pinned at block 102744233 completed all five deployment transactions
  locally. Estimated gas: 17,678,071; estimate at 0.040000001 gwei: 0.000707122857678071 ETH.
  Test deployer/platform were explicit disposable public fixture addresses, not live choices.
  The simulation manifest cannot activate runtime and has no keys.

## Review scope

This is an implementation self-review, not an independent audit or certification. Tests target
deployment ownership/choreography, immutable-link and code-hash verification, duplicate races,
wallet-cap exemptions and accounting. Full EthTrust conformance and independent external audit
are not claimed. Mainnet broadcasts and ownership transfers are outside this workstream.

Compiler: Solidity 0.8.26, Cancun, via-IR, optimizer 200 runs, no bytecode hash/CBOR metadata;
the exact settings are in `contracts/foundry.toml`. Existing installed OpenZeppelin and Uniswap
sources are reused, with no dependency additions or edits. Code-hash manifests include deployed
immutables; their hashes therefore differ when launcher/hook constructor links differ.

## Final verification and remaining live blockers

Final `forge build` succeeded. `forge test --no-match-contract ForkTest -vv` passed **70 tests
across 12 suites, zero failures/skips**. The separate advanced fork passed at **102855166**,
giving **71 passing contract tests across those runs**. The five historical, read-only
`CarbonForkTest` tests were not rerun by this workstream. Both advanced fuzz tests ran 10,000
cases; both advanced invariants ran 256 × 64 = 16,384 calls each. The extra integration tests
exercise two funded callers racing the same identity in both orderings (loser uncharged and
unreserved), and a successful three-market launch with correctly divisible raw supply.

The **11 passing JavaScript tests** cover both profile families, legacy-exemption tampering,
CREATE provenance, every immutable-link mismatch, code/address/hash checks, strict cap getters,
denied quotes and a complete **469-quote synthetic approval fixture** with exact per-quote
decimal/calldata correspondence. That fixture is a local test, not live quote approvals.

Two additional self-review findings were fixed and tested:

1. Admission-only `capToleranceBps` no longer changes economic identity. Single-market,
   unpriced multi-market and priceable multi-market regressions reject tolerance-only copies.
2. New `PluggedAdvancedFeed` and `PluggedAdvancedSplitter` expose permissionless
   `recoverStuckFees()` from their immutable hook. A temporary quote blacklist can no longer
   permanently strand Carbon's deferred recipient liabilities. Tests cover positive deferrals,
   rollback, fixed recipients, conserved funding, double claims and callback reentrancy.

The advanced ledger also fixes a separately reproduced Carbon magnified-stream dust
double-counting issue locally. Its negative control exercises the unchanged Carbon ledger.
These are new deployments only; existing Carbon instances receive none of these fixes.

Final advanced deployment simulation at **block 102865460** completed the six-transaction
choreography, including the internal identity-registry creation and reconstructed CREATE2
provenance. Estimated total gas: **22,663,975**, costing **0.000913811494663975 ETH** at the
simulation's **0.040320001 gwei** estimate. This is deployment gas, not per-launch gas.
The final factory is **29,016 runtime bytes / 32,210 init-code bytes**. The explicit Robinhood
size gate passed for all **13 named artifacts**, including both recovery adapters. Baseline
five-transaction simulation also passed. No transaction was broadcast.

Evidence is under ignored `artifacts/deployment-*.log`, `runtime/deployment-*-*.json` and
`runtime/broadcast/*/4663/dry-run/`, plus the advanced test log paths recorded in
`contracts/ADVANCED-API.md`. The latest live baseline read-only check at **102846175** still
matched all six original code hashes. Final file inspection confirmed the locally intended
owner unchanged and its platform recipient still blank. Both Merc templates remain blank.

Before live activation, the operator still needs a chosen platform recipient, an authorized
funded deployment signer, actual independent deployments, successful live manifest promotion,
and quote-owner approvals. The parent integration must use the explicit advanced ABI/profile
and equal-slice economics described above. Native-Linux coverage, broader scanners and an
independent external audit remain unperformed; this work is not a mainnet security sign-off.
