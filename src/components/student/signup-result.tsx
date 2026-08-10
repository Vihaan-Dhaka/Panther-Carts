import type { JoinQueueResult } from "@/lib/queue/join-queue";

export function StudentSignupResult({ result }: { result: JoinQueueResult }) {
  if (result.status === "READY") {
    return (
      <section
        aria-labelledby="signup-success-heading"
        className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-950 shadow-sm"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
          Cart ready
        </p>
        <h2
          id="signup-success-heading"
          className="mt-2 text-2xl font-bold tracking-tight"
        >
          You can pick up a cart now.
        </h2>
        <p className="mt-3 text-sm leading-6">
          Show this four-digit pickup code to staff. Keep it private.
        </p>
        <p
          aria-label={`Pickup code ${result.pickupCode.split("").join(" ")}`}
          className="mt-5 rounded-2xl bg-white px-5 py-4 text-center font-mono text-4xl font-bold tracking-[0.3em] text-emerald-900 ring-1 ring-emerald-200"
        >
          {result.pickupCode}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="signup-success-heading"
      className="rounded-3xl border border-sky-200 bg-sky-50 p-6 text-sky-950 shadow-sm"
    >
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-700">
        You are in line
      </p>
      <h2
        id="signup-success-heading"
        className="mt-2 text-2xl font-bold tracking-tight"
      >
        Queue position {result.position}
      </h2>
      {result.estimatedWaitMinutes === null ? (
        <p className="mt-3 text-sm leading-6">
          An estimated wait is not available yet. We will not guess.
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6">
          Estimated wait: about {result.estimatedWaitMinutes} minutes.
        </p>
      )}
      <p className="mt-3 text-sm leading-6">
        No pickup code is assigned while you are waiting.
      </p>
    </section>
  );
}
