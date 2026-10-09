// Live connection to the MQTT broker (over WebSocket) and the state of every
// Smart Sump device it hears about. Pages read it with useSump().
//
// The dashboard never decides anything about the pump: it only shows what the
// device reports and sends *requests* (cmd/...). The device applies its own
// safety rules and reports back.

import mqtt, { type MqttClient } from "mqtt";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Device, SumpEvent, Setpoints, Telemetry } from "./types";

export const BASE_TOPIC = "smartsump";
const MAX_LIVE_EVENTS = 200;

export interface Login {
  url: string;
  username: string;
  password: string;
}

export type ConnState = "connecting" | "connected" | "reconnecting" | "auth-failed";

type Action =
  | { kind: "telemetry"; key: string; site: string; device: string; data: Telemetry }
  | { kind: "status"; key: string; site: string; device: string; status: string }
  | { kind: "config"; key: string; site: string; device: string; config: Setpoints }
  | { kind: "event"; key: string; site: string; device: string; event: SumpEvent }
  | { kind: "reset" };

function reducer(state: Record<string, Device>, a: Action): Record<string, Device> {
  if (a.kind === "reset") return {};
  const d: Device = state[a.key] ?? { key: a.key, site: a.site, device: a.device, events: [] };
  switch (a.kind) {
    case "telemetry":
      return { ...state, [a.key]: { ...d, telemetry: a.data, lastMsgAt: Date.now() } };
    case "status":
      return { ...state, [a.key]: { ...d, status: a.status } };
    case "config":
      return { ...state, [a.key]: { ...d, config: a.config } };
    case "event":
      return { ...state, [a.key]: { ...d, events: [a.event, ...d.events].slice(0, MAX_LIVE_EVENTS) } };
  }
}

interface SumpCtx {
  conn: ConnState;
  error: string | null;
  devices: Device[];
  device: Device | undefined;
  select: (key: string) => void;
  /** Publish a command to the selected device. Returns false if not connected. */
  send: (cmd: "mode" | "pump" | "reset" | "config", payload: object) => boolean;
  /** Bumped on every live event, so pages can refresh history from the logger. */
  eventTick: number;
}

const Ctx = createContext<SumpCtx | null>(null);

export function SumpProvider({ login, onAuthFailed, children }: {
  login: Login;
  onAuthFailed: (message: string) => void;
  children: ReactNode;
}) {
  const [devices, dispatch] = useReducer(reducer, {});
  const [conn, setConn] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("smartsump.device"));
  const [eventTick, setEventTick] = useState(0);
  const clientRef = useRef<MqttClient | null>(null);

  useEffect(() => {
    dispatch({ kind: "reset" });
    setConn("connecting");
    const client = mqtt.connect(login.url, {
      username: login.username,
      password: login.password,
      clientId: `dashboard-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
    });
    clientRef.current = client;

    client.on("connect", () => {
      setConn("connected");
      setError(null);
      // Everything from every device. Retained messages (status, config/state)
      // arrive straight away, so the page fills in immediately.
      client.subscribe(`${BASE_TOPIC}/+/+/#`, { qos: 1 });
    });
    client.on("reconnect", () => setConn("reconnecting"));
    client.on("error", (err: Error & { code?: number }) => {
      // CONNACK codes 4/5 (MQTT 3.1.1) or 134/135 (MQTT 5) = bad username/password.
      if ([4, 5, 134, 135].includes(err.code ?? -1) || /not authori[sz]ed|bad user/i.test(err.message)) {
        setConn("auth-failed");
        client.end(true);
        onAuthFailed("The broker refused the username or password.");
      } else {
        setError(err.message);
      }
    });
    client.on("message", (topic, payload) => {
      const parts = topic.split("/");
      if (parts.length < 4 || parts[0] !== BASE_TOPIC) return;
      const [, site, device, ...rest] = parts;
      const what = rest.join("/");
      const key = `${site}/${device}`;
      const text = payload.toString();
      try {
        if (what === "status") dispatch({ kind: "status", key, site, device, status: text.trim() });
        else if (what === "telemetry") dispatch({ kind: "telemetry", key, site, device, data: JSON.parse(text) });
        else if (what === "config/state") dispatch({ kind: "config", key, site, device, config: JSON.parse(text) });
        else if (what === "event") {
          dispatch({ kind: "event", key, site, device, event: JSON.parse(text) });
          setEventTick((n) => n + 1);
        }
      } catch {
        // A malformed message must never break the page; just skip it.
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, [login, onAuthFailed]);

  const list = useMemo(() => Object.values(devices).sort((a, b) => a.key.localeCompare(b.key)), [devices]);

  // The selected device, or the first one that is actually sending data.
  const device =
    (selected && devices[selected]) ||
    list.find((d) => d.telemetry && d.status === "online") ||
    list.find((d) => d.telemetry) ||
    list[0];

  const select = useCallback((key: string) => {
    setSelected(key);
    localStorage.setItem("smartsump.device", key);
  }, []);

  const send = useCallback<SumpCtx["send"]>(
    (cmd, payload) => {
      const client = clientRef.current;
      if (!client?.connected || !device) return false;
      client.publish(`${BASE_TOPIC}/${device.site}/${device.device}/cmd/${cmd}`, JSON.stringify(payload), { qos: 1 });
      return true;
    },
    [device],
  );

  return (
    <Ctx.Provider value={{ conn, error, devices: list, device, select, send, eventTick }}>{children}</Ctx.Provider>
  );
}

export function useSump(): SumpCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSump must be used inside <SumpProvider>");
  return ctx;
}

/** Re-render every `ms` milliseconds (for "updated 3 s ago" style labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
