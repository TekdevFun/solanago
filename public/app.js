// The SolanaGO app: map, hunt, camera claim and wallet, talking to the server in ../server.
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const outCubic = t => 1 - Math.pow(1 - t, 3);
const ioCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TileMap = window.TileMap; // from /tilemap.js
const RAD = Math.PI / 180;

/* ---------- one animation loop for everything ---------- */
const tickers = new Set(); let raf = 0, last = 0;
function frame(t) { const dt = Math.min(.05, Math.max(0, (t - last) / 1000)); last = t; tickers.forEach(fn => fn(dt, t / 1000)); raf = tickers.size ? requestAnimationFrame(frame) : 0; }
function addTicker(fn) { tickers.add(fn); if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } return () => tickers.delete(fn); }
function tween(ms, step, done) { let t = 0; const stop = addTicker(dt => { t += dt * 1000 / Math.max(1, ms); if (t >= 1) { stop(); step(1); done && done(); } else step(t); }); return stop; }

/* ---------- words and numbers ---------- */
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const sol = lamports => nf.format(lamports / 1e9);
const int = n => Math.round(n).toLocaleString('en-US');
const short = a => a.slice(0, 4) + '…' + a.slice(-4);
const tk = n => n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? (n / 1e3) + 'K' : String(n);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const distLabel = m => m < 1000 ? Math.round(m) + ' m' : m < 10000 ? (m / 1000).toFixed(1) + ' km' : int(m / 1000) + ' km';
const timeOfDay = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function countdown(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':'); }
function ago(ts) { const m = Math.floor((now() - ts) / 60000); return m < 1 ? 'Just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

/* ---------- geography ---------- */
function distanceM(a, b) { const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2; return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h))); }
function bearing(a, b) { const p1 = a.lat * RAD, p2 = b.lat * RAD, dl = (b.lng - a.lng) * RAD; return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / RAD + 360) % 360; }
const wrap180 = d => ((d % 360) + 540) % 360 - 180;
const compassWord = d => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(d / 45) % 8];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function isAddress(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  return bytes + zeros === 32;
}

/* ---------- what this phone remembers ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('sgo.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sgo.' + k, JSON.stringify(v)); } catch (e) {} }
};
let device = store.get('device', '');
if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) { device = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); store.set('device', device); }
let address = store.get('address', ''); if (!isAddress(address)) address = '';

const S = { cfg: null, batches: [], drops: [], tier: 0, balance: 0, reach: 30, stats: null, mine: null, offset: 0, synced: 0, syncPos: null };
const me = { lat: null, lng: null, acc: null, compass: null, compassTs: 0, course: null, state: 'idle' };
const now = () => Date.now() + S.offset;
const T = () => '$' + S.cfg.ticker;
const batchOf = id => S.batches.find(b => b.id === id);
// Map pictures are turned dark in the browser unless the map provider already serves a dark style.
const darkTiles = () => /dark|night|black/i.test(S.cfg.tileUrl || '');

async function api(path, body) {
  let res;
  try { res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined); }
  catch (e) { const err = new Error('No connection. Check your signal and try again.'); err.code = 'offline'; throw err; }
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok || (data && data.ok === false)) { const err = new Error((data && data.message) || 'Something went wrong. Try again.'); err.code = (data && data.error) || 'server'; err.data = data || {}; throw err; }
  return data;
}

/* ---------- the coin, drawn on canvas so it can turn ---------- */
const css = getComputedStyle(document.documentElement), tok = n => css.getPropertyValue(n).trim();
const COL = { a: tok('--coin-a') || '#cf47ea', b: tok('--coin-b') || '#6f9acd', c: tok('--coin-c') || '#19f5a3', f: tok('--coin-face') || '#232323', f2: tok('--coin-face-hi') || '#3b3b42', e1: tok('--coin-e1') || '#0b0b0c', e2: tok('--coin-e2') || '#3a3a40', e3: tok('--coin-e3') || '#151517' };
function drawCoin(ctx, x, y, R, yaw, alpha) {
  const c = Math.cos(yaw), s = Math.sin(yaw), ac = Math.max(Math.abs(c), .03), off = R * .13 * s;
  const nx = c >= 0 ? off : -off, fx = -nx;
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = alpha == null ? 1 : alpha;
  const eg = ctx.createLinearGradient(-R, 0, R, 0); eg.addColorStop(0, COL.e1); eg.addColorStop(.5, COL.e2); eg.addColorStop(1, COL.e3);
  ctx.fillStyle = eg; ctx.beginPath(); ctx.ellipse(fx, 0, R * ac, R, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(Math.min(fx, nx), -R, Math.abs(nx - fx), R * 2);
  if (Math.abs(nx - fx) > 1.5) {
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = Math.max(.6, R * .014); ctx.beginPath();
    const side = nx > 0 ? Math.PI : 0;
    for (let i = -11; i <= 11; i++) { const ph = side + i * .125, xr = R * ac * Math.cos(ph), yr = R * Math.sin(ph); ctx.moveTo(fx + xr, yr); ctx.lineTo(nx + xr, yr); }
    ctx.stroke();
  }
  ctx.translate(nx, 0); ctx.scale(ac, 1);
  const fg = ctx.createRadialGradient(-R * .3, -R * .4, 0, 0, 0, R * 1.1); fg.addColorStop(0, COL.f2); fg.addColorStop(1, COL.f);
  ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = R * .04; ctx.beginPath(); ctx.arc(0, 0, R * .93, 0, Math.PI * 2); ctx.stroke();
  const bg = ctx.createLinearGradient(-R * .575, R * .47, R * .575, -R * .48); bg.addColorStop(0, COL.a); bg.addColorStop(.5, COL.b); bg.addColorStop(1, COL.c);
  ctx.fillStyle = bg; ctx.strokeStyle = bg; ctx.lineWidth = R * .05; ctx.lineJoin = 'round'; ctx.beginPath();
  for (const cy of [-.357, 0, .357]) {
    const k = .19 * R * (cy === 0 ? -1 : 1), x0 = -.55 * R, x1 = .55 * R, y0 = (cy - .093) * R, y1 = (cy + .093) * R;
    ctx.moveTo(x0 + Math.max(k, 0), y0); ctx.lineTo(x1 + Math.min(k, 0), y0); ctx.lineTo(x1 - Math.max(k, 0), y1); ctx.lineTo(x0 - Math.min(k, 0), y1); ctx.closePath();
  }
  ctx.fill(); ctx.stroke();
  const hl = Math.max(0, Math.cos(yaw - .5)), sg = ctx.createRadialGradient(-R * .36, -R * .46, 0, -R * .36, -R * .46, R * 1.15);
  sg.addColorStop(0, `rgba(255,255,255,${(.26 * hl).toFixed(3)})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${(.45 * (1 - ac)).toFixed(3)})`; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function sizeCanvas(c, w, h) { const dpr = Math.min(2.5, window.devicePixelRatio || 1); c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return x; }

/* ---------- screens ---------- */
const phone = $('#phone');
const screens = { home: $('#home'), map: $('#map'), hunt: $('#hunt'), ar: $('#ar') };
let cur = 'home';
function go(name) {
  if (name === cur) return;
  const prev = screens[cur], next = screens[name], was = cur;
  next.hidden = false; void next.offsetWidth; next.classList.add('on'); prev.classList.remove('on');
  cur = name;
  setTimeout(() => { if (cur !== was) prev.hidden = true; }, 800);
  if (name === 'map') mapView.show();
  if (name === 'home') { renderHome(); refreshHome(); }
}
const toastEl = $('#toast'); let toastT = 0;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), Math.max(3200, msg.length * 65)); } // long messages stay long enough to read
const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };
[$('#pins'), $('#mapWrap'), $('#map'), phone].forEach(el => el.addEventListener('scroll', () => { if (el.scrollLeft || el.scrollTop) { el.scrollLeft = 0; el.scrollTop = 0; } }));

/* ---------- location and compass ---------- */
let watchId = null;
function startLocation() {
  if (!('geolocation' in navigator)) { me.state = 'unavailable'; locChanged(); return; }
  if (watchId !== null) return;
  if (me.lat === null) me.state = 'asking';
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 });
  locChanged();
}
function onPosition(p) {
  const first = me.lat === null, prev = first ? null : { lat: me.lat, lng: me.lng };
  me.lat = p.coords.latitude; me.lng = p.coords.longitude; me.acc = p.coords.accuracy; me.state = 'on';
  if (Number.isFinite(p.coords.heading) && p.coords.speed > .7) me.course = p.coords.heading;
  else if (prev && distanceM(prev, me) > 5) me.course = bearing(prev, me);
  if (first) { sync(); if (cur === 'map') mapView.centre(false); }
  else if (S.syncPos && distanceM(S.syncPos, me) > 25) sync();
  locChanged();
}
function onPositionError(e) {
  if (e.code === 1) { me.state = 'denied'; if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
  else if (me.lat === null) me.state = 'unavailable';
  locChanged();
}
function locChanged() { renderAlert(); if (cur === 'map') { mapView.place(); mapView.note(); } if (hunt) huntUpdate(); }
let compassOn = false;
async function startCompass() {
  if (compassOn) return true;
  const D = window.DeviceOrientationEvent; if (!D) return false;
  try { if (typeof D.requestPermission === 'function' && (await D.requestPermission()) !== 'granted') return false; } catch (e) { return false; }
  const onTurn = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h === null || !Number.isFinite(h)) return;
    me.compass = (h + ((screen.orientation && screen.orientation.angle) || 0) + 360) % 360; me.compassTs = Date.now();
  };
  window.addEventListener('deviceorientationabsolute', onTurn, true); window.addEventListener('deviceorientation', onTurn, true);
  compassOn = true; return true;
}
/** Which way the phone points, in degrees from north, or null when we cannot tell. */
const heading = () => (me.compass !== null && Date.now() - me.compassTs < 4000) ? me.compass : me.course;

/* ---------- talking to the server ---------- */
let syncing = false, syncAgain = false, netDown = false, wantFresh = false;
async function sync(fresh) {
  if (!S.cfg) return;
  if (fresh) wantFresh = true; // re-read the token balance now: they may have just bought
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const q = new URLSearchParams({ device });
    if (wantFresh && address) { q.set('fresh', '1'); wantFresh = false; }
    const pos = me.lat === null ? null : { lat: me.lat, lng: me.lng };
    if (pos) { q.set('lat', pos.lat.toFixed(6)); q.set('lng', pos.lng.toFixed(6)); if (me.acc != null) q.set('acc', String(Math.round(me.acc))); }
    if (address) q.set('address', address);
    const d = await api('/api/sync?' + q);
    S.batches = d.batches; S.drops = d.drops; S.tier = d.tier; S.balance = d.balance || 0; S.reach = d.reach; S.offset = d.now - Date.now(); S.synced = Date.now(); S.syncPos = pos;
    $('#pauseTag').hidden = !d.paused;
    if (netDown) { netDown = false; toast('Back online'); }
    renderAlert(); renderBatches(); renderPerks(); renderFees(); if (cur === 'map') mapView.refresh(); if (hunt) huntRefresh();
  } catch (e) { S.synced = Date.now() - 3000; if (!netDown && e.code === 'offline') { netDown = true; toast(e.message); } }
  finally { syncing = false; if (syncAgain) { syncAgain = false; sync(); } }
}
async function refreshHome() {
  try {
    const [stats, mine] = await Promise.all([api('/api/stats'), address ? api('/api/me?address=' + encodeURIComponent(address)) : null]);
    S.stats = stats; S.mine = mine; renderFees(); renderFound();
  } catch (e) {}
}

/* ---------- home ---------- */
function renderWallet() {
  $('#walletChipTxt').textContent = address ? short(address) : 'Add wallet';
  $('#walletChip').classList.toggle('none', !address);
  $('#walletSub').textContent = address ? short(address) : 'Where your SOL goes';
}
function nearestDrop() { return S.drops.find(d => !d.locked && !(batchOf(d.b) || {}).done) || null; }
function renderAlert() {
  if (!S.cfg) return;
  let title, sub;
  if (me.state === 'denied') [title, sub] = ['Location is off', 'Allow it in your browser settings to hunt'];
  else if (me.lat === null && me.state === 'unavailable') [title, sub] = ["Can't find you yet", 'Step outside, or check that location is on'];
  else if (me.lat === null) [title, sub] = me.state === 'asking' ? ['Finding you…', 'Waiting for your location'] : ['Find drops near you', 'Tap to turn on location'];
  else {
    const d = nearestDrop(), open = S.batches.filter(b => b.open && b.left > 0).sort((a, b) => a.distM - b.distM)[0], soon = S.batches.filter(b => !b.open).sort((a, b) => a.opensAt - b.opensAt)[0];
    if (d) { const b = batchOf(d.b) || {}; [title, sub] = [`A ${sol(d.lamports)} SOL drop is ${distLabel(d.dist)} away`, `${b.area || b.name || 'Nearby'} · ${T()} fees`]; }
    else if (open) [title, sub] = [`Drops are live in ${open.area || open.name}`, open.distM == null ? 'Open the map to see where' : open.distM <= open.radiusM ? 'You are inside the drop zone' : `${distLabel(open.distM)} from you`];
    else if (soon) [title, sub] = [`Next drop: ${soon.area || soon.name}`, `Opens at ${timeOfDay(soon.opensAt)}`];
    else [title, sub] = ['No drops live right now', 'New batches are hidden as fees come in'];
  }
  $('#alertTitle').textContent = title; $('#alertSub').textContent = sub;
}
function renderBatches() {
  const el = $('#batchList');
  if (!S.batches.length) { el.innerHTML = '<div class="list"><div class="empty">No drops live right now. New batches are hidden as trading fees come in.</div></div>'; return; }
  el.innerHTML = S.batches.map(b => {
    const pct = b.drops ? ((b.drops - b.left) / b.drops * 100).toFixed(1) : 0;
    const when = !b.open ? `Opens in <b data-until="${b.opensAt}"></b>` : b.left === 0 ? 'Every drop here has been found.' : b.early ? `<b>Early access.</b> Opens to everyone in <b data-until="${b.startsAt}"></b>` : `Ends at ${timeOfDay(b.endsAt)}`;
    return `<button class="camp${b.done ? ' done' : ''}" type="button" data-batch="${b.id}"><svg class="coinf" width="34" height="34"><use href="#coinf"/></svg>` +
      `<span class="camp-t"><b>${esc(b.name)}</b><small>${sol(b.totalLamports)} SOL · ${int(b.left)} of ${int(b.drops)} left${b.distM == null ? '' : ' · ' + distLabel(b.distM)}</small></span>` +
      `<svg class="ico"><use href="#i-chev"/></svg><span class="bar"><i style="width:${pct}%"></i></span><span class="when">${b.done ? 'You found your drop in this batch. ' : ''}${b.done && b.left === 0 ? '' : when}</span></button>`;
  }).join('');
  tickClocks();
}
function renderFees() {
  const s = S.stats, c = S.cfg; if (!s || !c) return;
  $('#feeIn').textContent = sol(s.feesIn); $('#feeOut').textContent = sol(s.hidden); $('#feeClaimed').textContent = sol(s.claimed);
  $('#nextAmt').textContent = sol(s.pending || 0);
  const when = $('#nextWhen'); when.hidden = !s.nextBatchAt;
  if (s.nextBatchAt) { const early = S.tier >= 1; $('#nextLbl').textContent = early ? 'Live for you in' : 'Goes live in'; $('#nextIn').dataset.until = s.nextBatchAt + (early ? 0 : c.earlyMin * 60000); when.classList.toggle('early', early); }
  const link = $('#treasuryLink'); if (s.practice) { link.removeAttribute('href'); } else link.href = c.explorerAddress.replace('{address}', s.treasury);
  const proof = $('#proof'); proof.hidden = !s.recent.length;
  proof.innerHTML = s.recent.slice(0, 5).map(r => `<div class="frow"><svg class="coin" width="28"><use href="#coin"/></svg><span class="frow-t"><b>${sol(r.lamports)} SOL</b><small>${esc(r.area)} · ${ago(r.ts)}</small></span>` +
    (s.practice ? '<time>practice</time>' : `<a class="tx" href="${esc(c.explorerTx.replace('{sig}', r.sig))}" target="_blank" rel="noopener">View</a>`) + '</div>').join('');
  tickClocks();
}
function renderPerks() {
  const c = S.cfg; if (!c) return;
  const t = address ? S.tier : 0, chip = $('#tierChip');
  $('#holdAmt').textContent = address ? int(S.balance) : '0';
  chip.textContent = !address ? 'No wallet yet' : t ? `Tier ${t}` : 'Not holding'; chip.classList.toggle('on', t > 0);
  $('#perk1').textContent = `${c.earlyMin} min head start`; $('#perk3').textContent = `Claim from ${c.reachTopM} m`; $('#perk3s').textContent = `Everyone else needs ${c.reachM} m`;
  $$('.perk').forEach(p => { const need = +p.dataset.need, on = t >= need; p.classList.toggle('on', on); $('.pk-n', p).textContent = on ? 'Unlocked' : tk(c.tierLevels[need - 1]) + '+'; });
  const get = $('#getToken'); get.hidden = !c.tokenUrl; if (c.tokenUrl) get.href = c.tokenUrl;
  $('#perkNote').textContent = !c.mint ? `${T()} is not live yet. Perks switch on when it launches.` : address ? 'Perks follow the wallet you added. We only read its balance.' : 'Add your wallet to see your perks. We only read its balance.';
}
function renderFound() {
  const m = S.mine, c = S.cfg, total = m ? m.total : 0;
  const whole = Math.floor(total / 1e9), frac = Math.round((total - whole * 1e9) / 1e7);
  $('#balInt').textContent = int(frac === 100 ? whole + 1 : whole); $('#balDec').textContent = '.' + String(frac === 100 ? 0 : frac).padStart(2, '0');
  $('#foundSum').textContent = m && m.claims.length ? `${m.claims.length} ${m.claims.length === 1 ? 'drop' : 'drops'}` : '';
  $('#foundList').innerHTML = m && m.claims.length ? m.claims.map(f => `<div class="frow"><svg class="coin" width="34"><use href="#coin"/></svg><span class="frow-t"><b>${sol(f.lamports)} SOL</b><small>${esc(f.area)} · ${ago(f.ts)}</small></span>` +
    (c.practice ? '<time>practice</time>' : `<a class="tx" href="${esc(c.explorerTx.replace('{sig}', f.sig))}" target="_blank" rel="noopener">View</a>`) + '</div>').join('')
    : `<div class="empty">${address ? 'Nothing yet. Your first drop is waiting.' : 'Add your wallet, then go find your first drop.'}</div>`;
}
function renderHome() { renderWallet(); renderAlert(); renderBatches(); renderFees(); renderPerks(); renderFound(); }
function tickClocks() { const t = now(); $$('[data-until]').forEach(el => { el.textContent = countdown(+el.dataset.until - t); }); }

/* ---------- map ---------- */
const mapView = (() => {
  const wrap = $('#mapWrap'), pinsEl = $('#pins'), sheet = $('#pinSheet'), scr = $('#map'), zonesEl = $('#zones'), routeEl = $('#route'), selZone = $('#selZone'), noteEl = $('#mapNote');
  const pins = new Map(), zones = new Map();
  let map = null, meEl = null, sel = null, follow = true, first = true;

  function ensure() {
    if (map) return;
    wrap.classList.toggle('darken', !darkTiles()); map = new TileMap(wrap, { tileUrl: S.cfg.tileUrl, maxZoom: S.cfg.tileMaxZoom, onMove: place, onTap: () => deselect(), onUser: () => { follow = false; } });
    meEl = document.createElement('span'); meEl.className = 'medot'; meEl.hidden = true; meEl.innerHTML = '<i class="cone"></i><i class="dot"></i>'; pinsEl.appendChild(meEl);
  }
  const zoomFor = b => clamp(Math.log2((Math.min(wrap.clientWidth || 390, 430) * .4) / Math.max(20, b.radiusM) * 156543.03392 * Math.cos(b.lat * RAD)), 4, 17);
  function show() {
    ensure(); map.resize();
    if (first) {
      first = false;
      const b = [...S.batches].sort((x, y) => (x.distM || 0) - (y.distM || 0))[0];
      if (me.lat !== null) map.setView(me.lat, me.lng, 16.3);
      else if (b) map.setView(b.lat, b.lng, zoomFor(b));
      else map.setView(S.cfg.home.lat, S.cfg.home.lng, 13);
    }
    refresh(); note();
    if (me.lat === null && me.state === 'idle') startLocation();
  }
  function makePin(d) {
    const b = document.createElement('button'); b.type = 'button';
    b.innerHTML = `<span class="pin-c"><svg><use href="#coinf"/></svg></span>${d.gold ? '<span class="pin-k"><svg class="ico"><use href="#i-lock"/></svg></span>' : ''}<span class="pin-l">${sol(d.lamports)} SOL</span>`;
    b.addEventListener('click', e => { e.stopPropagation(); select(pins.get(d.id).d); });
    b.addEventListener('focus', () => { const p = map.project(d.lat, d.lng); if (p.x < 30 || p.y < 90 || p.x > map.w - 30 || p.y > map.h - 60) map.flyTo({ lat: d.lat, lng: d.lng }, 350); });
    return b;
  }
  function stylePin(p) {
    const d = p.d;
    p.el.className = 'pin pin--' + d.tier + (d.gold ? ' pin--gold' : '') + (d.locked ? ' locked' : '') + (sel && sel.id === d.id ? ' sel' : '');
    p.el.setAttribute('aria-label', `${sol(d.lamports)} SOL drop, ${distLabel(d.dist)} away${d.gold ? ', holders only' : ''}`);
  }
  function refresh() {
    if (!map) return;
    const seen = new Set();
    for (const d of S.drops) {
      seen.add(d.id); let p = pins.get(d.id);
      if (!p) { p = { el: makePin(d), d }; pins.set(d.id, p); pinsEl.insertBefore(p.el, meEl); } else p.d = d;
      if (sel && sel.id === d.id) sel = d;
      stylePin(p);
    }
    for (const [id, p] of pins) if (!seen.has(id)) { p.el.remove(); pins.delete(id); if (sel && sel.id === id) { deselect(); toast('That drop was just claimed.'); } }
    // one dashed circle per batch, so people far away can see where to go
    const live = new Set();
    for (const b of S.batches) {
      live.add(b.id); let z = zones.get(b.id);
      if (!z) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); zonesEl.appendChild(c);
        const label = document.createElement('button'); label.type = 'button'; label.className = 'zlabel';
        label.addEventListener('click', e => { e.stopPropagation(); follow = false; const zb = zones.get(b.id).b; map.flyTo({ lat: zb.lat, lng: zb.lng, zoom: zoomFor(zb) }, 700); });
        pinsEl.insertBefore(label, pinsEl.firstChild);
        z = { c, label, b }; zones.set(b.id, z);
      }
      z.b = b; z.c.setAttribute('class', 'b-zone' + (b.open ? '' : ' soon'));
      z.label.textContent = !b.open ? `${b.area || b.name} · opens ${timeOfDay(b.opensAt)}` : b.left ? `${b.area || b.name} · ${int(b.left)} ${b.left === 1 ? 'drop' : 'drops'}` : `${b.area || b.name} · all found`;
    }
    for (const [id, z] of zones) if (!live.has(id)) { z.c.remove(); z.label.remove(); zones.delete(id); }
    if (sel) fillSheet();
    const near = (x, y) => (x.distM || 0) - (y.distM || 0), openNow = S.batches.filter(b => b.open);
    const head = openNow.filter(b => b.left > 0).sort(near)[0] || openNow.sort(near)[0];
    $('#mapTitle').textContent = head ? head.name : 'Live drops';
    $('#mapSub').textContent = head ? `${sol(head.totalLamports)} SOL · ${int(head.left)} of ${int(head.drops)} left` : S.batches.length ? 'Opening soon' : 'Nothing hidden right now';
    place(); note();
  }
  function place() {
    if (!map || !map.w) return;
    const mpp = map.metresPerPx();
    pinsEl.classList.toggle('far', map.zoom < 14.2);
    for (const p of pins.values()) { const s = map.project(p.d.lat, p.d.lng); p.el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px) translate(-50%,-50%)`; }
    for (const z of zones.values()) {
      const s = map.project(z.b.lat, z.b.lng), r = z.b.radiusM / mpp;
      z.c.setAttribute('cx', s.x.toFixed(1)); z.c.setAttribute('cy', s.y.toFixed(1)); z.c.setAttribute('r', r.toFixed(1));
      z.label.style.transform = `translate(${s.x.toFixed(1)}px,${(s.y - r - 16).toFixed(1)}px) translate(-50%,-50%)`;
      z.label.hidden = r > Math.max(map.w, map.h) * .9 || (map.zoom > 15.4 && z.b.open);
    }
    const here = me.lat !== null;
    meEl.hidden = !here;
    if (here) {
      const s = map.project(me.lat, me.lng), h = heading();
      meEl.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`; meEl.firstChild.style.display = h === null ? 'none' : ''; meEl.style.setProperty('--hd', (h || 0).toFixed(0) + 'deg');
    }
    if (sel) {
      const s = map.project(sel.lat, sel.lng);
      selZone.setAttribute('cx', s.x.toFixed(1)); selZone.setAttribute('cy', s.y.toFixed(1)); selZone.setAttribute('r', (S.reach / mpp).toFixed(1));
      if (here) { const m = map.project(me.lat, me.lng); routeEl.setAttribute('x1', m.x.toFixed(1)); routeEl.setAttribute('y1', m.y.toFixed(1)); routeEl.setAttribute('x2', s.x.toFixed(1)); routeEl.setAttribute('y2', s.y.toFixed(1)); }
      routeEl.setAttribute('visibility', here ? 'visible' : 'hidden');
    } else { selZone.setAttribute('r', 0); routeEl.setAttribute('visibility', 'hidden'); }
  }
  function note() {
    let text = '', act = null;
    if (me.state === 'denied') text = 'Location is off. Allow it in your browser settings to hunt.';
    else if (me.lat === null) { text = me.state === 'asking' ? 'Finding you…' : 'Tap here to turn on location'; act = startLocation; }
    else if (!S.drops.length && S.batches.length) { const b = [...S.batches].sort((x, y) => x.distM - y.distM)[0]; text = b.distM == null ? `Drops are live in ${b.area || b.name}. Tap to see where.` : `No drops within ${S.cfg.nearbyKm} km of you. Nearest: ${b.area || b.name}, ${distLabel(b.distM)} away.`; act = () => { follow = false; map.flyTo({ lat: b.lat, lng: b.lng, zoom: zoomFor(b) }, 900); }; }
    else if (!S.batches.length) text = 'Nothing hidden right now. New batches arrive as fees come in.';
    noteEl.hidden = !text || !!sel; noteEl.textContent = text; noteEl.onclick = act;
  }
  function fillSheet() {
    const d = sel, b = batchOf(d.b) || {}, c = S.cfg, need = `${tk(c.tierLevels[c.goldTier - 1])} ${T()}`;
    $('#psTitle').innerHTML = `${sol(d.lamports)} SOL drop${d.gold ? '<span class="gold-chip">Holders only</span>' : ''}`;
    $('#psSub').textContent = [b.area || b.name, me.lat === null ? null : distLabel(d.dist), me.lat === null ? null : `${Math.max(1, Math.round(d.dist * 1.3 / 80))} min walk`].filter(Boolean).join(' · ');
    $('#psLeft').innerHTML = d.gold ? (d.locked ? `<b>Holders only.</b> Needs ${esc(need)}` : `<b>Holder-only drop.</b> You're in`) : `<b>${int(b.left || 0)} of ${int(b.drops || 0)}</b> drops still hidden here`;
    $('#psReach').innerHTML = `Exact spot shows up <b>${S.reach} m</b> away`;
    const off = d.locked || b.done;
    $('#startHunt').setAttribute('aria-disabled', String(!!off));
    $('#startLbl').textContent = d.locked ? `Needs ${need}` : b.done ? 'You already found one here' : me.lat === null ? 'Turn on location' : 'Start the hunt';
    $('#startIco').setAttribute('href', d.locked ? '#i-lock' : b.done ? '#i-check' : '#i-compass');
  }
  function select(d) {
    if (sel && sel.id === d.id) return;
    if (sel) { const old = pins.get(sel.id); sel = null; if (old) stylePin(old); }
    sel = d; follow = false; stylePin(pins.get(d.id)); fillSheet();
    sheet.classList.add('on'); sheet.inert = false; scr.style.setProperty('--sh', sheet.offsetHeight + 'px'); scr.classList.add('has-sheet'); note();
    const pts = me.lat === null ? [d] : [d, me], pad = { top: 120, bottom: sheet.offsetHeight + 56, left: 56, right: 56 };
    map.flyTo(pts.length === 1 ? { lat: d.lat, lng: d.lng, zoom: Math.max(map.zoom, 16.5) } : map.viewFor(pts, pad, 18), 700);
    place();
  }
  function deselect() {
    if (!sel) return; const old = pins.get(sel.id); sel = null; if (old) stylePin(old);
    sheet.classList.remove('on'); sheet.inert = true; scr.classList.remove('has-sheet'); place(); note();
  }
  function centre(animate = true) { if (!map || me.lat === null) return; follow = true; const to = { lat: me.lat, lng: me.lng, zoom: Math.max(map.zoom, 16.3) }; if (animate) map.flyTo(to, 550); else map.setView(to.lat, to.lng, to.zoom); }
  function moved() { if (map && follow && !sel && me.lat !== null && !map.flying) map.setView(me.lat, me.lng); }
  return { show, refresh, place: () => { moved(); place(); }, note, select, deselect, centre, get selected() { return sel; }, focusBatch(b) { ensure(); follow = false; first = false; map.resize(); map.setView(b.lat, b.lng, zoomFor(b)); } };
})();

/* ---------- hunt ---------- */
const bezel = $('#bezel'), orbit = $('#orbit'), orb = $('#orb');
(() => { let h = ''; for (let i = 0; i < 72; i++) { const big = i % 6 === 0; h += `<line class="${big ? 'tk tk-b' : 'tk'}" x1="0" y1="-118" x2="0" y2="${big ? -105 : -111}" transform="rotate(${i * 5})"/>`; } bezel.innerHTML = h + '<text class="tk-n" x="0" y="-88" text-anchor="middle">N</text>'; })();
let hunt = null, miniMap = null, wakeLock = null, pendingHunt = null;
function placeMini() {
  const h = hunt; if (!h || !miniMap || !miniMap.w) return;
  const c = miniMap.project(h.d.lat, h.d.lng);
  $('#miniCoin').style.transform = `translate(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px)`;
  const z = $('#miniZone'); z.setAttribute('cx', c.x.toFixed(1)); z.setAttribute('cy', c.y.toFixed(1)); z.setAttribute('r', (S.reach / miniMap.metresPerPx()).toFixed(1));
  const dot = $('#miniMe'); dot.hidden = me.lat === null;
  if (me.lat !== null) { const m = miniMap.project(me.lat, me.lng), hd = heading(); dot.style.transform = `translate(${m.x.toFixed(1)}px,${m.y.toFixed(1)}px)`; dot.firstChild.style.display = hd === null ? 'none' : ''; dot.style.setProperty('--hd', (hd || 0).toFixed(0) + 'deg'); }
}
function startHunt(d) {
  if (!address) { pendingHunt = d; openWallet(); return; }
  if (me.lat === null) { startLocation(); toast('Turn on location to start the hunt.'); return; }
  startCompass(); // has to be asked from a tap, and this is one
  const b = batchOf(d.b) || {};
  hunt = { id: d.id, d, area: b.area || b.name || '', track: [], warm: '', hint: '', shownHeading: 0, shownRel: 0, lastSync: 0, arrived: false, stop: null };
  mapView.deselect();
  $('#huntTitle').textContent = `Hunting ${sol(d.lamports)} SOL`; $('#huntPlace').textContent = hunt.area; $('#inCircle').hidden = true; $('#noteReach').textContent = S.reach; $('#warm').textContent = 'Follow the coin';
  go('hunt');
  if (!miniMap) { $('#miniMap').classList.toggle('darken', !darkTiles()); miniMap = new TileMap($('#miniMap'), { tileUrl: S.cfg.tileUrl, maxZoom: S.cfg.tileMaxZoom, interactive: false, onMove: placeMini }); }
  miniMap.resize(); miniMap.setView(d.lat, d.lng, Math.min(17.6, S.cfg.tileMaxZoom));
  if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(w => { wakeLock = w; }).catch(() => {});
  hunt.stop = addTicker(dt => { // the dial turns smoothly between sensor readings
    const h = hunt; if (!h) return; const hd = heading();
    const brg = me.lat === null ? 0 : bearing(me, h.d), k = Math.min(1, dt * 7);
    h.shownHeading += wrap180((hd === null ? 0 : hd) - h.shownHeading) * k; h.shownRel += wrap180(brg - (hd === null ? 0 : hd) - h.shownRel) * k;
    bezel.style.transform = `rotate(${(-h.shownHeading).toFixed(1)}deg)`; orbit.style.transform = `rotate(${h.shownRel.toFixed(1)}deg)`; orb.firstElementChild.style.transform = `rotate(${(-h.shownRel).toFixed(1)}deg)`;
  });
  huntUpdate();
}
function huntUpdate() {
  const h = hunt; if (!h || me.lat === null) return;
  const dist = distanceM(me, h.d), t = Date.now(), hd = heading(), brg = bearing(me, h.d);
  $('#distN').textContent = dist < 1000 ? Math.round(dist) : (dist / 1000).toFixed(1); $('#distU').textContent = dist < 1000 ? 'm' : 'km';
  h.track.push({ t, dist }); while (h.track.length > 1 && t - h.track[0].t > 7000) h.track.shift();
  const trend = h.track[0].dist - dist;
  let warm = h.warm || 'Follow the coin';
  if (dist <= S.reach + 12) warm = 'Very hot'; else if (trend > 3) warm = 'Getting warmer'; else if (trend < -3) warm = 'Getting colder';
  if (warm !== h.warm) { h.warm = warm; $('#warm').textContent = warm; if (warm === 'Very hot') buzz(14); }
  let hint;
  if (hd === null) hint = `Head ${compassWord(brg)}`;
  else { const rel = wrap180(brg - hd), a = Math.abs(rel), side = rel < 0 ? 'left' : 'right'; hint = a < 14 ? 'Straight ahead' : a < 55 ? `A little to your ${side}` : a < 135 ? `On your ${side}` : 'Behind you'; }
  if (hint !== h.hint) { h.hint = hint; $('#hint').textContent = hint; }
  if (dist <= S.reach + 32) $('#inCircle').hidden = false;
  placeMini();
  if (dist <= S.reach + 30 && !h.d.exact && t - h.lastSync > 2500) { h.lastSync = t; sync(); } // close: ask for the exact spot
  if (h.d.exact && dist <= S.reach && !h.arrived) { h.arrived = true; buzz([18, 60, 18]); openAR(h.d, h.area); }
}
function huntRefresh() {
  const h = hunt; if (!h || h.arrived) return;
  const d = S.drops.find(x => x.id === h.id);
  if (!d) { toast('Someone got there first. That drop is gone.'); endHunt(); go('map'); return; }
  h.d = d; if (miniMap && d.exact) miniMap.setView(d.lat, d.lng);
  huntUpdate();
}
function endHunt() { if (hunt && hunt.stop) hunt.stop(); hunt = null; if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }

/* ---------- camera and claim ---------- */
const arScr = $('#ar'), arC = $('#arCoin'), holdBtn = $('#holdBtn'), holdBar = $('#holdBar'), foundEl = $('#found'), holdLbl = $('#holdLbl'), cam = $('#cam');
const HOLD_C = 2 * Math.PI * 38; let ar = null, holdP = 0, holdStop = null, holdBack = null, actx = null, camStream = null, lastFound = null;
const setHold = p => { holdBar.style.strokeDashoffset = (HOLD_C * (1 - p)).toFixed(1); };
const setLabel = (text, bad) => { holdLbl.textContent = text; holdLbl.classList.toggle('bad', !!bad); };
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (cur !== 'ar') { stream.getTracks().forEach(t => t.stop()); return; }
    camStream = stream; cam.srcObject = stream; cam.hidden = false; arScr.classList.add('live'); cam.play().catch(() => {});
  } catch (e) {} // no camera or not allowed: the drawn scene stays
}
function stopCamera() { if (camStream) camStream.getTracks().forEach(t => t.stop()); camStream = null; cam.srcObject = null; cam.hidden = true; arScr.classList.remove('live'); }
function openAR(d, area) {
  ar = { d, area, phase: 'in', t: 0, y: 0, yaw: 0, stop: null, claimed: false, busy: false };
  arScr.classList.remove('claimed'); foundEl.classList.remove('on'); foundEl.inert = true; holdP = 0; setHold(0); setLabel('Hold to claim');
  $('#arTitle').textContent = `${sol(d.lamports)} SOL drop`; $('#arSub').textContent = d.gold ? `Holder-only drop · ${area}` : `Paid by ${T()} fees · ${area}`;
  go('ar'); startCamera();
  actx = sizeCanvas(arC, 230, 230); arC.style.opacity = 1;
  ar.stop = addTicker(dt => {
    const a = ar; if (!a) return; a.t += dt; let y = 0, sc = 1, al = 1, yaw = 0;
    if (a.phase === 'in') { const k = Math.min(1, a.t / (reduced ? .01 : 1.15)), e = outCubic(k); y = -360 * (1 - e) - Math.sin(k * Math.PI) * 14; yaw = (1 - e) * Math.PI * 5; if (k >= 1) { a.phase = 'idle'; a.t = 0; } }
    else if (a.phase === 'idle') { const cyc = a.t % 5.2; y = Math.sin(a.t * 1.7) * 7; yaw = reduced ? .35 : Math.sin(a.t * .85) * .5 + (cyc > 4.2 ? ioCubic(cyc - 4.2) * Math.PI * 2 : 0); }
    else { const k = Math.min(1, a.t / .75); y = a.y0 - 64 * Math.sin(k * Math.PI) + 190 * k * k; sc = 1 + .14 * Math.sin(k * Math.PI) - .78 * k * k; al = k < .7 ? 1 : 1 - (k - .7) / .3; yaw = a.yaw0 + k * (2 - k) * 9; if (k >= 1) { actx.clearRect(0, 0, 230, 230); arC.style.opacity = 0; a.stop(); return; } }
    a.y = y; a.yaw = yaw;
    arC.style.transform = `translateY(${y.toFixed(1)}px) scale(${sc.toFixed(3)})`;
    actx.clearRect(0, 0, 230, 230); drawCoin(actx, 115, 115, 84, yaw, al);
  });
}
function closeAR(to) { if (ar && ar.stop) ar.stop(); ar = null; if (holdStop) { holdStop(); holdStop = null; } holdBtn.classList.remove('down', 'busy'); stopCamera(); endHunt(); go(to || 'map'); if (to !== 'home') mapView.centre(false); }
function holdStart(e) {
  if (!ar || ar.claimed || ar.busy || holdStop) return; if (e && e.cancelable) e.preventDefault();
  if (holdBack) { holdBack(); holdBack = null; }
  holdBtn.classList.add('down'); buzz(10); setLabel('Keep holding');
  holdStop = addTicker(dt => { holdP = Math.min(1, holdP + dt / 1.1); setHold(holdP); if (holdP >= 1) { holdStop(); holdStop = null; holdBtn.classList.remove('down'); claim(); } });
}
function holdEnd() { if (!holdStop) return; holdStop(); holdStop = null; holdBtn.classList.remove('down'); const from = holdP; setLabel('Hold to claim'); holdBack = tween(240, t => { holdP = from * (1 - t); setHold(holdP); }, () => { holdBack = null; }); }
holdBtn.addEventListener('pointerdown', e => { try { holdBtn.setPointerCapture(e.pointerId); } catch (_) {} holdStart(e); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => holdBtn.addEventListener(t, holdEnd));
holdBtn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) holdStart(e); });
holdBtn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') holdEnd(); });
holdBtn.addEventListener('contextmenu', e => e.preventDefault());
async function claim() {
  const a = ar; if (!a || a.claimed || a.busy) return;
  a.busy = true; holdBtn.classList.add('busy'); setLabel('Checking your location…');
  const t0 = performance.now();
  try {
    const r = await api('/api/claim', { dropId: a.d.id, address, device, lat: me.lat, lng: me.lng, acc: me.acc });
    if (ar !== a) return;
    a.claimed = true; buzz([25, 50, 40]); showFound(a, r, (performance.now() - t0) / 1000);
  } catch (e) {
    if (ar !== a) return;
    holdP = 0; setHold(0);
    if (e.code === 'pending') { a.claimed = true; showFound(a, null, 0); }
    else if (['gone', 'not_live', 'no_drop', 'one_per_person', 'holders_only', 'held'].includes(e.code) || (e.data && e.data.held)) { toast(e.message); closeAR('map'); sync(); } // nothing more to do at this drop for now
    else setLabel(e.message, true); // too far, weak signal, wait a moment: stay here and let them hold again
  } finally { a.busy = false; holdBtn.classList.remove('busy'); }
}
function showFound(a, r, seconds) {
  const practice = S.cfg.practice, chip = $('#fChip');
  lastFound = r ? { lamports: r.lamports, area: r.area } : null;
  $('#fTitle').textContent = r ? `You found ${sol(r.lamports)} SOL` : 'Payout on its way';
  $('#fFrom').textContent = r ? `${sol(r.lamports)} SOL from ${T()} fees` : 'The network is slow to confirm. Check your wallet in a minute. If nothing arrives, the drop goes back on the map for you to claim again.';
  chip.classList.toggle('wait', !r); $('#fChipTxt').textContent = !r ? 'Confirming' : practice ? 'Practice payout' : 'In your wallet';
  $('#fPlace').textContent = r ? r.area : a.area; $('#fTime').textContent = !r ? 'still confirming' : r.repeat ? 'a moment ago' : `${seconds.toFixed(1)} seconds`; $('#fLeft').textContent = !r ? '' : r.left === 1 ? '1 drop' : `${int(r.left)} drops`;
  const tx = $('#fTx'); tx.hidden = !r || practice; if (r && !practice) tx.href = r.explorer;
  $('#fNote').hidden = !practice; $('#shareBtn').hidden = !r;
  a.phase = 'out'; a.t = 0; a.y0 = a.y || 0; a.yaw0 = a.yaw || 0; arScr.classList.add('claimed');
  setTimeout(() => { foundEl.classList.add('on'); foundEl.inert = false; }, reduced ? 0 : 430);
  sync(); refreshHome();
}

/* ---------- wallet ---------- */
const walletEl = $('#walletSheet'), scrim = $('#scrim'), addrEl = $('#addr'), addrErr = $('#addrErr');
const walletApp = () => (window.phantom && window.phantom.solana) || window.solflare || window.backpack || window.solana || null;
function openWallet() {
  addrEl.value = address; addrErr.hidden = true; addrEl.classList.remove('bad');
  $('#connectBtn').hidden = !walletApp();
  scrim.hidden = false; void scrim.offsetWidth; scrim.classList.add('on'); walletEl.classList.add('on'); walletEl.inert = false;
}
function closeWallet() { walletEl.classList.remove('on'); walletEl.inert = true; scrim.classList.remove('on'); pendingHunt = null; setTimeout(() => { if (!walletEl.classList.contains('on')) scrim.hidden = true; }, 400); }
let checkingWallet = false;
async function saveWallet() {
  const v = addrEl.value.trim();
  const refuse = msg => { addrErr.textContent = msg; addrErr.hidden = false; addrEl.classList.add('bad'); };
  if (!isAddress(v)) return refuse(v ? 'That does not look like a Solana address. Copy it again from your wallet.' : 'Paste your Solana address first.');
  if (checkingWallet) return;
  // People sometimes paste the coin's address or a token account. SOL sent there cannot be got back, so the server checks first.
  checkingWallet = true; $('#saveAddr').disabled = true;
  let info = null;
  try { info = await api('/api/me?address=' + encodeURIComponent(v)); } catch (e) {} // no connection: save it anyway, the check is made again at the drop
  checkingWallet = false; $('#saveAddr').disabled = false;
  if (!walletEl.classList.contains('on') || addrEl.value.trim() !== v) return; // closed or changed while we were asking
  if (info && info.hint) return refuse(info.hint);
  const next = pendingHunt; address = v; store.set('address', v); S.mine = info;
  closeWallet(); renderWallet(); renderPerks(); renderFound(); sync(true); refreshHome(); toast('Wallet saved');
  if (next) startHunt(next);
}
async function connectWallet() {
  const w = walletApp(); if (!w) return;
  try { const r = await w.connect(); const key = (r && r.publicKey) || w.publicKey; if (key) { addrEl.value = key.toString(); addrErr.hidden = true; addrEl.classList.remove('bad'); } }
  catch (e) { addrErr.textContent = 'The wallet app did not share an address. Paste it instead.'; addrErr.hidden = false; }
}

/* ---------- wiring ---------- */
$('#alertBtn').addEventListener('click', () => { if (me.state === 'denied') { toast('Location is blocked for this site. Allow it in your browser settings, then reload.'); return; } startLocation(); go('map'); const d = nearestDrop(); if (d) setTimeout(() => { if (cur === 'map' && !mapView.selected && S.drops.some(x => x.id === d.id)) mapView.select(S.drops.find(x => x.id === d.id)); }, reduced ? 0 : 650); });
$('#goHunt').addEventListener('click', () => { startLocation(); go('map'); });
$('#goWallet').addEventListener('click', openWallet); $('#walletChip').addEventListener('click', openWallet);
$('#batchList').addEventListener('click', e => { const el = e.target.closest('[data-batch]'); if (!el) return; const b = batchOf(+el.dataset.batch); startLocation(); if (b && (b.distM == null || b.distM > b.radiusM + 400)) mapView.focusBatch(b); go('map'); });
$('#mapBack').addEventListener('click', () => { mapView.deselect(); go('home'); });
$('#recenter').addEventListener('click', () => { if (me.lat === null) { startLocation(); toast(me.state === 'denied' ? 'Location is blocked for this site.' : 'Finding you…'); } else mapView.centre(true); });
$('#startHunt').addEventListener('click', () => {
  const d = mapView.selected; if (!d) return; const b = batchOf(d.b) || {}, c = S.cfg;
  if (d.locked) { toast(`Hold ${tk(c.tierLevels[c.goldTier - 1])} ${T()} in your wallet to hunt this one.`); return; }
  if (b.done) { toast('One drop per person in this batch, and you already found yours.'); return; }
  startHunt(d);
});
$('#huntClose').addEventListener('click', () => { endHunt(); go('map'); mapView.centre(false); });
$('#arClose').addEventListener('click', () => closeAR('map'));
$('#keepBtn').addEventListener('click', () => closeAR('map'));
$('#shareBtn').addEventListener('click', async () => {
  const f = lastFound, text = f ? `I just found ${sol(f.lamports)} SOL hidden in ${f.area} on ${S.cfg.app}.` : S.cfg.app, url = location.origin;
  try { if (navigator.share) { await navigator.share({ text, url }); return; } await navigator.clipboard.writeText(`${text} ${url}`); toast('Copied. Paste it anywhere.'); } catch (e) { if (e && e.name !== 'AbortError') toast(`${text} ${url}`); }
});
$('#walletClose').addEventListener('click', closeWallet); scrim.addEventListener('click', closeWallet);
$('#saveAddr').addEventListener('click', saveWallet); $('#connectBtn').addEventListener('click', connectWallet);
addrEl.addEventListener('keydown', e => { if (e.key === 'Enter') saveWallet(); });
addrEl.addEventListener('input', () => { addrErr.hidden = true; addrEl.classList.remove('bad'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (walletEl.classList.contains('on')) closeWallet(); else if (cur === 'map') mapView.deselect(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(true); if (cur === 'home') refreshHome(); } });

/* ---------- start ---------- */
async function boot() {
  try { S.cfg = await api('/api/config'); }
  catch (e) { $('#alertTitle').textContent = "Can't reach SolanaGO"; $('#alertSub').textContent = 'Check your connection and reload'; setTimeout(boot, 5000); return; }
  $$('.tkr').forEach(e => { e.textContent = T(); });
  $$('.attr').forEach(a => { a.textContent = S.cfg.tileAttribution; a.href = S.cfg.tileAttributionUrl; }); // map credit, wherever a map shows
  $('#modeTag').hidden = !S.cfg.practice; $('#noteReach').textContent = S.cfg.reachM;
  renderHome(); sync(); refreshHome();
  if (navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') startLocation(); else if (p.state === 'denied') { me.state = 'denied'; locChanged(); } }).catch(() => {});
  setInterval(() => { tickClocks(); if (document.hidden) return; const age = Date.now() - S.synced; if (age > (cur === 'home' ? 20000 : 6000)) sync(); }, 1000);
  setInterval(() => { if (!document.hidden && cur === 'home') refreshHome(); }, 30000);
}
boot();
})();
