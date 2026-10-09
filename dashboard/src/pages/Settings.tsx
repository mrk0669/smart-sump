// Set-point editor. Saving sends cmd/config; the change only counts as done
// when the device publishes the new values back on config/state.

import { Save, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Card, ConfirmDialog, Empty } from "../components/ui";
import { useCommand } from "../lib/command";
import { ALL_FIELDS, GROUPS, validate } from "../lib/limits";
import { useSump } from "../lib/sump";
import type { Setpoints } from "../lib/types";

type Form = Record<string, string>;
const toForm = (c: Setpoints): Form => Object.fromEntries(ALL_FIELDS.map((f) => [f.key, String(c[f.key])]));

export function Settings() {
  const { device } = useSump();
  const cmd = useCommand();
  const cfg = device?.config;
  const online = device?.status === "online";
  const [form, setForm] = useState<Form | null>(null);
  const [confirm, setConfirm] = useState(false);

  // Load the device's values; reload them when they change, unless the
  // operator is in the middle of editing.
  const dirty = !!form && !!cfg && ALL_FIELDS.some((f) => Number(form[f.key]) !== cfg[f.key]);
  useEffect(() => {
    if (cfg && (!form || !dirty)) setForm(toForm(cfg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  const errors = useMemo(() => (form ? validate(form) : {}), [form]);
  const changes = useMemo(() => {
    if (!form || !cfg) return {} as Partial<Setpoints>;
    return Object.fromEntries(ALL_FIELDS.filter((f) => Number(form[f.key]) !== cfg[f.key])
      .map((f) => [f.key, Number(form[f.key])])) as Partial<Setpoints>;
  }, [form, cfg]);
  const nChanges = Object.keys(changes).length;
  const hasErrors = Object.keys(errors).length > 0;

  if (!cfg || !form)
    return <Card title="Set-points"><Empty>Waiting for the device to report its set-points (config/state)…</Empty></Card>;

  const save = () => {
    setConfirm(false);
    const patch = changes;
    cmd.run("Set-points", "config", patch,
      (d) => !!d.config && Object.entries(patch).every(([k, v]) => d.config![k as keyof Setpoints] === v));
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Set-points</h1>
        <div className="flex gap-2">
          <Button onClick={() => setForm(toForm(cfg))} disabled={!dirty}><Undo2 className="size-4" /> Undo</Button>
          <Button tone="primary" onClick={() => setConfirm(true)} disabled={!dirty || hasErrors || !online || !!cmd.pending}>
            <Save className="size-4" /> Save{nChanges ? ` (${nChanges})` : ""}
          </Button>
        </div>
      </div>

      {!online && <Banner severity="warning">The device is offline. Changes can't be sent until it reconnects.</Banner>}
      {cmd.pending && <Banner severity="info">Sent. Waiting for the device to confirm the new values…</Banner>}
      {cmd.result && <Banner severity={cmd.result.ok ? "good" : "critical"}>{cmd.result.text}</Banner>}

      <div className="grid gap-4 md:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title} title={g.title}>
            <div className="space-y-4">
              {g.fields.map((f) => {
                const changed = Number(form[f.key]) !== cfg[f.key];
                return (
                  <label key={f.key} className="block">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{f.label}</span>
                      {changed && <span className="text-sm text-ink-2">device: {cfg[f.key]} {f.unit}</span>}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step}
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        aria-invalid={!!errors[f.key]}
                        className={`min-h-11 w-32 rounded-lg border bg-raised px-3 text-lg font-semibold text-ink ${
                          errors[f.key] ? "border-crit" : changed ? "border-ink" : "border-line"}`}
                      />
                      <span className="text-ink-2">{f.unit}</span>
                    </div>
                    {errors[f.key]
                      ? <div className="mt-1 text-sm font-medium text-crit">{errors[f.key]}</div>
                      : <div className="mt-1 text-sm text-muted">{f.help}</div>}
                  </label>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      <ConfirmDialog open={confirm} title="Send new set-points?" confirmLabel="Send to device"
        onCancel={() => setConfirm(false)} onConfirm={save}>
        <ul className="list-disc space-y-1 pl-5">
          {ALL_FIELDS.filter((f) => f.key in changes).map((f) => (
            <li key={f.key}>{f.label}: {cfg[f.key]} → <b className="text-ink">{changes[f.key]}</b> {f.unit}</li>
          ))}
        </ul>
        <p className="mt-2">The device checks them again before using them.</p>
      </ConfirmDialog>
    </>
  );
}
