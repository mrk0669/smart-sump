import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Severity } from "../lib/alarms";

export function Card({ title, action, children, className = "" }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold tracking-wide text-ink-2 uppercase">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// Status colours always come with an icon and a word, never colour alone
// (readable for colour-blind users and in harsh sunlight).
const SEV = {
  critical: { Icon: CircleAlert, ring: "border-crit/50 bg-crit/12", icon: "text-crit" },
  serious: { Icon: TriangleAlert, ring: "border-serious/50 bg-serious/12", icon: "text-serious" },
  warning: { Icon: TriangleAlert, ring: "border-warn/60 bg-warn/15", icon: "text-warn" },
  good: { Icon: CircleCheck, ring: "border-good/50 bg-good/12", icon: "text-good" },
  info: { Icon: Info, ring: "border-line bg-raised", icon: "text-muted" },
} satisfies Record<Severity, unknown>;

export function SeverityIcon({ severity, className = "size-4" }: { severity: Severity; className?: string }) {
  const { Icon, icon } = SEV[severity];
  return <Icon className={`${className} shrink-0 ${icon}`} aria-hidden />;
}

export function Badge({ severity, children }: { severity: Severity; children: ReactNode }) {
  const s = SEV[severity];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium text-ink ${s.ring}`}>
      <SeverityIcon severity={severity} className="size-3.5" />
      {children}
    </span>
  );
}

export function Banner({ severity, children }: { severity: Severity; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border p-3 text-ink ${SEV[severity].ring}`} role="status">
      <SeverityIcon severity={severity} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

type Tone = "primary" | "neutral" | "danger";
const TONE: Record<Tone, string> = {
  primary: "bg-ink text-page hover:opacity-90",
  neutral: "border border-line bg-raised text-ink hover:bg-grid",
  danger: "bg-crit text-white hover:opacity-90",
};

export const buttonClass = (tone: Tone = "neutral") =>
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 font-semibold transition
   disabled:cursor-not-allowed disabled:opacity-40 ${TONE[tone]}`;

export function Button({ tone = "neutral", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return <button {...props} className={`${buttonClass(tone)} ${className}`} />;
}

/** Two-or-more option switch, e.g. AUTO / MANUAL or 1 h / 24 h / 7 d. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-lg border border-line bg-raised p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-9 rounded-md px-4 text-sm font-semibold transition ${
            value === o.value ? "bg-ink text-page" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "Are you sure?" before anything that moves the pump. Uses the native
 *  <dialog> element, so Esc closes it and focus is handled by the browser. */
export function ConfirmDialog({ open, title, children, confirmLabel, tone = "primary", onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: Tone;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(92vw,420px)] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/50"
    >
      <div className="p-5">
        <div className="mb-2 flex items-start justify-between gap-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onCancel} aria-label="Close" className="text-muted hover:text-ink">
            <X className="size-5" />
          </button>
        </div>
        <div className="text-ink-2">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button tone={tone} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-ink-2">{children}</p>;
}
