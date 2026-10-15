// The SolanaGO admin console: treasury numbers, hiding batches, the schedule, recent claims.
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const sol = l => nf.format((l || 0) / 1e9);
const int = n => Math.round(n || 0).toLocaleString('en-US');
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const num = el => Number(String(el.value).replace(',', '.'));

let token = '';
try { token = sessionStorage.getItem('sgo.admin') || ''; } catch (e) {}
let cfg = null, data = null, map = null, areas = [], autoLoaded = false, confirming = 0;
const pick = { lat: 35.6702, lng: 139.7027 };

async function call(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.ok === false) { const e = new Error(d.message || 'That did not work. Try again.'); e.status = res.status; throw e; }
  return d;
}
function say(el, text, ok) { el.hidden = !text; el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'bad'); }

/* ---------- unlock ---------- */
async function unlock() {
  try {
    data = await call('/api/admin/overview');
    cfg = cfg || await (await fetch('/api/config')).json();
    try { sessionStorage.setItem('sgo.admin', token); } catch (e) {}
    $('#gate').hidden = true; $('#app').hidden = false; $('#lockBtn').hidden = false;
    if (!map) initMap();
    render(); preview();
  } catch (e) {
    $('#gate').hidden = false; $('#app').hidden = true;
    if (token) { $('#gateErr').hidden = false; $('#gateErr').textContent = e.message; }
    token = '';
  }
}
$('#gateForm').addEventListener('submit', e => { e.preventDefault(); token = $('#pw').value; $('#gateErr').hidden = true; unlock(); });
$('#lockBtn').addEventListener('click', () => { token = ''; try { sessionStorage.removeItem('sgo.admin'); } catch (e) {} location.reload(); });

/* ---------- map ---------- */
function initMap() {
  pick.lat = cfg.home.lat; pick.lng = cfg.home.lng;
  const last = data.batches[0]; if (last) { pick.lat = last.lat; pick.lng = last.lng; }
  $('#attr').textContent = cfg.tileAttribution; $('#attr').href = cfg.tileAttributionUrl; $('#fEarly').value = cfg.earlyMin;
  map = new TileMap($('#pick'), { tileUrl: cfg.tileUrl, maxZoom: cfg.tileMaxZoom, onMove: place, onTap: ll => setCentre(ll.lat, ll.lng, false) });
  map.resize(); map.setView(pick.lat, pick.lng, 15.5); setCentre(pick.lat, pick.lng, false);
}
function setCentre(lat, lng, move) {
  pick.lat = lat; pick.lng = lng; $('#fLat').value = lat.toFixed(6); $('#fLng').value = lng.toFixed(6);
  if (move && map) map.flyTo({ lat, lng }, 400); else place();
  nameTheSpot();
}
// The place name comes from the map, unless the admin typed one of their own.
let nameTimer = 0, nameReq = 0;
function nameTheSpot() {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(async () => {
    const req = ++nameReq, lat = pick.lat, lng = pick.lng;
    try {
      const r = await call(`/api/admin/place?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`);
      if (req !== nameReq || !r.name) return;
      const area = $('#fArea'), name = $('#fName');
      if (!area.value.trim() || area.dataset.auto === '1') { area.value = r.name; area.dataset.auto = '1'; }
      if (!name.value.trim() || name.dataset.auto === '1') { name.value = 'Fee drop · ' + $('#fArea').value; name.dataset.auto = '1'; }
    } catch (e) {}
  }, 500);
}
for (const id of ['#fArea', '#fName']) $(id).addEventListener('input', () => { $(id).dataset.auto = '0'; });
function place() {
  if (!map || !map.w) return;
  const p = map.project(pick.lat, pick.lng), mpp = map.metresPerPx(pick.lat), c = $('#pickCircle');
  c.setAttribute('cx', p.x.toFixed(1)); c.setAttribute('cy', p.y.toFixed(1)); c.setAttribute('r', (num($('#fRadius')) / mpp).toFixed(1));
  $('#pickDot').style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
  const live = (data ? data.batches : []).filter(b => b.status === 'live');
  $('#liveZones').innerHTML = live.map(b => { const s = map.project(b.lat, b.lng); return `<circle class="z-live" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${(b.radiusM / map.metresPerPx(b.lat)).toFixed(1)}"/>`; }).join('');
}
$('#fRadius').addEventListener('input', () => { $('#radiusOut').textContent = int(num($('#fRadius'))); place(); });
for (const id of ['#fLat', '#fLng']) $(id).addEventListener('change', () => { const lat = num($('#fLat')), lng = num($('#fLng')); if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180) setCentre(lat, lng, true); });
$('#hereBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return say($('#formMsg'), 'This browser cannot share a location.');
  navigator.geolocation.getCurrentPosition(p => { setCentre(p.coords.latitude, p.coords.longitude, false); map.setView(p.coords.latitude, p.coords.longitude, 16); }, () => say($('#formMsg'), 'Location was not shared. Tap the map instead.'), { enableHighAccuracy: true, timeout: 15000 });
});

/* ---------- hide a batch ---------- */
let previewTimer = 0;
function preview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const total = num($('#fSol')), box = $('#preview');
    if (!(total > 0)) { box.textContent = 'Enter an amount to see the split.'; return; }
    try {
      const p = await call('/api/admin/preview', { totalSol: total, goldShare: num($('#fGold')) / 100 });
      const v = data.tierValues, parts = [[p.counts.s, v.s], [p.counts.m, v.m], [p.counts.l, v.l]].filter(x => x[0]).map(x => `<b>${int(x[0])}</b> × ${sol(x[1])} SOL`);
      const over = p.available !== null && p.total > p.available;
      box.innerHTML = p.drops ? `${parts.join(' · ')} = <b>${sol(p.total)} SOL</b> in ${int(p.drops)} drops, ${int(p.gold)} of them holder-only.` + (over ? ` <span class="err">Only ${sol(Math.max(0, p.available))} SOL is free.</span>` : '') : 'That is too little for even one drop.';
      $('#hideBtn').disabled = !p.drops || over;
    } catch (e) { box.textContent = e.message; }
  }, 250);
}
$('#fSol').addEventListener('input', preview);
$('#fGold').addEventListener('input', () => { $('#goldOut').textContent = num($('#fGold')); preview(); });
$('#fStart').addEventListener('change', () => { const later = $('#fStart').value === 'later'; $('#fAtWrap').hidden = !later; if (later && !$('#fAt').value) { const d = new Date(Date.now() + 3600e3 - new Date().getTimezoneOffset() * 60000); $('#fAt').value = d.toISOString().slice(0, 16); } });
$('#hideBtn').addEventListener('click', async () => {
  const startsAt = $('#fStart').value === 'later' ? new Date($('#fAt').value).getTime() : Date.now(), hours = num($('#fHours'));
  if (!Number.isFinite(startsAt)) return say($('#formMsg'), 'Pick a start time.');
  if (!(hours > 0)) return say($('#formMsg'), 'Enter how many hours the batch runs for.');
  $('#hideBtn').disabled = true;
  try {
    const area = $('#fArea').value.trim(), name = $('#fName').value.trim() || (area ? 'Fee drop · ' + area : '');
    if (!name) throw new Error('Give the place a name first (the box under the map).');
    const r = await call('/api/admin/batches', { name, area, lat: pick.lat, lng: pick.lng, radiusM: num($('#fRadius')), totalSol: num($('#fSol')), goldShare: num($('#fGold')) / 100, startsAt, endsAt: startsAt + hours * 3600e3, earlyMin: num($('#fEarly')), onePerPerson: $('#fOne').checked });
    say($('#formMsg'), `Hidden: ${int(r.batch.drops)} drops, ${sol(r.batch.totalLamports)} SOL in ${r.batch.area || r.batch.name}.`, true);
    $('#fArea').dataset.auto = '1'; $('#fName').dataset.auto = '1'; // the next spot picked on the map gets its own name again
    await refresh();
  } catch (e) { say($('#formMsg'), e.message); }
  $('#hideBtn').disabled = false; preview();
});

/* ---------- lists ---------- */
function render() {
  const d = data, now = Date.now();
  $('#modeBadge').hidden = false; $('#modeBadge').textContent = d.practice ? 'Practice mode: pretend payouts' : 'Live: real SOL'; $('#modeBadge').classList.toggle('live', !d.practice);
  $('#netWarn').hidden = !d.networkWarning; $('#netWarn').textContent = d.networkWarning || '';
  $('#pauseBadge').hidden = !d.paused; $('#pauseBtn').hidden = false; $('#pauseBtn').textContent = d.paused ? 'Resume claims' : 'Pause claims'; $('#pauseBtn').classList.toggle('danger', !d.paused);
  $('#sAddr').textContent = showFull ? d.treasury : short(d.treasury); $('#sAddr').title = d.treasury;
  if (d.practice) $('#sAddr').removeAttribute('href'); else $('#sAddr').href = cfg.explorerAddress.replace('{address}', d.treasury);
  $('#sBal').textContent = d.balance === null ? '…' : sol(d.balance); $('#sOut').textContent = sol(d.outstanding); $('#sFree').textContent = d.available === null ? '…' : sol(Math.max(0, d.available));
  $('#batches').innerHTML = d.batches.length ? d.batches.map(b => {
    const live = b.status === 'live' && b.endsAt > now, soon = live && b.startsAt > now, pct = b.drops ? (b.claimed / b.drops * 100).toFixed(1) : 0;
    return `<div class="batch"><div class="b-top"><b>${esc(b.name)}</b><span class="state ${soon ? 'soon' : live ? 'live' : ''}">${soon ? 'Starts ' + when(b.startsAt) : live ? 'Live' : 'Ended'}</span><span class="spacer"></span>` +
      (live ? (confirming === b.id ? '' : `<button class="btn danger" data-end="${b.id}" type="button">End now</button>`) : '') + '</div>' +
      (confirming === b.id ? `<div class="confirm">End this batch? The ${int(b.left)} unfound drops go back to the treasury.<button class="btn danger" data-end-yes="${b.id}" type="button">End it</button><button class="btn" data-end-no type="button">Keep it</button></div>` : '') +
      `<div class="b-sub">${esc(b.area || '')}${b.area ? ' · ' : ''}${sol(b.totalLamports)} SOL · ${int(b.claimed)} of ${int(b.drops)} found (${sol(b.claimedLamports)} SOL) · ${int(b.gold)} holder-only · ${b.source === 'fees' ? 'scheduled' : 'by hand'} · ${live ? 'ends' : 'ended'} ${when(b.endsAt)}</div>` +
      `<div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join('') : '<p class="empty">Nothing hidden yet.</p>';
  $('#claims').innerHTML = d.claims.length ? d.claims.map(c => `<tr><td>${when(c.ts)}</td><td title="${esc(c.address)}">${esc(short(c.address))}</td><td>${sol(c.lamports)}</td><td>${c.dist === null ? '' : c.dist + ' m'}</td><td>${c.acc === null ? '' : Math.round(c.acc) + ' m'}</td><td class="${esc(c.status)}" title="${esc(c.error || '')}">${esc(c.status)}</td><td>${esc(c.device)}</td><td>${esc(c.ip.slice(0, 8))}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">No claims yet.</td></tr>';
  if (!autoLoaded) {
    autoLoaded = true; const a = d.auto; areas = a.areas.slice();
    $('#aOn').checked = a.enabled; $('#aEvery').value = Math.round(a.everyHours * 60); $('#aDrop').value = a.dropSol; $('#aHours').value = a.durationHours; $('#aMin').value = a.minSol; $('#aMax').value = a.maxSol; $('#aGold').value = Math.round(a.goldShare * 100);
    if (a.enabled && a.nextAt) say($('#autoMsg'), `Next run: ${when(a.nextAt)}.`, true);
  }
  renderAreas(); place();
}
function renderAreas() {
  const rows = areas.map((a, i) => `<div class="area"><span><b>${esc(a.name)}</b> <small>${a.lat.toFixed(4)}, ${a.lng.toFixed(4)} · ${int(a.radiusM)} m</small></span><button class="btn" data-rm="${i}" type="button">Remove</button></div>`).join('');
  $('#areas').innerHTML = !areas.length ? '<p class="empty">No places yet. Add the circle on the map, or the list of places around the world.</p>'
    : areas.length <= 12 ? rows
    : `<details class="arealist"${areasOpen ? ' open' : ''}><summary><b>${int(areas.length)} places</b> · tap to see them</summary>${rows}</details>`;
  $('#clearAreas').hidden = !areas.length;
}
let areasOpen = false;
$('#areas').addEventListener('toggle', e => { if (e.target.matches('details')) areasOpen = e.target.open; }, true);
$('#batches').addEventListener('click', async e => {
  const end = e.target.closest('[data-end]'), yes = e.target.closest('[data-end-yes]'), no = e.target.closest('[data-end-no]');
  if (end) { confirming = +end.dataset.end; render(); }
  else if (no) { confirming = 0; render(); }
  else if (yes) { confirming = 0; try { await call(`/api/admin/batches/${+yes.dataset.endYes}/end`, {}); } catch (err) { say($('#formMsg'), err.message); } await refresh(); }
});
$('#areas').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { areas.splice(+b.dataset.rm, 1); renderAreas(); } });
$('#addArea').addEventListener('click', () => {
  const name = $('#fArea').value.trim(); if (!name) return say($('#autoMsg'), 'Give the place a name first (the box under the map).');
  areas.push({ name, lat: pick.lat, lng: pick.lng, radiusM: num($('#fRadius')) }); renderAreas(); say($('#autoMsg'), `${name} added. Save the schedule to keep it.`, true);
});
$('#addWorld').addEventListener('click', async () => {
  $('#addWorld').disabled = true;
  try {
    const r = await call('/api/admin/places');
    const have = new Set(areas.map(a => a.name.toLowerCase()));
    let added = 0;
    for (const p of r.places) if (!have.has(p.name.toLowerCase())) { areas.push(p); added++; }
    areasOpen = false; renderAreas();
    say($('#autoMsg'), added ? `${int(added)} places added, ${int(areas.length)} in all. Save the schedule to keep them.` : 'Those places are all in the list already.', true);
  } catch (e) { say($('#autoMsg'), e.message); }
  $('#addWorld').disabled = false;
});
$('#clearAreas').addEventListener('click', () => { areas = []; renderAreas(); say($('#autoMsg'), 'All places removed. Save the schedule to make it so.', true); });
$('#saveAuto').addEventListener('click', async () => {
  try {
    const r = await call('/api/admin/auto', { enabled: $('#aOn').checked, everyHours: num($('#aEvery')) / 60, dropSol: num($('#aDrop')), durationHours: num($('#aHours')), minSol: num($('#aMin')), maxSol: num($('#aMax')), goldShare: num($('#aGold')) / 100, areas });
    areas = r.auto.areas.slice(); $('#aOn').checked = r.auto.enabled; renderAreas();
    $('#aEvery').value = Math.round(r.auto.everyHours * 60); $('#aDrop').value = r.auto.dropSol;
    say($('#autoMsg'), r.auto.enabled ? `Saved. ${int(areas.length)} places, ${r.auto.dropSol} SOL per drop, every ${Math.round(r.auto.everyHours * 60)} minutes. Next run: ${when(r.auto.nextAt)}.` : areas.length ? 'Saved. The schedule is off.' : 'Saved, but the schedule needs at least one place to run.', r.auto.enabled || !$('#aOn').checked);
  } catch (e) { say($('#autoMsg'), e.message); }
});
// The emergency brake: nobody can claim while paused. Drops and batches stay as they are.
$('#pauseBtn').addEventListener('click', async () => {
  $('#pauseBtn').disabled = true;
  try { await call('/api/admin/pause', { paused: !data.paused }); } catch (e) { say($('#formMsg'), e.message); }
  await refresh(); $('#pauseBtn').disabled = false;
});
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  t.remove(); return ok;
}
let showFull = false;
$('#copyAddr').addEventListener('click', async () => {
  const b = $('#copyAddr');
  if (await copyText(data.treasury)) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1600); }
  else { showFull = true; $('#sAddr').textContent = data.treasury; $('#sAddr').style.cssText = 'white-space:normal;word-break:break-all;font-size:12px'; b.hidden = true; } // copying is blocked here: show all of it to select by hand
});
async function refresh() { try { data = await call('/api/admin/overview'); render(); } catch (e) { if (e.status === 401) location.reload(); } }
setInterval(() => { if (token && !document.hidden && !confirming) refresh(); }, 15000);
if (token) unlock();
})();
