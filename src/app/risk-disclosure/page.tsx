import type { Metadata } from "next";

import { LegalDocumentPage, NeedsCounsel, Section } from "@/components/legal/legal-document";

export const metadata: Metadata = {
  title: "Risk Disclosure",
  description: "The risks of trading prediction markets on this platform.",
};

/**
 * Risk Disclosure (FR-6.4).
 *
 * Unlike the Terms, this is written out properly rather than left as a
 * skeleton: every statement below is a fact about how this platform actually
 * works, drawn from the architecture rather than from a template — the builder
 * fee and its rate, pUSD versus USDC, who resolves markets, what the geo gate
 * does, and what self-custody means when the signer is an embedded wallet.
 * Those are things only we can state accurately, and a lawyer would have to ask
 * us for them anyway.
 *
 * It still carries a review marker: what a disclosure is *required* to say
 * varies by jurisdiction, and that part is not an engineering judgment.
 */
export default function RiskDisclosurePage() {
  return (
    <LegalDocumentPage id="risk">
      <NeedsCounsel>
        The disclosures below describe how this platform works and are accurate to the best of our
        knowledge. Whether they are <em>sufficient</em> for the jurisdictions you intend to serve is a
        question for counsel — required wording varies, and this document has not been reviewed.
      </NeedsCounsel>

      <p>
        Trading prediction markets carries substantial risk. Read this document before depositing
        funds or placing an order. Nothing on this platform is investment, financial, legal, or tax
        advice, and nothing here is a recommendation to enter any position.
      </p>

      <Section heading="You can lose everything you put in">
        <p>
          Prediction market contracts settle at either their full value or nothing. A position on an
          outcome that does not occur expires worthless — not merely reduced in value. There is no
          partial recovery, no stop-loss guarantee, and no mechanism by which a losing contract
          returns anything at settlement.
        </p>
        <p>
          Only commit funds you are prepared to lose entirely. Past results of any market, trader, or
          strategy do not predict future outcomes.
        </p>
      </Section>

      <Section heading="Your funds are not insured or protected">
        <p>
          This platform is not a bank, broker-dealer, or exchange. Deposits are not covered by
          deposit insurance, investor compensation schemes, or any equivalent protection in any
          jurisdiction. If a market resolves against you, if a counterparty fails, or if any
          underlying protocol malfunctions, no scheme exists to reimburse you.
        </p>
      </Section>

      <Section heading="You hold your own keys — and that cuts both ways">
        <p>
          This platform is self-custodial. Your funds sit in a Deposit Wallet controlled by a signer
          that belongs to you, and every order is signed in your browser by that signer. We never take
          custody, and we cannot move, freeze, or recover your funds.
        </p>
        <p>
          The consequence is that account access is your responsibility. If you permanently lose
          access to the login and recovery methods attached to your embedded wallet, you lose access
          to the funds it controls. No one — including us — can restore them for you.
        </p>
      </Section>

      <Section heading="We do not operate the market">
        <p>
          Orders placed here are routed to the Polymarket central limit order book. Polymarket
          operates the market, matches orders, and determines how each market resolves. We do not run
          a matching engine, set odds, or take the other side of your trade.
        </p>
        <p>
          Market outcomes are therefore determined by Polymarket&apos;s resolution process, not by us.
          Resolution can be disputed, delayed, or decided contrary to your expectation of the
          real-world event, including where the market&apos;s wording differs from how you interpreted
          it. Read each market&apos;s resolution criteria before trading it.
        </p>
      </Section>

      <Section heading="Fees reduce what you receive">
        <p>
          Trades on this platform are charged a builder fee of <strong>0.50% (50 basis points)</strong>{" "}
          on taker orders and <strong>no fee</strong> on maker orders. This fee is paid by you and is
          charged <em>in addition to</em> any fees Polymarket itself applies. The fee is disclosed in
          the order ticket before you commit to a trade.
        </p>
        <p>
          Your available balance must cover the notional value of your order plus all applicable fees.
          An order that does not leave room for fees will fail.
        </p>
      </Section>

      <Section heading="Prices move, and liquidity is not guaranteed">
        <p>
          Prediction market prices can move sharply and without warning as information about the
          underlying event changes. A market order fills at whatever prices are available in the book,
          which may be materially worse than the price displayed when you began — this is slippage,
          and the order ticket&apos;s protection limits it but cannot eliminate it.
        </p>
        <p>
          There is no guarantee you can exit a position before resolution. Thin or absent liquidity can
          leave a position impossible to close at any acceptable price, or at all.
        </p>
      </Section>

      <Section heading="Balances are held in pUSD, not USDC">
        <p>
          Deposited USDC is automatically converted to pUSD, the collateral token used across
          Polymarket. pUSD is an ERC-20 token on Polygon backed 1:1 by USDC. Balances, profit and loss,
          and fees on this platform are all denominated in pUSD, and withdrawals convert back to USDC
          on the way out.
        </p>
        <p>
          This conversion depends on Polymarket&apos;s infrastructure continuing to function and honour
          the peg. That is a risk you take on by depositing.
        </p>
      </Section>

      <Section heading="Software, protocol, and network risk">
        <p>
          Trades settle through smart contracts on the Polygon network. Smart contracts can contain
          defects, and networks can congest, halt, or reorganise. A bug, exploit, or outage in any
          component — this interface, Polymarket&apos;s contracts and services, the wallet provider, or
          Polygon itself — can result in failed transactions, incorrect state, or total loss of funds.
          None of these components is under our control.
        </p>
      </Section>

      <Section heading="Availability is restricted, and rules can change">
        <p>
          Trading is unavailable or restricted in a number of jurisdictions. Some regions are blocked
          entirely; others are limited to closing existing positions and cannot open new ones. These
          restrictions are enforced by Polymarket regardless of what this interface allows, and they
          can change at any time.
        </p>
        <p>
          You are responsible for determining whether your use of this platform is lawful where you
          are, and for any tax arising from your activity. The regulatory treatment of prediction
          markets is unsettled in many jurisdictions and may change in ways that affect your ability to
          trade or to withdraw.
        </p>
      </Section>

      <Section heading="Withdrawals are irreversible">
        <p>
          A withdrawal sends funds to a blockchain address you specify. Blockchain transactions cannot
          be reversed, cancelled, or recalled. Funds sent to an incorrect, incompatible, or
          unsupported address are permanently lost. Check the destination address in full before
          confirming.
        </p>
      </Section>
    </LegalDocumentPage>
  );
}
