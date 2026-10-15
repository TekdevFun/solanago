// A small slippy map with no dependencies: map tiles, drag to pan, pinch and wheel to zoom.
// Used by the app and by the admin console. Positions of pins are left to the page:
// call map.project(lat, lng) inside onMove to place anything on top of the map.

(() => {
  'use strict';
  const RAD = Math.PI / 180;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  class TileMap {
    constructor(el, { tileUrl, maxZoom = 19, minZoom = 3, interactive = true, onMove, onTap, onUser } = {}) {
      this.el = el;
      this.layer = el.querySelector('.tiles');
      this.tileUrl = tileUrl;
      this.maxZoom = maxZoom;
      this.minZoom = minZoom;
      this.onMove = onMove || (() => {});
      this.onTap = onTap;
      this.onUser = onUser;
      this.lat = 0;
      this.lng = 0;
      this.zoom = 15;
      this.w = 0;
      this.h = 0;
      this.tiles = new Map();
      this.flying = 0;
      if (interactive) this.bind();
      if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(el);
    }

    /** Web Mercator: degrees to pixels at a zoom level, and back. */
    static px(lat, lng, zoom) {
      const size = 256 * Math.pow(2, zoom);
      const sin = Math.sin(clamp(lat, -85.05, 85.05) * RAD);
      return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
    }

    static ll(x, y, zoom) {
      const size = 256 * Math.pow(2, zoom);
      const n = Math.PI - (2 * Math.PI * y) / size;
      return { lat: Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) / RAD, lng: (x / size) * 360 - 180 };
    }

    resize() {
      const w = this.el.clientWidth;
      const h = this.el.clientHeight;
      if (!w || !h) return;
      this.w = w;
      this.h = h;
      this.render();
    }

    stop() {
      if (this.flying) cancelAnimationFrame(this.flying);
      this.flying = 0;
    }

    setView(lat, lng, zoom) {
      this.stop();
      this.lat = clamp(lat, -85, 85);
      this.lng = lng;
      if (zoom != null) this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
      this.render();
    }

    /** Where a coordinate sits inside the map element, in pixels. */
    project(lat, lng) {
      const c = TileMap.px(this.lat, this.lng, this.zoom);
      const p = TileMap.px(lat, lng, this.zoom);
      return { x: p.x - c.x + this.w / 2, y: p.y - c.y + this.h / 2 };
    }

    unproject(x, y) {
      const c = TileMap.px(this.lat, this.lng, this.zoom);
      return TileMap.ll(c.x + x - this.w / 2, c.y + y - this.h / 2, this.zoom);
    }

    metresPerPx(lat = this.lat) {
      return (156543.03392 * Math.cos(lat * RAD)) / Math.pow(2, this.zoom);
    }

    panBy(dx, dy) {
      const c = TileMap.px(this.lat, this.lng, this.zoom);
      const p = TileMap.ll(c.x - dx, c.y - dy, this.zoom);
      this.lat = clamp(p.lat, -85, 85);
      this.lng = p.lng;
      this.render();
    }

    /** Zooms while keeping the point under the finger or cursor where it is. */
    zoomAt(x, y, dz) {
      const anchor = this.unproject(x, y);
      this.zoom = clamp(this.zoom + dz, this.minZoom, this.maxZoom);
      const after = this.project(anchor.lat, anchor.lng);
      this.panBy(x - after.x, y - after.y);
    }

    flyTo(to, ms = 600) {
      this.stop();
      const from = { lat: this.lat, lng: this.lng, zoom: this.zoom };
      const zoom = to.zoom == null ? from.zoom : clamp(to.zoom, this.minZoom, this.maxZoom);
      const duration = reducedMotion() ? 1 : ms;
      const started = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - started) / duration);
        const e = ease(k);
        this.lat = lerp(from.lat, to.lat, e);
        this.lng = lerp(from.lng, to.lng, e);
        this.zoom = lerp(from.zoom, zoom, e);
        this.flying = k < 1 ? requestAnimationFrame(step) : 0;
        this.render();
      };
      this.flying = requestAnimationFrame(step);
    }

    /** The centre and zoom that fit every point inside the area left free by the padding. */
    viewFor(points, pad = { top: 0, right: 0, bottom: 0, left: 0 }, maxZoom = 18) {
      const box = { w: Math.max(40, this.w - pad.left - pad.right), h: Math.max(40, this.h - pad.top - pad.bottom) };
      const p0 = points.map((p) => TileMap.px(p.lat, p.lng, 0));
      const x0 = Math.min(...p0.map((p) => p.x));
      const x1 = Math.max(...p0.map((p) => p.x));
      const y0 = Math.min(...p0.map((p) => p.y));
      const y1 = Math.max(...p0.map((p) => p.y));
      const zoom = clamp(Math.min(Math.log2(box.w / Math.max(1e-9, x1 - x0)), Math.log2(box.h / Math.max(1e-9, y1 - y0))), this.minZoom, Math.min(maxZoom, this.maxZoom));
      const scale = Math.pow(2, zoom);
      const centre = TileMap.ll(((x0 + x1) / 2) * scale - (pad.left - pad.right) / 2, ((y0 + y1) / 2) * scale - (pad.top - pad.bottom) / 2, zoom);
      return { lat: centre.lat, lng: centre.lng, zoom };
    }

    url(z, x, y) {
      return this.tileUrl
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y)
        .replace('{s}', 'abc'[(x + y) % 3])
        .replace('{r}', (window.devicePixelRatio || 1) > 1.3 ? '@2x' : '');
    }

    render() {
      if (!this.w || !this.h) return;
      const z = clamp(Math.round(this.zoom), this.minZoom, this.maxZoom);
      const n = Math.pow(2, z);
      const scale = Math.pow(2, this.zoom - z);
      const c = TileMap.px(this.lat, this.lng, z);
      const hw = this.w / 2 / scale;
      const hh = this.h / 2 / scale;
      const now = Date.now();
      const x0 = Math.floor((c.x - hw) / 256);
      const x1 = Math.floor((c.x + hw) / 256);
      const y0 = Math.max(0, Math.floor((c.y - hh) / 256));
      const y1 = Math.min(n - 1, Math.floor((c.y + hh) / 256));
      const want = new Set();
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const key = `${z}/${tx}/${ty}`;
          want.add(key);
          if (this.tiles.has(key)) continue;
          const img = new Image();
          const tile = { img, z, tx, ty, gone: 0 };
          img.className = 'tile';
          img.alt = '';
          img.decoding = 'async';
          img.draggable = false;
          img.onload = () => img.classList.add('ok');
          img.onerror = () => {
            img.remove();
            if (this.tiles.get(key) === tile) this.tiles.delete(key);
          };
          img.src = this.url(z, ((tx % n) + n) % n, ty);
          this.layer.appendChild(img);
          this.tiles.set(key, tile);
        }
      }
      for (const [key, tile] of this.tiles) {
        if (want.has(key)) {
          tile.gone = 0;
          tile.img.classList.remove('old');
        } else {
          // Tiles from the previous zoom level stay underneath for a moment, so the map never flashes empty.
          if (!tile.gone) tile.gone = now;
          if (tile.z === z || now - tile.gone > 700 || this.tiles.size > 90) {
            tile.img.remove();
            this.tiles.delete(key);
            continue;
          }
          tile.img.classList.add('old');
        }
        const s = Math.pow(2, this.zoom - tile.z);
        const cz = tile.z === z ? c : TileMap.px(this.lat, this.lng, tile.z);
        tile.img.style.transform = `translate(${((tile.tx * 256 - cz.x) * s + this.w / 2).toFixed(2)}px,${((tile.ty * 256 - cz.y) * s + this.h / 2).toFixed(2)}px) scale(${(s * 1.003).toFixed(4)})`;
      }
      this.onMove();
    }

    bind() {
      const el = this.el;
      const pointers = new Map();
      let pinch = 0;
      let moved = 0;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.pin, .zlabel, button, a, input')) return;
        this.stop();
        try {
          el.setPointerCapture(e.pointerId);
        } catch (_) {}
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) moved = 0;
        pinch = 0;
        el.classList.add('drag');
      });
      el.addEventListener('pointermove', (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 6 && this.onUser) this.onUser();
        if (pointers.size === 1) this.panBy(dx, dy);
        else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const r = el.getBoundingClientRect();
          this.panBy(dx / 2, dy / 2);
          if (pinch && d > 0) this.zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, Math.log2(d / pinch));
          pinch = d;
        }
      });
      const end = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        pinch = 0;
        if (pointers.size) return;
        el.classList.remove('drag');
        if (moved < 6 && e.type === 'pointerup' && this.onTap) {
          const r = el.getBoundingClientRect();
          this.onTap(this.unproject(e.clientX - r.left, e.clientY - r.top), e);
        }
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          if (this.onUser) this.onUser();
          this.stop();
          const r = el.getBoundingClientRect();
          this.zoomAt(e.clientX - r.left, e.clientY - r.top, -e.deltaY * 0.0028);
        },
        { passive: false },
      );
    }
  }

  window.TileMap = TileMap;
})();
