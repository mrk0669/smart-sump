import { Play, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { SystemDiagram } from "../components/SystemDiagram";
import { SimPanel } from "../virtual/SimPanel";
import { Badge, Banner, Button, Card, ConfirmDialog, Segmented, SeverityIcon } from "../components/ui";
import { alarmInfo, STATE_LABEL, type Severity } from "../lib/alarms";
import { useCommand } from "../lib/command";
import { num } from "../lib/format";
import { useSump } from "../lib/sump";
import type { Mode, Telemetry } from "../lib/types";

type Confirm =
  | { kind: "mode"; mode: Mode }
  | { kind: "pump"; action: "start" | "stop" }
  | { kind: "reset" }
  | null;

export function Overview() {
  const { device, virtual } = useSump();
  const cmd = useCommand();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const t = device?.telemetry;
  const cfg = device?.config;
  const online = device?.status === "online";
  const manual = t?.mode === "MANUAL";
  const warnMin = cfg?.overflow_warn_min ?? 30;

  const doConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "mode")
      cmd.run(`Switch to ${confirm.mode}`, "mode", { mode: confirm.mode }, (d) => d.telemetry?.mode === confirm.mode);
    else if (confirm.kind === "pump")
      cmd.run(`Pump ${confirm.action}`, "pump", { action: confirm.action },
        (d) => d.telemetry?.pump_on === (confirm.action === "start"));
    else
      cmd.run("Dry-run reset", "reset", { alarm: "DRY_RUN" }, (d) => !d.telemetry?.alarms.includes("DRY_RUN"));
    setConfirm(null);
  };

  return (
    <>
      {virtual && <SimPanel />}

      {/* active alarms first: the most important thing on the screen */}
      {t && t.alarms.length > 0 && (
        <div className="space-y-2">
          {t.alarms.map((code) => {
            const a = alarmInfo(code);
            return (
              <Banner key={code} severity={a.severity}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold">{a.label}</div>
                    <div className="text-sm text-ink-2">{a.help}</div>
                  </div>
                  {code === "DRY_RUN" && (
                    <Button onClick={() => setConfirm({ kind: "reset" })} disabled={!online}>
                      <RotateCcw className="size-4" /> Reset
                    </Button>
                  )}
                </div>
              </Banner>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="System" className="lg:col-span-2">
          <SystemDiagram t={t} config={cfg} online={online} />
        </Card>

        <Card title="Control">
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-sm text-ink-2">Mode</div>
              <Segmented<Mode>
                label="Control mode"
                value={t?.mode ?? "AUTO"}
                options={[{ value: "AUTO", label: "AUTO" }, { value: "MANUAL", label: "MANUAL" }]}
                onChange={(mode) => mode !== t?.mode && setConfirm({ kind: "mode", mode })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={!online || !manual || t?.pump_on} onClick={() => setConfirm({ kind: "pump", action: "start" })}>
                <Play className="size-4" /> Start
              </Button>
              <Button disabled={!online || !manual || !t?.pump_on} onClick={() => setConfirm({ kind: "pump", action: "stop" })}>
                <Square className="size-4" /> Stop
              </Button>
            </div>
            <p className="text-sm text-ink-2">
              {manual
                ? "MANUAL: you start and stop the pump. Tank-full and dry-run protection still work."
                : "AUTO: the controller starts and stops the pump by itself. Switch to MANUAL to use Start/Stop."}
            </p>
            {cmd.pending && <Banner severity="info">{cmd.pending}: sent, waiting for the device…</Banner>}
            {cmd.result && <Banner severity={cmd.result.ok ? "good" : "critical"}>{cmd.result.text}</Banner>}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Sump level" value={num(t?.sump_pct, 0)} unit="%" swatch="bg-sump"
          sub={t?.sump_pct == null ? (t ? "sensor fault" : "") : `${num(t.sump_cm, 0)} cm of water`} />
        <Stat label="Tank level" value={num(t?.tank_pct, 0)} unit="%" swatch="bg-tank"
          sub={cfg ? `full at ${cfg.tank_high_pct}%` : ""} />
        <PumpStat t={t} />
        <Stat label="Flow" value={num(t?.flow_lpm, 1)} unit="L/min" swatch="bg-flow" />
        <Stat label="Pump current" value={num(t?.current_a, 1)} unit="A" swatch="bg-amps"
          sub={cfg ? `dry below ${cfg.dry_run_current_a} A` : ""} />
        <OverflowStat t={t} warnMin={warnMin} />
      </div>

      <ConfirmDialog
        open={confirm != null}
        title={
          confirm?.kind === "mode" ? `Switch to ${confirm.mode}?` :
          confirm?.kind === "pump" ? `${confirm.action === "start" ? "Start" : "Stop"} the pump?` : "Reset the dry-run lockout?"
        }
        confirmLabel={confirm?.kind === "pump" ? (confirm.action === "start" ? "Start pump" : "Stop pump") : "Yes, do it"}
        tone={confirm?.kind === "pump" && confirm.action === "stop" ? "danger" : "primary"}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.kind === "mode" && confirm.mode === "MANUAL" &&
          "The level set-points will be ignored and the pump will only start or stop when you press the buttons. Safety interlocks stay active."}
        {confirm?.kind === "mode" && confirm.mode === "AUTO" &&
          "The controller takes over and runs the pump from the level set-points."}
        {confirm?.kind === "pump" && confirm.action === "start" &&
          "Make sure the area around the pump and the delivery line is clear."}
        {confirm?.kind === "pump" && confirm.action === "stop" && "The pump will stop now."}
        {confirm?.kind === "reset" &&
          "Only reset after checking the suction line and strainer. If it is still blocked the pump will trip again."}
      </ConfirmDialog>
    </>
  );
}

function Stat({ label, value, unit, sub, swatch, children }: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  swatch?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-1.5 text-sm text-ink-2">
        {swatch && <span className={`size-2.5 rounded-sm ${swatch}`} aria-hidden />}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight">{value}</span>
        {unit && value !== "—" && <span className="text-ink-2">{unit}</span>}
      </div>
      {children}
      {sub && <div className="mt-0.5 text-sm text-ink-2">{sub}</div>}
    </div>
  );
}

function PumpStat({ t }: { t?: Telemetry }) {
  const locked = t && (t.state.startsWith("LOCKOUT") || t.state === "FAULT_SENSOR");
  const sev: Severity = locked ? "critical" : t?.pump_on ? "good" : "info";
  return (
    <Stat label="Pump" value={t ? (t.pump_on ? "ON" : "OFF") : "—"}>
      {t && (
        <div className="mt-1">
          <Badge severity={sev}>{STATE_LABEL[t.state] ?? t.state}</Badge>
        </div>
      )}
    </Stat>
  );
}

function OverflowStat({ t, warnMin }: { t?: Telemetry; warnMin: number }) {
  const tto = t?.tto_min ?? null;
  const risk = t?.alarms.includes("OVERFLOW_RISK") || (tto != null && tto < warnMin);
  const near = !risk && tto != null && tto < warnMin * 2;
  const sev: Severity | null = risk ? "critical" : near ? "warning" : null;
  const value = tto == null ? "—" : tto === 0 ? "now" : tto >= 600 ? ">10 h" : tto.toFixed(tto < 10 ? 1 : 0);
  return (
    <div className={`rounded-xl border p-3 ${risk ? "border-crit/60 bg-crit/10" : near ? "border-warn/70 bg-warn/10" : "border-line bg-surface"}`}>
      <div className="flex items-center gap-1.5 text-sm text-ink-2">
        {sev && <SeverityIcon severity={sev} />}
        Time to overflow
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight">{value}</span>
        {tto != null && tto > 0 && tto < 600 && <span className="text-ink-2">min</span>}
      </div>
      <div className="mt-0.5 text-sm text-ink-2">
        {risk ? "Overflow risk!" : tto == null ? (t?.rate_pct_per_min != null ? "level not rising" : "") :
          `rising ${num(t?.rate_pct_per_min, 1)} %/min`}
      </div>
    </div>
  );
}
