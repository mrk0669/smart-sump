// Runs the virtual sump inside the app and feeds the dashboard the same
// things it would get from a real device over MQTT. Every page works
// unchanged; history and reports come from the virtual sump's own log.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { setLocalApi } from "../lib/api";
import { SumpContext } from "../lib/sump";
import type { Device } from "../lib/types";
import { LAB, PROFILES } from "../sim/profiles";
import { localApi, VirtualDevice } from "../sim/virtual";
import type { Profile } from "../sim/virtual";

const TICK_MS = 250;   // redraw 4 times a second, however fast the simulation runs
export const SPEEDS = [1, 10, 60, 300, 1000];

/** True physical values, for smooth animation (the controller's telemetry
 *  only updates every 2 simulated seconds and includes sensor noise). */
export interface Live {
  sumpPct: number;
  tankPct: number;
  flowLpm: number;
  inflowLpm: number;
  suctionBlocked: boolean;
  outletBlocked: boolean;
}

interface SimCtx {
  profiles: Profile[];
  profile: Profile;
  setProfile: (p: Profile) => void;
  scenario: string;
  setScenario: (s: string) => void;   // restarts with that scenario
  speed: number;
  setSpeed: (n: number) => void;
  running: boolean;
  setRunning: (b: boolean) => void;
  inflow: number;
  setInflow: (lpm: number) => void;   // take over the rain: switches to "custom" without restarting
  restart: () => void;
  simSeconds: number;
  live: Live | null;
}

const SimContext = createContext<SimCtx | null>(null);
export const useSimOptional = () => useContext(SimContext);
export function useSim(): SimCtx {
  const c = useContext(SimContext);
  if (!c) throw new Error("useSim must be used inside <VirtualProvider>");
  return c;
}

interface View {
  device: Device;
  simSeconds: number;
  eventTick: number;
  scenario: string;
  live: Live;
}

function snapshot(dev: VirtualDevice, prev: View | null, fresh: Device["events"]): View {
  const changed = !prev || dev.telemetry !== prev.device.telemetry;
  return {
    device: {
      key: `virtual/${dev.profile.id}`,
      site: "virtual",
      device: dev.profile.id,
      status: dev.status,
      telemetry: dev.telemetry ?? undefined,
      lastMsgAt: changed && dev.telemetry ? Date.now() : prev?.device.lastMsgAt,
      config: dev.ctrl.sp,
      events: [...fresh].reverse().concat(prev?.device.events ?? []).slice(0, 200),
    },
    simSeconds: dev.t,
    eventTick: (prev?.eventTick ?? 0) + (fresh.length ? 1 : 0),
    scenario: dev.scenario.name,
    live: {
      sumpPct: dev.plant.sumpPct,
      tankPct: dev.plant.tankPct,
      flowLpm: dev.plant.flowLpm,
      inflowLpm: dev.last.inflow_lpm,
      suctionBlocked: dev.last.suction_blocked,
      outletBlocked: dev.last.outlet_blocked,
    },
  };
}

export function VirtualProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>(PROFILES);
  const [profile, setProfileState] = useState<Profile>(LAB);
  const [scenarioReq, setScenarioReq] = useState("normal");
  const [speed, setSpeed] = useState(LAB.defaultSpeed);
  const [running, setRunning] = useState(true);
  const [inflow, setInflowState] = useState(LAB.baseInflowLpm);
  const [generation, setGeneration] = useState(0);
  const devRef = useRef<VirtualDevice | null>(null);
  const [view, setView] = useState<View | null>(null);

  const publish = useCallback((reset = false) => {
    const dev = devRef.current;
    if (!dev) return;
    const fresh = dev.takeDelivered();
    setView((prev) => snapshot(dev, reset ? null : prev, fresh));
  }, []);

  // A new virtual sump whenever the site, the chosen scenario or "Restart" changes.
  useEffect(() => {
    const dev = new VirtualDevice(profile, scenarioReq);
    if (scenarioReq === "custom") dev.inflowOverride = inflow;
    dev.advance(2);   // first readings, so the screen isn't empty
    devRef.current = dev;
    setLocalApi((path, init) => localApi(dev, path, init));
    publish(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, scenarioReq, generation, publish]);

  // The clock: run `speed` simulated seconds per real second.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      devRef.current?.advance((speed * TICK_MS) / 1000);
      publish();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, speed, publish]);

  const send = useCallback((cmd: "mode" | "pump" | "reset" | "config", payload: object) => {
    const dev = devRef.current;
    if (!dev) return false;
    dev.command(cmd, payload);
    if (!running) {
      dev.tick();   // paused: still process the command
      publish();
    }
    return true;
  }, [running, publish]);

  const setProfile = useCallback((p: Profile) => {
    setProfiles((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
    setProfileState(p);
    setSpeed(p.defaultSpeed);
    setInflowState(p.baseInflowLpm);
  }, []);

  const setInflow = useCallback((lpm: number) => {
    setInflowState(lpm);
    const dev = devRef.current;
    if (!dev) return;
    if (dev.scenario.name !== "custom") dev.switchScenario("custom");
    dev.inflowOverride = lpm;
    publish();
  }, [publish]);

  const sim: SimCtx = {
    profiles, profile, setProfile,
    scenario: view?.scenario ?? scenarioReq,
    setScenario: (s) => {
      setScenarioReq(s);
      setGeneration((n) => n + 1);   // restart even if it's the same scenario again
    },
    speed, setSpeed, running, setRunning,
    inflow, setInflow,
    restart: () => setGeneration((n) => n + 1),
    simSeconds: view?.simSeconds ?? 0,
    live: view?.live ?? null,
  };

  const sump = useMemo(() => ({
    conn: "connected" as const,
    error: null,
    devices: view ? [view.device] : [],
    device: view?.device,
    select: () => {},
    send,
    eventTick: view?.eventTick ?? 0,
    clock: () => devRef.current?.now ?? Date.now() / 1000,
    virtual: true,
  }), [view, send]);

  return (
    <SimContext.Provider value={sim}>
      <SumpContext.Provider value={sump}>{children}</SumpContext.Provider>
    </SimContext.Provider>
  );
}
