import type { Metadata } from "next";

import { LegalDocumentPage, NeedsCounsel, Section } from "@/components/legal/legal-document";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms governing use of this platform.",
};

/**
 * Terms of Service (FR-6.4).
 *
 * ⚠️ **A skeleton, on purpose.** Unlike the Risk Disclosure — which states facts
 * about how this platform works and which we are the right people to write —
 * the Terms are a binding contract between the operator and the user. Drafting
 * one is a legal task, and generated contract text that reads plausibly is worse
 * than an obvious gap: it looks finished, so nobody reviews it, and it is
 * enforced against real users.
 *
 * What is here is the *structure* a prediction-market interface's terms need,
 * with each section carrying the platform-specific facts counsel would
 * otherwise have to extract from us. Every clause that requires a legal or
 * commercial decision is marked and must be replaced before launch —
 * `npm run check:legal` fails while any marker remains.
 */
export default function TermsPage() {
  return (
    <LegalDocumentPage id="terms">
      <NeedsCounsel>
        This document is a structural skeleton prepared by the engineering team, not a contract. It
        must be drafted or reviewed by qualified counsel before this platform accepts a single user.
        The notes in each section describe how the platform actually behaves, so that counsel has the
        facts they need.
      </NeedsCounsel>

      <Section heading="1. Who we are and what this is">
        <NeedsCounsel>
          Operator&apos;s legal entity name, registered address, jurisdiction of incorporation, and
          contact address for legal notices.
        </NeedsCounsel>
        <p>
          This platform is an interface to prediction markets operated by Polymarket. We do not
          operate a market, match orders, act as a counterparty, or hold customer funds.
        </p>
      </Section>

      <Section heading="2. Eligibility">
        <NeedsCounsel>
          Minimum age, the list of jurisdictions excluded from use, and the representations a user
          must make about their eligibility and residency.
        </NeedsCounsel>
        <p>
          Access is restricted by jurisdiction. Some regions are blocked from trading entirely and
          others are limited to closing existing positions. These restrictions are enforced upstream
          by Polymarket regardless of this interface.
        </p>
      </Section>

      <Section heading="3. Accounts and wallets">
        <p>
          Signing in provisions an embedded wallet controlled by you. That wallet, and the Deposit
          Wallet it controls, hold your funds. We never take custody, cannot sign on your behalf, and
          cannot recover funds if you lose access to your login and recovery methods.
        </p>
        <NeedsCounsel>
          Account security obligations, prohibition on sharing or transferring accounts, and the
          consequences of lost access.
        </NeedsCounsel>
      </Section>

      <Section heading="4. Fees">
        <p>
          A builder fee of 0.50% (50 basis points) applies to taker orders and no fee applies to maker
          orders. This fee is paid by the user in addition to any fees charged by Polymarket, and is
          disclosed in the order ticket before the user commits to a trade.
        </p>
        <NeedsCounsel>
          Notice period and mechanism for changing fee rates. Note for counsel: a rate change takes
          approximately four days to become effective upstream, so any contractual notice period
          should account for that lead time.
        </NeedsCounsel>
      </Section>

      <Section heading="5. Risk acknowledgement">
        <p>
          Use of this platform requires acknowledging the Risk Disclosure, which forms part of these
          terms. Prediction market positions can expire worthless, funds are uninsured, and
          withdrawals are irreversible.
        </p>
      </Section>

      <Section heading="6. Prohibited conduct">
        <NeedsCounsel>
          Market manipulation, use of the platform for unlawful purposes, circumvention of
          jurisdictional restrictions, automated abuse of the interface, and the operator&apos;s
          remedies.
        </NeedsCounsel>
      </Section>

      <Section heading="7. No advice, no guarantees">
        <p>
          Nothing on this platform is investment, financial, legal, or tax advice. Market data,
          prices, and any derived figures are provided as-is and may be delayed, incomplete, or
          incorrect.
        </p>
        <NeedsCounsel>Warranty disclaimers in the form required by the governing jurisdiction.</NeedsCounsel>
      </Section>

      <Section heading="8. Limitation of liability">
        <NeedsCounsel>
          Liability cap, excluded categories of loss, and any carve-outs that cannot be excluded under
          applicable law.
        </NeedsCounsel>
      </Section>

      <Section heading="9. Third-party services">
        <p>
          This platform depends on services we do not control, including Polymarket&apos;s markets and
          settlement contracts, the wallet provider, and the Polygon network. Their availability,
          correctness, and terms are outside our control, and their failure can affect your funds.
        </p>
      </Section>

      <Section heading="10. Changes to these terms">
        <p>
          Material changes require renewed acceptance before continued use. Each revision is
          versioned, and a user whose recorded acceptance predates the current version is asked to
          accept again.
        </p>
        <NeedsCounsel>
          What constitutes a material change, and the notice period for changes that do not require
          renewed acceptance.
        </NeedsCounsel>
      </Section>

      <Section heading="11. Governing law and disputes">
        <NeedsCounsel>
          Governing law, venue, and the dispute resolution mechanism, including any arbitration
          agreement or class-action waiver.
        </NeedsCounsel>
      </Section>
    </LegalDocumentPage>
  );
}
