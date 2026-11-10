import * as THREE from '../vendor/three-r170/three.module.min.js';

export const PRINTER_FOLD_PORTION = .2;
export const PRINTER_DEPARTURE_MS = 22500;
const HALF_WIDTH = 1.13;
const HALF_LENGTH = 1.34;
const SPINE = .14;
const smooth = value => { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const nose = new THREE.Vector3(0, 0, -HALF_LENGTH);
const cornerFolds = [
  { side: 1, slope: 1, from: .12, to: .27 },
  { side: -1, slope: 1, from: .27, to: .42 },
  { side: 1, slope: Math.tan(Math.PI / 8), from: .42, to: .57 },
  { side: -1, slope: Math.tan(Math.PI / 8), from: .57, to: .72 },
].map(fold => ({ ...fold, axis: new THREE.Vector3(fold.side * fold.slope, 0, 1).normalize() }));

function clipped(vertices, distance, sign) {
  const result = [];
  vertices.forEach((end, index) => {
    const start = vertices[(index + vertices.length - 1) % vertices.length];
    const a = distance(start.position) * sign;
    const b = distance(end.position) * sign;
    if ((a < -1e-8) !== (b < -1e-8)) {
      const fraction = a / (a - b);
      result.push({ position: start.position.clone().lerp(end.position, fraction), uv: start.uv.clone().lerp(end.uv, fraction) });
    }
    if (b >= -1e-8) result.push({ position: end.position.clone(), uv: end.uv.clone() });
  });
  return result;
}

function split(panels, distance, fold = null) {
  return panels.flatMap(panel => [-1, 1].flatMap(sign => {
    const vertices = clipped(panel.vertices, distance, sign);
    if (vertices.length < 3) return [];
    const moving = sign > 0;
    if (fold && moving) vertices.forEach(vertex => {
      vertex.position = vertex.position.clone().sub(nose).applyAxisAngle(fold.axis, fold.side * (Math.PI - .006)).add(nose);
    });
    return [{ vertices, folds: fold ? [...panel.folds, moving] : panel.folds }];
  }));
}

/** A single sheet with material-space UVs and rigid rotations about its creases. */
export function createFoldingPaper() {
  let panels = [{ folds: [], vertices: [
    [-HALF_WIDTH, -HALF_LENGTH], [HALF_WIDTH, -HALF_LENGTH],
    [HALF_WIDTH, HALF_LENGTH], [-HALF_WIDTH, HALF_LENGTH],
  ].map(([x, z]) => ({ position: new THREE.Vector3(x, 0, z), uv: new THREE.Vector2((x + HALF_WIDTH) / (2 * HALF_WIDTH), (HALF_LENGTH - z) / (2 * HALF_LENGTH)) })) }];
  cornerFolds.forEach(fold => {
    panels = split(panels, position => fold.side * position.x - fold.slope * (position.z + HALF_LENGTH), fold);
  });
  for (const x of [-SPINE, 0, SPINE]) panels = split(panels, position => position.x - x);
  const vertices = [];
  const triangles = [];
  panels.forEach(panel => {
    const center = panel.vertices.reduce((sum, vertex) => sum + vertex.position.x, 0) / panel.vertices.length;
    const offset = vertices.length;
    panel.vertices.forEach(vertex => vertices.push({
      initial: new THREE.Vector3((vertex.uv.x - .5) * 2 * HALF_WIDTH, 0, (.5 - vertex.uv.y) * 2 * HALF_LENGTH),
      uv: vertex.uv, folds: panel.folds, side: center < 0 ? -1 : 1, wing: Math.abs(center) > SPINE,
    }));
    for (let index = 1; index < panel.vertices.length - 1; index++) triangles.push(offset, offset + index, offset + index + 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(vertices.flatMap(vertex => vertex.uv.toArray()), 2));
  geometry.setIndex(triangles);
  const position = new THREE.Vector3();
  const spineAxis = new THREE.Vector3(0, 0, 1);
  let previous = '';

  function update(progress, curl = 0) {
    const signature = progress + '/' + curl;
    if (previous === signature) return;
    previous = signature;
    const rotations = cornerFolds.map(fold => new THREE.Matrix4().makeRotationAxis(fold.axis,
      fold.side * (Math.PI - .006) * smooth((progress - fold.from) / (fold.to - fold.from))));
    const book = smooth((progress - .72) / .14) * (Math.PI / 2 - .012);
    const wings = smooth((progress - .86) / .14) * (Math.PI / 2 - .055);
    vertices.forEach((vertex, index) => {
      position.copy(vertex.initial);
      rotations.forEach((rotation, fold) => {
        if (vertex.folds[fold]) position.sub(nose).applyMatrix4(rotation).add(nose);
      });
      if (vertex.wing) {
        position.x -= vertex.side * SPINE;
        position.applyAxisAngle(spineAxis, -vertex.side * wings);
        position.x += vertex.side * SPINE;
      }
      position.applyAxisAngle(spineAxis, vertex.side * book);
      position.y -= curl * Math.pow((HALF_LENGTH - vertex.initial.z) / (2 * HALF_LENGTH), 2);
      geometry.attributes.position.setXYZ(index, position.x, position.y, position.z);
    });
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }
  update(0);
  return { geometry, update };
}
