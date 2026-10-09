import { Download, Printer } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banner, Button, buttonClass, Card, Empty, Segmented } from "../components/ui";
import { alarmInfo } from "../lib/alarms";
import { csvUrl, nowS, query, useApi } from "../lib/api";
import { useSump } from "../lib/sump";

interface Day {
  date: string;
  pump_hours: number;
  volume_m3: number;
  cycles: number;
  energy_kwh: number;
  cost_rs: number;
  alarms: Record<string, number>;
}

export function Reports() {
  const { device } = useSump();
  const [days, setDays] = useState<"7" | "30">("7");
  const id = device ? { site: device.site, device: device.device } : null;
  const { data, error } = useApi<{ tariff_rs_per_kwh: number; days: Day[] }>(
    id ? `/report/daily?${query({ ...id, days })}` : null, [], 60_000);

  const rows = data?.days ?? [];
  const total = rows.reduce(
    (t, d) => ({
      pump_hours: t.pump_hours + d.pump_hours, volume_m3: t.volume_m3 + d.volume_m3, cycles: t.cycles + d.cycles,
      energy_kwh: t.energy_kwh + d.energy_kwh, cost_rs: t.cost_rs + d.cost_rs,
      alarms: t.alarms + Object.values(d.alarms).reduce((a, b) => a + b, 0),
    }),
    { pump_hours: 0, volume_m3: 0, cycles: 0, energy_kwh: 0, cost_rs: 0, alarms: 0 });
  const chart = [...rows].reverse().map((d) => ({ ...d, label: d.date.slice(5) }));
  const th = "px-3 py-2 text-right font-semibold whitespace-nowrap first:text-left";
  const td = "px-3 py-2 text-right tabular-nums whitespace-nowrap first:text-left";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Reports{device ? ` · ${device.key}` : ""}</h1>
        <div className="no-print flex flex-wrap gap-2">
          <Segmented<"7" | "30"> label="Days" value={days} onChange={setDays}
            options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
          <Button onClick={() => print()}><Printer className="size-4" /> Print</Button>
        </div>
      </div>

      {error && <Banner severity="warning">Reports come from the logger, which isn't answering ({error}).</Banner>}

      <Card title="Water pumped per day (m³)">
        {rows.length === 0 ? <Empty>No data yet.</Empty> : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} />
              <YAxis stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} />
              <Tooltip cursor={{ fill: "var(--grid)" }} contentStyle={{ background: "var(--raised)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink)" }}
                formatter={(v) => [`${Number(v).toFixed(3)} m³`, "Pumped"]} />
              <Bar dataKey="volume_m3" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card title="Daily summary">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-ink-2">
              <tr>
                <th className={th}>Date</th><th className={th}>Pump hours</th><th className={th}>Pumped (m³)</th>
                <th className={th}>Starts</th><th className={th}>Energy (kWh)</th><th className={th}>Cost (₹)</th>
                <th className={`${th} !text-left`}>Alarms</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((d) => (
                <tr key={d.date}>
                  <td className={td}>{d.date}</td>
                  <td className={td}>{d.pump_hours.toFixed(2)}</td>
                  <td className={td}>{d.volume_m3.toFixed(2)}</td>
                  <td className={td}>{d.cycles}</td>
                  <td className={td}>{d.energy_kwh.toFixed(2)}</td>
                  <td className={td}>{d.cost_rs.toFixed(2)}</td>
                  <td className="px-3 py-2 text-ink-2">
                    {Object.entries(d.alarms).map(([c, n]) => `${alarmInfo(c).label} ×${n}`).join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="border-t-2 border-line font-semibold">
                <tr>
                  <td className={td}>Total</td>
                  <td className={td}>{total.pump_hours.toFixed(2)}</td>
                  <td className={td}>{total.volume_m3.toFixed(2)}</td>
                  <td className={td}>{total.cycles}</td>
                  <td className={td}>{total.energy_kwh.toFixed(2)}</td>
                  <td className={td}>{total.cost_rs.toFixed(2)}</td>
                  <td className="px-3 py-2">{total.alarms} alarms</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {data && (
          <p className="mt-3 text-sm text-muted">
            Energy = V × I × power factor × run time (× √3 for a three-phase pump), from the measured current.
            Tariff ₹{data.tariff_rs_per_kwh}/kWh, from <code>config/site.yaml</code>.
          </p>
        )}
      </Card>

      {id && (
        <Card title="Download (CSV, opens in Excel)" className="no-print">
          <div className="flex flex-wrap gap-2">
            <a className={buttonClass()} href={csvUrl("report", { ...id, days })}><Download className="size-4" /> Daily report</a>
            <a className={buttonClass()} href={csvUrl("telemetry", { ...id, since: nowS() - 86400 })}><Download className="size-4" /> Readings, last 24 h</a>
            <a className={buttonClass()} href={csvUrl("events", { ...id, since: nowS() - 30 * 86400 })}><Download className="size-4" /> Events, last 30 days</a>
          </div>
        </Card>
      )}
    </>
  );
}
