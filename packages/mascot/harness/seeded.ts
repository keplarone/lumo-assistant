/**
 * Deterministic Math.random for the harness pages.
 *
 * Both the reference and the port call Math.random in the character constructor (first blink time,
 * particle layout) and on every blink. three.js also calls Math.random for every object's UUID, and
 * r149 and r186 create a different number of internal objects, which would desync one shared
 * stream. So calls coming from three's generateUUID get their own stream, and everything else (the
 * character) gets the seeded stream, identical in both renders.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function installSeededRandom(seed = 0x10e0) {
  const character = mulberry32(seed);
  const uuid = mulberry32(seed ^ 0x5eed);
  Math.random = () => (/generateUUID/.test(new Error().stack ?? '') ? uuid() : character());
}
