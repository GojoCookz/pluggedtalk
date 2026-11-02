---
name: Plugged — coins and their people
description: A light-first green market board with a readable fee-allocation receipt.
---

# Plugged design system

## Authority and purpose

The Telegram brief pins white/green, light/dark modes, languages, iOS-like clarity and
early pump.fun simplicity. This is a distinct Plugged surface, not a reskin of Carbon's
dark-first gem identity. Discovery opens with coins; creation explains recipients before
any future transaction. The current product boundary is defined in PRODUCT.md.

## Tokens used by the implementation

| Role | Light | Dark |
|---|---|---|
| Canvas | `#f5f7f6` | `#101713` |
| Surface | `#ffffff` | `#19231d` |
| Primary text | `#14241c` | `#eff6f1` |
| Secondary text | `#56665d` | `#aabbb0` |
| Divider | `#dce4df` | `#34483b` |
| Strong border | `#95a79b` | `#6f8e7a` |
| Action green | `#087b46` | `#6be3a4` |
| On-green | `#ffffff` | `#10241a` |
| Mint surface | `#e7f6ed` | `#223c2d` |
| Error | `#b33131` | `#ff9c9c` |

Native system body typography, rounded system display fallback, and monospace addresses
avoid font downloads. Body size is 15px with 1.5 line height. Page headings are 30px desktop,
27px mobile; form controls use 16px on mobile. Cards use 16px corners and controls 10px.
Primary spacing is 24px desktop and 16px mobile; content width is capped at 1240px.

## Composition and behavior

- Desktop: top task navigation, compact source/status strip, coin board and a quiet fee
  explanation rail. At 1440px the board has three columns. Mobile: one column at 390px,
  fixed bottom task navigation and sufficient bottom content padding.
- Create: numbered recipient rows alongside a live fee-allocation receipt; receipt moves
  below the form on mobile. New draft is explicit. Save, export, edit and delete are
  separate actions; changing drafts protects unsaved edits.
- The receipt distinguishes holder rewards from the creator-recipient pool. Recipient
  percentages apply to that pool, not trading volume. Deployment status remains visible.
- Token cards use deterministic address identicons, not claimed token logos. When market
  metrics are unavailable, cards show actual launch dates and legacy cap reads instead.
- Loading, RPC failure, empty Plugged launches, unmatched search, unavailable charts and
  undeployed claims have distinct copy and actionable navigation.
- English/Spanish and light/dark preferences persist locally. Wallet connection requests
  a public address only. No decorative animation; brief hover feedback respects reduced motion.
- Focus rings, skip navigation, native controls, heading order and landmarks are explicit.

## Assets and evidence

`web/mark.svg` is an original geometric plug mark authored for this build. UI icons are
inline SVG paths. No downloaded or generated raster art is shipped. Ignored screenshot
artifacts are Chromium captures of the actual frozen build. Create screenshots contain
explicitly labeled automated local fixtures, not live tokens or seeded product data.

The follow-up adds developer/community toggles, complementary numeric ratios, progressively
disclosed campaign/cashback/charity settings and project social links. Quote assets have a
separate address-first catalog with evidence disclosures; they never become launch cards.
The discovery page now contains only Plugged's undeployed-market empty state.

Economics retains the established form tokens: fixed $2,500 USD opening, editable FDV
milestone, optional hybrid fieldsets, and collapsed USD conversion and ETH-route previews.
Changing the quote does not change the USD opening. No Pons preset, mode selector or
eligibility button remains. All hybrid pools share the same full-supply valuation.
Recipients select wallet, X or GitHub; resolution is an explicit action with pending/error
states. Profile allocation, provider resolution and rightful-owner wallet control are distinct.
Anti-copy copy names all three identity inputs and explicitly permits different settings.

Visual inspection covered mobile first, then desktop, in both themes. The earlier reviewer
found stale quote-address/eligibility state; rebuilding on quote change and discarding stale
responses resolved it. The updated regression exercises USD conversion instead of eligibility.
Final recorded browser run: 28 checks, zero borrowed launch cards and zero runtime errors. AccessLint: 24 combinations,
94 rules each, zero violations or skipped rules. These are automated checks, not a WCAG
conformance certification. See VERIFICATION.md for exact limits and the coverage-tool failure.
