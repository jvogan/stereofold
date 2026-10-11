'use strict';

const EPSILON = 1e-9;
const IDENTITY_4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const IDENTITY_3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function vector(value, length, name) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${name} requires ${length} finite numbers.`);
  }
  const result = [];
  for (let i = 0; i < length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) throw new TypeError(`${name} requires a dense array.`);
    const component = value[i];
    if (!Number.isFinite(component)) throw new TypeError(`${name} requires ${length} finite numbers.`);
    result.push(component);
  }
  return result;
}

function finiteResult(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} is outside the finite numeric range.`);
  return value;
}

function determinant3(value) {
  const m = vector(value, 9, 'Rotation');
  return finiteResult(m[0] * (m[4] * m[8] - m[7] * m[5])
    - m[3] * (m[1] * m[8] - m[7] * m[2])
    + m[6] * (m[1] * m[5] - m[4] * m[2]), 'Determinant');
}

function rotationMatrix(value) {
  const m = vector(value, 9, 'Rotation');
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      let dot = 0;
      for (let i = 0; i < 3; i++) dot += m[3 * a + i] * m[3 * b + i];
      if (Math.abs(dot - (a === b ? 1 : 0)) > EPSILON) {
        throw new RangeError('Display rotation must be orthonormal.');
      }
    }
  }
  if (Math.abs(determinant3(m) - 1) > EPSILON) {
    throw new RangeError('Display rotation must preserve handedness.');
  }
  return m;
}

// Mol* assembly matrices use column-major storage and scientific angstroms.
function applyOperator(point, matrix) {
  const p = vector(point, 3, 'Scientific point');
  const m = vector(matrix, 16, 'Assembly matrix');
  if ([m[3], m[7], m[11], m[15] - 1].some(v => Math.abs(v) > EPSILON)) {
    throw new RangeError('Assembly matrix must be affine.');
  }
  return vector([0, 1, 2].map(row => m[row] * p[0] + m[4 + row] * p[1]
    + m[8 + row] * p[2] + m[12 + row]), 3, 'Transformed scientific point');
}

function displayTransform({ metresPerAngstrom, rotation = IDENTITY_3, translationMetres = [0, 0, 0] }) {
  if (!Number.isFinite(metresPerAngstrom) || metresPerAngstrom <= 0) {
    throw new RangeError('Display scale must be a finite positive metres-per-angstrom value.');
  }
  return Object.freeze({
    metresPerAngstrom,
    rotation: Object.freeze([...rotationMatrix(rotation)]),
    translationMetres: Object.freeze([...vector(translationMetres, 3, 'Display translation')]),
  });
}

function toDisplayPoint(pointAngstrom, transform) {
  const p = vector(pointAngstrom, 3, 'Scientific point');
  const t = displayTransform(transform);
  return vector([0, 1, 2].map(row => t.translationMetres[row] + t.metresPerAngstrom * (
    t.rotation[row] * p[0] + t.rotation[3 + row] * p[1]
    + t.rotation[6 + row] * p[2])), 3, 'Display point');
}

function fromDisplayPoint(pointMetres, transform) {
  const point = vector(pointMetres, 3, 'Display point');
  const t = displayTransform(transform);
  const p = point.map((v, i) => (v - t.translationMetres[i]) / t.metresPerAngstrom);
  return vector([0, 1, 2].map(col => t.rotation[3 * col] * p[0]
    + t.rotation[3 * col + 1] * p[1] + t.rotation[3 * col + 2] * p[2]), 3, 'Recovered scientific point');
}

function distance(a, b) {
  const first = vector(a, 3, 'First point');
  const second = vector(b, 3, 'Second point');
  return finiteResult(Math.hypot(...first.map((v, i) => v - second[i])), 'Distance');
}

function signedVolume6(points) {
  if (!Array.isArray(points) || points.length !== 4) throw new TypeError('Four points are required.');
  const snapshot = [];
  for (let i = 0; i < 4; i++) {
    if (!Object.prototype.hasOwnProperty.call(points, i)) throw new TypeError('Four dense points are required.');
    snapshot.push(vector(points[i], 3, 'Volume point'));
  }
  return determinant3(snapshot.slice(1).flatMap(p => p.map((v, i) => v - snapshot[0][i])));
}

module.exports = { EPSILON, IDENTITY_4, IDENTITY_3, applyOperator, displayTransform, toDisplayPoint, fromDisplayPoint, distance, signedVolume6 };
