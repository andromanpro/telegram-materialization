import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as THREE from '../assets/vendor/three-r170/three.module.min.js';
import { createFoldingPaper, PRINTER_FOLD_PORTION, PRINTER_DEPARTURE_MS } from '../assets/js/telegram-paper.js';

const sheet = createFoldingPaper();
const { geometry } = sheet;
const indices = geometry.index.array;
const point = index => new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, index);
const initialEdges = [];
let initialArea = 0;
for (let index = 0; index < indices.length; index += 3) {
  const [a, b, c] = Array.from(indices.slice(index, index + 3), point);
  initialEdges.push(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
  initialArea += new THREE.Triangle(a, b, c).getArea();
}
assert.ok(Math.abs(initialArea - 2.26 * 2.68) < 1e-5, 'The crease partition covers the complete sheet');
const initialUvs = geometry.attributes.uv.array.slice();
let edgeError = 0;
let maximumStep = 0;
let previous = geometry.attributes.position.array.slice();
for (let frame = 0; frame <= 270; frame++) {
  sheet.update(frame / 270);
  const positions = geometry.attributes.position.array;
  assert.ok(Array.from(positions).every(Number.isFinite));
  assert.deepEqual(geometry.attributes.uv.array, initialUvs);
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = Array.from(indices.slice(index, index + 3), point);
    const lengths = [a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)];
    lengths.forEach((length, edge) => { edgeError = Math.max(edgeError, Math.abs(length - initialEdges[index + edge])); });
  }
  for (let index = 0; index < positions.length; index += 3) {
    maximumStep = Math.max(maximumStep, Math.hypot(...positions.slice(index, index + 3).map((value, axis) => value - previous[index + axis])));
  }
  previous = positions.slice();
}
assert.ok(edgeError < 2e-6, 'Every panel must remain rigid during each fold');
assert.ok(maximumStep < .12, 'Folding must be continuous at 60 frames per second');
geometry.computeBoundingBox();
const size = geometry.boundingBox.getSize(new THREE.Vector3());
assert.ok(size.x > 1 && size.x < 2.3 && size.z > 2.5 && size.y < .3, 'The final sheet has two spread wings and a narrow spine');
assert.ok(Math.abs(PRINTER_DEPARTURE_MS * (1 - PRINTER_FOLD_PORTION) - 18000) < 1e-8);
const report = { status: 'OK', frames: 271, vertices: geometry.attributes.position.count, triangles: indices.length / 3,
  sheet_area: initialArea, maximum_edge_error: edgeError, maximum_vertex_step: maximumStep,
  final_size: size.toArray(), fold_ms: PRINTER_DEPARTURE_MS * PRINTER_FOLD_PORTION,
  stable_uvs: true, rigid_panels: true };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
