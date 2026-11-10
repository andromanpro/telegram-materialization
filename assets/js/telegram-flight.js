// A point-mass glider. Forces act on air-relative velocity, in fixed 1/120 s steps.
// Background: https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/three-forces-on-a-glider/
// Coefficients, launch gust and trimmed banking are tuned for the site illustration.
import * as THREE from '../vendor/three-r170/three.module.min.js';

const STEP = 1 / 120;
const STRIDE = 10;
const UP = new THREE.Vector3(0, 1, 0);
const bounded = (value, limit) => Math.max(-limit, Math.min(limit, value));
const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

export function createGlider({ origin, forward, exitDirection, duration = 18, initialBank = 0, windStrength = 1, seed = 1, airspace = null }) {
  const count = Math.ceil(duration / STEP) + 2;
  const history = new Float64Array(count * STRIDE);
  const position = origin.clone();
  const velocity = forward.clone().multiplyScalar(5.3).addScaledVector(UP, .32);
  const air = new THREE.Vector3();
  const wind = new THREE.Vector3();
  const lift = new THREE.Vector3();
  const desired = exitDirection.clone().normalize();
  const heading = desired.clone().setY(0).normalize();
  const steering = new THREE.Vector3();
  const safeHeading = airspace ? airspace.forward.clone().setY(0).normalize() : heading;
  function noise(time, rate, channel) {
    const value = time * rate;
    const index = Math.floor(value);
    function hash(cell) {
      let bits = (seed ^ Math.imul(cell + channel * 193, 1597334677)) >>> 0;
      bits = Math.imul(bits ^ (bits >>> 16), 2246822507);
      bits = Math.imul(bits ^ (bits >>> 13), 3266489909);
      return ((bits ^ (bits >>> 16)) >>> 0) / 2147483648 - 1;
    }
    return THREE.MathUtils.lerp(hash(index), hash(index + 1), smooth(value - index));
  }
  const turn = seed & 1 ? 1 : -1;
  const phase = (seed >>> 8) / 16777216 * Math.PI * 2;
  let bank = initialBank;
  let bankRate = 0;
  let coefficient = .65;
  let completed = 0;

  function save(index) {
    const offset = index * STRIDE;
    history.set([position.x, position.y, position.z, velocity.x, velocity.y, velocity.z,
      bank, air.x, air.y, air.z], offset);
  }

  air.copy(velocity);
  save(0);

  function step(index) {
    const time = index * STEP;
    const release = smooth((time / duration - .41) / .23);
    wind.set(.7 * noise(time, .47, 1) + .16 * Math.sin(position.z * .32 + phase),
      .35 + 1.45 * Math.exp(-time / 1.6) + .35 * noise(time, .55, 2),
      .65 * noise(time, .39, 3) + .14 * Math.cos(position.x * .28 + phase));
    const depth = airspace ? position.clone().sub(airspace.position).dot(airspace.forward) : Infinity;
    const pressure = smooth((10 - depth) / 5);
    wind.addScaledVector(desired, release * 6);
    if (airspace) wind.addScaledVector(airspace.forward, pressure * 8);
    wind.multiplyScalar(windStrength);
    air.copy(velocity).sub(wind);
    const speed = Math.max(.2, air.length());
    const direction = air.clone().multiplyScalar(1 / speed);
    steering.copy(heading).lerp(safeHeading, pressure).normalize();
    const headingError = Math.atan2(direction.z * steering.x - direction.x * steering.z,
      direction.x * steering.x + direction.z * steering.z);
    const trimBank = turn * (.18 + .4 * Math.sin(time * .64 + phase)) + .22 * noise(time, .62, 4);
    const targetBank = THREE.MathUtils.lerp(trimBank, bounded(-headingError * 1.15, .75), Math.max(release, pressure));
    bankRate += ((targetBank - bank) * 10 - bankRate * 4.5) * STEP;
    bank += bankRate * STEP;

    const mass = .04;
    const gravity = 9.81;
    const dynamicArea = .5 * 1.225 * speed * speed * .04;
    const trimLift = mass * (gravity + (-.5 - air.y) * 1.6) / Math.max(.6, Math.cos(bank));
    const requested = Math.max(.12, Math.min(1.15, trimLift / Math.max(.001, dynamicArea)));
    coefficient += (requested - coefficient) * (1 - Math.exp(-STEP / .45));
    const dragCoefficient = .018 + .045 * coefficient * coefficient;
    lift.copy(UP).addScaledVector(direction, -UP.dot(direction)).normalize().applyAxisAngle(direction, bank);
    velocity.addScaledVector(lift, dynamicArea * coefficient / mass * STEP);
    velocity.addScaledVector(direction, -dynamicArea * dragCoefficient / mass * STEP);
    velocity.y -= gravity * STEP;
    position.addScaledVector(velocity, STEP);
    air.copy(velocity).sub(wind);
    save(index);
  }

  function indexAt(time) {
    const value = Math.max(0, Math.min(duration, time)) / STEP;
    const upper = Math.min(count - 1, Math.ceil(value));
    while (completed < upper) step(++completed);
    return { lower: Math.floor(value), upper, fraction: value - Math.floor(value) };
  }

  function interpolate(index, component) {
    return THREE.MathUtils.lerp(history[index.lower * STRIDE + component], history[index.upper * STRIDE + component], index.fraction);
  }

  function positionAt(time) {
    const index = indexAt(time);
    return new THREE.Vector3(interpolate(index, 0), interpolate(index, 1), interpolate(index, 2));
  }

  return {
    positionAt,
    sample(time) {
      const index = indexAt(time);
      return {
        position: new THREE.Vector3(interpolate(index, 0), interpolate(index, 1), interpolate(index, 2)),
        velocity: new THREE.Vector3(interpolate(index, 3), interpolate(index, 4), interpolate(index, 5)),
        airVelocity: new THREE.Vector3(interpolate(index, 7), interpolate(index, 8), interpolate(index, 9)),
        bank: interpolate(index, 6),
      };
    },
  };
}
