// What each alarm code means, in plain words, and how serious it is.
// Severity matches simulator/control.py ALARM_SEVERITY.

export type Severity = "critical" | "serious" | "warning" | "good" | "info";

export const ALARM_INFO: Record<string, { label: string; severity: Severity; help: string }> = {
  TANK_FULL: {
    label: "Tank full",
    severity: "critical",
    help: "Sedimentation tank at its limit. The pump is locked off until the tank drains.",
  },
  DRY_RUN: {
    label: "Dry run / blockage",
    severity: "critical",
    help: "The pump ran with too little current or flow. Check the suction and strainer, then reset.",
  },
  OVERFLOW_RISK: {
    label: "Overflow risk",
    severity: "critical",
    help: "At the current rise rate the sump will overflow soon.",
  },
  SENSOR_FAULT: {
    label: "Level sensor fault",
    severity: "warning",
    help: "No valid ultrasonic reading. Control has fallen back to the float switches.",
  },
  INFLOW_EXCEEDS_PUMP: {
    label: "Inflow exceeds pump",
    severity: "warning",
    help: "The level keeps rising although the pump is running.",
  },
};

export function alarmInfo(code: string) {
  return ALARM_INFO[code] ?? { label: code, severity: "warning" as Severity, help: "" };
}

export const STATE_LABEL: Record<string, string> = {
  IDLE: "Idle",
  PUMPING: "Pumping",
  LOCKOUT_DRY: "Locked out: dry run",
  LOCKOUT_TANK: "Locked out: tank full",
  MANUAL: "Manual control",
  FAULT_SENSOR: "Sensor fault: floats only",
};
