# Carbon-backed launch MVP

Scope confirmed by the user on 2026-10-31: reuse Carbon's working Robinhood launch
engine. Complete launch preparation, pair configuration, wallet transactions and confirmed
Plugged listings. Social onboarding, campaigns, cashback and other extended programs are
post-MVP; their absence must not block a standard wallet-recipient launch.

The existing Carbon contracts remain unchanged. Plugged uses a backend adapter and records
only launches prepared through Plugged and independently confirmed on-chain. It does not
import the existing Carbon launch list. Production deployment of new money contracts is
not required for this integration.

The live contract is the authority on fees, approvals and supported parameters. Carbon's
ERC-20 launch path requires an opening purchase in the selected quote token. Native ETH
is funding input, not an ERC-20 quote; do not pretend Robinhood's bridged WETH supports
`deposit()`. Funding and launch are separate wallet transactions in this MVP.

All configured ERC-20 addresses are included in the operator's registry-setup manifest.
An entry in JSON cannot replace the registry owner's approval transaction. Unsupported
token behavior, missing prices or absent liquidity must fail explicitly rather than
produce fabricated quotes. No user-facing eligibility button is required.

Live preparation uses a current $2,500 USD conversion, reads deployed fee constraints,
builds the exact Carbon ABI, verifies balances/allowances and simulates before signing.
The launch confirmation identifies creator, exact calldata, factory, receipt and emitted
token. Only confirmed transactions enter discovery. Database state survives restarts.

The existing core has tick-rounded opening prices and an opening-delivery wallet-cap
exemption. Plugged bounds its opening purchase and checks the simulated result; do not
claim that a frontend policy changes Carbon's bytecode or enforces global anti-copy rules.

Implementation and verification progress are recorded in the deployment report and tests.
