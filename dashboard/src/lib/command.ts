// Send a command and follow it until the device answers.
//
// MQTT is fire-and-forget: "sent" does not mean "done". So after sending we
// watch what the device reports: either the change shows up in its telemetry
// or config (confirmed), or it publishes a CMD_REJECTED event with the reason,
// or nothing happens for 10 s (device offline?).

import { useEffect, useRef, useState } from "react";
import type { Device, SumpEvent } from "./types";
import { useNow, useSump } from "./sump";

const TIMEOUT_MS = 10_000;

interface Pending {
  label: string;
  sentAt: number;
  lastEventBefore: SumpEvent | undefined;
  confirmed: (d: Device) => boolean;
}

export interface CommandResult {
  ok: boolean;
  text: string;
}

export function useCommand() {
  const { send, device } = useSump();
  const now = useNow(500);
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const deviceRef = useRef(device);
  deviceRef.current = device;

  useEffect(() => {
    if (!pending || !device) return;
    if (pending.confirmed(device)) {
      setResult({ ok: true, text: `${pending.label}: confirmed by the device.` });
      setPending(null);
      return;
    }
    const cut = pending.lastEventBefore ? device.events.indexOf(pending.lastEventBefore) : device.events.length;
    const fresh = device.events.slice(0, cut < 0 ? device.events.length : cut);
    const rejected = fresh.find((e) => e.type === "CMD_REJECTED");
    if (rejected) {
      setResult({ ok: false, text: `Refused by the device: ${rejected.reason}` });
      setPending(null);
    } else if (now - pending.sentAt > TIMEOUT_MS) {
      setResult({ ok: false, text: `${pending.label}: no answer from the device in 10 s. Is it online?` });
      setPending(null);
    }
  }, [device, now, pending]);

  function run(label: string, cmd: "mode" | "pump" | "reset" | "config", payload: object,
               confirmed: (d: Device) => boolean) {
    setResult(null);
    const d = deviceRef.current;
    if (!send(cmd, payload)) {
      setResult({ ok: false, text: "Not connected to the broker." });
      return;
    }
    setPending({ label, sentAt: Date.now(), lastEventBefore: d?.events[0], confirmed });
  }

  return { run, pending: pending?.label ?? null, result, clear: () => setResult(null) };
}
