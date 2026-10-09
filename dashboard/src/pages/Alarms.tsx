import { Check, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Badge, Banner, Button, Card, ConfirmDialog, Empty, Segmented, SeverityIcon } from "../components/ui";
import { alarmInfo, type Severity } from "../lib/alarms";
import { api, query, useApi } from "../lib/api";
import { useCommand } from "../lib/command";
import { dateTime } from "../lib/format";
import { useSump } from "../lib/sump";
import type { SumpEvent } from "../lib/types";

type Filter = "all" | "alarms" | "pump" | "changes" | "status";
const GROUP: Record<string, Filter> = {
  ALARM: "alarms", ALARM_CLEAR: "alarms",
  PUMP_START: "pump", PUMP_STOP: "pump",
  MODE_CHANGE: "changes", CONFIG_CHANGE: "changes", CMD_REJECTED: "changes", STATE_CHANGE: "changes",
  STATUS: "status",
};

function describe(e: SumpEvent): { title: string; severity: Severity } {
  switch (e.type) {
    case "ALARM": {
      const a = alarmInfo(e.code ?? "");
      return { title: `Alarm: ${a.label}`, severity: (e.severity as Severity) ?? a.severity };
    }
    case "ALARM_CLEAR": return { title: `Cleared: ${alarmInfo(e.code ?? "").label}`, severity: "good" };
    case "PUMP_START": return { title: "Pump started", severity: "info" };
    case "PUMP_STOP": return { title: "Pump stopped", severity: "info" };
    case "MODE_CHANGE": return { title: `Mode set to ${e.code}`, severity: "info" };
    case "CONFIG_CHANGE": return { title: "Set-points changed", severity: "info" };
    case "CMD_REJECTED": return { title: "Command refused", severity: "warning" };
    case "STATE_CHANGE": return { title: `State: ${e.code}`, severity: "info" };
    case "STATUS": return { title: `Device ${String(e.code).toLowerCase()}`, severity: e.code === "OFFLINE" ? "warning" : "good" };
    default: return { title: e.type, severity: "info" };
  }
}

export function Alarms() {
  const { device, eventTick } = useSump();
  const cmd = useCommand();
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmReset, setConfirmReset] = useState(false);
  const t = device?.telemetry;
  const online = device?.status === "online";

  // History from the logger; refreshed every 10 s and whenever a live event arrives.
  const { data, error, reload } = useApi<SumpEvent[]>(
    device ? `/events?${query({ site: device.site, device: device.device, limit: 300 })}` : null,
    [eventTick], 10_000);
  // Without the logger, fall back to the events seen since this page opened.
  const events = error ? (device?.events ?? []) : (data ?? []);
  const shown = events.filter((e) => (filter === "all" ? e.type !== "STATE_CHANGE" : GROUP[e.type] === filter));

  const ack = async (id: number) => {
    await api(`/events/${id}/ack`, { method: "POST" }).catch(() => undefined);
    reload();
  };

  return (
    <>
      <h1 className="text-xl font-bold">Alarms & events</h1>

      <Card title="Active now">
        {!t ? <Empty>No live data from the device.</Empty> : t.alarms.length === 0 ? (
          <div className="flex items-center gap-2 text-ink-2"><SeverityIcon severity="good" /> No active alarms.</div>
        ) : (
          <ul className="space-y-3">
            {t.alarms.map((code) => {
              const a = alarmInfo(code);
              return (
                <li key={code} className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Badge severity={a.severity}>{a.label}</Badge>
                    <p className="mt-1 text-sm text-ink-2">{a.help}</p>
                  </div>
                  {code === "DRY_RUN" && (
                    <Button onClick={() => setConfirmReset(true)} disabled={!online}>
                      <RotateCcw className="size-4" /> Reset dry run
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {cmd.pending && <div className="mt-3"><Banner severity="info">{cmd.pending}: sent, waiting for the device…</Banner></div>}
        {cmd.result && <div className="mt-3"><Banner severity={cmd.result.ok ? "good" : "critical"}>{cmd.result.text}</Banner></div>}
      </Card>

      <Card title="History" action={
        <Segmented<Filter> label="Filter events" value={filter} onChange={setFilter} options={[
          { value: "all", label: "All" }, { value: "alarms", label: "Alarms" }, { value: "pump", label: "Pump" },
          { value: "changes", label: "Changes" }, { value: "status", label: "Status" },
        ]} />
      }>
        {error && (
          <div className="mb-3">
            <Banner severity="warning">Logger not reachable ({error}): showing only events since this page was opened.</Banner>
          </div>
        )}
        {shown.length === 0 ? <Empty>No events.</Empty> : (
          <ul className="divide-y divide-line">
            {shown.map((e, i) => {
              const d = describe(e);
              return (
                <li key={e.id ?? `${e.ts}-${i}`} className="flex items-start gap-3 py-2.5">
                  <SeverityIcon severity={d.severity} className="mt-0.5 size-5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <span className="font-semibold">{d.title}</span>
                      <span className="text-sm text-muted tabular-nums">{dateTime(e.ts)}</span>
                    </div>
                    <div className="text-sm break-words text-ink-2">{e.reason}</div>
                  </div>
                  {e.type === "ALARM" && e.id != null && (
                    e.acked_ts ? (
                      <span className="flex shrink-0 items-center gap-1 text-sm text-ink-2"><Check className="size-4" /> Acknowledged</span>
                    ) : (
                      <Button className="min-h-9 shrink-0 px-3 text-sm" onClick={() => ack(e.id!)}>Acknowledge</Button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog open={confirmReset} title="Reset the dry-run lockout?" confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          cmd.run("Dry-run reset", "reset", { alarm: "DRY_RUN" }, (d) => !d.telemetry?.alarms.includes("DRY_RUN"));
        }}>
        Only reset after checking the suction line and strainer. If it is still blocked the pump will trip again.
      </ConfirmDialog>
    </>
  );
}
