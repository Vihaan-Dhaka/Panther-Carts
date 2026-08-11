"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  CheckoutConfirmationState,
  CheckoutLookupState,
  ReturnConfirmationState,
  ReturnLookupState,
} from "@/lib/queue/staff-station";
import {
  CheckoutPreviewPanel,
  EligibleBinSelect,
  PantherCardConfirmation,
  ReturnPreviewPanel,
  WorkflowSuccess,
} from "./workflow-panels";
import { claimSubmission, releaseSubmission } from "./submission-guard";

type CheckoutLookupAction = (
  state: CheckoutLookupState,
  formData: FormData,
) => Promise<CheckoutLookupState>;
type CheckoutConfirmationAction = (
  pickupCode: string,
  idempotencyKey: string,
  state: CheckoutConfirmationState,
  formData: FormData,
) => Promise<CheckoutConfirmationState>;
type ReturnLookupAction = (
  state: ReturnLookupState,
  formData: FormData,
) => Promise<ReturnLookupState>;
type ReturnConfirmationAction = (
  idempotencyKey: string,
  state: ReturnConfirmationState,
  formData: FormData,
) => Promise<ReturnConfirmationState>;

const initialCheckoutLookupState: CheckoutLookupState = {
  status: "idle",
  values: { pickupCode: "" },
  fieldErrors: {},
  formError: null,
};
const initialReturnLookupState: ReturnLookupState = {
  status: "idle",
  values: { binNumber: "" },
  fieldErrors: {},
  formError: null,
};

function useDuplicateSubmissionGuard(pending: boolean) {
  const submitting = useRef(false);

  useEffect(() => {
    if (!pending) {
      releaseSubmission(submitting);
    }
  }, [pending]);

  return (event: FormEvent<HTMLFormElement>) => {
    if (!claimSubmission(submitting)) {
      event.preventDefault();
    }
  };
}

function FormAlert({ message }: { message: string | null }) {
  return message ? (
    <div
      role="alert"
      className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-900"
    >
      {message}
    </div>
  ) : null;
}

function CheckoutConfirmation({
  state: lookupState,
  action,
  onReset,
}: {
  state: Extract<CheckoutLookupState, { status: "preview" }>;
  action: CheckoutConfirmationAction;
  onReset: () => void;
}) {
  const reservedBin =
    lookupState.preview.eligibleBins.find((bin) => bin.reserved)?.binNumber ??
    lookupState.preview.eligibleBins[0]?.binNumber ??
    "";
  const initialState: CheckoutConfirmationState = {
    status: "idle",
    values: { binNumber: reservedBin, pantherCardCollected: false },
    fieldErrors: {},
    formError: null,
  };
  const boundAction = async (
    previousState: CheckoutConfirmationState,
    formData: FormData,
  ): Promise<CheckoutConfirmationState> => {
    const nextState = await action(
      lookupState.values.pickupCode,
      lookupState.idempotencyKey,
      previousState,
      formData,
    );
    if (
      nextState.status !== "success" &&
      nextState.eligibleBinsRefreshAttempted
    ) {
      return {
        ...nextState,
        eligibleBinsRevision:
          (previousState.status === "success"
            ? 0
            : (previousState.eligibleBinsRevision ?? 0)) + 1,
      };
    }
    return nextState;
  };
  const [state, formAction, pending] = useActionState(
    boundAction,
    initialState,
  );
  const guardSubmission = useDuplicateSubmissionGuard(pending);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    previewHeadingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (state.status === "success") {
      successHeadingRef.current?.focus();
    }
  }, [state.status]);

  if (state.status === "success") {
    return (
      <div className="space-y-4">
        <WorkflowSuccess
          kind="checkout"
          headingRef={successHeadingRef}
          {...state.result}
        />
        <button
          type="button"
          onClick={onReset}
          className="w-full rounded-2xl border border-emerald-700 px-4 py-3 font-bold text-emerald-800 transition hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          Start another checkout
        </button>
      </div>
    );
  }

  const binError = state.fieldErrors.binNumber?.[0];
  const cardError = state.fieldErrors.pantherCardCollected?.[0];
  const eligibleBins =
    state.eligibleBins ??
    (state.eligibleBinsRefreshAttempted
      ? lookupState.preview.eligibleBins.filter(
          (bin) => bin.binNumber !== state.values.binNumber,
        )
      : lookupState.preview.eligibleBins);
  const selectedBin = eligibleBins.some(
    (bin) => bin.binNumber === state.values.binNumber,
  )
    ? state.values.binNumber
    : (eligibleBins.find((bin) => bin.reserved)?.binNumber ??
      eligibleBins[0]?.binNumber ??
      "");
  const eligibleBinListKey = state.eligibleBinsRevision
    ? `refresh-${state.eligibleBinsRevision}-${eligibleBins
        .map((bin) => `${bin.binNumber}:${bin.reserved ? "r" : "a"}`)
        .join("|")}`
    : "initial";

  return (
    <div className="space-y-5">
      <CheckoutPreviewPanel
        preview={lookupState.preview}
        headingRef={previewHeadingRef}
      />
      <form
        action={formAction}
        onSubmit={guardSubmission}
        className="space-y-5"
      >
        <FormAlert message={state.formError} />
        <EligibleBinSelect
          key={eligibleBinListKey}
          bins={eligibleBins}
          defaultValue={selectedBin}
          error={binError}
        />
        <PantherCardConfirmation
          workflow="checkout"
          defaultChecked={state.values.pantherCardCollected}
          error={cardError}
        />
        <button
          type="submit"
          disabled={pending}
          aria-disabled={pending}
          className="w-full rounded-2xl bg-indigo-700 px-5 py-3.5 font-bold text-white transition hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pending
            ? "Completing checkout…"
            : "Confirm card collection and checkout"}
        </button>
        <p aria-live="polite" className="text-center text-sm text-slate-500">
          {pending ? "Checkout is processing. Do not submit again." : ""}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="w-full text-sm font-bold text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600"
        >
          Look up a different pickup code
        </button>
      </form>
    </div>
  );
}

function CheckoutAttempt({
  lookupAction,
  confirmationAction,
  onReset,
}: {
  lookupAction: CheckoutLookupAction;
  confirmationAction: CheckoutConfirmationAction;
  onReset: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    lookupAction,
    initialCheckoutLookupState,
  );
  const guardSubmission = useDuplicateSubmissionGuard(pending);

  if (state.status === "preview") {
    return (
      <CheckoutConfirmation
        state={state}
        action={confirmationAction}
        onReset={onReset}
      />
    );
  }

  const error = state.fieldErrors.pickupCode?.[0];
  return (
    <form action={formAction} onSubmit={guardSubmission} className="space-y-5">
      <FormAlert message={state.formError} />
      <div>
        <label
          htmlFor="pickup-code"
          className="mb-2 block text-sm font-bold text-slate-800"
        >
          Four-digit pickup code
        </label>
        <input
          id="pickup-code"
          name="pickupCode"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4}"
          maxLength={4}
          defaultValue={state.values.pickupCode}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "pickup-code-error" : "pickup-code-help"}
          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 font-mono text-2xl tracking-[0.25em] text-slate-950 outline-none focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100 aria-[invalid=true]:border-red-500"
        />
        <p id="pickup-code-help" className="mt-2 text-sm text-slate-500">
          Enter the code shown by the student.
        </p>
        {error ? (
          <p
            id="pickup-code-error"
            role="alert"
            className="mt-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        aria-disabled={pending}
        className="w-full rounded-2xl bg-indigo-700 px-5 py-3.5 font-bold text-white transition hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? "Looking up pickup…" : "Look up pickup"}
      </button>
      <p aria-live="polite" className="text-center text-sm text-slate-500">
        {pending ? "Checking the pickup code. Please wait." : ""}
      </p>
    </form>
  );
}

function ReturnConfirmation({
  state: lookupState,
  action,
  onReset,
}: {
  state: Extract<ReturnLookupState, { status: "preview" }>;
  action: ReturnConfirmationAction;
  onReset: () => void;
}) {
  const initialState: ReturnConfirmationState = {
    status: "idle",
    values: {
      binNumber: lookupState.preview.binNumber,
      pantherCardReturned: false,
    },
    fieldErrors: {},
    formError: null,
  };
  const boundAction = action.bind(null, lookupState.idempotencyKey);
  const [state, formAction, pending] = useActionState(
    boundAction,
    initialState,
  );
  const guardSubmission = useDuplicateSubmissionGuard(pending);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    previewHeadingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (state.status === "success") {
      successHeadingRef.current?.focus();
    }
  }, [state.status]);

  if (state.status === "success") {
    return (
      <div className="space-y-4">
        <WorkflowSuccess
          kind="return"
          headingRef={successHeadingRef}
          {...state.result}
        />
        <button
          type="button"
          onClick={onReset}
          className="w-full rounded-2xl border border-emerald-700 px-4 py-3 font-bold text-emerald-800 transition hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          Start another return
        </button>
      </div>
    );
  }

  const binError = state.fieldErrors.binNumber?.[0];
  const cardError = state.fieldErrors.pantherCardReturned?.[0];
  return (
    <div className="space-y-5">
      <ReturnPreviewPanel
        preview={lookupState.preview}
        headingRef={previewHeadingRef}
      />
      <form
        action={formAction}
        onSubmit={guardSubmission}
        className="space-y-5"
      >
        <FormAlert message={state.formError} />
        <input
          type="hidden"
          name="binNumber"
          value={lookupState.preview.binNumber}
        />
        {binError ? (
          <p role="alert" className="text-sm text-red-700">
            {binError}
          </p>
        ) : null}
        <PantherCardConfirmation
          workflow="return"
          defaultChecked={state.values.pantherCardReturned}
          error={cardError}
        />
        <button
          type="submit"
          disabled={pending}
          aria-disabled={pending}
          className="w-full rounded-2xl bg-amber-700 px-5 py-3.5 font-bold text-white transition hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pending
            ? "Completing check-in…"
            : "Confirm card return and check in"}
        </button>
        <p aria-live="polite" className="text-center text-sm text-slate-500">
          {pending ? "Check-in is processing. Do not submit again." : ""}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="w-full text-sm font-bold text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600"
        >
          Look up a different bin
        </button>
      </form>
    </div>
  );
}

function ReturnAttempt({
  lookupAction,
  confirmationAction,
  onReset,
}: {
  lookupAction: ReturnLookupAction;
  confirmationAction: ReturnConfirmationAction;
  onReset: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    lookupAction,
    initialReturnLookupState,
  );
  const guardSubmission = useDuplicateSubmissionGuard(pending);

  if (state.status === "preview") {
    return (
      <ReturnConfirmation
        state={state}
        action={confirmationAction}
        onReset={onReset}
      />
    );
  }

  const error = state.fieldErrors.binNumber?.[0];
  return (
    <form action={formAction} onSubmit={guardSubmission} className="space-y-5">
      <FormAlert message={state.formError} />
      <div>
        <label
          htmlFor="return-bin"
          className="mb-2 block text-sm font-bold text-slate-800"
        >
          Physical bin number
        </label>
        <input
          id="return-bin"
          name="binNumber"
          type="text"
          autoComplete="off"
          defaultValue={state.values.binNumber}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "return-bin-error" : "return-bin-help"}
          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-xl font-bold text-slate-950 outline-none focus:border-amber-600 focus:ring-4 focus:ring-amber-100 aria-[invalid=true]:border-red-500"
        />
        <p id="return-bin-help" className="mt-2 text-sm text-slate-500">
          Enter the number printed on the returned bin.
        </p>
        {error ? (
          <p
            id="return-bin-error"
            role="alert"
            className="mt-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        aria-disabled={pending}
        className="w-full rounded-2xl bg-amber-700 px-5 py-3.5 font-bold text-white transition hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? "Looking up rental…" : "Look up active rental"}
      </button>
      <p aria-live="polite" className="text-center text-sm text-slate-500">
        {pending ? "Checking the bin. Please wait." : ""}
      </p>
    </form>
  );
}

export function StaffStation({
  checkoutLookupAction,
  checkoutConfirmationAction,
  returnLookupAction,
  returnConfirmationAction,
}: {
  checkoutLookupAction: CheckoutLookupAction;
  checkoutConfirmationAction: CheckoutConfirmationAction;
  returnLookupAction: ReturnLookupAction;
  returnConfirmationAction: ReturnConfirmationAction;
}) {
  const [checkoutAttempt, setCheckoutAttempt] = useState(0);
  const [returnAttempt, setReturnAttempt] = useState(0);

  return (
    <div className="grid gap-7 lg:grid-cols-2">
      <section
        aria-labelledby="checkout-heading"
        className="rounded-[2rem] border border-indigo-200 bg-white p-6 shadow-xl shadow-indigo-100/60 sm:p-8"
      >
        <p className="text-sm font-bold uppercase tracking-[0.18em] text-indigo-700">
          Workflow 1
        </p>
        <h2
          id="checkout-heading"
          className="mt-2 text-2xl font-bold text-slate-950"
        >
          Checkout
        </h2>
        <p className="mt-2 mb-6 text-sm leading-6 text-slate-600">
          Verify the pickup code, issue an eligible bin, and collect the
          physical PantherCard.
        </p>
        <CheckoutAttempt
          key={checkoutAttempt}
          lookupAction={checkoutLookupAction}
          confirmationAction={checkoutConfirmationAction}
          onReset={() => setCheckoutAttempt((attempt) => attempt + 1)}
        />
      </section>

      <section
        aria-labelledby="return-heading"
        className="rounded-[2rem] border border-amber-200 bg-white p-6 shadow-xl shadow-amber-100/60 sm:p-8"
      >
        <p className="text-sm font-bold uppercase tracking-[0.18em] text-amber-700">
          Workflow 2
        </p>
        <h2
          id="return-heading"
          className="mt-2 text-2xl font-bold text-slate-950"
        >
          Return
        </h2>
        <p className="mt-2 mb-6 text-sm leading-6 text-slate-600">
          Find the active rental by bin number, return the physical PantherCard,
          and check in the bin.
        </p>
        <ReturnAttempt
          key={returnAttempt}
          lookupAction={returnLookupAction}
          confirmationAction={returnConfirmationAction}
          onReset={() => setReturnAttempt((attempt) => attempt + 1)}
        />
      </section>
    </div>
  );
}
