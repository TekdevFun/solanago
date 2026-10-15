// Small geography helpers. Distances are in metres, coordinates in degrees.

import crypto from 'node:crypto';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export const validLatLng = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/** Great-circle distance between two {lat, lng} points. */
export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Moves a point by metres east and north. Accurate at city scale. */
export function offsetM(point, eastM, northM) {
  return {
    lat: point.lat + (northM / EARTH_RADIUS_M) / RAD,
    lng: point.lng + (eastM / (EARTH_RADIUS_M * Math.cos(point.lat * RAD))) / RAD,
  };
}

/** A uniformly random point inside a circle. */
export function randomInCircle(center, radiusM, rnd = Math.random) {
  const r = radiusM * Math.sqrt(rnd());
  const angle = rnd() * 2 * Math.PI;
  return offsetM(center, r * Math.cos(angle), r * Math.sin(angle));
}

/** Size of a box (in degrees) that contains a circle of radiusM around the point. */
export function boundingBox(point, radiusM) {
  const dLat = (radiusM / EARTH_RADIUS_M) / RAD;
  const dLng = dLat / Math.max(0.01, Math.cos(point.lat * RAD));
  return { minLat: point.lat - dLat, maxLat: point.lat + dLat, minLng: point.lng - dLng, maxLng: point.lng + dLng };
}

/**
 * The position shown on the map until a hunter is close: the true spot shifted by
 * up to maxM, always the same shift for the same drop, and not guessable without the secret.
 */
export function fuzzPoint(point, key, secret, maxM) {
  if (!(maxM > 0)) return { lat: point.lat, lng: point.lng };
  const h = crypto.createHmac('sha256', String(secret)).update(String(key)).digest();
  const r = maxM * Math.sqrt(h.readUInt32BE(0) / 0xffffffff);
  const angle = (h.readUInt32BE(4) / 0xffffffff) * 2 * Math.PI;
  return offsetM(point, r * Math.cos(angle), r * Math.sin(angle));
}

/** Deterministic random numbers in [0, 1) from a seed, for repeatable batches in tests. */
export function seededRandom(seed) {
  let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
