// The live picture of the system: sump -> pump -> sedimentation tank -> filling
// point. Water levels fill to the real %, the impeller spins and the pipes
// animate while water is moving. It is a schematic, not to scale.

import type { Setpoints, Telemetry } from "../lib/types";

// Geometry (SVG units; the viewBox scales to the screen width).
const GROUND = 110;
const PIT = { top: GROUND, bottom: 250, left: 20, right: 190, inset: 18 };
const TANK = { left: 370, right: 520, top: 20, bottom: 110 };
const PUMP = { x: 265, y: 84, r: 22 };
const TANK_OUTLET_PCT = 25; // outlet pipe height (water below it settles)

const LOCKED = new Set(["LOCKOUT_DRY", "LOCKOUT_TANK"]);

export function SystemDiagram({ t, config, online }: {
  t?: Telemetry;
  config?: Setpoints;
  online: boolean;
}) {
  const sump = t?.sump_pct ?? null;
  const tank = t?.tank_pct ?? null;
  const pumpOn = !!t?.pump_on;
  const flowing = online && pumpOn && (t?.flow_lpm ?? 0) > 1;
  const outletFlowing = online && tank != null && tank > TANK_OUTLET_PCT + 1;
  const locked = !!t && (LOCKED.has(t.state) || t.state === "FAULT_SENSOR");
  const start = config?.sump_start_pct ?? 80;
  const stop = config?.sump_stop_pct ?? 20;
  const tankHigh = config?.tank_high_pct ?? 90;

  const pitDepth = PIT.bottom - PIT.top;
  const sumpY = (p: number) => PIT.bottom - (pitDepth * p) / 100;
  const tankDepth = TANK.bottom - TANK.top;
  const tankY = (p: number) => TANK.bottom - (tankDepth * p) / 100;
  const outletY = tankY(TANK_OUTLET_PCT);

  const pitPath = `M${PIT.left} ${PIT.top} L${PIT.left + PIT.inset} ${PIT.bottom} L${PIT.right - PIT.inset} ${PIT.bottom} L${PIT.right} ${PIT.top}`;
  const suction = `M150 ${PIT.bottom - 12} V${PUMP.y} H${PUMP.x - PUMP.r}`;
  const delivery = `M${PUMP.x} ${PUMP.y - PUMP.r} V14 H410 V${TANK.top + 14}`;
  const outlet = `M${TANK.right} ${outletY} H565 V${outletY + 8}`;

  const pumpRing = locked ? "stroke-crit" : pumpOn ? "stroke-good" : "stroke-muted";
  const pumpWord = locked ? "LOCKED OUT" : pumpOn ? "RUNNING" : "STOPPED";

  return (
    <svg viewBox="0 0 600 270" className="h-auto w-full select-none" role="img"
      aria-label={`Sump ${sump ?? "unknown"} %, pump ${pumpWord.toLowerCase()}, tank ${tank ?? "unknown"} %`}>
      <defs>
        <clipPath id="pit-clip">
          <path d={`${pitPath} Z`} />
        </clipPath>
      </defs>

      {/* ground and the excavated pit */}
      <rect x="0" y={GROUND} width="340" height="160" className="fill-[var(--earth)]" opacity="0.55" />
      <path d={`${pitPath} Z`} className="fill-page" />
      {sump != null && (
        <g clipPath="url(#pit-clip)">
          <rect x={PIT.left} y={sumpY(sump)} width={PIT.right - PIT.left} height={pitDepth}
            className="fill-water transition-all duration-700" opacity="0.85" />
          <line x1={PIT.left} x2={PIT.right} y1={sumpY(sump)} y2={sumpY(sump)}
            className="stroke-[var(--water-deep)] transition-all duration-700" strokeWidth="2" />
        </g>
      )}
      <path d={pitPath} fill="none" className="stroke-ink-2" strokeWidth="3" strokeLinejoin="round" />
      <line x1="0" x2="340" y1={GROUND} y2={GROUND} className="stroke-ink-2" strokeWidth="2" />

      {/* start / stop set-points inside the sump */}
      {[{ p: start, label: `start ${start}%` }, { p: stop, label: `stop ${stop}%` }].map(({ p, label }) => (
        <g key={label}>
          <line x1={PIT.left + 4} x2={PIT.right - 4} y1={sumpY(p)} y2={sumpY(p)}
            className="stroke-ink-2" strokeWidth="1.5" strokeDasharray="5 4" />
          <text x={PIT.left + 8} y={sumpY(p) - 5} className="fill-ink-2 text-[13px]">{label}</text>
        </g>
      ))}

      {/* pipes: grey pipe, with moving water drawn over it while flowing */}
      {[suction, delivery].map((d) => (
        <g key={d}>
          <path d={d} fill="none" className="stroke-[var(--axis)]" strokeWidth="9" strokeLinejoin="round" />
          {flowing && <path d={d} fill="none" className="water-flow stroke-water" strokeWidth="5" strokeLinejoin="round" />}
        </g>
      ))}
      <path d={outlet} fill="none" className="stroke-[var(--axis)]" strokeWidth="7" strokeLinejoin="round" />
      {outletFlowing && <path d={outlet} fill="none" className="water-flow stroke-water" strokeWidth="3.5" />}

      {/* pump */}
      <rect x={PUMP.x - 30} y={GROUND - 4} width="60" height="6" rx="1" className="fill-ink-2" />
      <circle cx={PUMP.x} cy={PUMP.y} r={PUMP.r} className={`fill-raised ${pumpRing}`} strokeWidth="4" />
      <g className={pumpOn ? "impeller-spin" : ""}>
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <path key={a} d={`M${PUMP.x} ${PUMP.y} q 4 -8 0 -15`} fill="none" className="stroke-ink-2"
            strokeWidth="3" strokeLinecap="round" transform={`rotate(${a} ${PUMP.x} ${PUMP.y})`} />
        ))}
        <circle cx={PUMP.x} cy={PUMP.y} r="4" className="fill-ink-2" />
      </g>

      {/* sedimentation tank with baffles */}
      <rect x={TANK.left - 8} y={TANK.bottom} width={TANK.right - TANK.left + 16} height="6" className="fill-ink-2" />
      {tank != null && (
        <rect x={TANK.left + 2} y={tankY(tank)} width={TANK.right - TANK.left - 4}
          height={Math.max(0, TANK.bottom - tankY(tank))} className="fill-water transition-all duration-700" opacity="0.85" />
      )}
      <line x1={TANK.left + 50} x2={TANK.left + 50} y1={TANK.top + 4} y2={TANK.bottom - 30} className="stroke-ink-2" strokeWidth="2" />
      <line x1={TANK.left + 100} x2={TANK.left + 100} y1={TANK.top + 30} y2={TANK.bottom} className="stroke-ink-2" strokeWidth="2" />
      <line x1={TANK.left} x2={TANK.right} y1={tankY(tankHigh)} y2={tankY(tankHigh)}
        className="stroke-ink-2" strokeWidth="1.5" strokeDasharray="5 4" />
      <text x={TANK.right - 4} y={tankY(tankHigh) - 4} textAnchor="end" className="fill-ink-2 text-[13px]">full {tankHigh}%</text>
      <path d={`M${TANK.left} ${TANK.top} V${TANK.bottom} H${TANK.right} V${TANK.top}`} fill="none"
        className="stroke-ink-2" strokeWidth="3" strokeLinejoin="round" />

      {/* filling point: tap and a water stream when the tank outlet runs */}
      <rect x="553" y={outletY + 6} width="24" height="6" rx="2" className="fill-ink-2" />
      {outletFlowing && (
        <line x1="565" x2="565" y1={outletY + 14} y2="128" className="water-flow stroke-water" strokeWidth="4" />
      )}
      <path d="M545 128 h40 l-4 18 h-32 z" className="fill-raised stroke-ink-2" strokeWidth="2" />

      {/* labels */}
      <text x={(PIT.left + PIT.right) / 2} y={PIT.bottom + 18} textAnchor="middle" className="fill-ink text-[15px] font-semibold">
        Sump {sump == null ? "?" : `${sump.toFixed(0)}%`}
      </text>
      <text x={PUMP.x} y={GROUND + 28} textAnchor="middle" className="fill-ink text-[15px] font-semibold">Pump</text>
      <text x={PUMP.x} y={GROUND + 46} textAnchor="middle" className="fill-ink-2 text-[13px]">
        {pumpWord}{pumpOn && t ? ` · ${t.flow_lpm.toFixed(0)} L/min` : ""}
      </text>
      <text x={(TANK.left + TANK.right) / 2} y={GROUND + 28} textAnchor="middle" className="fill-ink text-[15px] font-semibold">
        Tank {tank == null ? "?" : `${tank.toFixed(0)}%`}
      </text>
      <text x={(TANK.left + TANK.right) / 2} y={GROUND + 46} textAnchor="middle" className="fill-ink-2 text-[13px]">sedimentation</text>
      <text x="565" y="164" textAnchor="middle" className="fill-ink text-[15px] font-semibold">Filling</text>
      <text x="565" y="182" textAnchor="middle" className="fill-ink-2 text-[13px]">point</text>
    </svg>
  );
}
