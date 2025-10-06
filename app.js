
// Sanwa Mobile Viewer — Pan (1 finger), Pinch Zoom (2 fingers), Search with count, Fit-to-Bounds
(function(){
  'use strict';

  // ---------- Utilities
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function qs(sel){ return document.querySelector(sel); }
  function showToast(msg, ms=1200){
    const t = qs('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>t.classList.remove('show'), ms);
  }

  function normalizeText(s){
    return (s || '')
      .toString()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase();
  }

  // ---------- State
  const S = {
    canvas: null, ctx: null,
    vw: 0, vh: 0,
    panX: 0, panY: 0,
    zoom: 1, minZoom: 0.2, maxZoom: 6,
    dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
    objects: [],
    bounds: null, // {minx,miny,maxx,maxy}
    skuByCode: new Map(),
    searchMatches: [], searchIdx: -1, highlightId: null,
    pointers: new Map(), pinch0: null,
  };

  // ---------- Layout loading
  async function loadLayout(){
    try{
      const urlParams = new URLSearchParams(location.search);
      const file = urlParams.get('layout') || (window.DEFAULT_LAYOUT || '');
      if (!file) throw new Error('No layout specified.');

      const res = await fetch(file, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load layout: ${file}`);
      const raw = await res.json();

      // Build SKU lookup from optional skuDB
      S.skuByCode.clear();
      const db = Array.isArray(raw.skuDB) ? raw.skuDB : [];
      for (const rec of db){
        if (!rec || rec.sku == null) continue;
        S.skuByCode.set(String(rec.sku), {
          name: rec.name || '',
          category: rec.category || '',
          tags: Array.isArray(rec.tags) ? rec.tags.join(' ') : (rec.tags || '')
        });
      }

      // Normalize objects
      const objs = Array.isArray(raw.objects) ? raw.objects : [];
      S.objects = objs.map(o => normalizeObject(o));

      // Precompute search text per object
      for (const o of S.objects) o._searchText = buildSearchText(o);

      // Bounds
      S.bounds = computeSceneBounds(S.objects, raw.bounds);
      fitToBounds();
      draw();
      showToast('Layout loaded');
      updateSearchCount();
    }catch(e){
      console.error(e);
      showToast('Error loading layout');
    }
  }

  function computeSceneBounds(objs, pre){
    if (pre && isFinite(pre.minX) && isFinite(pre.maxX) && isFinite(pre.minY) && isFinite(pre.maxY)){
      return {minx: pre.minX, miny: pre.minY, maxx: pre.maxX, maxy: pre.maxY};
    }
    let minx=+Infinity, miny=+Infinity, maxx=-Infinity, maxy=-Infinity;
    for (const o of objs){
      const a = o._aabb;
      if (!a) continue;
      if (a.minx<minx) minx=a.minx;
      if (a.miny<miny) miny=a.miny;
      if (a.maxx>maxx) maxx=a.maxx;
      if (a.maxy>maxy) maxy=a.maxy;
    }
    if (!isFinite(minx)) { minx=-100; miny=-100; maxx=100; maxy=100; }
    return {minx,miny,maxx,maxy};
  }

  // Robust normalization: handles degrees vs radians, center vs top-left anchors
  function normalizeObject(o){
    const obj = {...o};
    // rotation
    let rot = Number(o.rot) || 0;
    if (Math.abs(rot) > Math.PI * 2) rot = rot * Math.PI / 180; // degrees -> radians if needed

    // size
    const w = Number(o.w) || 0;
    const h = Number(o.h) || 0;

    // anchor mode: prefer center if cx/cy present or anchor:'center'
    const anchorIsCenter = ('cx' in o) || ('cy' in o) || o.anchor === 'center';

    let x, y, cx, cy;
    if (anchorIsCenter){
      cx = Number(o.cx ?? o.x ?? 0);
      cy = Number(o.cy ?? o.y ?? 0);
      x = cx - w/2;
      y = cy - h/2;
    } else {
      x = Number(o.x) || 0;
      y = Number(o.y) || 0;
      cx = x + w/2;
      cy = y + h/2;
    }

    obj._rot = rot;
    obj._cx = cx; obj._cy = cy;
    obj.x = x; obj.y = y; obj.w = w; obj.h = h;

    if (o.type === 'wall'){
      const minx = Math.min(o.x1, o.x2);
      const maxx = Math.max(o.x1, o.x2);
      const miny = Math.min(o.y1, o.y2);
      const maxy = Math.max(o.y1, o.y2);
      obj._aabb = {minx, miny, maxx, maxy};
    } else {
      obj._aabb = rectAABB(x, y, w, h, rot);
    }
    return obj;
  }

  function rectAABB(x,y,w,h, rot){
    const cx = x + w/2, cy = y + h/2;
    const pts = [
      [x,y],[x+w,y],[x+w,y+h],[x,y+h]
    ].map(([px,py])=> rotatePoint(px,py,cx,cy,rot));
    let minx=+Infinity, miny=+Infinity, maxx=-Infinity, maxy=-Infinity;
    for (const [px,py] of pts){
      if (px<minx) minx=px; if (py<miny) miny=py;
      if (px>maxx) maxx=px; if (py>maxy) maxy=py;
    }
    return {minx,miny,maxx,maxy};
  }

  function rotatePoint(x,y,cx,cy,ang){
    const s = Math.sin(ang), c = Math.cos(ang);
    const dx = x - cx, dy = y - cy;
    return [ cx + dx*c - dy*s, cy + dx*s + dy*c ];
  }

  // Build object search text: label + assigned sku codes + sku names/categories/tags
  function buildSearchText(o){
    const parts = [];
    if (o.label) parts.push(o.label);

    const codes = new Set();
    if (o.skuQty && typeof o.skuQty === 'object'){
      for (const code of Object.keys(o.skuQty)) codes.add(String(code));
    }
    if (Array.isArray(o.skus)){
      for (const code of o.skus) codes.add(String(code));
    }

    for (const code of codes){
      parts.push(code);
      const rec = S.skuByCode.get(String(code));
      if (rec){
        parts.push(rec.name, rec.category, rec.tags);
      }
    }
    return normalizeText(parts.join(' '));
  }

  // ---------- View transforms
  function worldToScreen(x,y){
    return [ x*S.zoom + S.panX, y*S.zoom + S.panY ];
  }
  function screenToWorld(x,y){
    return [ (x - S.panX)/S.zoom, (y - S.panY)/S.zoom ];
  }

  function fitToBounds(padding=0.06){
    const {minx,miny,maxx,maxy} = S.bounds;
    const cw = maxx-minx, ch = maxy-miny;
    const vw = S.vw, vh = S.vh;
    const padW = cw * padding, padH = ch * padding;
    const scale = Math.min( vw/(cw + 2*padW), vh/(ch + 2*padH) );
    S.zoom = clamp(scale, S.minZoom, S.maxZoom);
    const left = (vw - (cw)*S.zoom)/2;
    const top  = (vh - (ch)*S.zoom)/2;
    S.panX = left - minx*S.zoom;
    S.panY = top  - miny*S.zoom;
  }

  // ---------- Canvas setup
  function resize(){
    const c = S.canvas;
    const r = c.getBoundingClientRect();
    S.vw = r.width; S.vh = r.height;
    const w = Math.round(r.width * S.dpr);
    const h = Math.round(r.height * S.dpr);
    if (c.width !== w || c.height !== h){
      c.width = w; c.height = h;
      S.ctx.setTransform(S.dpr,0,0,S.dpr,0,0);
    }
    draw();
  }

  // ---------- Drawing
  function draw(){
    const ctx = S.ctx;
    const {vw,vh} = S;
    ctx.clearRect(0,0,vw,vh);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0,0,vw,vh);

    // View AABB for culling
    const [wx0, wy0] = screenToWorld(0,0);
    const [wx1, wy1] = screenToWorld(vw, vh);
    const viewAABB = {minx: Math.min(wx0,wx1), miny: Math.min(wy0,wy1), maxx: Math.max(wx0,wx1), maxy: Math.max(wy0,wy1)};

    const showLabels = S.zoom >= 0.6;

    // Walls
    for (const o of S.objects){
      if (o.type !== 'wall') continue;
      if (!intersects(viewAABB, o._aabb)) continue;
      drawWall(o);
    }
    // Rect-likes
    for (const o of S.objects){
      if (o.type === 'wall') continue;
      if (!intersects(viewAABB, o._aabb)) continue;
      drawRectLike(o, showLabels);
    }

    // Highlight
    if (S.highlightId){
      const o = S.objects.find(x=>x.id===S.highlightId);
      if (o && o._aabb){
        const a = o._aabb;
        const [sx0,sy0] = worldToScreen(a.minx,a.miny);
        const [sx1,sy1] = worldToScreen(a.maxx,a.maxy);
        ctx.save();
        ctx.strokeStyle = '#e31e24';
        ctx.lineWidth = 3;
        ctx.setLineDash([6,6]);
        ctx.strokeRect(sx0,sy0, sx1-sx0, sy1-sy0);
        ctx.restore();
      }
    }
  }

  function drawWall(o){
    const ctx = S.ctx;
    const [sx1, sy1] = worldToScreen(o.x1, o.y1);
    const [sx2, sy2] = worldToScreen(o.x2, o.y2);
    ctx.save();
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.stroke();
    ctx.restore();
  }

  function drawRectLike(o, showLabel){
    const ctx = S.ctx;
    const x = o.x || 0, y = o.y || 0, w = o.w || 0, h = o.h || 0;
    const rot = o._rot || 0;
    const cx = o._cx, cy = o._cy;
    const [scx, scy] = worldToScreen(cx, cy);

    ctx.save();
    ctx.translate(scx, scy);
    ctx.rotate(rot);
    const sw = w*S.zoom, sh = h*S.zoom;
    const sx = -sw/2, sy = -sh/2;

    // Fill/stroke by type
    const type = o.type;
    let fill = '#e5e7eb', stroke = '#6b7280';
    if (type === 'pallet' || type === 'bin'){ fill = '#f3f4f6'; stroke = '#9ca3af'; }
    if (type === 'zone'){ fill = hexWithAlpha(o.color || '#2563EB', 0.08); stroke = o.color || '#2563EB'; }
    if (o.color && type !== 'zone') fill = o.color;

    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.fill();
    ctx.stroke();

    if (showLabel && o.label){
      ctx.fillStyle = '#111827';
      const base = Math.max(10, (o.labelSize || 12));
      ctx.font = `${Math.round(base*S.zoom)}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxWidth = sw - 8;
      const lines = wrapText(o.label, ctx, maxWidth, 2);
      const lh = base * S.zoom * 1.2;
      const totalH = lines.length * lh;
      let ty = -totalH/2 + lh/2;
      for (const line of lines){
        ctx.fillText(line, 0, ty, maxWidth);
        ty += lh;
      }
    }

    ctx.restore();
  }

  function wrapText(text, ctx, maxWidth, maxLines){
    const words = (text || '').split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words){
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width <= maxWidth || !cur){
        cur = test;
      }else{
        lines.push(cur);
        cur = w;
        if (lines.length >= maxLines-1) break;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
  }

  function hexWithAlpha(hex, alpha){
    let r,g,b;
    if (/^#([a-f0-9]{3})$/i.test(hex)){
      const m = hex.match(/^#([a-f0-9])([a-f0-9])([a-f0-9])$/i);
      r = parseInt(m[1]+m[1],16); g = parseInt(m[2]+m[2],16); b = parseInt(m[3]+m[3],16);
    }else{
      const m = hex.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
      if (!m) return hex;
      r = parseInt(m[1],16); g = parseInt(m[2],16); b = parseInt(m[3],16);
    }
    return `rgba(${r},${b},${b},${alpha})`.replace(`${b},${b}`, `${g},${b}`); // keep order r,g,b
  }

  function intersects(a,b){
    return !(b.minx > a.maxx || b.maxx < a.minx || b.miny > a.maxy || b.maxy < a.miny);
  }

  // ---------- Input (Pointer Events)
  function setupInput(){
    const c = S.canvas;
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove, {passive:false});
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerUp);
    c.addEventListener('wheel', onWheel, {passive:false});

    // Buttons
    qs('#zoomIn').addEventListener('click', ()=> zoomAt(1.15));
    qs('#zoomOut').addEventListener('click', ()=> zoomAt(1/1.15));
    qs('#resetView').addEventListener('click', ()=> { fitToBounds(); draw(); });
    qs('#btnFit').addEventListener('click', ()=> { fitToBounds(); draw(); });

    // Search
    qs('#btnSearch').addEventListener('click', doSearch);
    qs('#btnNext').addEventListener('click', nextMatch);
    qs('#searchInput').addEventListener('keydown', (e)=>{
      if (e.key === 'Enter'){
        e.preventDefault(); // avoid layout jump on mobile
        doSearch();
      }
    });

    window.addEventListener('resize', resize);
  }

  function onPointerDown(e){
    S.canvas.setPointerCapture(e.pointerId);
    S.pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  }

  function onPointerMove(e){
    if (!S.pointers.has(e.pointerId)) return;
    const p = S.pointers.get(e.pointerId);
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (S.pointers.size === 1){
      S.panX += dx;
      S.panY += dy;
      draw();
    }else if (S.pointers.size === 2){
      e.preventDefault();
      const keys = [...S.pointers.keys()];
      const a = S.pointers.get(keys[0]);
      const b = S.pointers.get(keys[1]);
      const midX = (a.x + b.x)/2;
      const midY = (a.y + b.y)/2;
      const dCurr = Math.hypot(a.x - b.x, a.y - b.y);

      if (!S.pinch0){
        S.pinch0 = { d: dCurr, zoom: S.zoom, panX: S.panX, panY: S.panY, midX, midY };
      }else{
        const r = (dCurr / S.pinch0.d) || 1;
        const newZoom = clamp(S.pinch0.zoom * r, S.minZoom, S.maxZoom);
        const [wx, wy] = screenToWorldAt(newZoom, S.pinch0.panX, S.pinch0.panY, midX, midY);
        S.zoom = newZoom;
        S.panX = midX - wx * S.zoom;
        S.panY = midY - wy * S.zoom;
        draw();
      }
    }
  }

  function onPointerUp(e){
    S.pointers.delete(e.pointerId);
    if (S.pointers.size < 2) S.pinch0 = null;
  }

  function onWheel(e){
    e.preventDefault();
    const factor = (e.deltaY < 0) ? 1.1 : 1/1.1;
    zoomAt(factor, e.clientX, e.clientY);
  }

  function screenToWorldAt(zoom, panX, panY, sx, sy){
    return [ (sx - panX)/zoom, (sy - panY)/zoom ];
  }

  function zoomAt(factor, sx=null, sy=null){
    const oldZoom = S.zoom;
    const newZoom = clamp(oldZoom * factor, S.minZoom, S.maxZoom);
    if (newZoom === oldZoom) return;
    const cx = sx ?? (S.vw/2);
    const cy = sy ?? (S.vh/2);
    const [wx, wy] = screenToWorld(cx, cy);
    S.zoom = newZoom;
    S.panX = cx - wx * S.zoom;
    S.panY = cy - wy * S.zoom;
    draw();
  }

  // ---------- Search
  function updateSearchCount(){
    const el = qs('#searchCount');
    if (!el) return;
    const n = S.searchMatches.length;
    el.textContent = n ? `${S.searchIdx + 1} of ${n}` : '0 of 0';
  }

  function doSearch(){
    const qRaw = (qs('#searchInput').value || '').trim();
    S.searchMatches = [];
    S.searchIdx = -1;
    S.highlightId = null;
    if (!qRaw){ draw(); updateSearchCount(); return; }

    const terms = normalizeText(qRaw).split(/\s+/).filter(Boolean);
    for (const o of S.objects){
      const t = o._searchText || '';
      if (terms.every(term => t.includes(term))) S.searchMatches.push(o.id);
    }

    if (!S.searchMatches.length){
      showToast('No matches');
      draw(); updateSearchCount();
      return;
    }
    S.searchIdx = 0;
    updateSearchCount();
    jumpToMatch();
  }

  function nextMatch(){
    if (!S.searchMatches.length) return;
    S.searchIdx = (S.searchIdx + 1) % S.searchMatches.length;
    updateSearchCount();
    jumpToMatch();
  }

  function jumpToMatch(){
    const id = S.searchMatches[S.searchIdx];
    const o = S.objects.find(x => x.id === id);
    if (!o) return;
    S.highlightId = id;

    const targetZoom = clamp(S.zoom < 0.9 ? 1.2 : S.zoom, S.minZoom, 2.5);
    const cx = S.vw/2, cy = S.vh/2;
    const tx = o._cx,  ty = o._cy; // world coords

    S.zoom = targetZoom;
    S.panX = cx - tx * S.zoom;
    S.panY = cy - ty * S.zoom;
    draw();
  }

  // ---------- Boot
  function boot(){
    S.canvas = document.getElementById('map');
    S.ctx = S.canvas.getContext('2d', { alpha: false });
    resize();
    setupInput();
    loadLayout();
  }
  window.addEventListener('DOMContentLoaded', boot);

  // Helpers used above
  function intersects(a,b){
    return !(b.minx > a.maxx || b.maxx < a.minx || b.miny > a.maxy || b.maxy < a.miny);
  }

})();
