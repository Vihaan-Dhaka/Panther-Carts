"use client";

import { useActionState } from "react";
import type { StaffAccessState } from "@/app/staff/actions";

const initialState: StaffAccessState = {
  status: "idle",
  fieldErrors: {},
  formError: null,
};

export function StaffAccessForm({
  action,
}: {
  action: (
    state: StaffAccessState,
    formData: FormData,
  ) => Promise<StaffAccessState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="mt-6 space-y-5" noValidate>
      <div>
        <label className="font-bold text-slate-800" htmlFor="accessCode">
          Staff access code
        </label>
        <input
          id="accessCode"
          name="accessCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          required
          aria-invalid={Boolean(state.fieldErrors.accessCode)}
          className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-mono text-xl tracking-[0.25em] text-slate-950"
        />
        {state.fieldErrors.accessCode?.map((message) => (
          <p key={message} className="mt-2 text-sm text-red-700">
            {message}
          </p>
        ))}
      </div>
      {state.formError && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">
          {state.formError}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-slate-950 px-5 py-3 font-bold text-white disabled:opacity-60"
      >
        {pending ? "Verifying…" : "Open staff station"}
      </button>
    </form>
  );
}
