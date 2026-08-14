import { ActivityView } from "@/components/activity/activity-view";

/**
 * Activity page (FR-4.4).
 *
 * A thin server shell only, for the same reason as `/portfolio`: the Data API
 * needs the *Deposit Wallet* address, which the server never learns, so the
 * feed is read in the browser from the user's own authenticated client. See
 * `lib/polymarket/activity.ts`.
 */
export default function ActivityPage() {
  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every trade, redemption and reward on your account, newest first. Times are shown in your
          local timezone.
        </p>
      </header>

      <ActivityView />
    </div>
  );
}
