import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import * as THREE from '../assets/vendor/three-r170/three.module.min.js';
import { createGlider } from '../assets/js/telegram-flight.js';

const forward = new THREE.Vector3(-Math.sin(-3.62), 0, -Math.cos(-3.62));
const settings = {
  origin: new THREE.Vector3(0, .19, .35), forward,
  exitDirection: new THREE.Vector3(.825, 0, -.565),
};
const start = performance.now();
const direct = createGlider(settings);
const final = direct.sample(18);
const setupMs = performance.now() - start;
const stepped = createGlider(settings);
for (let time = 0; time <= 18; time += 1 / 60) stepped.sample(time);
assert.ok(stepped.sample(18).position.distanceTo(final.position) < 1e-10);
const still = createGlider({ ...settings, windStrength: 0 }).sample(6);
assert.ok(still.position.distanceTo(direct.sample(6).position) > 1);
assert.ok(direct.sample(1.5).position.y > settings.origin.y);
const rows = [];
for (const time of [0, .5, 1, 2, 4, 6, 10, 14, 18]) {
  const state = direct.sample(time);
  assert.ok([...state.position, ...state.velocity, state.bank].every(Number.isFinite));
  assert.ok(state.velocity.length() < 15);
  rows.push({ time, position: state.position.toArray(), speed: state.velocity.length(), bank: state.bank });
}
const camera = new THREE.PerspectiveCamera(23,520/430,.1,200);
camera.position.copy(new THREE.Vector3(4.8,3.2,7).normalize().multiplyScalar(6.05/(2*Math.tan(23*Math.PI/360))).add(new THREE.Vector3(0,.45,0)));
camera.lookAt(0,.45,0);
camera.setViewOffset(520,430,-460,-285,1440,1000);
camera.updateMatrixWorld();
const failures = [];
const sides = new Set();
let minimumDepth = Infinity;
let minimumDepthRatio = Infinity;
const launches = [settings, {
  origin: new THREE.Vector3(0, 1.25, -.18),
  forward: new THREE.Vector3(-Math.sin(-.1), 0, -Math.cos(-.1)),
}];
for (const launch of launches) {
  for (let index=0;index<512;index++) {
    const seed=Math.imul(index+1,2654435761)>>>0;
    const side=seed&1?1:-1;
    const vertical=((seed>>>1)/2147483648-.5)*4;
    const exitDirection=new THREE.Vector3(side,vertical,-.1).applyQuaternion(camera.quaternion);
    const airspace={position:camera.position.clone(),forward:camera.getWorldDirection(new THREE.Vector3())};
    const simulation=createGlider({...launch,seed,exitDirection,airspace});
    let closest=Infinity,furthest=-Infinity;
    for(let time=.1;time<=18;time+=.1){
      const state=simulation.sample(time);
      assert.ok([...state.position,...state.velocity,state.bank].every(Number.isFinite));
      assert.ok(state.velocity.length()<20);
      const depth=state.position.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
      minimumDepth=Math.min(minimumDepth,depth);
      closest=Math.min(closest,depth);
      furthest=Math.max(furthest,depth);
    }
    const position=simulation.sample(18).position;
    const end=position.clone().project(camera);
    const bounds=[];
    for(const x of [-2,2]) for(const y of [-2,2]) for(const z of [-2,2]) bounds.push(position.clone().add(new THREE.Vector3(x,y,z)).project(camera));
    const exited=bounds.every(p=>p.x>1)||bounds.every(p=>p.x< -1)||bounds.every(p=>p.y>1)||bounds.every(p=>p.y< -1);
    if(!exited) failures.push({seed,end:end.toArray()});
    sides.add(Math.abs(end.x)>Math.abs(end.y)?(end.x>0?'right':'left'):(end.y>0?'top':'bottom'));
    minimumDepthRatio=Math.min(minimumDepthRatio,furthest/closest);
  }
}
console.log(JSON.stringify({seeded_exit_failures:failures,minimum_depth:minimumDepth,minimum_depth_ratio:minimumDepthRatio,exit_sides:[...sides]}));
assert.equal(failures.length,0,'Every sampled flight must leave the viewport before reset');
const different=createGlider({...settings,seed:2048}).sample(6);
assert.ok(different.position.distanceTo(direct.sample(6).position)>1);
const report = { status: 'OK', setup_ms: setupMs, deterministic: true, wind_changes_flight: true, seeds_checked:512 * launches.length, launch_variants: launches.length, exit_sides:[...sides], minimum_depth:minimumDepth, minimum_depth_ratio:minimumDepthRatio, rows };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
