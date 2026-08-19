"use client";

import { useActionState } from "react";
import type { AdminLoginState } from "@/app/admin/login/actions";

const initialState: AdminLoginState = {
  status: "idle",
  fieldErrors: {},
  formError: null,
};

export function AdminLoginForm({
  action,
}: {
  action: (
    state: AdminLoginState,
    formData: FormData,
  ) => Promise<AdminLoginState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="mt-7 space-y-5" noValidate>
      <div>
        <label className="text-sm font-bold text-slate-800" htmlFor="email">
          Admin email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          aria-invalid={Boolean(state.fieldErrors.email)}
          className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-950"
        />
        {state.fieldErrors.email?.map((message) => (
          <p key={message} className="mt-2 text-sm text-red-700">
            {message}
          </p>
        ))}
      </div>
      <div>
        <label className="text-sm font-bold text-slate-800" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(state.fieldErrors.password)}
          className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-950"
        />
        {state.fieldErrors.password?.map((message) => (
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
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
