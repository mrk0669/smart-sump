// Runs the app's TypeScript simulator with sensor noise switched off and
// prints every event as JSON. Called by tools/crosscheck.py, which runs the
// Python simulator the same way and compares the two.
//
//   node dashboard/scripts/crosscheck.ts <seconds> <scenario> [<scenario>...]

import { LAB } from "../src/sim/profiles.ts";
import { VirtualDevice } from "../src/sim/virtual.ts";

const [secs, ...names] = process.argv.slice(2);
const profile = { ...LAB, plant: { ...LAB.plant, sensor_noise_cm: 0, sensor_dropout_prob: 0, sensor_glitch_prob: 0 } };

const result: Record<string, unknown> = { lab_profile: { plant: LAB.plant, setpoints: LAB.setpoints } };
for (const name of names) {
  const events: [number, string, string | null][] = [];
  const dev = new VirtualDevice(profile, name, { seed: 1, epoch0: 0 });
  dev.onRawEvent = (t, ev) => events.push([Math.round(t * 10) / 10, ev.type, ev.code]);
  while (dev.t < Number(secs)) dev.tick();
  result[name] = events;
}
console.log(JSON.stringify(result));
