// Turns a map position into a place name for the admin console ("Jardin d'Essai, Algiers"), so that nobody has to
// type one. Uses MapTiler when the map itself comes from MapTiler (the key is already in MAP_TILE_URL), and
// OpenStreetMap's Nominatim otherwise. Best effort: anything that goes wrong simply means no name.

const NAME_LIMIT = 40; // the Place name box takes this many characters
const TIMEOUT_MS = 5000;

/** The MapTiler key inside a tile address, if the map comes from MapTiler. */
export function maptilerKey(tileUrl) {
  const m = String(tileUrl || '').match(/^https:\/\/api\.maptiler\.com\/.*[?&]key=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** "Park, City", cut to fit the box without chopping a word in half when it can be helped. */
function join(name, city) {
  const a = clean(name);
  const b = clean(city);
  if (!a) return '';
  const full = b && b.toLowerCase() !== a.toLowerCase() ? `${a}, ${b}` : a;
  if (full.length <= NAME_LIMIT) return full;
  if (a.length <= NAME_LIMIT) return a;
  return a.slice(0, NAME_LIMIT - 1).trimEnd() + '…';
}

// What a park, a square or a street is called in each answer, from the most useful kind of feature to the least.
const MAPTILER_PREFERENCE = ['poi', 'park', 'neighbourhood', 'locality', 'municipal_district', 'address', 'street', 'postal_code', 'municipality', 'place', 'subregion', 'region'];

/** Picks a name out of MapTiler's reverse-geocoding answer. Exported for tests. */
export function fromMaptiler(body) {
  const features = body && Array.isArray(body.features) ? body.features : [];
  let best = null;
  let bestRank = Infinity;
  for (const f of features) {
    const types = Array.isArray(f.place_type) ? f.place_type : [];
    const rank = Math.min(...types.map((t) => (MAPTILER_PREFERENCE.includes(t) ? MAPTILER_PREFERENCE.indexOf(t) : 50)), 60);
    if (rank < bestRank && clean(f.text)) {
      best = f;
      bestRank = rank;
    }
  }
  if (!best) return '';
  const context = Array.isArray(best.context) ? best.context : [];
  const city = context.find((c) => /^(municipality|place|city)\b/.test(String(c.id || '')) && clean(c.text));
  return join(best.text, city ? city.text : '');
}

/** The same for Nominatim (OpenStreetMap). Exported for tests. */
export function fromNominatim(body) {
  if (!body || typeof body !== 'object') return '';
  const a = body.address && typeof body.address === 'object' ? body.address : {};
  const name = body.name || a.leisure || a.tourism || a.amenity || a.pedestrian || a.road || a.neighbourhood || a.suburb || a.quarter;
  const city = a.city || a.town || a.village || a.municipality || a.county;
  return join(name, city);
}

/**
 * A short name for the place at lat, lng, or '' when none can be had.
 * `tileUrl` decides the provider; `fetchImpl` and `userAgent` are for tests and for being a polite Nominatim client.
 */
export async function placeName(lat, lng, { tileUrl = '', fetchImpl = globalThis.fetch, userAgent = 'SolanaGO (admin console)' } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  const ask = async (url, parse) => {
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': userAgent }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return '';
      return parse(await res.json());
    } catch {
      return '';
    }
  };
  const key = maptilerKey(tileUrl);
  const viaMaptiler = key ? await ask(`https://api.maptiler.com/geocoding/${lng.toFixed(6)},${lat.toFixed(6)}.json?key=${encodeURIComponent(key)}&limit=5`, fromMaptiler) : '';
  if (viaMaptiler) return viaMaptiler;
  // OpenStreetMap's own service, when the map is not from MapTiler or MapTiler had no answer
  return ask(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&zoom=17`, fromNominatim);
}
