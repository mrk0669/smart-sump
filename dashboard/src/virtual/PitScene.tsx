// "Touch the pit": an animated cross-section of an opencast mine pit that you
// play with. Drag the rain cloud down for a storm, tap the pump to drive it.
// It draws the virtual sump's TRUE physical state (smooth), while the
// controller's view (state, alarms) decides badges and locks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Setpoints, Telemetry } from "../lib/types";
import type { Live } from "./VirtualProvider";

export const VIEW = { w: 420, h: 500 };

// Pit outline, left rim -> benches -> sump -> benches -> right rim.
const LEFT = [[0, 170], [28, 170], [50, 225], [76, 225], [96, 280], [118, 280], [130, 330], [138, 330]];
const SUMP = { topL: 138, topR: 218, botL: 146, botR: 210, top: 330, bot: 470 };
const RIGHT = [[218, 330], [226, 330], [238, 280], [260, 280], [280, 225], [306, 225], [328, 170], [420, 170]];
const SUMP_DEPTH = SUMP.bot - SUMP.top;

export const PUMP = { x: 249, y: 268 };
const INTAKE = { x: 200, y: 458 };
const TANK = { l: 334, r: 374, top: 110, bot: 170 };
const TANK_OUTLET_PCT = 25;

const CLOUD_Y = { min: 26, max: 96 };   // dragging down = heavier rain
const CLOUD_X = { min: 70, max: 300 };

const pts = (a: number[][]) => a.map(([x, y]) => `${x},${y}`).join(" ");
const earthPolygon = pts([...LEFT, [SUMP.botL, SUMP.bot], [SUMP.botR, SUMP.bot], ...RIGHT, [420, 500], [0, 500]]);
const sumpPolygon = pts([[SUMP.topL, SUMP.top], [SUMP.topR, SUMP.top], [SUMP.botR, SUMP.bot], [SUMP.botL, SUMP.bot]]);
const outline = [...LEFT, [SUMP.botL, SUMP.bot], [SUMP.botR, SUMP.bot], ...RIGHT];

/** Height of the ground (or water) under x, where a raindrop lands. */
function groundY(x: number, waterY: number): number {
  if (x > SUMP.topL && x < SUMP.topR) return waterY;
  for (let i = 0; i < outline.length - 1; i++) {
    const [x1, y1] = outline[i], [x2, y2] = outline[i + 1];
    if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && x1 !== x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return 170;
}

// A long wavy water surface; it slides sideways (CSS) for a living surface.
const WAVE = (() => {
  let d = "M120 0";
  for (let x = 120; x < 260; x += 16) d += " q4 -2.2 8 0 t8 0";
  return `${d} L256 160 L120 160 Z`;
})();

export function intensityToInflow(i: number, base: number, max: number) {
  return base + (max - base) * Math.pow(i, 1.5);
}
export function inflowToIntensity(lpm: number, base: number, max: number) {
  return max <= base ? 0 : Math.pow(Math.min(1, Math.max(0, (lpm - base) / (max - base))), 1 / 1.5);
}

export function PitScene({ live, t, config, intensity, onIntensity, onPumpTap, rainLabel, pumpCapLabel, inflowRatio, pumpCapLpm }: {
  live: Live;
  t?: Telemetry;
  config?: Setpoints;
  intensity: number;                 // 0 = seepage only, 1 = heaviest storm
  onIntensity: (i: number) => void;
  onPumpTap: () => void;
  rainLabel: string;
  pumpCapLabel: string;
  inflowRatio: number;               // inflow / pump capacity
  pumpCapLpm: number;                // rated pump flow
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [cloudX, setCloudX] = useState(175);
  const [dragging, setDragging] = useState(false);
  // A ref (not just state): move events can arrive before React re-renders
  // after the touch starts, and must not be lost.
  const draggingRef = useRef(false);
  const cloudY = CLOUD_Y.min + intensity * (CLOUD_Y.max - CLOUD_Y.min);

  const toSvg = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const moveTo = (e: { clientX: number; clientY: number }) => {
    const p = toSvg(e);
    if (!p) return;
    setCloudX(Math.min(CLOUD_X.max, Math.max(CLOUD_X.min, p.x)));
    const y = Math.min(CLOUD_Y.max, Math.max(CLOUD_Y.min, p.y));
    onIntensity((y - CLOUD_Y.min) / (CLOUD_Y.max - CLOUD_Y.min));
  };
  const onDown = (e: ReactPointerEvent) => {
    draggingRef.current = true;
    setDragging(true);
    try {
      // Keep receiving moves even if the finger slides off the cloud.
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* some WebViews refuse capture on SVG elements: the window listener below still ends the drag */
    }
  };
  const onMove = (e: ReactPointerEvent) => {
    if (draggingRef.current) moveTo(e);
  };
  const onUp = () => {
    draggingRef.current = false;
    setDragging(false);
  };

  const sump = Math.max(0, Math.min(100, live.sumpPct));
  const tank = Math.max(0, Math.min(100, live.tankPct));
  const waterY = SUMP.bot - (SUMP_DEPTH * sump) / 100;
  const tankY = TANK.bot - ((TANK.bot - TANK.top) * tank) / 100;
  const pumpOn = !!t?.pump_on;
  const flowRatio = Math.min(1, live.flowLpm / Math.max(1e-9, pumpCapLpm));
  const flowing = pumpOn && flowRatio > 0.02;
  const dryLock = t?.state === "LOCKOUT_DRY";
  const tankFull = t?.state === "LOCKOUT_TANK" || t?.alarms.includes("TANK_FULL");
  const dryRunning = pumpOn && live.suctionBlocked;
  const overflowing = sump >= 98 || (!!t?.alarms.includes("OVERFLOW_RISK") && sump >= 95);
  const outletFlowing = tank > TANK_OUTLET_PCT + 1 && !live.outletBlocked;
  const start = config?.sump_start_pct ?? 80;
  const stop = config?.sump_stop_pct ?? 20;
  const tankHigh = config?.tank_high_pct ?? 90;

  // Raindrops: stable pseudo-random positions so animations don't restart every frame.
  const drops = useMemo(() => {
    const n = intensity < 0.06 ? 0 : Math.round(6 + intensity * 54);
    return Array.from({ length: n }, (_, i) => ({
      dx: ((i * 53) % 140) - 70,
      delay: ((i * 0.137) % 1).toFixed(3),
      speed: 0.55 + ((i * 7) % 5) * 0.06,
    }));
  }, [intensity]);
  const ripples = useMemo(() => {
    const n = intensity < 0.08 ? 0 : Math.round(2 + intensity * 6);
    return Array.from({ length: n }, (_, i) => ({ x: SUMP.topL + 10 + ((i * 29) % (SUMP.topR - SUMP.topL - 20)), delay: (i * 0.23) % 1.1 }));
  }, [intensity]);

  useEffect(() => {
    if (!dragging) return;
    const up = () => {
      draggingRef.current = false;
      setDragging(false);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragging]);

  const impellerDur = `${(1.4 - 1.1 * Math.min(1, flowRatio)).toFixed(2)}s`;
  const cloudFill = `color-mix(in oklab, var(--cloud-light), var(--cloud-dark) ${Math.round(intensity * 100)}%)`;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} className="block h-auto w-full touch-pan-y select-none"
      role="img" aria-label={`Pit: sump ${sump.toFixed(0)} %, ${pumpOn ? "pump running" : "pump stopped"}, ${rainLabel}`}>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--sky-top)" />
          <stop offset="1" stopColor="var(--sky-bottom)" />
        </linearGradient>
        <clipPath id="sump-clip"><polygon points={sumpPolygon} /></clipPath>
        <clipPath id="tank-clip"><rect x={TANK.l + 2} y={TANK.top} width={TANK.r - TANK.l - 4} height={TANK.bot - TANK.top - 2} /></clipPath>
      </defs>

      {/* sky */}
      <rect width={VIEW.w} height={VIEW.h} fill="url(#sky)" />

      {/* raindrops, behind the earth so they "land" on it */}
      <g stroke="var(--rain)" strokeWidth="1.6" strokeLinecap="round" opacity="0.8">
        {drops.map((d, i) => {
          const x = cloudX + d.dx;
          const y0 = cloudY + 14;
          const fall = Math.max(10, groundY(x, waterY) - y0 - 8);
          return (
            <line key={i} x1={x} x2={x - 1} y1={y0} y2={y0 + 7} className="raindrop"
              style={{ ["--fall" as string]: `${fall}px`, ["--dur" as string]: `${d.speed}s`, ["--delay" as string]: `-${d.delay}s` }} />
          );
        })}
      </g>

      {/* earth with the stepped benches */}
      <polygon points={earthPolygon} fill="var(--earth)" />
      <polyline points={pts(LEFT)} fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinejoin="round" />
      <polyline points={pts(RIGHT)} fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinejoin="round" />

      {/* sump water: a wavy surface that rises and falls with the level */}
      <g clipPath="url(#sump-clip)">
        <g className="water-level" style={{ transform: `translateY(${waterY}px)` }}>
          <path d={WAVE} fill="var(--water)" opacity="0.9" className="wave" />
        </g>
        {ripples.map((r, i) => (
          <ellipse key={i} cx={r.x} cy={waterY} rx="5" ry="1.5" fill="none" stroke="var(--sky-bottom)" strokeWidth="1"
            className="ripple" style={{ ["--delay" as string]: `-${r.delay}s` }} />
        ))}
        {/* suction foam while the pump is pulling water */}
        {flowing && [0, 1, 2, 3].map((i) => (
          <circle key={i} cx={INTAKE.x - 6 + i * 4} cy={INTAKE.y - 2} r="1.6" fill="#ffffff" opacity="0.8"
            className="bubble" style={{ ["--delay" as string]: `-${i * 0.3}s` }} />
        ))}
      </g>
      <polyline points={pts([[SUMP.topL, SUMP.top], [SUMP.botL, SUMP.bot], [SUMP.botR, SUMP.bot], [SUMP.topR, SUMP.top]])}
        fill="none" stroke="var(--ink-2)" strokeWidth="2.5" strokeLinejoin="round" />

      {/* start / stop set-points */}
      {[{ p: start, label: `start ${start}%` }, { p: stop, label: `stop ${stop}%` }].map(({ p, label }) => {
        const y = SUMP.bot - (SUMP_DEPTH * p) / 100;
        return (
          <g key={label}>
            <line x1={SUMP.topL + 2} x2={SUMP.topR - 2} y1={y} y2={y} stroke="var(--ink-2)" strokeWidth="1.2" strokeDasharray="4 3" />
            <text x={SUMP.topR + 6} y={y + 4} fontSize="11" fill="var(--ink-2)">{label}</text>
          </g>
        );
      })}

      {/* overflow: water spills over the lip and floods the pit floor */}
      {overflowing && (
        <g>
          <polygon points="127,316 229,316 226,330 130,330" fill="var(--water)" opacity="0.85" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <circle key={i} cx={i < 3 ? SUMP.topL : SUMP.topR} cy={SUMP.top - 2} r="2" fill="var(--water)"
              className="splash" style={{ ["--dx" as string]: `${i < 3 ? -6 - i * 3 : 6 + (i - 3) * 3}px`, ["--delay" as string]: `-${(i % 3) * 0.25}s` }} />
          ))}
        </g>
      )}

      {/* pipes: suction into the sump, delivery up the benches to the tank, tank outlet to the tanker */}
      {(() => {
        const suction = `M${PUMP.x - 10} ${PUMP.y} H${INTAKE.x} V${INTAKE.y}`;
        const delivery = `M${PUMP.x} ${PUMP.y - 10} V210 H292 V98 H354 V${TANK.top + 4}`;
        const outY = TANK.bot - ((TANK.bot - TANK.top) * TANK_OUTLET_PCT) / 100;
        const outlet = `M${TANK.r} ${outY} H392 V158`;
        return (
          <g fill="none" strokeLinejoin="round">
            {[suction, delivery].map((d) => (
              <g key={d}>
                <path d={d} stroke="var(--axis)" strokeWidth="7" />
                {flowing && <path d={d} stroke="var(--water)" strokeWidth="3.5" className="water-flow" />}
              </g>
            ))}
            <path d={outlet} stroke="var(--axis)" strokeWidth="5" />
            {outletFlowing && <path d={outlet} stroke="var(--water)" strokeWidth="2.5" className="water-flow" />}
            {dryRunning && [0, 1, 2].map((i) => (
              <circle key={i} cx={INTAKE.x} cy={INTAKE.y - 30 - i * 40} r="2.2" fill="var(--sky-bottom)" stroke="var(--axis)"
                className="bubble" style={{ ["--delay" as string]: `-${i * 0.4}s` }} />
            ))}
          </g>
        );
      })()}

      {/* sedimentation tank on the surface */}
      <g>
        <rect x={TANK.l - 4} y={TANK.bot - 1} width={TANK.r - TANK.l + 8} height="5" fill="var(--ink-2)" />
        <g clipPath="url(#tank-clip)">
          <rect x={TANK.l} y={tankY} width={TANK.r - TANK.l} height={TANK.bot - tankY} fill="var(--water)" opacity="0.9"
            style={{ transition: "y .35s linear, height .35s linear" }} />
        </g>
        <line x1={TANK.l + 13} x2={TANK.l + 13} y1={TANK.top + 4} y2={TANK.bot - 18} stroke="var(--ink-2)" strokeWidth="1.5" />
        <line x1={TANK.l + 26} x2={TANK.l + 26} y1={TANK.top + 18} y2={TANK.bot} stroke="var(--ink-2)" strokeWidth="1.5" />
        <line x1={TANK.l} x2={TANK.r} y1={TANK.bot - ((TANK.bot - TANK.top) * tankHigh) / 100} y2={TANK.bot - ((TANK.bot - TANK.top) * tankHigh) / 100}
          stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="3 3" />
        <path d={`M${TANK.l} ${TANK.top} V${TANK.bot} H${TANK.r} V${TANK.top}`} fill="none"
          stroke={tankFull ? "#d03b3b" : "var(--ink-2)"} strokeWidth={tankFull ? 3.5 : 2.5} strokeLinejoin="round" />
        {tankFull && <text x={(TANK.l + TANK.r) / 2} y={TANK.top - 6} textAnchor="middle" fontSize="11" fontWeight="700" fill="#d03b3b">⚠ FULL</text>}
        <text x={(TANK.l + TANK.r) / 2} y={TANK.bot + 16} textAnchor="middle" fontSize="11" fill="var(--ink)">Tank {tank.toFixed(0)}%</text>
      </g>

      {/* filling point: a water tanker */}
      <g>
        <rect x="378" y="158" width="34" height="11" rx="4" fill="var(--raised)" stroke="var(--ink-2)" strokeWidth="1.5" />
        <rect x="410" y="161" width="9" height="8" rx="1.5" fill="var(--ink-2)" />
        <circle cx="386" cy="171" r="3.2" fill="var(--ink)" />
        <circle cx="404" cy="171" r="3.2" fill="var(--ink)" />
        <text x="398" y="186" textAnchor="middle" fontSize="10" fill="var(--ink-2)">filling</text>
      </g>

      {/* pump on its bench; tap target is bigger than the drawing */}
      <g className={dryLock ? "shake" : ""}>
        <rect x={PUMP.x - 13} y={PUMP.y + 10} width="26" height="3" fill="var(--ink-2)" />
        <circle cx={PUMP.x} cy={PUMP.y} r="10.5" fill="var(--raised)"
          stroke={dryLock || tankFull ? "#d03b3b" : pumpOn ? "#0ca30c" : "var(--muted)"} strokeWidth="3" />
        <g className={pumpOn ? "impeller-spin" : ""} style={{ animationDuration: impellerDur }}>
          {[0, 72, 144, 216, 288].map((a) => (
            <path key={a} d={`M${PUMP.x} ${PUMP.y} q3 -4 0 -7`} fill="none" stroke="var(--ink-2)" strokeWidth="1.8"
              strokeLinecap="round" transform={`rotate(${a} ${PUMP.x} ${PUMP.y})`} />
          ))}
          <circle cx={PUMP.x} cy={PUMP.y} r="2" fill="var(--ink-2)" />
        </g>
        {dryLock && (
          <g transform={`translate(${PUMP.x + 8} ${PUMP.y - 18})`}>
            <circle r="7" fill="#d03b3b" />
            <rect x="-3" y="-1" width="6" height="4.5" rx="0.8" fill="#fff" />
            <path d="M-2 -1 v-1.6 a2 2 0 0 1 4 0 v1.6" fill="none" stroke="#fff" strokeWidth="1.2" />
          </g>
        )}
      </g>
      <circle cx={PUMP.x} cy={PUMP.y} r="22" fill="transparent" className="cursor-pointer" onClick={onPumpTap}
        role="button" aria-label="Pump: tap to control" />
      <text x={PUMP.x} y={PUMP.y + 28} textAnchor="middle" fontSize="11" fill="var(--ink)">
        {pumpOn ? "pump ON" : "pump off"}
      </text>

      {/* the rain cloud: drag it down for heavier rain */}
      <g transform={`translate(${cloudX} ${cloudY})`} className={dragging ? "cursor-grabbing" : "cursor-grab"}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ touchAction: "none" }} role="slider" aria-label="Rain: drag down for more"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(intensity * 100)}>
        <rect x="-60" y="-26" width="120" height="56" fill="transparent" />
        <g fill={cloudFill} stroke="var(--ink-2)" strokeOpacity="0.25">
          <circle cx="-22" cy="2" r="14" />
          <circle cx="0" cy="-6" r="18" />
          <circle cx="22" cy="2" r="14" />
          <rect x="-34" y="2" width="68" height="14" rx="7" />
        </g>
        <text y="38" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--ink)">{rainLabel}</text>
        {/* inflow vs pump capacity */}
        <g transform="translate(-40 44)">
          <rect width="80" height="5" rx="2.5" fill="var(--grid)" />
          <rect width={Math.min(80, 40 * inflowRatio)} height="5" rx="2.5" fill={inflowRatio > 1 ? "#d03b3b" : "var(--rain)"} />
          <line x1="40" x2="40" y1="-2" y2="7" stroke="var(--ink)" strokeWidth="1.2" />
          <text x="40" y="17" textAnchor="middle" fontSize="9" fill="var(--ink-2)">pump {pumpCapLabel}</text>
        </g>
      </g>
    </svg>
  );
}
