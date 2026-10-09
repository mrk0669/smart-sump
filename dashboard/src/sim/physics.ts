// Water-balance model of the sump, pump and sedimentation tank:
// TypeScript mirror of simulator/physics.py (see that file for the "why").

export const PUMP_RAMP_TAU_S = 2.0;

export interface PlantParams {
  sump_depth_cm: number;
  tank_depth_cm: number;
  sump_area_m2: number;
  tank_area_m2: number;
  sensor_offset_cm: number;
  tank_sensor_offset_cm: number;
  pump_rated_flow_lpm: number;
  pump_run_current_a: number;
  pump_dry_current_a: number;
  pump_intake_pct: number;
  tank_outlet_lpm_at_full: number;
  tank_outlet_pct: number;
  sump_high_float_pct: number;
  sump_low_float_pct: number;
  tank_high_float_pct: number;
  sensor_noise_cm: number;
  sensor_dropout_prob: number;
  sensor_glitch_prob: number;
  ultrasonic_min_cm: number;
  ultrasonic_max_cm: number;
}

export interface Rng {
  random(): number;
  gauss(mu: number, sigma: number): number;
  uniform(a: number, b: number): number;
}

/** Small seeded random generator (mulberry32) with a normal distribution
 *  (Box-Muller). Not the same numbers as Python's, but the same behaviour. */
export function makeRng(seed = Date.now()): Rng {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random,
    uniform: (lo, hi) => lo + (hi - lo) * random(),
    gauss: (mu, sigma) => {
      if (sigma === 0) return mu;
      const u = 1 - random(), v = random();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export const capacityL = (areaM2: number, depthCm: number) => areaM2 * depthCm / 100.0 * 1000.0;

export class Plant {
  p: PlantParams;
  rng: Rng;
  sumpL: number;
  tankL: number;
  flowLpm = 0;
  currentA = 0;
  pumpedL = 0;
  sumpSpillL = 0;
  tankSpillL = 0;
  dryRunningS = 0;

  constructor(p: PlantParams, sumpPct: number, tankPct: number, rng: Rng) {
    this.p = p;
    this.rng = rng;
    this.sumpL = this.sumpCap * sumpPct / 100.0;
    this.tankL = this.tankCap * tankPct / 100.0;
  }

  get sumpCap() { return capacityL(this.p.sump_area_m2, this.p.sump_depth_cm); }
  get tankCap() { return capacityL(this.p.tank_area_m2, this.p.tank_depth_cm); }
  get sumpPct() { return this.sumpL / this.sumpCap * 100.0; }
  get tankPct() { return this.tankL / this.tankCap * 100.0; }

  advance(dt: number, pumpOn: boolean, inflowLpm: number, suctionBlocked = false, outletBlocked = false) {
    const p = this.p;
    const hasWater = this.sumpPct > p.pump_intake_pct && !suctionBlocked;
    const target = pumpOn && hasWater ? p.pump_rated_flow_lpm : 0.0;
    this.flowLpm += (target - this.flowLpm) * Math.min(1.0, dt / PUMP_RAMP_TAU_S);
    if (this.flowLpm < 0.01) this.flowLpm = 0.0;

    if (pumpOn) {
      const load = this.flowLpm / p.pump_rated_flow_lpm;
      this.currentA = p.pump_dry_current_a + (p.pump_run_current_a - p.pump_dry_current_a) * load;
      if (!hasWater) this.dryRunningS += dt;
    } else {
      this.currentA = 0.0;
    }

    const minutes = dt / 60.0;
    const pumped = Math.min(this.flowLpm * minutes, this.sumpL);
    this.pumpedL += pumped;

    this.sumpL += inflowLpm * minutes - pumped;
    if (this.sumpL > this.sumpCap) {
      this.sumpSpillL += this.sumpL - this.sumpCap;
      this.sumpL = this.sumpCap;
    }
    this.sumpL = Math.max(0.0, this.sumpL);

    const out = p.tank_outlet_pct / 100.0;
    const head = Math.max(0.0, (this.tankL / this.tankCap - out) / (1.0 - out));
    const outlet = outletBlocked ? 0.0 : p.tank_outlet_lpm_at_full * Math.sqrt(head);
    this.tankL += pumped - Math.min(outlet * minutes, this.tankL);
    if (this.tankL > this.tankCap) {
      this.tankSpillL += this.tankL - this.tankCap;
      this.tankL = this.tankCap;
    }
  }

  ultrasonicBurst(which: "sump" | "tank", n = 5, dead = false): (number | null)[] {
    const p = this.p;
    const [depth, offset, pct] = which === "sump"
      ? [p.sump_depth_cm, p.sensor_offset_cm, this.sumpPct]
      : [p.tank_depth_cm, p.tank_sensor_offset_cm, this.tankPct];
    const trueCm = offset + depth * (1.0 - pct / 100.0);
    const pings: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      if (dead || this.rng.random() < p.sensor_dropout_prob) pings.push(null);
      else if (this.rng.random() < p.sensor_glitch_prob) pings.push(this.rng.uniform(p.ultrasonic_min_cm, p.ultrasonic_max_cm));
      else pings.push(trueCm + this.rng.gauss(0.0, p.sensor_noise_cm));
    }
    return pings;
  }

  floats(): [boolean, boolean, boolean] {
    const p = this.p;
    return [this.sumpPct >= p.sump_high_float_pct, this.sumpPct <= p.sump_low_float_pct, this.tankPct >= p.tank_high_float_pct];
  }

  currentReading(noise = 0.05): number {
    return this.currentA === 0 ? 0 : Math.max(0, this.currentA + this.rng.gauss(0, noise * Math.max(1, this.p.pump_run_current_a / 2.8)));
  }

  flowReading(): number {
    return this.flowLpm === 0 ? 0 : Math.max(0, this.flowLpm * (1 + this.rng.gauss(0, 0.02)));
  }

  turbidityReading(inflowLpm: number): number {
    // Illustrative: storm water carries more mud. Scaled to the pump size so
    // the lab and mine profiles give similar numbers.
    const rel = inflowLpm / (this.p.pump_rated_flow_lpm / 10);
    return Math.max(0, 40 + 4 * rel + this.rng.gauss(0, 3));
  }
}
