function minutes(value: number): string {
  return `${Math.max(0, Math.ceil(value))} min`;
}

export function signupWaitingMessage(
  position: number,
  estimatedWaitMinutes: number | null,
): string {
  const wait =
    estimatedWaitMinutes === null
      ? `#${position}; wait TBD.`
      : `#${position}, est ${minutes(estimatedWaitMinutes)}.`;
  return `Panther Carts: Joined. ${wait} Reply TIME for status, CANCEL to leave, or HOLD once after an offer. Msg&data rates may apply. STOP=opt out.`;
}

export function readyMessage(
  pickupCode: string,
  pickupWindowMinutes: number,
): string {
  return `Panther Carts: Cart ready. Code ${pickupCode}; pickup within ${minutes(pickupWindowMinutes)}. Reply HOLD once to defer or CANCEL to leave. Msg&data rates may apply. STOP=opt out.`;
}

export function holdConfirmationMessage(position: number): string {
  return `Panther Carts: HOLD confirmed. You are #${position}. Reply TIME for status or CANCEL to leave. Msg&data rates may apply. STOP=opt out.`;
}

export function timeWaitingMessage(
  position: number,
  estimatedWaitMinutes: number | null,
): string {
  const wait =
    estimatedWaitMinutes === null
      ? `#${position}; wait TBD.`
      : `#${position}, est ${minutes(estimatedWaitMinutes)}.`;
  return `Panther Carts: ${wait} Reply CANCEL to leave. STOP=opt out.`;
}

export function timeReadyMessage(
  pickupCode: string,
  remainingPickupMinutes: number,
): string {
  return `Panther Carts: Cart ready. Code ${pickupCode}; ${minutes(remainingPickupMinutes)} left to pick up. Reply HOLD once or CANCEL to leave. STOP=opt out.`;
}

export function timeRentalMessage(
  binNumber: string,
  minutesFromDue: number,
): string {
  return minutesFromDue < 0
    ? `Panther Carts: Bin ${binNumber} is ${minutes(-minutesFromDue)} overdue. Return it through staff. STOP=opt out.`
    : `Panther Carts: Bin ${binNumber} has ${minutes(minutesFromDue)} remaining. Return it through staff when done. STOP=opt out.`;
}

export const UNKNOWN_COMMAND_MESSAGE =
  "Panther Carts: Reply TIME, HOLD, or CANCEL for queue help. Reply STOP to opt out.";
export const NO_ACTIVE_ENTRY_MESSAGE =
  "Panther Carts: No active queue, reservation, or rental was found. Reply STOP to opt out.";
export const AMBIGUOUS_ENTRY_MESSAGE =
  "Panther Carts: We could not safely match this number to one active session. Contact staff. STOP=opt out.";
export const CHECKED_OUT_CANCEL_MESSAGE =
  "Panther Carts: An active rental cannot be canceled by SMS. Return the cart through staff. STOP=opt out.";
