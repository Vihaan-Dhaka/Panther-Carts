"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ADMIN_VIEW_OPTIONS,
  type AdminActionResult,
  type AdminDashboardSnapshot,
  type AdminInventoryRow,
  type AdminRentalRow,
  type AdminViewKey,
  type RentalVisualStatus,
} from "@/lib/admin/types";

export type AdminMutationAction = (
  previousState: AdminActionResult | null,
  formData: FormData,
) => Promise<AdminActionResult>;

type AdminDashboardProps = {
  snapshot: AdminDashboardSnapshot;
  createSessionAction: AdminMutationAction;
  configureSessionAction: AdminMutationAction;
  startSessionAction: AdminMutationAction;
  endSessionAction: AdminMutationAction;
  addBinsAction: AdminMutationAction;
  notifyRentalAction: AdminMutationAction;
  createSessionIdempotencyKey: string;
  notifyIdempotencyKeys: Record<string, string>;
};

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-200";
const primaryButton =
  "rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800 focus:outline-2 focus:outline-offset-2 focus:outline-slate-950 disabled:cursor-not-allowed disabled:opacity-50";

function useAdminMutation(action: AdminMutationAction) {
  const submitting = useRef(false);
  const [result, formAction, pending] = useActionState(action, null);

  useEffect(() => {
    if (!pending) submitting.current = false;
  }, [pending]);

  function guardSubmission(event: FormEvent<HTMLFormElement>) {
    if (submitting.current) {
      event.preventDefault();
      return;
    }
    submitting.current = true;
  }

  return { result, pending, formAction, guardSubmission };
}

function FieldError({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p role="alert" className="mt-1 text-sm font-medium text-red-700">
      {errors[0]}
    </p>
  );
}

function ActionNotice({ result }: { result: AdminActionResult | null }) {
  if (!result) return null;
  const message = result.message;
  if (result.status === "error" && !message) return null;
  return (
    <div
      role={result.status === "error" ? "alert" : "status"}
      aria-live="polite"
      className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
        result.status === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-red-200 bg-red-50 text-red-800"
      }`}
    >
      {message && <p>{message}</p>}
      {result.status === "success" && result.duplicateBins?.length ? (
        <p className="mt-1">
          Already present or repeated: {result.duplicateBins.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-xl font-bold text-slate-950">{title}</h2>
      {children}
    </section>
  );
}

function CreateSessionForm({
  action,
  idempotencyKey,
}: {
  action: AdminMutationAction;
  idempotencyKey: string;
}) {
  const { result, pending, formAction, guardSubmission } =
    useAdminMutation(action);
  const errors = result?.status === "error" ? result.fieldErrors : {};
  return (
    <Panel title="Create the next session">
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Creating a draft generates new student and staff access codes. Review
        the durations before starting it.
      </p>
      <form
        action={formAction}
        onSubmit={guardSubmission}
        className="mt-5 grid gap-4 sm:grid-cols-3"
      >
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <label className="text-sm font-semibold text-slate-800 sm:col-span-3">
          Session name
          <input
            className={inputClass}
            name="name"
            maxLength={120}
            required
            placeholder="Fall cart service"
          />
          <FieldError errors={errors.name} />
        </label>
        <label className="text-sm font-semibold text-slate-800">
          Rental duration (minutes)
          <input
            className={inputClass}
            name="rentalDurationMinutes"
            type="number"
            min={1}
            max={1440}
            defaultValue={60}
            required
          />
          <FieldError errors={errors.rentalDurationMinutes} />
        </label>
        <label className="text-sm font-semibold text-slate-800">
          Pickup window (minutes)
          <input
            className={inputClass}
            name="pickupWindowMinutes"
            type="number"
            min={1}
            max={240}
            defaultValue={10}
            required
          />
          <FieldError errors={errors.pickupWindowMinutes} />
        </label>
        <div className="flex items-end">
          <button className={primaryButton} disabled={pending} type="submit">
            {pending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </form>
      <ActionNotice result={result} />
    </Panel>
  );
}

function ConfigurationForm({
  action,
  rentalDurationMinutes,
  pickupWindowMinutes,
}: {
  action: AdminMutationAction;
  rentalDurationMinutes: number;
  pickupWindowMinutes: number;
}) {
  const { result, pending, formAction, guardSubmission } =
    useAdminMutation(action);
  const errors = result?.status === "error" ? result.fieldErrors : {};
  return (
    <form
      action={formAction}
      onSubmit={guardSubmission}
      className="mt-5 grid gap-4 sm:grid-cols-2"
    >
      <label className="text-sm font-semibold text-slate-800">
        Rental duration (minutes)
        <input
          className={inputClass}
          name="rentalDurationMinutes"
          type="number"
          min={1}
          max={1440}
          defaultValue={rentalDurationMinutes}
          required
        />
        <FieldError errors={errors.rentalDurationMinutes} />
      </label>
      <label className="text-sm font-semibold text-slate-800">
        Pickup window (minutes)
        <input
          className={inputClass}
          name="pickupWindowMinutes"
          type="number"
          min={1}
          max={240}
          defaultValue={pickupWindowMinutes}
          required
        />
        <FieldError errors={errors.pickupWindowMinutes} />
      </label>
      <div className="sm:col-span-2">
        <button className={primaryButton} disabled={pending} type="submit">
          {pending ? "Saving…" : "Save durations"}
        </button>
      </div>
      <div className="sm:col-span-2">
        <ActionNotice result={result} />
      </div>
    </form>
  );
}

function LifecycleButton({
  action,
  kind,
}: {
  action: AdminMutationAction;
  kind: "start" | "end";
}) {
  const { result, pending, formAction, guardSubmission } =
    useAdminMutation(action);
  return (
    <form action={formAction} onSubmit={guardSubmission} className="mt-5">
      <button
        className={
          kind === "end"
            ? "rounded-xl border border-red-300 bg-white px-4 py-2.5 text-sm font-bold text-red-800 transition hover:bg-red-50 focus:outline-2 focus:outline-offset-2 focus:outline-red-700 disabled:opacity-50"
            : primaryButton
        }
        disabled={pending}
        type="submit"
      >
        {pending
          ? kind === "start"
            ? "Starting…"
            : "Ending…"
          : kind === "start"
            ? "Start session"
            : "End session"}
      </button>
      <ActionNotice result={result} />
    </form>
  );
}

function AccessDetails({
  label,
  code,
  link,
}: {
  label: string;
  code: string;
  link: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="font-bold text-slate-950">{label}</h3>
      <dl className="mt-3 grid gap-2 text-sm">
        <div>
          <dt className="font-semibold text-slate-600">Code</dt>
          <dd className="mt-1 break-all font-mono text-slate-950">{code}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Link</dt>
          <dd className="mt-1 break-all">
            <a
              className="font-medium text-sky-700 underline decoration-sky-300 underline-offset-2"
              href={link}
            >
              {link}
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function BinForm({
  action,
  mode,
}: {
  action: AdminMutationAction;
  mode: "single" | "range" | "paste";
}) {
  const { result, pending, formAction, guardSubmission } =
    useAdminMutation(action);
  const errors = result?.status === "error" ? result.fieldErrors : {};
  return (
    <form
      action={formAction}
      onSubmit={guardSubmission}
      className="rounded-xl border border-slate-200 bg-slate-50 p-4"
    >
      <input type="hidden" name="mode" value={mode} />
      {mode === "single" && (
        <label className="text-sm font-semibold text-slate-800">
          Individual bin number
          <input
            className={inputClass}
            name="binNumber"
            inputMode="numeric"
            required
          />
          <FieldError errors={errors.binNumber} />
        </label>
      )}
      {mode === "range" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold text-slate-800">
            First bin
            <input
              className={inputClass}
              name="rangeStart"
              inputMode="numeric"
              required
            />
            <FieldError errors={errors.rangeStart} />
          </label>
          <label className="text-sm font-semibold text-slate-800">
            Last bin
            <input
              className={inputClass}
              name="rangeEnd"
              inputMode="numeric"
              required
            />
            <FieldError errors={errors.rangeEnd} />
          </label>
        </div>
      )}
      {mode === "paste" && (
        <label className="text-sm font-semibold text-slate-800">
          Pasted bin list
          <textarea
            className={`${inputClass} min-h-28 resize-y`}
            name="pastedBins"
            placeholder={"101, 102, 103\n104"}
            required
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            Separate numbers with spaces, commas, semicolons, or new lines.
          </span>
          <FieldError errors={errors.pastedBins} />
        </label>
      )}
      <button
        className={`${primaryButton} mt-4`}
        disabled={pending}
        type="submit"
      >
        {pending ? "Adding…" : "Add bins"}
      </button>
      <ActionNotice result={result} />
    </form>
  );
}

const statusClasses: Record<
  RentalVisualStatus | "available" | "reserved",
  string
> = {
  "currently-late": "border-red-300 bg-red-100 text-red-900",
  "checked-out-on-time": "border-emerald-300 bg-emerald-100 text-emerald-950",
  "returned-late": "border-orange-300 bg-orange-100 text-orange-950",
  "returned-on-time": "border-slate-300 bg-slate-200 text-slate-800",
  available: "border-slate-300 bg-white text-slate-900",
  reserved: "border-sky-300 bg-sky-100 text-sky-950",
};

export function StatusBadge({
  status,
  text,
}: {
  status: RentalVisualStatus | "available" | "reserved";
  text: string;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${statusClasses[status]}`}
    >
      {text}
    </span>
  );
}

export function formatAdminDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function NotifyButton({
  rentalId,
  idempotencyKey,
  action,
}: {
  rentalId: string;
  idempotencyKey: string;
  action: AdminMutationAction;
}) {
  const { result, pending, formAction, guardSubmission } =
    useAdminMutation(action);
  return (
    <form action={formAction} onSubmit={guardSubmission} className="min-w-28">
      <input type="hidden" name="rentalId" value={rentalId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-900 hover:bg-slate-100 focus:outline-2 focus:outline-offset-2 focus:outline-slate-950 disabled:opacity-50"
      >
        {pending ? "Queuing…" : "Notify"}
      </button>
      {result && (
        <span
          role={result.status === "error" ? "alert" : "status"}
          className={`mt-1 block text-xs ${
            result.status === "error" ? "text-red-700" : "text-emerald-700"
          }`}
        >
          {result.message}
        </span>
      )}
    </form>
  );
}

function RentalTable({
  caption,
  rows,
  notifyAction,
  notifyKeys,
}: {
  caption: string;
  rows: AdminRentalRow[];
  notifyAction: AdminMutationAction;
  notifyKeys: Record<string, string>;
}) {
  if (!rows.length) {
    return (
      <p role="status" className="py-10 text-center text-slate-600">
        No records in this view.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] border-separate border-spacing-0 text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-slate-600">
            {[
              "Bin",
              "Student",
              "Panther ID",
              "Email",
              "Phone",
              "Status",
              "Checked out",
              "Due",
              "Returned",
              "Action",
            ].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="border-b border-slate-200 px-3 py-3 font-bold"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rentalId} className="align-top text-slate-800">
              <th
                scope="row"
                className="border-b border-slate-100 px-3 py-4 font-bold text-slate-950"
              >
                {row.binNumber}
              </th>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.fullName}
              </td>
              <td className="border-b border-slate-100 px-3 py-4 font-mono">
                {row.pantherId}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.email}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.phone}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                <StatusBadge status={row.visualStatus} text={row.statusText} />
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {formatAdminDateTime(row.checkedOutAt)}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {formatAdminDateTime(row.dueAt)}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {formatAdminDateTime(row.returnedAt)}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.rentalStatus === "OUT" ? (
                  <NotifyButton
                    rentalId={row.rentalId}
                    idempotencyKey={notifyKeys[row.rentalId]}
                    action={notifyAction}
                  />
                ) : (
                  <span className="text-slate-500">Returned</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryTable({
  rows,
  notifyAction,
  notifyKeys,
}: {
  rows: AdminInventoryRow[];
  notifyAction: AdminMutationAction;
  notifyKeys: Record<string, string>;
}) {
  if (!rows.length) {
    return (
      <p role="status" className="py-10 text-center text-slate-600">
        No bins have been added to this session.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left text-sm">
        <caption className="sr-only">
          Total inventory for the current session
        </caption>
        <thead>
          <tr className="text-slate-600">
            {[
              "Bin",
              "Status",
              "Student",
              "Panther ID",
              "Email",
              "Phone",
              "Due",
              "Action",
            ].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="border-b border-slate-200 px-3 py-3 font-bold"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.binNumber} className="align-top text-slate-800">
              <th
                scope="row"
                className="border-b border-slate-100 px-3 py-4 font-bold text-slate-950"
              >
                {row.binNumber}
              </th>
              <td className="border-b border-slate-100 px-3 py-4">
                <StatusBadge status={row.visualStatus} text={row.statusText} />
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.fullName ?? "—"}
              </td>
              <td className="border-b border-slate-100 px-3 py-4 font-mono">
                {row.pantherId ?? "—"}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.email ?? "—"}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.phone ?? "—"}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {formatAdminDateTime(row.currentDueAt)}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.currentRentalId ? (
                  <NotifyButton
                    rentalId={row.currentRentalId}
                    idempotencyKey={notifyKeys[row.currentRentalId]}
                    action={notifyAction}
                  />
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WaitlistTable({ snapshot }: { snapshot: AdminDashboardSnapshot }) {
  if (!snapshot.waitlist.length) {
    return (
      <p role="status" className="py-10 text-center text-slate-600">
        The current waitlist is empty.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
        <caption className="sr-only">Current waitlist for the session</caption>
        <thead>
          <tr className="text-slate-600">
            {[
              "Position",
              "Student",
              "Panther ID",
              "Email",
              "Phone",
              "Joined",
            ].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="border-b border-slate-200 px-3 py-3 font-bold"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {snapshot.waitlist.map((row) => (
            <tr key={row.queueEntryId} className="text-slate-800">
              <th
                scope="row"
                className="border-b border-slate-100 px-3 py-4 font-bold"
              >
                {row.position}
              </th>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.fullName}
              </td>
              <td className="border-b border-slate-100 px-3 py-4 font-mono">
                {row.pantherId}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.email}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {row.phone}
              </td>
              <td className="border-b border-slate-100 px-3 py-4">
                {formatAdminDateTime(row.joinedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ snapshot }: { snapshot: AdminDashboardSnapshot }) {
  const cards = [
    ["Total inventory", snapshot.overview.totalBins],
    ["Available", snapshot.overview.availableBins],
    ["Reserved", snapshot.overview.reservedBins],
    ["Checked out", snapshot.overview.checkedOutBins],
    ["Currently late", snapshot.overview.currentLateRentals],
    ["Waiting", snapshot.overview.currentWaitlist],
  ] as const;
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map(([label, value]) => (
        <div
          key={label}
          className="rounded-xl border border-slate-200 bg-slate-50 p-5"
        >
          <dt className="text-sm font-bold text-slate-600">{label}</dt>
          <dd className="mt-2 text-3xl font-black text-slate-950">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SelectedTable({
  view,
  snapshot,
  notifyAction,
  notifyKeys,
}: {
  view: AdminViewKey;
  snapshot: AdminDashboardSnapshot;
  notifyAction: AdminMutationAction;
  notifyKeys: Record<string, string>;
}) {
  switch (view) {
    case "overview":
      return <Overview snapshot={snapshot} />;
    case "current-late":
      return (
        <RentalTable
          caption="Current late rentals"
          rows={snapshot.currentLateRentals}
          notifyAction={notifyAction}
          notifyKeys={notifyKeys}
        />
      );
    case "all-late":
      return (
        <RentalTable
          caption="All late rentals in the session"
          rows={snapshot.allLateRentals}
          notifyAction={notifyAction}
          notifyKeys={notifyKeys}
        />
      );
    case "checked-out":
      return (
        <RentalTable
          caption="Currently checked out rentals"
          rows={snapshot.currentOutRentals}
          notifyAction={notifyAction}
          notifyKeys={notifyKeys}
        />
      );
    case "inventory":
      return (
        <InventoryTable
          rows={snapshot.inventory}
          notifyAction={notifyAction}
          notifyKeys={notifyKeys}
        />
      );
    case "rentals":
      return (
        <RentalTable
          caption="All rentals in the session"
          rows={snapshot.sessionRentals}
          notifyAction={notifyAction}
          notifyKeys={notifyKeys}
        />
      );
    case "waitlist":
      return <WaitlistTable snapshot={snapshot} />;
  }
}

export function AdminDashboard(props: AdminDashboardProps) {
  const { snapshot } = props;
  const [view, setView] = useState<AdminViewKey>("overview");
  const session = snapshot.session;

  return (
    <div className="mx-auto max-w-[96rem]">
      <header className="rounded-[2rem] bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-300/50 sm:px-9">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-300">
          Panther Carts
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Admin Dashboard
          </h1>
          {session && (
            <span className="rounded-full border border-white/30 bg-white/10 px-3 py-1 text-sm font-bold">
              Session status: {session.status}
            </span>
          )}
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          Manage the current rental session, inventory, reporting, and Ticket 4
          notification intents.
        </p>
      </header>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.55fr)]">
        <div className="space-y-6">
          {session ? (
            <Panel title={session.name}>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                <span>
                  <strong className="text-slate-900">Status:</strong>{" "}
                  {session.status}
                </span>
                <span>
                  <strong className="text-slate-900">Created:</strong>{" "}
                  {formatAdminDateTime(session.createdAt)}
                </span>
                <span>
                  <strong className="text-slate-900">Started:</strong>{" "}
                  {formatAdminDateTime(session.startedAt)}
                </span>
                <span>
                  <strong className="text-slate-900">Ended:</strong>{" "}
                  {formatAdminDateTime(session.endedAt)}
                </span>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <AccessDetails
                  label="Student signup"
                  code={session.studentCode}
                  link={session.studentLink}
                />
                <AccessDetails
                  label="Staff access"
                  code={session.staffCode}
                  link={session.staffLink}
                />
              </div>
              {session.status !== "CLOSED" && (
                <ConfigurationForm
                  action={props.configureSessionAction}
                  rentalDurationMinutes={session.rentalDurationMinutes}
                  pickupWindowMinutes={session.pickupWindowMinutes}
                />
              )}
              {session.status === "DRAFT" && (
                <LifecycleButton
                  action={props.startSessionAction}
                  kind="start"
                />
              )}
              {session.status === "ACTIVE" && (
                <LifecycleButton action={props.endSessionAction} kind="end" />
              )}
            </Panel>
          ) : (
            <section className="rounded-[1.5rem] border border-dashed border-slate-300 bg-white p-6 text-slate-700">
              <h2 className="text-xl font-bold text-slate-950">
                No sessions yet
              </h2>
              <p className="mt-2">
                Create a draft to generate access links and begin adding
                inventory.
              </p>
            </section>
          )}

          {(!session || session.status === "CLOSED") && (
            <CreateSessionForm
              action={props.createSessionAction}
              idempotencyKey={props.createSessionIdempotencyKey}
            />
          )}

          {session && session.status !== "CLOSED" && (
            <Panel title="Bin management">
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Numbers are trimmed, leading zeroes are normalized, and
                duplicates are reported without changing existing bins.
              </p>
              <div className="mt-5 grid gap-4 lg:grid-cols-3">
                <BinForm action={props.addBinsAction} mode="single" />
                <BinForm action={props.addBinsAction} mode="range" />
                <BinForm action={props.addBinsAction} mode="paste" />
              </div>
            </Panel>
          )}
        </div>

        <aside className="rounded-[1.5rem] border border-slate-200 bg-white p-6 shadow-sm xl:self-start">
          <h2 className="text-xl font-bold text-slate-950">Status key</h2>
          <ul className="mt-4 grid gap-3 text-sm">
            <li>
              <StatusBadge status="currently-late" text="Checked out — late" />
            </li>
            <li>
              <StatusBadge
                status="checked-out-on-time"
                text="Checked out — on time"
              />
            </li>
            <li>
              <StatusBadge status="returned-late" text="Returned late" />
            </li>
            <li>
              <StatusBadge status="returned-on-time" text="Returned on time" />
            </li>
            <li>
              <StatusBadge status="available" text="Available" />
            </li>
            <li>
              <StatusBadge
                status="reserved"
                text="Reserved — awaiting pickup"
              />
            </li>
          </ul>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            Each color is paired with readable status text.
          </p>
        </aside>
      </div>

      <section
        className="mt-6 rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
        aria-labelledby="admin-table-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2
              id="admin-table-heading"
              className="text-xl font-bold text-slate-950"
            >
              Session tables
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              All rows below are scoped to the displayed session.
            </p>
          </div>
          <label className="min-w-72 text-sm font-bold text-slate-800">
            Table view
            <select
              className={inputClass}
              value={view}
              onChange={(event) => setView(event.target.value as AdminViewKey)}
            >
              {ADMIN_VIEW_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-6">
          <SelectedTable
            view={view}
            snapshot={snapshot}
            notifyAction={props.notifyRentalAction}
            notifyKeys={props.notifyIdempotencyKeys}
          />
        </div>
      </section>
    </div>
  );
}
