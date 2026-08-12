import {
  SMS_COMMANDS,
  type SmsCommand,
  type SmsComplianceClassification,
} from "./types";

export type ParsedSmsCommand =
  | { kind: "command"; command: SmsCommand }
  | { kind: "compliance"; classification: SmsComplianceClassification }
  | { kind: "unknown" };

const COMPLIANCE_COMMANDS: Record<string, SmsComplianceClassification> = {
  STOP: "STOP",
  START: "START",
  UNSTOP: "START",
  HELP: "HELP",
};

export function parseSmsCommand(body: string): ParsedSmsCommand {
  const normalized = body.trim().toUpperCase();
  const compliance = COMPLIANCE_COMMANDS[normalized];
  if (compliance) return { kind: "compliance", classification: compliance };
  if ((SMS_COMMANDS as readonly string[]).includes(normalized)) {
    return { kind: "command", command: normalized as SmsCommand };
  }
  return { kind: "unknown" };
}
