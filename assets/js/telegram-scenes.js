// Self-hosted Three.js scenes. The host controls activation and timing.
import * as THREE from '../vendor/three-r170/three.module.min.js';
import { createGlider } from './telegram-flight.js';
import { createFoldingPaper, PRINTER_FOLD_PORTION, PRINTER_DEPARTURE_MS } from './telegram-paper.js';

const CYAN = 0x38d6f4;
const MINT = 0x85eadc;
const CRAFT_YAW = -4;
const FLIGHTS = {
  fabricator: { origin: [0, .19, .35], scale: 1, roll: -.055 },
  fragments: { origin: [0, .27, .7], scale: 1, roll: 0 },
  printer: { origin: [0, 1.25, -.18], scale: 1, roll: 0, yaw: -.1 },
};
const clamp = value => Math.min(1, Math.max(0, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const easeOut = value => 1 - Math.pow(1 - clamp(value), 3);
const point = coordinates => new THREE.Vector3(...coordinates);

function metal(color, roughness = .35, metalness = .75) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function lightMaterial(color = CYAN, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false });
}

function brushedFinish() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  for (let row = 0; row < 128; row++) {
    const shade = 175 + (row * 37 % 54);
    context.fillStyle = 'rgb(' + shade + ',' + shade + ',' + shade + ')';
    context.fillRect(0, row, 128, 1);
  }
  return new THREE.CanvasTexture(canvas);
}

function rectangular(width, height, depth, material, position = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function rounded(width, height, depth, radius, material, position = [0, 0, 0]) {
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.min(radius, width / 3, height / 3);
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, steps: 1, bevelEnabled: true, bevelSegments: 3,
    bevelSize: Math.min(.035, depth / 5), bevelThickness: Math.min(.035, depth / 5), curveSegments: 5,
  });
  geometry.center();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinder(radius, length, material, position, axis = 'y', segments = 24) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material);
  mesh.position.set(...position);
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  return mesh;
}

function ring(radius, tube, material) {
  return new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 100), material);
}

function bolts(parent, locations, material, axis = 'z', radius = .035) {
  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(radius, radius, .025, 6), material, locations.length);
  const transform = new THREE.Object3D();
  if (axis === 'z') transform.rotation.x = Math.PI / 2;
  locations.forEach((position, index) => {
    transform.position.set(...position);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  });
  parent.add(mesh);
}

function textureLabel(lines, background = '#101f2c', ink = '#adc5d0') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = ink;
  lines.forEach((line, index) => {
    context.font = (index ? '400 26px' : '500 42px') + ' "JetBrains Mono", monospace';
    context.fillText(line, 30, 65 + index * 45);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function plaque(lines, width, height, position, background, ink) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: textureLabel(lines, background, ink), toneMapped: false }));
  mesh.position.set(...position);
  return mesh;
}

function studioEnvironment(renderer) {
  const studio = new THREE.Scene();
  studio.add(new THREE.Mesh(new THREE.BoxGeometry(14, 12, 14), new THREE.MeshBasicMaterial({ color: 0x141f2b, side: THREE.BackSide })));
  for (const [position, size, color] of [
    [[-4, 5, 2], [3, 7], 0xd5e6ee],
    [[4, 3, -2], [2, 6], 0x5195b1],
    [[0, 6, -3], [5, 3], 0x9db0c9],
  ]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(...size), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    panel.position.set(...position);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  }
  const generator = new THREE.PMREMGenerator(renderer);
  const environment = generator.fromScene(studio, .06);
  generator.dispose();
  studio.traverse(object => { if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); } });
  return environment;
}

function worldFor(canvas, { anchor = canvas.parentElement, overlay = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, overlay ? 1.25 : 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  const scene = new THREE.Scene();
  const environment = studioEnvironment(renderer);
  scene.environment = environment.texture;
  scene.environmentIntensity = .85;
  scene.add(new THREE.HemisphereLight(0xb7d7e9, 0x142031, 1.6));
  const key = new THREE.DirectionalLight(0xe8f3ff, 3.6);
  key.position.set(-3, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.normalBias = .025;
  key.shadow.bias = -.0002;
  key.shadow.radius = 3;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x48cbe7, 1.8);
  rim.position.set(4, 2, -4);
  scene.add(rim);
  const warm = new THREE.DirectionalLight(0xb47a91, .8);
  warm.position.set(-4, 1, -3);
  scene.add(warm);
  const contact = new THREE.PointLight(CYAN, 0, 1.1, 2);
  scene.add(contact);
  const camera = new THREE.PerspectiveCamera(23, 1, .1, 200);
  camera.layers.enable(1);
  const flights = new Map();
  const flightView = { object: null };
  const occlusion = new THREE.Scene();
  const occluder = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  occluder.layers.set(1);
  occlusion.add(occluder);
  const baseCanvas = overlay ? document.createElement('canvas') : null;
  if (baseCanvas) {
    baseCanvas.className = 'tg-invite-base';
    baseCanvas.setAttribute('aria-hidden', 'true');
    baseCanvas.hidden = true;
    anchor.append(baseCanvas);
  }
  const materials = {
    body: metal(0x20394a, .4, .6), trim: metal(0x5b7382, .32, .8),
    black: metal(0x080e16, .75, .12), silver: metal(0xadbcc5, .22, .9),
    copper: metal(0xb68554, .3, .8), light: lightMaterial(), mint: lightMaterial(MINT),
  };
  const finish = brushedFinish();
  materials.body.roughnessMap = finish;
  materials.trim.roughnessMap = finish;
  const base = new THREE.Group();
  base.add(cylinder(2.55, .18, materials.body, [0, -1.08, 0], 'y', 80));
  base.add(cylinder(2.43, .075, materials.trim, [0, -.955, 0], 'y', 80));
  base.add(cylinder(2.37, .03, metal(0x142634, .7, .35), [0, -.898, 0], 'y', 80));
  const perimeter = ring(2.46, .012, materials.light);
  perimeter.rotation.x = Math.PI / 2;
  perimeter.position.y = -.985;
  base.add(perimeter);
  const calibration = ring(2.05, .006, lightMaterial(0x44829b, .5));
  calibration.rotation.x = Math.PI / 2;
  calibration.position.y = -.874;
  base.add(calibration);
  const locations = [];
  for (let index = 0; index < 12; index++) {
    const angle = index * Math.PI / 6;
    locations.push([Math.sin(angle) * 2.26, -.87, Math.cos(angle) * 2.26]);
    const mark = rectangular(.015, .006, .11, materials.trim, [Math.sin(angle) * 2.16, -.872, Math.cos(angle) * 2.16]);
    mark.rotation.y = angle;
    base.add(mark);
  }
  bolts(base, locations, materials.silver, 'y', .027);
  base.traverse(object => { if (object.isMesh) object.receiveShadow = true; });
  scene.add(base);
  scene.traverse(object => { if (object.isLight) object.layers.enable(1); });
  let previousSize = '';
  let bufferSize = '';
  function resize() {
    const box = anchor.getBoundingClientRect();
    const width = box.width || 720;
    const height = box.height || 360;
    const screenWidth = overlay ? innerWidth : width;
    const screenHeight = overlay ? innerHeight : height;
    const size = [width, height, screenWidth, screenHeight].join('/');
    if (size !== previousSize) {
      if (!overlay) renderer.setSize(width, height, false);
      flights.clear();
      previousSize = size;
    }
    camera.aspect = width / height;
    const viewHeight = Math.max(6.05, 5.85 / camera.aspect);
    const distance = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const target = new THREE.Vector3(0, .45, 0);
    camera.position.copy(new THREE.Vector3(4.8, 3.2, 7).normalize().multiplyScalar(distance).add(target));
    camera.lookAt(target);
    if (overlay) camera.setViewOffset(width, height, -box.left, -box.top, screenWidth, screenHeight);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return box;
  }
  function viewport(rect, bufferWidth = rect.width, bufferHeight = rect.height) {
    if (!overlay) return;
    const box = anchor.getBoundingClientRect();
    canvas.style.left = rect.left + 'px';
    canvas.style.top = rect.top + 'px';
    canvas.style.right = 'auto';
    canvas.style.bottom = 'auto';
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const size = [Math.round(bufferWidth), Math.round(bufferHeight)].join('/');
    if (size !== bufferSize) {
      renderer.setSize(Math.round(bufferWidth), Math.round(bufferHeight), false);
      bufferSize = size;
    }
    camera.setViewOffset(box.width, box.height, rect.left - box.left, rect.top - box.top, rect.width, rect.height);
  }
  resize();
  return { scene, renderer, camera, materials, resize, viewport, environment, contact, flights, flightView, baseCanvas, overlay, occlusion, occluder };
}

// Merge the cached machine once. A single colorless draw restores its depth
// in the moving flight region, including gaps between rails and inside the ring.
function occlusionGeometry(scene) {
  const parts = [];
  scene.updateMatrixWorld(true);
  scene.traverseVisible(object => {
    if (!object.isMesh || !(object.layers.mask & 1) || object.material.opacity < .99 || !object.material.depthWrite) return;
    const instances = object.isInstancedMesh ? object.count : 1;
    for (let instance = 0; instance < instances; instance++) {
      const matrix = object.matrixWorld.clone();
      if (object.isInstancedMesh) {
        const local = new THREE.Matrix4();
        object.getMatrixAt(instance, local);
        matrix.multiply(local);
      }
      parts.push({ geometry: object.geometry, matrix });
    }
  });
  const count = parts.reduce((sum, part) => sum + part.geometry.attributes.position.count, 0);
  const positions = new Float32Array(count * 3);
  const indices = [];
  const position = new THREE.Vector3();
  let offset = 0;
  parts.forEach(({ geometry, matrix }) => {
    const attribute = geometry.attributes.position;
    for (let index = 0; index < attribute.count; index++) {
      position.fromBufferAttribute(attribute, index).applyMatrix4(matrix).toArray(positions, (offset + index) * 3);
    }
    const total = geometry.index ? geometry.index.count : attribute.count;
    for (let index = 0; index < total; index++) indices.push(offset + (geometry.index ? geometry.index.getX(index) : index));
    offset += attribute.count;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const nose = [0, .015, -1.9];
const ridge = [0, .34, .79];
const keel = [0, -.43, .69];
const innerLeft = [-.22, .055, .53];
const innerRight = [.22, .055, .53];
const facets = [
  [nose, [-1.55, .02, .86], innerLeft],
  [nose, innerLeft, ridge],
  [nose, ridge, innerRight],
  [nose, innerRight, [1.55, .02, .86]],
  [nose, ridge, keel],
];

function foldedPrism(points) {
  const vertices = points.map(point);
  const normal = new THREE.Vector3().subVectors(vertices[1], vertices[0]).cross(new THREE.Vector3().subVectors(vertices[2], vertices[0])).normalize().multiplyScalar(.018);
  const back = vertices.map(vertex => vertex.clone().sub(normal));
  const positions = [];
  function triangle(a, b, c) { positions.push(...a.toArray(), ...b.toArray(), ...c.toArray()); }
  triangle(...vertices);
  triangle(back[2], back[1], back[0]);
  for (let index = 0; index < 3; index++) {
    const next = (index + 1) % 3;
    triangle(vertices[index], back[index], vertices[next]);
    triangle(vertices[next], back[index], back[next]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function aircraft(clippingPlane = null, paper = false) {
  const group = new THREE.Group();
  const surfaces = [];
  const outlines = [];
  facets.forEach((points, index) => {
    const geometry = foldedPrism(points);
    const color = paper ? [0xe5e6d9, 0xd1ded8, 0xa5c0bd, 0xd9e5dc, 0x829e9d][index] : [0xb9e4ed, 0x75bcd0, 0x39758f, 0x92cbd6, 0x285469][index];
    const material = new THREE.MeshPhysicalMaterial({ color, roughness: paper ? .75 : .27, metalness: paper ? 0 : .4, clearcoat: paper ? 0 : .45, clearcoatRoughness: .25, side: THREE.DoubleSide, transparent: true, clippingPlanes: clippingPlane ? [clippingPlane] : null });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(1);
    group.add(mesh);
    surfaces.push(material);
    const outline = new THREE.LineBasicMaterial({ color: 0xbcebf3, transparent: true, opacity: .45, clippingPlanes: clippingPlane ? [clippingPlane] : null, depthWrite: false });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 32), outline);
    edges.layers.set(1);
    group.add(edges);
    outlines.push(outline);
  });
  group.rotation.y = CRAFT_YAW;
  return { group, surfaces, outlines };
}

function flightSimulation(world, flight) {
  if (world.flights.has(flight)) return world.flights.get(flight);
  const origin = point(flight.origin);
  const yaw = flight.yaw ?? CRAFT_YAW + .38;
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const seed = world.flightView.seed;
  const side = seed & 1 ? 1 : -1;
  const vertical = ((seed >>> 1) / 2147483648 - .5) * 4;
  const exitDirection = new THREE.Vector3(side, vertical, -.1).applyQuaternion(world.camera.quaternion);
  const airspace = {position:world.camera.position.clone(),forward:world.camera.getWorldDirection(new THREE.Vector3())};
  const simulation = createGlider({ origin, forward, exitDirection, initialBank: flight.roll, seed, airspace });
  world.flights.set(flight, simulation);
  return simulation;
}

function flightPoint(progress, flight, world) {
  return flightSimulation(world, flight).positionAt(clamp(progress) * 18);
}

function depart(craft, progress, flight, world, opacity = 1) {
  craft.group.scale.setScalar(flight.scale);
  craft.group.traverse(object => { if (object.isMesh) object.castShadow = progress <= 0; });
  craft.surfaces.forEach(surface => { surface.opacity = opacity; });
  craft.outlines.forEach(outline => { outline.opacity = opacity * .45; });
  if (progress <= 0) { world.flights.delete(flight); world.flightView.object = null; return; }
  world.flightView.object = craft.group;
  const state = flightSimulation(world, flight).sample(clamp(progress) * 18);
  const position = state.position;
  const tangent = state.airVelocity.clone().normalize();
  const bank = state.bank;
  const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, position.clone().add(tangent), new THREE.Vector3(0, 1, 0)));
  orientation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank));
  const launch = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, flight.yaw ?? CRAFT_YAW + .38, flight.roll));
  craft.group.position.copy(position);
  craft.group.quaternion.copy(launch).slerp(orientation, smooth(progress / .035));
}

function printPaths(rotation) {
  const paths = [];
  let previous = null;
  let length = 0;
  function move(start, end, printing) {
    const distance = start.distanceTo(end);
    if (distance < .002) return;
    const weight = Math.max(.08, distance);
    paths.push({ start: start.clone(), end: end.clone(), printing, from: length, to: length + weight });
    length += weight;
  }
  for (let y = -.42; y <= .35; y += .055) {
    const layer = [];
    for (const facet of facets) {
      const cut = [];
      for (let index = 0; index < 3; index++) {
        const a = point(facet[index]);
        const b = point(facet[(index + 1) % 3]);
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) cut.push(a.lerp(b, (y - a.y) / (b.y - a.y)).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation));
      }
      if (cut.length === 2) layer.push(cut);
    }
    while (layer.length) {
      let nearest = 0;
      if (previous) {
        let distance = Infinity;
        layer.forEach((segment, index) => {
          const candidate = Math.min(previous.distanceToSquared(segment[0]), previous.distanceToSquared(segment[1]));
          if (candidate < distance) { distance = candidate; nearest = index; }
        });
      }
      const segment = layer.splice(nearest, 1)[0];
      if (previous && previous.distanceToSquared(segment[1]) < previous.distanceToSquared(segment[0])) segment.reverse();
      if (previous) move(previous, segment[0], false);
      move(segment[0], segment[1], true);
      previous = segment[1];
    }
  }
  return { paths, length };
}

function fabricator(world, locale) {
  const { scene, materials: material } = world;
  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), -.5);
  const craft = aircraft(clip);
  scene.add(craft.group);
  const machine = new THREE.Group();
  machine.add(rounded(4.05, .2, 3.25, .1, material.body, [0, -.7, 0]));
  machine.add(rounded(3.6, .07, 2.85, .06, metal(0x304756, .68, .6), [0, -.545, 0]));
  for (const x of [-1.85, 1.85]) {
    machine.add(rectangular(.12, 2.75, .17, material.body, [x, .52, -1.1]));
    machine.add(cylinder(.032, 2.65, material.silver, [x + .07, .52, -.98]));
    machine.add(rectangular(.02, 2.5, .01, material.light, [x - .035, .5, -.998]));
    machine.add(rounded(.32, .17, .32, .04, material.trim, [x, 1.94, -1.1]));
  }
  machine.add(rounded(3.86, .18, .25, .04, material.body, [0, 1.95, -1.1]));
  machine.add(plaque(['ANDROMAN', locale === 'en' ? 'ADDITIVE / FIELD LAB' : '3D-ПЕЧАТЬ / ЛАБОРАТОРИЯ'], 1.1, .34, [0, -.69, 1.665]));
  bolts(machine, [[-1.73, -.69, 1.67], [1.73, -.69, 1.67]], material.silver);
  bolts(machine, [[-1.52, -.49, -1.15], [1.52, -.49, -1.15], [-1.52, -.49, 1.15], [1.52, -.49, 1.15]], material.silver, 'y', .035);
  const bridge = new THREE.Group();
  bridge.add(rounded(3.85, .22, .2, .035, material.trim));
  bridge.add(cylinder(.027, 3.8, material.silver, [0, .1, .15], 'x'));
  bridge.add(cylinder(.027, 3.8, material.silver, [0, -.1, .15], 'x'));
  machine.add(bridge);
  const head = new THREE.Group();
  head.add(rounded(.46, .42, .36, .045, material.body));
  head.add(rounded(.34, .31, .03, .035, material.black, [0, 0, .215]));
  const fan = new THREE.Group();
  fan.add(ring(.116, .015, material.trim));
  for (let index = 0; index < 5; index++) {
    const blade = rectangular(.19, .025, .012, material.trim);
    blade.rotation.z = index * Math.PI / 5;
    fan.add(blade);
  }
  fan.position.z = .24;
  head.add(fan);
  head.add(rectangular(.21, .045, .04, material.mint, [0, .25, .15]));
  head.add(cylinder(.07, .12, material.trim, [0, -.29, 0]));
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(.065, .12, 16), material.copper);
  nozzle.rotation.z = Math.PI;
  nozzle.position.y = -.4;
  head.add(nozzle);
  bolts(head, [[-.17, -.15, .245], [.17, -.15, .245], [-.17, .15, .245], [.17, .15, .245]], material.silver, 'z', .018);
  machine.add(head);
  scene.add(machine);
  const contact = world.contact;
  const pathGeometry = new THREE.BufferGeometry();
  const pathPositions = new Float32Array(6);
  pathGeometry.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3));
  const activePath = new THREE.Line(pathGeometry, new THREE.LineBasicMaterial({ color: MINT, transparent: true, opacity: .9, depthWrite: false }));
  scene.add(activePath);
  const route = printPaths(craft.group.rotation.y);
  return (progress, departure = 0, reset = null) => {
    const build = clamp((progress - .06) / .7);
    const settle = smooth((progress - .78) / .22);
    const distance = build * route.length;
    const segment = route.paths.find(move => distance <= move.to) || route.paths[route.paths.length - 1];
    const cursor = segment.start.clone().lerp(segment.end, smooth((distance - segment.from) / (segment.to - segment.from)));
    const park = new THREE.Vector3(-1.45, .9, -1.05);
    const tool = cursor.clone().add(new THREE.Vector3(0, .48, 0)).lerp(park, settle);
    if (reset !== null) tool.lerp(park, 1 - smooth(reset));
    head.position.copy(tool);
    bridge.position.set(0, tool.y, tool.z - .13);
    fan.rotation.z = progress * 48;
    craft.group.visible = progress > .055 && reset === null;
    craft.group.position.set(0, settle * .19, settle * .35);
    craft.group.rotation.set(0, CRAFT_YAW + settle * .38, settle * -.055);
    depart(craft, departure, FLIGHTS.fabricator, world);
    clip.constant = departure > 0 ? 1000 : cursor.y + .025 + settle * 2;
    contact.position.copy(cursor).add(new THREE.Vector3(0, .08, 0));
    contact.intensity = progress > .055 && progress < .8 && segment.printing ? .5 : 0;
    activePath.visible = progress > .055 && progress < .8 && segment.printing;
    pathPositions.set(segment.start.toArray(), 0);
    pathPositions.set(cursor.toArray(), 3);
    pathGeometry.attributes.position.needsUpdate = true;
    pathGeometry.computeBoundingSphere();
  };
}

function receipt(locale) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  context.fillStyle = '#e5e6d9';
  context.fillRect(0, 0, 768, 1024);
  for (let row = 0; row < 1024; row += 3) {
    context.fillStyle = row % 9 ? '#dfe1d520' : '#fffdf32a';
    context.fillRect(0, row, 768, 1);
  }
  context.fillStyle = '#162a30';
  context.font = '700 78px Manrope, sans-serif';
  context.fillText('ANDROMAN', 58, 130);
  context.font = '500 24px "JetBrains Mono", monospace';
  context.fillText(locale === 'en' ? 'FIELD NOTES / TELEGRAM' : 'ЗАМЕТКИ / TELEGRAM', 62, 186);
  context.fillRect(60, 232, 648, 3);
  context.font = '700 49px Manrope, sans-serif';
  const lines = locale === 'en' ? ['The experiment', 'continues.'] : ['Эксперимент', 'продолжается.'];
  lines.forEach((line, index) => context.fillText(line, 60, 340 + index * 75));
  context.font = '500 32px "JetBrains Mono", monospace';
  context.fillText(locale === 'en' ? '1C  /  AI  /  PRACTICE' : '1С  /  ИИ  /  ПРАКТИКА', 60, 535);
  context.fillText('@andromanpro1c', 60, 602);
  context.fillRect(60, 655, 648, 3);
  context.font = '400 26px "JetBrains Mono", monospace';
  context.fillText('t.me/andromanpro1c', 60, 755);
  context.fillText(locale === 'en' ? 'SEE YOU IN THE CHANNEL' : 'ДО ВСТРЕЧИ В КАНАЛЕ', 60, 815);
  context.setLineDash([8, 9]);
  context.strokeStyle = '#7c8b88';
  context.beginPath(); context.moveTo(40, 935); context.lineTo(728, 935); context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function printer(world, locale) {
  const { scene, materials: material } = world;
  const machine = new THREE.Group();
  machine.add(rounded(3.15, .9, 1.94, .15, material.body, [0, -.42, .12]));
  machine.add(rounded(3.03, .12, 1.85, .11, material.trim, [0, .1, .12]));
  machine.add(rounded(2.53, .025, .33, .05, material.black, [0, .185, -.08]));
  const rollers = [];
  for (const z of [-.19, .03]) {
    const roller = cylinder(.075, 2.4, material.black, [0, .18, z], 'x', 32);
    machine.add(roller);
    rollers.push(roller);
  }
  machine.add(rectangular(2.57, .018, .025, material.light, [0, .2, .12]));
  machine.add(rounded(1.13, .32, .035, .04, material.black, [-.54, -.28, 1.13]));
  machine.add(plaque(['ANDROMAN', locale === 'en' ? 'THERMAL / 02' : 'ТЕРМО / 02'], .96, .25, [-.54, -.27, 1.156], '#061e26', '#64d4df'));
  for (let index = 0; index < 3; index++) {
    const button = cylinder(.085, .035, index === 0 ? material.mint : material.trim, [.41 + index * .27, -.27, 1.14], 'z');
    machine.add(button);
  }
  for (let index = 0; index < 9; index++) machine.add(rounded(.025, .23, .018, .01, material.black, [1.602, -.42, -.56 + index * .13]));
  const seam = rectangular(3.09, .012, .012, material.black, [0, -.58, 1.105]);
  machine.add(seam);
  for (const x of [-1.15, 1.15]) for (const z of [-.5, .7]) machine.add(cylinder(.16, .1, material.black, [x, -.94, z]));
  bolts(machine, [[-1.38, -.67, 1.12], [1.38, -.67, 1.12], [-1.38, -.05, 1.12], [1.38, -.05, 1.12]], material.silver);
  machine.rotation.y = -.1;
  scene.add(machine);
  const clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), -.2);
  const sheet = createFoldingPaper();
  const paper = new THREE.Mesh(sheet.geometry, new THREE.MeshPhysicalMaterial({ map: receipt(locale), color: 0xffffff, roughness: .92, metalness: 0, side: THREE.DoubleSide, clippingPlanes: [clip], clearcoat: 0, transparent: true }));
  paper.castShadow = true;
  paper.receiveShadow = true;
  paper.layers.set(1);
  const craft = { group: new THREE.Group(), surfaces: [paper.material], outlines: [] };
  craft.group.add(paper);
  scene.add(craft.group);
  return (progress, departure = 0, reset = null) => {
    const feed = smooth((progress - .05) / .75);
    const fold = clamp(departure / PRINTER_FOLD_PORTION);
    const lift = smooth(fold / .22);
    const flight = clamp((departure - PRINTER_FOLD_PORTION) / (1 - PRINTER_FOLD_PORTION));
    clip.constant = departure > 0 ? 1000 : -.2;
    sheet.update(fold, .05 * (1 - smooth(fold / .12)));
    craft.group.visible = progress > .05 && reset === null;
    craft.group.position.set(0, THREE.MathUtils.lerp(.2 + (feed - .5) * 2.68, FLIGHTS.printer.origin[1], lift),
      THREE.MathUtils.lerp(-.08, FLIGHTS.printer.origin[2], lift));
    craft.group.rotation.set((1 - lift) * Math.PI / 2, FLIGHTS.printer.yaw, 0);
    depart(craft, flight, FLIGHTS.printer, world);
    rollers.forEach(roller => { roller.rotation.x = -feed * 18; });
  };
}

function portal(world) {
  const { scene, materials: material } = world;
  const craft = aircraft();
  scene.add(craft.group);
  const assembly = new THREE.Group();
  const halo = new THREE.Group();
  halo.add(ring(1.78, .065, material.body));
  halo.add(ring(1.69, .018, material.light));
  halo.add(ring(1.9, .012, material.trim));
  const locations = [];
  for (let index = 0; index < 18; index++) {
    const angle = index * Math.PI / 9;
    const housing = rounded(.16, .28, .15, .025, material.trim, [Math.cos(angle) * 1.82, Math.sin(angle) * 1.82, 0]);
    housing.rotation.z = angle - Math.PI / 2;
    halo.add(housing);
    const led = rectangular(.06, .16, .012, index % 6 === 0 ? material.mint : material.light, [Math.cos(angle) * 1.82, Math.sin(angle) * 1.82, .092]);
    led.rotation.z = angle - Math.PI / 2;
    halo.add(led);
    locations.push([Math.cos(angle) * 1.9, Math.sin(angle) * 1.9, .035]);
  }
  bolts(halo, locations, material.silver, 'z', .022);
  assembly.add(halo);
  assembly.position.set(0, .73, -.68);
  assembly.rotation.y = -.18;
  scene.add(assembly);
  scene.add(rounded(.7, .27, .7, .06, material.body, [0, -.7, -.68]));
  const targets = [];
  for (const facet of facets.slice(0, 4)) {
    for (let row = 0; row <= 17; row++) {
      for (let column = 0; column <= 17 - row; column++) {
        const u = row / 17;
        const v = column / 17;
        targets.push(point(facet[0]).multiplyScalar(1 - u - v).addScaledVector(point(facet[1]), u).addScaledVector(point(facet[2]), v));
      }
    }
  }
  const shardMaterial = new THREE.MeshStandardMaterial({ color: 0x7bdced, metalness: .65, roughness: .26, emissive: 0x126680, emissiveIntensity: .35, transparent: true });
  const shards = new THREE.InstancedMesh(new THREE.OctahedronGeometry(.055), shardMaterial, targets.length);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const cloud = new THREE.Group();
  cloud.add(shards);
  scene.add(cloud);
  targets.forEach((target, index) => shards.setColorAt(index, new THREE.Color(index % 19 === 0 ? 0xd1e9ee : 0x65bdd4)));
  const transform = new THREE.Object3D();
  const start = new THREE.Vector3();
  return (progress, departure = 0, reset = null) => {
    const solid = smooth((progress - .72) / .22);
    const yaw = CRAFT_YAW + easeOut(progress) * .38;
    cloud.rotation.y = yaw;
    craft.group.rotation.set(0, yaw, 0);
    cloud.position.y = .08 + solid * .19;
    cloud.position.z = solid * .7;
    craft.group.position.set(0, cloud.position.y, cloud.position.z);
    craft.group.visible = progress > .71 && reset === null;
    craft.surfaces.forEach(surface => { surface.opacity = solid; surface.depthWrite = solid > .8; });
    craft.outlines.forEach(outline => { outline.opacity = solid * .45; });
    depart(craft, departure, FLIGHTS.fragments, world, solid);
    shards.visible = progress > .025 && progress < .96;
    shardMaterial.opacity = smooth(progress / .12) * (1 - solid);
    targets.forEach((target, index) => {
      const delay = (target.z + 1.9) / 2.8 * .17;
      const arrive = easeOut((progress - .04 - delay) / .57);
      const angle = index * 2.39996 + progress * 3.1;
      const radius = 2.05 + (index % 9) * .055;
      start.set(Math.cos(angle) * radius, .4 + ((index * 11) % 23) * .065, Math.sin(angle) * radius);
      transform.position.copy(start).lerp(target, arrive);
      transform.position.y += Math.sin(arrive * Math.PI) * .55;
      transform.rotation.set((1 - arrive) * angle, (1 - arrive) * angle * .6, (1 - arrive) * 1.2);
      transform.scale.set(.5 + arrive * .5, .65 + arrive * .35, .5 + arrive * .5);
      transform.updateMatrix();
      shards.setMatrixAt(index, transform.matrix);
    });
    shards.instanceMatrix.needsUpdate = true;
    halo.rotation.z = reset === null ? easeOut(progress) * .36 : .36 * (1 - smooth(reset));
  };
}

function disposeObjects(root, preserved = new Set(), extra = []) {
  const geometries = new Set();
  const materials = new Set(extra);
  const textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.isInstancedMesh) object.dispose();
    if (object.isLight && object.shadow) object.shadow.dispose();
    for (const material of object.material ? [].concat(object.material) : []) materials.add(material);
  });
  materials.forEach(material => {
    if (preserved.has(material)) return;
    for (const value of Object.values(material)) if (value && value.isTexture) textures.add(value);
    material.dispose();
  });
  geometries.forEach(geometry => geometry.dispose());
  textures.forEach(texture => texture.dispose());
}

export function createTelegramScene(canvas, variant, locale = 'ru', options) {
  const world = worldFor(canvas, options);
  const model = new THREE.Group();
  world.scene.add(model);
  const shared = new Set(Object.values(world.materials));
  const constructors = { fabricator, printer, fragments: portal };
  const trailPositions = new Float32Array(36 * 3);
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  const trail = new THREE.Points(trailGeometry, new THREE.PointsMaterial({ color: CYAN, size: .025, transparent: true, opacity: .6, depthWrite: false }));
  trail.frustumCulled = false;
  trail.layers.set(1);
  world.scene.add(trail);
  let kind = variant;
  let update;
  let disposed = false;
  let capturedSize = '';
  let flightCycle = -1;
  let modelRevision = 0;

  function setVariant(next, language = 'ru') {
    if (disposed) return;
    ++modelRevision;
    disposeObjects(model, shared);
    model.clear();
    kind = Object.hasOwn(constructors, next) ? next : 'fabricator';
    capturedSize = '';
    flightCycle = -1;
    world.flights.clear();
    canvas.dataset.variant = kind;
    world.contact.intensity = 0;
    update = constructors[kind]({ ...world, scene: model }, language);
  }

  function pose(progress, { departure = 0, reset = null } = {}) {
    update(clamp(progress), clamp(departure), reset);
    const flight = kind === 'printer' ? clamp((departure - PRINTER_FOLD_PORTION) / (1 - PRINTER_FOLD_PORTION)) : departure;
    trail.visible = flight > .01 && reset === null;
    trail.material.opacity = .28;
    if (trail.visible) {
      for (let index = 0; index < 36; index++) {
        const position = flightPoint(clamp(flight - index * .0009), FLIGHTS[kind], world);
        trailPositions.set(position.toArray(), index * 3);
      }
      trailGeometry.attributes.position.needsUpdate = true;
    }
  }

  function render(progress, options) {
    if (disposed) return;
    const cycle = options && options.cycle || 0;
    if (cycle !== flightCycle) {
      flightCycle = cycle;
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      world.flightView.seed = random[0] === world.flightView.seed ? (random[0] + 1) >>> 0 : random[0];
      canvas.dataset.flightSeed = String(world.flightView.seed);
      world.flights.clear();
    }
    const box = world.resize();
    pose(progress, options);
    const flying = Boolean(world.overlay && world.flightView.object);
    if (flying) {
      const size = [box.width, box.height].join('/');
      if (capturedSize !== size) {
        world.viewport(box);
        world.camera.layers.set(0);
        world.renderer.shadowMap.needsUpdate = true;
        world.renderer.render(world.scene, world.camera);
        world.baseCanvas.width = canvas.width;
        world.baseCanvas.height = canvas.height;
        world.baseCanvas.getContext('2d').drawImage(canvas, 0, 0);
        world.occluder.geometry.dispose();
        world.occluder.geometry = occlusionGeometry(world.scene);
        capturedSize = size;
        world.resize();
      }
      world.baseCanvas.hidden = false;
      world.flightView.object.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(world.flightView.object);
      const points = [];
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(world.camera);
        points.push({ x: (projected.x + 1) * innerWidth / 2, y: (1 - projected.y) * innerHeight / 2 });
      }
      const left = Math.min(...points.map(point => point.x));
      const right = Math.max(...points.map(point => point.x));
      const top = Math.min(...points.map(point => point.y));
      const bottom = Math.max(...points.map(point => point.y));
      const crop = Math.max(256, Math.ceil(Math.max(right - left, bottom - top) + 160));
      const rect = { left: (left + right - crop) / 2, top: (top + bottom - crop) / 2, width: crop, height: crop };
      world.viewport(rect, 512, 512);
      world.camera.layers.set(1);
      world.renderer.shadowMap.needsUpdate = false;
      canvas.style.visibility = right < -80 || left > innerWidth + 80 || bottom < -80 || top > innerHeight + 80 ? 'hidden' : 'visible';
    } else {
      if (world.baseCanvas) world.baseCanvas.hidden = true;
      world.viewport(box);
      world.camera.layers.set(0);
      world.camera.layers.enable(1);
      world.renderer.shadowMap.needsUpdate = true;
      canvas.style.visibility = 'visible';
    }
    if (canvas.style.visibility !== 'hidden') {
      const rect = canvas.getBoundingClientRect();
      const overlaps = flying && rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
      if (overlaps) {
        world.renderer.render(world.occlusion, world.camera);
        world.renderer.autoClear = false;
      }
      world.renderer.render(world.scene, world.camera);
      world.renderer.autoClear = true;
    }
  }

  setVariant(variant, locale);
  return {
    render,
    get departureDuration() { return kind === 'printer' ? PRINTER_DEPARTURE_MS : 18000; },
    resize: world.resize,
    setVariant,
    async prepare() {
      const revision = modelRevision;
      const poses = [[.35, {}], [1, {}], [1, { departure: .2 }], [1, { departure: .6 }], [0, { reset: .5 }]];
      for (const [progress, options] of poses) {
        if (disposed || revision !== modelRevision) return;
        pose(progress, options);
        await world.renderer.compileAsync(world.scene, world.camera);
        if (disposed || revision !== modelRevision) return;
        render(progress, options);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (!disposed && revision === modelRevision) render(0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++modelRevision;
      disposeObjects(world.scene, new Set(), Object.values(world.materials));
      disposeObjects(world.occlusion);
      world.environment.dispose();
      world.renderer.dispose();
      if (world.baseCanvas) world.baseCanvas.remove();
    },
  };
}
