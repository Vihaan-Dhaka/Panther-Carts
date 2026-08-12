"use client";

import { useActionState } from "react";
import { StudentSignupResult } from "@/components/student/signup-result";
import type { StudentSignupState } from "@/lib/queue/student-signup";

type SignupAction = (
  state: StudentSignupState,
  formData: FormData,
) => Promise<StudentSignupState>;

const initialStudentSignupState: StudentSignupState = {
  status: "idle",
  values: {
    fullName: "",
    pantherId: "",
    email: "",
    phone: "",
    smsConsent: false,
  },
  fieldErrors: {},
  formError: null,
};

const fields = [
  {
    name: "fullName",
    label: "Full name",
    type: "text",
    autoComplete: "name",
    inputMode: undefined,
    placeholder: "Jordan Panther",
  },
  {
    name: "pantherId",
    label: "Panther ID",
    type: "text",
    autoComplete: "off",
    inputMode: "numeric",
    placeholder: "900123456",
  },
  {
    name: "email",
    label: "Student email",
    type: "email",
    autoComplete: "email",
    inputMode: "email",
    placeholder: "jordan.panther@school.edu",
  },
  {
    name: "phone",
    label: "Phone number",
    type: "tel",
    autoComplete: "tel",
    inputMode: "tel",
    placeholder: "(404) 555-0123",
  },
] as const;

export function StudentSignupForm({ action }: { action: SignupAction }) {
  const [state, formAction, pending] = useActionState(
    action,
    initialStudentSignupState,
  );

  if (state.status === "success") {
    return (
      <div role="status" aria-live="polite">
        <StudentSignupResult result={state.result} />
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      {state.formError ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {state.formError}
        </div>
      ) : null}

      {fields.map((field) => {
        const error = state.fieldErrors[field.name]?.[0];
        const errorId = `${field.name}-error`;
        return (
          <div key={field.name}>
            <label
              htmlFor={field.name}
              className="mb-2 block text-sm font-semibold text-slate-800"
            >
              {field.label}
            </label>
            <input
              id={field.name}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              inputMode={field.inputMode}
              placeholder={field.placeholder}
              defaultValue={state.values[field.name]}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-sky-600 focus:ring-4 focus:ring-sky-100 aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus:ring-red-100"
            />
            {error ? (
              <p id={errorId} className="mt-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start gap-3">
          <input
            id="smsConsent"
            name="smsConsent"
            type="checkbox"
            required
            defaultChecked={state.values.smsConsent}
            aria-invalid={state.fieldErrors.smsConsent ? true : undefined}
            aria-describedby={
              state.fieldErrors.smsConsent
                ? "smsConsent-description smsConsent-error"
                : "smsConsent-description"
            }
            className="mt-1 h-5 w-5 shrink-0 rounded border-slate-400 text-sky-700 focus:ring-sky-600"
          />
          <label
            htmlFor="smsConsent"
            id="smsConsent-description"
            className="text-sm leading-6 text-slate-700"
          >
            I agree to receive Panther Carts transactional cart-rental text
            messages. Message frequency varies. Message and data rates may
            apply. Reply STOP to opt out or HELP for carrier help. Consent is
            not for marketing.
          </label>
        </div>
        {state.fieldErrors.smsConsent?.[0] ? (
          <p id="smsConsent-error" className="mt-2 text-sm text-red-700">
            {state.fieldErrors.smsConsent[0]}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={pending}
        aria-disabled={pending}
        className="flex w-full items-center justify-center rounded-2xl bg-sky-700 px-5 py-3.5 text-base font-bold text-white shadow-sm transition hover:bg-sky-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? "Joining queue…" : "Join the cart queue"}
      </button>
      <p aria-live="polite" className="text-center text-sm text-slate-500">
        {pending ? "Submitting your signup. Please wait." : ""}
      </p>
    </form>
  );
}
