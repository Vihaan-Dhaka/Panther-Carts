import type {
  CheckoutPreview,
  ReturnPreview,
  StaffStudent,
} from "@/lib/queue/staff-rentals";
import type { Ref } from "react";

export function StudentIdentity({ student }: { student: StaffStudent }) {
  return (
    <dl className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
      <div>
        <dt className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
          Student
        </dt>
        <dd className="mt-1 text-lg font-bold text-slate-950">
          {student.fullName}
        </dd>
      </div>
      <div>
        <dt className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
          Panther ID
        </dt>
        <dd className="mt-1 text-lg font-bold text-slate-950">
          {student.pantherId}
        </dd>
      </div>
    </dl>
  );
}

export function CheckoutPreviewPanel({
  preview,
  headingRef,
}: {
  preview: CheckoutPreview;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div aria-live="polite" className="space-y-5">
      <div>
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-indigo-700">
          Pickup found
        </p>
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="mt-1 text-xl font-bold text-slate-950 focus:outline-2 focus:outline-offset-4 focus:outline-indigo-700"
        >
          Confirm the physical handoff
        </h3>
      </div>
      <StudentIdentity student={preview.student} />
    </div>
  );
}

export function ReturnPreviewPanel({
  preview,
  headingRef,
}: {
  preview: ReturnPreview;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div aria-live="polite" className="space-y-5">
      <div>
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-amber-700">
          Active rental found · Bin {preview.binNumber}
        </p>
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="mt-1 text-xl font-bold text-slate-950 focus:outline-2 focus:outline-offset-4 focus:outline-amber-700"
        >
          Return the physical PantherCard
        </h3>
      </div>
      <StudentIdentity student={preview.student} />
    </div>
  );
}

export function EligibleBinSelect({
  bins,
  defaultValue,
  error,
}: {
  bins: CheckoutPreview["eligibleBins"];
  defaultValue: string;
  error?: string;
}) {
  return (
    <div>
      <label
        htmlFor="checkout-bin"
        className="mb-2 block text-sm font-bold text-slate-800"
      >
        Bin being issued
      </label>
      <select
        id="checkout-bin"
        name="binNumber"
        defaultValue={defaultValue}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "checkout-bin-error" : undefined}
        className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base font-semibold text-slate-950 outline-none focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100 aria-[invalid=true]:border-red-500"
      >
        {bins.map((bin) => (
          <option key={bin.binNumber} value={bin.binNumber}>
            Bin {bin.binNumber}
            {bin.reserved ? " — reserved" : " — available replacement"}
          </option>
        ))}
      </select>
      {error ? (
        <p
          id="checkout-bin-error"
          role="alert"
          className="mt-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PantherCardConfirmation({
  workflow,
  defaultChecked,
  error,
}: {
  workflow: "checkout" | "return";
  defaultChecked: boolean;
  error?: string;
}) {
  const checkout = workflow === "checkout";
  const name = checkout ? "pantherCardCollected" : "pantherCardReturned";
  const errorId = checkout ? "checkout-card-error" : "return-card-error";
  return (
    <div
      className={`rounded-2xl border p-4 ${
        checkout
          ? "border-indigo-200 bg-indigo-50"
          : "border-amber-200 bg-amber-50"
      }`}
    >
      <label className="flex cursor-pointer items-start gap-3 font-semibold text-slate-900">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`mt-1 size-5 ${checkout ? "accent-indigo-700" : "accent-amber-700"}`}
        />
        <span>
          {checkout
            ? "I collected the student’s physical PantherCard."
            : "I returned the physical PantherCard to the student."}
        </span>
      </label>
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WorkflowSuccess({
  kind,
  student,
  binNumber,
  idempotentReplay,
  headingRef,
}: {
  kind: "checkout" | "return";
  student: StaffStudent | null;
  binNumber: string;
  idempotentReplay: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const checkout = kind === "checkout";
  return (
    <section
      role="status"
      aria-live="polite"
      className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950"
    >
      <p className="text-sm font-bold uppercase tracking-[0.16em] text-emerald-700">
        {checkout ? "Checkout complete" : "Check-in complete"}
      </p>
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="mt-2 text-xl font-bold focus:outline-2 focus:outline-offset-4 focus:outline-emerald-700"
      >
        Bin {binNumber} {checkout ? "is checked out" : "was returned"}.
      </h3>
      {student ? (
        <p className="mt-2 text-sm leading-6">
          {student.fullName} · Panther ID {student.pantherId}
        </p>
      ) : null}
      <p className="mt-2 text-sm leading-6">
        {checkout
          ? "The PantherCard collection was recorded."
          : "The PantherCard return was recorded."}
      </p>
      {idempotentReplay ? (
        <p className="mt-2 text-sm leading-6">
          This was a safe retry; the original result was preserved.
        </p>
      ) : null}
    </section>
  );
}
