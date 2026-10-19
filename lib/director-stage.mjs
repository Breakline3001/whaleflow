// Shared, browser-safe director document contract. Angles are radians except camera.fov.
export const DIRECTOR_OBJECT_TYPES = Object.freeze(['person', 'box', 'sphere', 'plane']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const vector = value => Array.isArray(value) && value.length === 3 && value.every(finite);
export function validateDirectorStage(value) {
  const errors = [];
  const check = (ok, path, message) => { if (!ok) errors.push(`${path}: ${message}`); };
  if (!plain(value)) return { valid: false, errors: ['stage: expected an object'] };
  check(Number.isSafeInteger(value.revision) && value.revision >= 0, 'revision', 'expected a nonnegative safe integer');
  check(Array.isArray(value.objects) && value.objects.length <= 200, 'objects', 'expected at most 200 objects');
  const ids = new Set();
  if (Array.isArray(value.objects)) value.objects.forEach((object, index) => {
    const path = `objects[${index}]`;
    if (!plain(object)) { errors.push(`${path}: expected an object`); return; }
    check(typeof object.id === 'string' && object.id.length > 0 && object.id.length <= 128 && !ids.has(object.id), `${path}.id`, 'expected a unique nonempty ID (max 128 characters)');
    ids.add(object.id);
    check(DIRECTOR_OBJECT_TYPES.includes(object.type), `${path}.type`, 'unsupported geometry');
    check(typeof object.name === 'string' && object.name.length <= 200, `${path}.name`, 'expected a name (max 200 characters)');
    for (const key of ['position', 'rotation', 'scale']) check(vector(object[key]) && object[key].every(n => Math.abs(n) <= 10000) && (key !== 'scale' || object[key].every(n => n >= 0.001)), `${path}.${key}`, 'expected three bounded finite numbers; scales must be positive');
  });
  if (!plain(value.camera)) errors.push('camera: expected an object');
  else {
    const c = value.camera;
    check(finite(c.azimuth) && Math.abs(c.azimuth) <= 10000, 'camera.azimuth', 'expected bounded radians');
    check(finite(c.elevation) && Math.abs(c.elevation) <= 1.55, 'camera.elevation', 'expected radians between -1.55 and 1.55');
    check(finite(c.distance) && c.distance >= 0.2 && c.distance <= 1000, 'camera.distance', 'expected 0.2–1000');
    check(vector(c.target) && c.target.every(n => Math.abs(n) <= 10000), 'camera.target', 'expected a finite target');
    check(finite(c.fov) && c.fov >= 10 && c.fov <= 120, 'camera.fov', 'expected 10–120 degrees');
  }
  check(typeof value.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background), 'background', 'expected #rrggbb');
  check(typeof value.grid === 'boolean', 'grid', 'expected boolean');
  check(finite(value.aspectRatio) && value.aspectRatio >= 0.25 && value.aspectRatio <= 4, 'aspectRatio', 'expected 0.25–4');
  if (value.panoramaNodeId !== undefined) check(typeof value.panoramaNodeId === 'string' && value.panoramaNodeId.length > 0 && value.panoramaNodeId.length <= 128, 'panoramaNodeId', 'expected a nonempty node ID');
  return { valid: errors.length === 0, errors };
}
export function createDirectorStage(overrides = {}) {
  const value = {
    revision: 0,
    objects: [{ id: 'person-1', type: 'person', name: '人物 1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
    camera: { azimuth: 0.65, elevation: 0.3, distance: 7, target: [0, 0.9, 0], fov: 45 },
    background: '#181b20', grid: true, aspectRatio: 16 / 9,
    ...overrides,
  };
  const result = validateDirectorStage(value);
  if (!result.valid) throw new TypeError(result.errors.join('; '));
  return JSON.parse(JSON.stringify(value));
}
