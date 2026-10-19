// Shared browser-safe creative document contract. No Node or platform APIs.
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value, path, max = 200000) => {
  if (typeof value !== 'string' || value.length > max) return `${path}: expected a string (max ${max} characters)`;
  return null;
};
const ownKeys = (value, allowed, path, errors) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}: unsupported field ${key}`);
};
const clone = (value) => JSON.parse(JSON.stringify(value));

const SHOT_KEYS = new Set(['id', 'title', 'description', 'duration', 'shotSize', 'camera', 'dialogue', 'sound', 'prompt', 'referenceNodeId']);
const ENTITY_KEYS = new Set(['id', 'name', 'description']);
const ROOT_KEYS = new Set(['revision', 'title', 'synopsis', 'style', 'aspectRatio', 'script', 'shots', 'characters', 'scenes', 'props', 'history']);

function validateRows(rows, name, keys, errors, fields) {
  if (!Array.isArray(rows) || rows.length > 2000) { errors.push(`${name}: expected an array with at most 2000 entries`); return; }
  const ids = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const path = `${name}[${index}]`;
    if (!Object.hasOwn(rows, index) || !plain(row)) { errors.push(`${path}: expected an object`); continue; }
    ownKeys(row, keys, path, errors);
    const idError = text(row.id, `${path}.id`, 200);
    if (idError) errors.push(idError);
    else if (!row.id.trim() || ids.has(row.id)) errors.push(`${path}.id: expected a unique nonempty ID`);
    ids.add(row.id);
    for (const [key, max] of fields) {
      const error = text(row[key], `${path}.${key}`, max);
      if (error) errors.push(error);
    }
    if (name === 'shots') {
      if (typeof row.duration !== 'number' || !Number.isFinite(row.duration) || row.duration < 0 || row.duration > 86400) errors.push(`${path}.duration: expected a finite number from 0 to 86400`);
      if (row.referenceNodeId !== undefined) {
        const error = text(row.referenceNodeId, `${path}.referenceNodeId`, 200);
        if (error) errors.push(error);
        else if (!row.referenceNodeId.trim()) errors.push(`${path}.referenceNodeId: expected a nonempty ID`);
      }
    }
  }
}

export function validateCreativeDocument(value) {
  const errors = [];
  if (!plain(value)) return { valid: false, errors: ['creative: expected an object'] };
  ownKeys(value, ROOT_KEYS, 'creative', errors);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) errors.push('revision: expected a nonnegative safe integer');
  for (const [key, max] of [['title', 500], ['synopsis', 200000], ['style', 200000], ['aspectRatio', 50], ['script', 1000000]]) {
    const error = text(value[key], key, max); if (error) errors.push(error);
  }
  if (typeof value.aspectRatio !== 'string' || !value.aspectRatio.trim()) errors.push('aspectRatio: expected a nonempty value');
  validateRows(value.shots, 'shots', SHOT_KEYS, errors, [['title', 500], ['description', 200000], ['shotSize', 200], ['camera', 200000], ['dialogue', 200000], ['sound', 200000], ['prompt', 200000]]);
  for (const name of ['characters', 'scenes', 'props']) validateRows(value[name], name, ENTITY_KEYS, errors, [['name', 500], ['description', 200000]]);
  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > 8) errors.push('history: expected an array with at most 8 entries');
    else for (let index = 0; index < value.history.length; index++) {
      const entry = value.history[index];
      if (!Object.hasOwn(value.history, index) || !plain(entry) || Object.hasOwn(entry, 'history')) { errors.push(`history[${index}]: expected a document snapshot without nested history`); continue; }
      const result = validateCreativeDocument(entry);
      for (const error of result.errors) errors.push(`history[${index}].${error}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function createCreativeDocument(overrides = {}) {
  const value = {
    revision: 1, title: '', synopsis: '', style: '', aspectRatio: '16:9', script: '', shots: [],
    characters: [], scenes: [], props: [], ...overrides,
  };
  if (overrides.history !== undefined) value.history = overrides.history;
  const result = validateCreativeDocument(value);
  if (!result.valid) throw new TypeError(result.errors.join('; '));
  return clone(value);
}
