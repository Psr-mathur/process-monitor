/* stat dashboard: live view (served by stat.exe) and static report (data inlined). */
(function () {
  'use strict';

  // Metric slots, matching Store.cs: raw point = [t, ...8 values]; bucket = [t, n, avg x8, min x8, max x8].
  const M = { cpu: 0, ws: 1, priv: 2, threads: 3, handles: 4, ioR: 5, ioW: 6, ioO: 7 };
  const METRIC_COUNT = 8;
  const TOTAL = 'total'; // key of the series that adds up every monitored process (Store.TotalKey)
  const RECENT_KEEP_MS = 15 * 60 * 1000 + 30 * 1000;

  // CPU is the recorder strip (pens labelled); the rest are small multiples grouped by kind.
  const CHARTS = [
    { id: 'cpu', m: M.cpu, title: 'CPU', unit: '% of total machine capacity', fmt: v => fmtPct(v), hero: true },
    { id: 'ws', m: M.ws, title: 'Working set', unit: 'physical memory in use', fmt: v => fmtMB(v), group: 'mem' },
    { id: 'priv', m: M.priv, title: 'Private memory', unit: 'committed, not shared', fmt: v => fmtMB(v), group: 'mem' },
    { id: 'threads', m: M.threads, title: 'Threads', unit: 'count', fmt: v => fmtInt(v), group: 'obj' },
    { id: 'handles', m: M.handles, title: 'Handles', unit: 'open kernel handles', fmt: v => fmtInt(v), group: 'obj' },
    { id: 'ioR', m: M.ioR, title: 'I/O read', unit: 'per second, cached and network included', fmt: v => fmtRate(v), group: 'io' },
    { id: 'ioW', m: M.ioW, title: 'I/O write', unit: 'per second, cached and network included', fmt: v => fmtRate(v), group: 'io' },
    { id: 'ioO', m: M.ioO, title: 'I/O other', unit: 'per second, neither read nor write', fmt: v => fmtRate(v), group: 'io' },
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FONT = '"B612", "Segoe UI", system-ui, sans-serif';

  const state = {
    mode: 'live',
    run: null,
    procs: new Map(),      // key -> process summary
    order: [],             // keys in first-seen order
    events: [],
    recent: new Map(),     // key -> raw points (live)
    series: null,          // { key: {width, points} } whole-run data
    seriesFetchedAt: 0,
    range: 300000,         // ms window, or 'run'
    zoom: null,            // {min, max} or null
    hidden: new Set(),
    showBand: true,
    connected: false,
    lastTick: 0,           // server time of the latest tick
    lastTickAt: 0,         // browser time it arrived, to run the clock between ticks
  };

  // Theme colours read once per render rather than per canvas frame.
  let C = {};
  function readColors() {
    const v = n => cssVar('--' + n);
    C = { paper: v('paper'), gridMinor: v('grid-minor'), gridMajor: v('grid-major'), rule: v('rule'), ink: v('ink'),
      ink2: v('ink-2'), muted: v('muted'), markup: v('markup'), band: parseFloat(v('band-alpha')) || 0.2 };
  }

  const charts = new Map();  // id -> Chart
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- formatting

  function offsetMs() { return ((state.run && state.run.utcOffsetMinutes) || 0) * 60000; }
  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function partsOf(t) {
    const d = new Date(t + offsetMs());
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
  }
  function fmtTime(t, withSeconds) {
    const p = partsOf(t);
    return pad(p.h) + ':' + pad(p.mi) + (withSeconds === false ? '' : ':' + pad(p.s));
  }
  function fmtDate(t) { const p = partsOf(t); return p.y + '-' + pad(p.mo) + '-' + pad(p.d); }
  function fmtLongDate(t) { const p = partsOf(t); return p.d + ' ' + MONTHS[p.mo - 1] + ' ' + p.y; }
  function fmtClock(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return (d ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function fmtDateTime(t) { return fmtDate(t) + ' ' + fmtTime(t); }
  function fmtStamp(t) { const p = partsOf(t); return fmtDate(t) + ' ' + fmtTime(t) + '.' + pad(p.ms, 3); }
  function utcLabel() {
    const o = (state.run && state.run.utcOffsetMinutes) || 0;
    const sign = o < 0 ? '-' : '+', a = Math.abs(o);
    return 'UTC' + sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }
  // trimZeros: axis labels read better as "8%" than "8.00%".
  let trimZeros = false;
  function num(v, d) { return v == null || isNaN(v) ? '-' : Number(v).toLocaleString(undefined, { minimumFractionDigits: trimZeros ? 0 : d, maximumFractionDigits: d }); }
  function axisLabel(fmt, v) { trimZeros = true; try { return fmt(v); } finally { trimZeros = false; } }
  function fmtPct(v) { return v == null ? '-' : num(v, v < 10 ? 2 : 1) + '%'; }
  function fmtCores(v) { return v == null ? '-' : num(v, 2); }
  function fmtMB(v) { return v == null ? '-' : v >= 1024 ? num(v / 1024, 2) + ' GB' : num(v, v < 100 ? 1 : 0) + ' MB'; }
  function fmtInt(v) { return v == null ? '-' : num(Math.round(v), 0); }
  function fmtBytes(v) {
    if (v == null || isNaN(v)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return num(v, i === 0 ? 0 : v < 10 ? 2 : 1) + ' ' + u[i];
  }
  function fmtRate(v) { return v == null ? '-' : fmtBytes(v) + '/s'; }
  function coresOf(pct) { return pct == null || !state.run ? null : pct * state.run.cores / 100; }

  // ---------------------------------------------------------------- theme

  const THEMES = ['auto', 'light', 'dark'];
  let theme = 'auto';
  try { theme = localStorage.getItem('stat-theme') || 'auto'; } catch (e) { /* storage unavailable */ }
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('themeToggle').textContent = 'Theme: ' + theme;
    charts.forEach(c => c.destroy());
    charts.clear();
    render();
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function colorFor(proc) {
    if (proc && proc.total) return cssVar('--ink');
    return proc && proc.color >= 0 ? cssVar('--series-' + (proc.color + 1)) : cssVar('--series-neutral');
  }
  function withAlpha(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---------------------------------------------------------------- data

  /** Name with the user's label appended, e.g. "node:be". */
  function displayName(p) { return p.label ? p.name + ':' + p.label : p.name; }
  function labelOf(p) { return p.total ? 'Total' : displayName(p) + ' (' + p.pid + ')'; }

  function setProcesses(list) {
    for (const p of list) {
      // The Total is kept in procs but not in order: it is not a process and has no palette colour.
      if (!p.total && !state.procs.has(p.k)) state.order.push(p.k);
      state.procs.set(p.k, p);
    }
  }

  /** The Total only adds information once there is more than one process to add up. */
  function showTotal() { return state.order.length > 1 && state.procs.has(TOTAL); }

  function addEvents(list) {
    if (!list || !list.length) return;
    state.events.push(...list);
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
  }

  function intervalMs() { return Math.max(1, Math.round(((state.run && state.run.interval) || 1) * 1000)); }

  /** Groups raw points into bucket points ([t, n, avg x8, min x8, max x8]) of the given width, like Store.cs. */
  function bucketize(raw, width) {
    const out = [];
    let cur = null;
    for (const p of raw) {
      const t = p[0] - (((p[0] % width) + width) % width);
      if (!cur || cur.t !== t) {
        cur = { t, n: 0, sum: new Array(METRIC_COUNT).fill(0), min: p.slice(1, 1 + METRIC_COUNT), max: p.slice(1, 1 + METRIC_COUNT) };
        out.push(cur);
      }
      cur.n++;
      for (let i = 0; i < METRIC_COUNT; i++) {
        const v = p[1 + i];
        cur.sum[i] += v;
        if (v < cur.min[i]) cur.min[i] = v;
        if (v > cur.max[i]) cur.max[i] = v;
      }
    }
    return out.map(b => [b.t, b.n].concat(b.sum.map(s => s / b.n), b.min, b.max));
  }

  /** Converts stored points for one process + metric into chart points, inserting null gaps. */
  function buildPoints(key, m, wantBand) {
    const line = [], lo = [], hi = [];
    let width = 0, pts = [];
    if (state.range === 'run' || state.mode === 'report') {
      const s = state.series && state.series[key];
      if (s) { width = s.width; pts = s.points; }
      // In live mode, extend whole-run data with raw samples newer than the last fetch.
      if (state.mode === 'live') {
        const rec = state.recent.get(key) || [];
        const last = pts.length ? pts[pts.length - 1][0] + (width || 0) : -Infinity;
        const tail = rec.filter(p => p[0] > last);
        if (tail.length) pts = pts.concat(width > 0 ? bucketize(tail, width) : tail);
      }
    } else {
      pts = state.recent.get(key) || [];
    }

    const rawGap = Math.max(5 * intervalMs(), 3000);
    let prevX = null;
    for (const p of pts) {
      const isBucket = p.length > 9;
      const x = isBucket ? p[0] + width / 2 : p[0];
      const avg = isBucket ? p[2 + m] : p[1 + m];
      const gap = isBucket ? width * 2.5 : rawGap;
      if (prevX !== null && x - prevX > gap) {
        const gx = (prevX + x) / 2;
        line.push({ x: gx, y: null });
        if (wantBand) { lo.push({ x: gx, y: null }); hi.push({ x: gx, y: null }); }
      }
      if (isBucket) {
        const min = p[2 + METRIC_COUNT + m], max = p[2 + 2 * METRIC_COUNT + m];
        line.push({ x, y: avg, min, max, n: p[1], w: width });
        if (wantBand) { lo.push({ x, y: min }); hi.push({ x, y: max }); }
      } else {
        line.push({ x, y: avg });
        if (wantBand) { lo.push({ x, y: avg }); hi.push({ x, y: avg }); }
      }
      prevX = x;
    }
    return { line, lo, hi, aggregated: width > 0 };
  }

  function visibleKeys() {
    const keys = state.order.filter(k => !state.hidden.has(k));
    if (showTotal() && !state.hidden.has(TOTAL)) keys.push(TOTAL); // drawn last, on top
    return keys;
  }

  /** Time extent of whatever the charts are showing. */
  function xExtent() {
    if (state.zoom) return state.zoom;
    const now = state.mode === 'live' ? (state.run.endedAt || state.lastTick || Date.now()) : (state.run.endedAt || state.run.startedAt);
    if (state.mode === 'live' && state.range !== 'run') return { min: now - state.range, max: now };
    let min = Infinity, max = -Infinity;
    for (const k of state.order) {
      const s = state.series && state.series[k];
      if (s && s.points.length) {
        min = Math.min(min, s.points[0][0]);
        max = Math.max(max, s.points[s.points.length - 1][0] + (s.width || 0));
      }
      const r = state.recent.get(k);
      if (r && r.length) { min = Math.min(min, r[0][0]); max = Math.max(max, r[r.length - 1][0]); }
    }
    if (!isFinite(min)) { min = state.run.startedAt; max = now; }
    if (max - min < 10000) max = min + 10000;
    return { min, max };
  }

  // ---------------------------------------------------------------- charts

  /** For each visible series in a chart, the point nearest time xVal (within 4% of the visible span). */
  function nearestItems(chart, xVal) {
    const span = chart.scales.x.max - chart.scales.x.min;
    const items = [];
    chart.data.datasets.forEach((ds, di) => {
      if (ds.band || !chart.isDatasetVisible(di)) return;
      const data = ds.data;
      let lo = 0, hi = data.length - 1;
      if (hi < 0) return;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].x < xVal) lo = mid + 1; else hi = mid; }
      let best = -1, bestDist = Infinity;
      for (let i = Math.max(0, lo - 2); i <= Math.min(data.length - 1, lo + 2); i++) {
        if (data[i].y == null) continue;
        const d = Math.abs(data[i].x - xVal);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best < 0 || bestDist > span * 0.04) return;
      const el = chart.getDatasetMeta(di).data[best];
      if (el) items.push({ element: el, datasetIndex: di, index: best });
    });
    return items;
  }

  // Click mode (used for legend/tooltip clicks): points nearest the pointer's time.
  Chart.Interaction.modes.statNearestX = function (chart, e) {
    const pos = Chart.helpers.getRelativePosition(e, chart);
    const area = chart.chartArea;
    if (!area || pos.x < area.left || pos.x > area.right || pos.y < area.top || pos.y > area.bottom) return [];
    return nearestItems(chart, chart.scales.x.getValueForPixel(pos.x));
  };

  // Hover is synced across charts: the pointer over any chart picks a time, and every chart
  // shows its crosshair and tooltip at that time. Kept as chart + pixel so live updates that
  // scroll the axis keep the overlay under the pointer.
  const hover = { chart: null, px: 0 };
  function hoverTime() {
    const c = hover.chart;
    return c && c.chartArea && charts.get(c.$statId) === c ? c.scales.x.getValueForPixel(hover.px) : null;
  }

  function syncHover() {
    const t = drag ? null : hoverTime();
    charts.forEach(chart => {
      const area = chart.chartArea;
      if (!area) return;
      const items = t == null ? [] : nearestItems(chart, t);
      const px = t == null ? 0 : chart.scales.x.getPixelForValue(t);
      chart.$statHoverX = t == null ? null : px;
      chart.setActiveElements(items);
      chart.tooltip.setActiveElements(items, { x: px, y: (area.top + area.bottom) / 2 });
      chart.draw();
    });
  }

  let syncQueued = false;
  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; syncHover(); });
  }

  const crosshairPlugin = {
    id: 'statCrosshair',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx, area = chart.chartArea;
      const hx = chart.$statHoverX;
      if (hx != null && !drag && hx >= area.left && hx <= area.right) {
        const x = Math.round(hx) + 0.5;
        ctx.save();
        ctx.strokeStyle = C.markup;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke();
        ctx.restore();
      }
      if (drag && drag.chart === chart) {
        const x0 = Math.max(area.left, Math.min(drag.x0, drag.x1)), x1 = Math.min(area.right, Math.max(drag.x0, drag.x1));
        ctx.save();
        ctx.fillStyle = withAlpha(C.markup, 0.12);
        ctx.strokeStyle = C.markup;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(x0, area.top, x1 - x0, area.bottom - area.top);
        ctx.strokeRect(x0 + 0.5, area.top + 0.5, x1 - x0 - 1, area.bottom - area.top - 1);
        ctx.restore();
      }
    },
  };

  // Millimetre paper: five minor divisions between each pair of major gridlines.
  const paperPlugin = {
    id: 'statPaper',
    beforeDraw(chart) {
      const a = chart.chartArea, sx = chart.scales.x, sy = chart.scales.y;
      if (!a || !sx || !sy) return;
      const ctx = chart.ctx;
      const minors = (positions, lo, hi) => {
        const out = [];
        if (positions.length < 2) return out;
        const step = (positions[1] - positions[0]) / 5;
        if (Math.abs(step) < 4) return out;
        const start = positions[0] - Math.ceil((positions[0] - lo) / step) * step;
        for (let p = start; p <= hi + 0.5; p += step) {
          if (!positions.some(q => Math.abs(q - p) < 1)) out.push(p);
        }
        return out;
      };
      const xs = sx.ticks.map(t => sx.getPixelForValue(t.value));
      const ys = sy.ticks.map(t => sy.getPixelForValue(t.value)).sort((p, q) => p - q);
      ctx.save();
      ctx.strokeStyle = C.gridMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of minors(xs, a.left, a.right)) { const px = Math.round(x) + 0.5; ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); }
      for (const y of minors(ys, a.top, a.bottom)) { const py = Math.round(y) + 0.5; ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); }
      ctx.stroke();
      ctx.restore();
    },
  };

  /** Last drawable point of a dataset inside the visible x range. */
  function penIndex(chart, ds) {
    const min = chart.scales.x.min, max = chart.scales.x.max;
    for (let i = ds.data.length - 1; i >= 0; i--) {
      const p = ds.data[i];
      if (p.x > max) continue;
      if (p.x < min) return -1;
      if (p.y != null) return i;
    }
    return -1;
  }

  // Pen tips: a dot where each trace ends; on the CPU strip, the latest reading written beside it.
  const penPlugin = {
    id: 'statPen',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx, a = chart.chartArea;
      const labels = [];
      chart.data.datasets.forEach((ds, di) => {
        if (ds.band || !chart.isDatasetVisible(di)) return;
        const i = penIndex(chart, ds);
        if (i < 0) return;
        const el = chart.getDatasetMeta(di).data[i];
        if (!el) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(el.x, el.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = ds.borderColor;
        ctx.strokeStyle = C.paper;
        ctx.lineWidth = 2;
        ctx.fill(); ctx.stroke();
        ctx.restore();
        if (chart.$statLabels) labels.push({ x: el.x, y: el.y, want: el.y, color: ds.borderColor, value: chart.$statFmt(ds.data[i].y), name: ds.label });
      });
      if (!labels.length) return;

      // Spread labels vertically so they never overlap, keeping them inside the plot height.
      const gap = 17;
      labels.sort((p, q) => p.want - q.want);
      for (let i = 0; i < labels.length; i++) labels[i].y = Math.max(labels[i].want, i ? labels[i - 1].y + gap : a.top + 6);
      const overflow = labels[labels.length - 1].y - (a.bottom - 4);
      if (overflow > 0) {
        for (let i = labels.length - 1; i >= 0; i--) {
          labels[i].y = Math.min(labels[i].y - overflow, i < labels.length - 1 ? labels[i + 1].y - gap : Infinity);
        }
      }

      const x0 = a.right + 14, maxW = chart.width - x0 - 4;
      ctx.save();
      ctx.textBaseline = 'middle';
      for (const l of labels) {
        ctx.strokeStyle = C.ink2;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(l.x + 5, l.want); ctx.lineTo(x0 - 4, l.y); ctx.stroke();
        ctx.font = '700 12px ' + FONT;
        ctx.fillStyle = C.ink;
        ctx.fillText(l.value, x0, l.y);
        const vw = ctx.measureText(l.value + ' ').width;
        ctx.font = '12px ' + FONT;
        ctx.fillStyle = C.ink2;
        if (chart.$statCompact) continue; // narrow screens: value only; colour and the table identify the pen
        let name = l.name;
        while (name.length > 3 && vw + ctx.measureText(name).width > maxW) name = name.slice(0, -2) + '…';
        if (vw + ctx.measureText(name).width <= maxW) ctx.fillText(name, x0 + vw, l.y);
      }
      ctx.restore();
    },
  };

  // Drag across any chart to zoom all charts to that time range.
  let drag = null;
  function attachZoom(chart) {
    const canvas = chart.canvas;
    // Pointer position in chart pixels (the canvas has no border or transform, so this matches Chart.js).
    const local = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const a = chart.chartArea, x = local(e).x;
      if (x < a.left || x > a.right) return;
      drag = { chart, x0: x, x1: x };
      canvas.setPointerCapture(e.pointerId);
      queueSync(); // hide tooltips while dragging
    });
    canvas.addEventListener('pointermove', e => {
      const p = local(e);
      if (drag) {
        if (drag.chart !== chart) return;
        drag.x1 = p.x;
        chart.draw();
        return;
      }
      const a = chart.chartArea;
      const inside = a && p.x >= a.left && p.x <= a.right && p.y >= a.top && p.y <= a.bottom;
      hover.chart = inside ? chart : null;
      hover.px = p.x;
      queueSync();
    });
    canvas.addEventListener('pointerleave', () => {
      if (hover.chart === chart) { hover.chart = null; queueSync(); }
    });
    const end = e => {
      if (!drag || drag.chart !== chart) return;
      const d = drag; drag = null;
      if (Math.abs(d.x1 - d.x0) > 6) {
        const sx = chart.scales.x;
        const a = sx.getValueForPixel(Math.min(d.x0, d.x1)), b = sx.getValueForPixel(Math.max(d.x0, d.x1));
        if (b - a >= 1000) { state.zoom = { min: a, max: b }; render(); return; }
      }
      chart.draw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => { drag = null; chart.draw(); });
    canvas.addEventListener('dblclick', () => { if (state.zoom) { state.zoom = null; render(); } });
  }

  // Time ticks on round clock values (in the run's time zone) instead of arbitrary numbers.
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map(s => s * 1000);
  function timeTicks(axis) {
    const min = axis.min, max = axis.max, span = max - min;
    const target = Math.max(2, Math.floor(axis.width / 90));
    const step = TICK_STEPS.find(s => span / s <= target) || TICK_STEPS[TICK_STEPS.length - 1];
    const off = offsetMs();
    const ticks = [];
    for (let t = Math.ceil((min + off) / step) * step - off; t <= max; t += step) ticks.push({ value: t });
    axis.ticks = ticks;
  }

  function tickFormatter(span) {
    return value => {
      if (span > 2 * 86400000) { const p = partsOf(value); return pad(p.mo) + '-' + pad(p.d) + ' ' + fmtTime(value, false); }
      return fmtTime(value, span <= 15 * 60000);
    };
  }

  function ensureFigures() {
    const host = $('multiples');
    if (host.childElementCount) return;
    for (const def of CHARTS) {
      if (def.hero) continue;
      const fig = document.createElement('figure');
      fig.className = def.group;
      fig.innerHTML = '<figcaption><b></b><span class="unit"></span></figcaption><div class="chart-box"><canvas role="img"></canvas></div>';
      fig.querySelector('b').textContent = def.title;
      fig.querySelector('.unit').textContent = def.unit;
      const canvas = fig.querySelector('canvas');
      canvas.id = 'chart-' + def.id;
      canvas.setAttribute('aria-label', def.title + ' over time per process; values are listed in the Processes table.');
      host.appendChild(fig);
    }
  }

  function renderCharts() {
    ensureFigures();
    const anyData = state.order.some(k => (state.procs.get(k) || {}).n > 0);
    $('waiting').hidden = anyData;

    const ext = xExtent();
    const span = ext.max - ext.min;
    const keys = anyData ? visibleKeys() : [];
    let aggregatedAny = false;
    const heroWidth = $('chart-cpu').parentElement.clientWidth;

    for (const def of CHARTS) {
      const datasets = [];
      for (const k of keys) {
        const proc = state.procs.get(k);
        const color = colorFor(proc);
        const wantBand = state.showBand && (state.range === 'run' || state.mode === 'report');
        const pts = buildPoints(k, def.m, wantBand);
        if (pts.aggregated) aggregatedAny = true;
        if (wantBand && pts.aggregated) {
          datasets.push({ band: true, key: k, data: pts.lo, borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false });
          datasets.push({ band: true, key: k, data: pts.hi, borderWidth: 0, pointRadius: 0, fill: '-1', spanGaps: false,
            backgroundColor: withAlpha(color, C.band) });
        }
        datasets.push({
          key: k, label: labelOf(proc), data: pts.line,
          borderColor: color, backgroundColor: color, borderWidth: (def.hero ? 2 : 1.75) + (proc.total ? 0.25 : 0),
          borderDash: proc.total ? [7, 4] : undefined,
          pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: color, pointHoverBorderColor: C.paper, pointHoverBorderWidth: 2,
          spanGaps: false, tension: 0, fill: false,
        });
      }

      let chart = charts.get(def.id);
      if (!chart) {
        chart = new Chart($('chart-' + def.id), {
          type: 'line',
          data: { datasets },
          plugins: [paperPlugin, crosshairPlugin, penPlugin],
          options: {
            parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
            // Hover is driven by syncHover(); Chart.js only handles clicks.
            events: ['click'],
            interaction: { mode: 'statNearestX', intersect: false },
            layout: { padding: { top: 6, right: 8 } },
            scales: {
              x: { type: 'linear', afterBuildTicks: timeTicks, grid: { color: C.gridMajor, tickColor: C.gridMajor }, border: { color: C.ink2 },
                ticks: { color: C.muted, maxRotation: 0, autoSkip: false, font: { size: 11 } } },
              y: { beginAtZero: true, grid: { color: C.gridMajor, tickColor: C.gridMajor }, border: { display: false },
                ticks: { color: C.muted, maxTicksLimit: def.hero ? 7 : 5, font: { size: 11 }, callback: v => axisLabel(def.fmt, v) } },
            },
            plugins: {
              // The Processes table is the key; the CPU strip also labels each pen directly.
              legend: { display: false },
              tooltip: {
                backgroundColor: C.paper, titleColor: C.muted, bodyColor: C.ink, borderColor: C.ink2, borderWidth: 1, cornerRadius: 2,
                padding: 10, boxWidth: 14, boxHeight: 2, usePointStyle: false, titleFont: { weight: 'normal', size: 11.5 }, bodyFont: { size: 12 },
                callbacks: {
                  title: items => {
                    const t = hoverTime();
                    return t != null ? fmtStamp(t).slice(0, 19) : items.length ? fmtStamp(items[0].raw.x).slice(0, 19) : '';
                  },
                  label: item => tooltipLabel(def, item),
                  labelColor: item => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor, borderWidth: 0 }),
                },
              },
            },
          },
        });
        chart.$statId = def.id;
        chart.$statLabels = !!def.hero;
        chart.$statFmt = def.fmt;
        attachZoom(chart);
        charts.set(def.id, chart);
      } else {
        chart.data.datasets = datasets;
      }
      chart.options.scales.x.min = ext.min;
      chart.options.scales.x.max = ext.max;
      chart.options.scales.x.ticks.callback = tickFormatter(span);
      // Room to the right of the strip for the pen labels.
      if (def.hero) {
        chart.$statCompact = heroWidth <= 640;
        chart.options.layout.padding.right = chart.$statCompact ? 66 : 190;
      }
      chart.update('none');
    }

    const note = [];
    if (Date.now() < flashUntil) note.push(flashMsg);
    if (aggregatedAny) note.push('Each point averages a time bucket' + (state.showBand ? '; the shaded band shows its range.' : '.'));
    note.push(state.zoom ? 'Double-click a chart to reset the zoom.' : 'Drag across a chart to zoom.');
    $('viewNote').textContent = note.join(' ');
    $('resetZoom').hidden = !state.zoom;
    if (hover.chart) syncHover(); // re-apply after live updates rebuilt the datasets
  }

  function tooltipLabel(def, item) {
    const r = item.raw;
    let v = def.fmt(r.y);
    if (def.m === M.cpu) v += ' (' + fmtCores(coresOf(r.y)) + ' cores)';
    let s = v + '  ' + item.dataset.label;
    if (r.min != null && r.n > 1) s += '  [avg of ' + r.n + ', ' + def.fmt(r.min) + ' - ' + def.fmt(r.max) + ']';
    return s;
  }

  function toggleProcess(key) {
    if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
    render();
  }

  // A short message shown in the chart controls bar, e.g. when a label could not be saved.
  let flashMsg = '', flashUntil = 0;
  function flash(msg) { flashMsg = msg; flashUntil = Date.now() + 8000; render(); setTimeout(scheduleRender, 8100); }

  // ---------------------------------------------------------------- labels (live only)

  /** Sends a label to process-monitor.exe, which keeps it for every browser and the report. Empty removes it. */
  function saveLabel(k, text) {
    const p = state.procs.get(k);
    if (!p || text.trim() === (p.label || '')) return;
    fetch('api/label', {
      method: 'POST', cache: 'no-store',
      // The custom header makes the server reject posts from other websites (they would need a CORS preflight).
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Monitor-Request': '1' },
      body: new URLSearchParams({ k: k, label: text }).toString(),
    })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => { const cur = state.procs.get(k); if (cur) cur.label = d.label; render(); })
      .catch(err => flash('Could not save the label (' + err.message + '). Check that process-monitor.exe is still running.'));
  }

  /** Adds the "Add label" button and its inline editor to a process row. */
  function attachLabelEditor(tr, k) {
    const cell = tr.children[1];
    const key = cell.querySelector('.key');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'relabel';
    key.appendChild(btn);

    const form = document.createElement('form');
    form.className = 'label-form';
    form.hidden = true;
    form.innerHTML = '<span class="base"></span><input type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="be">' +
      '<span class="hint">Enter saves, Esc cancels, empty removes</span>';
    cell.insertBefore(form, cell.querySelector('.pmeta'));
    const input = form.querySelector('input');

    let editing = false;
    const close = () => { editing = false; form.hidden = true; key.hidden = false; };
    btn.addEventListener('click', () => {
      const p = state.procs.get(k);
      form.querySelector('.base').textContent = p.name + ':';
      input.value = p.label || '';
      input.setAttribute('aria-label', 'Label for ' + p.name + ' (PID ' + p.pid + ')');
      key.hidden = true;
      form.hidden = false;
      editing = true;
      input.focus();
      input.select();
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!editing) return;
      const v = input.value;
      close();
      btn.focus();
      saveLabel(k, v);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
    });
    input.addEventListener('blur', () => {
      if (!editing) return;
      const v = input.value;
      close();
      saveLabel(k, v);
    });
  }

  // ---------------------------------------------------------------- masthead, roster, logbook

  /** Server time now: the latest tick plus time elapsed since it arrived. */
  function serverNow() { return state.lastTick ? state.lastTick + (Date.now() - state.lastTickAt) : Date.now(); }

  function renderClock() {
    const r = state.run;
    if (!r) return;
    const finished = state.mode === 'report' || !!r.endedAt;
    const end = r.endedAt || (state.mode === 'report' ? (state.generatedAt || r.startedAt) : serverNow());
    $('clock').textContent = fmtClock(end - r.startedAt);
    $('clockLabel').textContent = finished ? 'recorded' : 'elapsed';
  }

  function renderHeader() {
    const r = state.run;
    const lamp = $('lamp'), station = $('stationText');
    let lampClass = 'lamp', verb;
    if (state.mode === 'report') verb = 'Report from ';
    else if (r.endedAt) verb = 'Stopped on ';
    else if (state.connected) { lampClass += ' on'; verb = 'Recording on '; }
    else { lampClass += ' warn'; verb = 'Reconnecting to '; }
    lamp.className = lampClass;
    station.textContent = verb;
    const host = document.createElement('b');
    host.textContent = r.host;
    station.appendChild(host);

    // One plain sentence instead of a strip of labelled fields.
    const when = t => fmtTime(t) + ' on ' + fmtLongDate(t);
    let s;
    if (r.endedAt || state.mode === 'report') {
      const end = r.endedAt || state.generatedAt || r.startedAt;
      s = 'Sampled every ' + r.interval + ' s across ' + r.cores + ' logical processors from ' +
        (fmtDate(r.startedAt) === fmtDate(end) ? fmtTime(r.startedAt) + ' to ' + when(end) : when(r.startedAt) + ' to ' + when(end));
    } else {
      s = 'Sampling every ' + r.interval + ' s across ' + r.cores + ' logical processors since ' + when(r.startedAt);
    }
    s += ' (' + utcLabel() + ').';
    if (!r.admin) s += ' Not running as Administrator, so processes owned by other users may be missing.';
    $('runSentence').textContent = s;
    renderClock();
  }

  /** Footer credit "Built by <author> · <repo link>", from the run info so the exe is the single source.
   *  Built once, not on every render, so the link is never replaced under the pointer. */
  function renderCredit() {
    const r = state.run, credit = $('credit');
    if (credit.childElementCount || !r.author) return;
    const who = document.createElement('b');
    who.textContent = r.author;
    credit.append('Built by ', who);
    if (r.repo && /^https:\/\//.test(r.repo)) {
      const a = document.createElement('a');
      a.href = r.repo;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = r.repo.replace(/^https:\/\//, '');
      credit.append(' \u00b7 ', a);
    }
  }

  /** Latest values for a process: the newest raw sample (live) or the last point of the run (report). */
  function latestOf(key) {
    const rec = state.recent.get(key);
    if (rec && rec.length) return rec[rec.length - 1].slice(1, 1 + METRIC_COUNT);
    const s = state.series && state.series[key];
    if (s && s.points.length) {
      const p = s.points[s.points.length - 1];
      return p.length > 9 ? p.slice(2, 2 + METRIC_COUNT) : p.slice(1, 1 + METRIC_COUNT);
    }
    return null;
  }

  const STATUS_TEXT = { running: 'running', exited: 'exited', 'not-listening': 'stopped listening', unavailable: 'access lost', stopped: 'all stopped' };
  const LAMP_FOR = { running: 'on', exited: 'fault' };

  function signedMB(v) {
    if (v == null || isNaN(v)) return '-';
    if (Math.abs(v) < 0.05) return fmtMB(0); // below display precision: no "-0.0 MB"
    return (v > 0 ? '+' : '−') + fmtMB(Math.abs(v));
  }

  function makeRow(k) {
    const tr = document.createElement('tr');
    tr.dataset.key = k;
    for (let i = 0; i < 14; i++) tr.appendChild(document.createElement('td'));
    const key = document.createElement('label');
    key.className = 'key';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => toggleProcess(k));
    const ink = document.createElement('span');
    ink.className = 'ink';
    key.append(cb, ink);
    tr.children[0].appendChild(key);
    tr.children[1].className = 'name-col';
    tr.children[1].innerHTML = '<span class="key"><span class="lamp"></span><span class="pname"></span></span><span class="pmeta"></span>';
    if (k !== TOTAL && state.mode === 'live') attachLabelEditor(tr, k);
    for (let i = 2; i < 14; i++) tr.children[i].className = 'num';
    return tr;
  }

  function fillRow(tr, k, p) {
    const c = tr.children;
    const shown = !state.hidden.has(k);
    tr.classList.toggle('lifted', !shown);
    const cb = c[0].querySelector('input');
    cb.checked = shown;
    cb.setAttribute('aria-label', 'Show ' + labelOf(p) + ' on the charts');
    const ink = c[0].querySelector('.ink');
    ink.classList.toggle('dashed', !!p.total);
    ink.style.color = colorFor(p);
    ink.style.background = p.total ? '' : colorFor(p);

    const lamp = c[1].querySelector('.lamp');
    lamp.className = 'lamp' + (LAMP_FOR[p.status] ? ' ' + LAMP_FOR[p.status] : '');
    lamp.title = STATUS_TEXT[p.status] || p.status;
    c[1].querySelector('.pname').textContent = p.total ? 'Total' : displayName(p);
    let meta;
    if (p.total) {
      meta = 'Sum of all ' + state.order.length + ' processes at each sample';
      if (p.status !== 'running') meta += ', ' + (STATUS_TEXT[p.status] || p.status);
    } else {
      // Sources look like "pid", "port 5057" or "pid, port 5057".
      const ports = p.source.split(', ').filter(s => s !== 'pid');
      meta = 'PID ' + p.pid + (ports.length ? ' on ' + ports.join(' and ') : '');
      if (p.status !== 'running') meta += ', ' + (STATUS_TEXT[p.status] || p.status) + (p.endedAt ? ' at ' + fmtTime(p.endedAt) : '');
    }
    c[1].querySelector('.pmeta').textContent = meta;
    const relabel = c[1].querySelector('.relabel');
    if (relabel) {
      relabel.hidden = !!state.run.endedAt; // the server is gone once the run has stopped
      relabel.textContent = p.label ? 'Edit label' : 'Add label';
      relabel.setAttribute('aria-label', (p.label ? 'Edit the label of ' : 'Add a label to ') + labelOf(p));
    }

    const has = p.n > 0, now = latestOf(k);
    c[2].textContent = now ? fmtPct(now[M.cpu]) : '-';
    c[3].textContent = has ? fmtPct(p.cpuAvg) : '-';
    c[4].textContent = has ? fmtPct(p.cpuP95) : '-';
    c[5].textContent = has ? fmtPct(p.cpuMax) : '-';
    c[5].title = has ? fmtCores(coresOf(p.cpuMax)) + ' cores' : '';
    c[6].textContent = now ? fmtMB(now[M.ws]) : '-';
    c[7].textContent = has ? fmtMB(p.wsMax) : '-';
    c[8].textContent = now ? fmtMB(now[M.priv]) : '-';
    c[9].textContent = has ? signedMB(p.privLast - p.privFirst) : '-';
    c[9].title = has ? 'from ' + fmtMB(p.privFirst) + ' to ' + fmtMB(p.privLast) + ', peak ' + fmtMB(p.privMax) : '';
    c[10].textContent = now ? fmtInt(now[M.threads]) : '-';
    c[10].title = has ? 'peak ' + fmtInt(p.threadsMax) : '';
    c[11].textContent = now ? fmtInt(now[M.handles]) : '-';
    c[11].title = has ? 'peak ' + fmtInt(p.handlesMax) : '';
    c[12].textContent = fmtBytes(p.ioReadTotal);
    c[13].textContent = fmtBytes(p.ioWriteTotal);
  }

  function renderTable() {
    const tbody = document.querySelector('#procTable tbody');
    const tfoot = document.querySelector('#procTable tfoot');
    const finished = state.mode === 'report' || !!state.run.endedAt;
    document.querySelectorAll('#procTable .now-label').forEach(th => { th.textContent = finished ? 'at end' : 'now'; });
    $('procEmpty').hidden = state.order.length > 0;
    for (const k of state.order) {
      let tr = tbody.querySelector('tr[data-key="' + CSS.escape(k) + '"]');
      if (!tr) { tr = makeRow(k); tbody.appendChild(tr); }
      fillRow(tr, k, state.procs.get(k));
    }
    const total = showTotal() ? state.procs.get(TOTAL) : null;
    tfoot.hidden = !total;
    if (total) {
      let tr = tfoot.firstElementChild;
      if (!tr) { tr = makeRow(TOTAL); tr.classList.add('total-row'); tfoot.appendChild(tr); }
      fillRow(tr, TOTAL, total);
    }
  }

  let renderedEvents = -1;
  function renderEvents() {
    if (renderedEvents === state.events.length && state.events.length < 1000) return;
    renderedEvents = state.events.length;
    const list = $('events');
    list.textContent = '';
    const shown = state.events.slice(-300).reverse();
    for (const e of shown) {
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'mark';
      const time = document.createElement('time');
      time.textContent = fmtDateTime(e.t);
      const msg = document.createElement('span');
      if (e.level === 'warn') {
        mark.textContent = '!';
        mark.setAttribute('aria-hidden', 'true');
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = 'Warning: ';
        msg.append(sr);
      }
      msg.append(document.createTextNode(e.msg));
      li.append(mark, time, msg);
      list.appendChild(li);
    }
    let count = state.events.length === 0 ? 'Nothing logged yet.' :
      state.events.length + ' entr' + (state.events.length === 1 ? 'y' : 'ies') + ', newest first. A red mark flags a warning.';
    if (state.events.length > shown.length) count += ' Showing the latest ' + shown.length + '.';
    $('eventCount').textContent = count;
  }

  function renderFooter() {
    const f = $('footer');
    f.textContent = '';
    const r = state.run;
    let text = 'Generated by ' + (r.product || 'process-monitor') + ' ' + r.version;
    if (state.mode === 'report' && state.generatedAt) text += ' on ' + fmtDateTime(state.generatedAt) + ' ' + utcLabel();
    text += '. ' + r.host + ' runs ' + r.os + '. Charts by Chart.js (MIT licence); type is B612 (SIL Open Font License).';
    f.textContent = text;
    // The command line keeps its node (and Copy button) between renders; only the text is set.
    if ($('commandLine').textContent !== r.commandLine) $('commandLine').textContent = r.commandLine;
    renderCredit();
  }

  /** Copies the run's command line, falling back to a hidden textarea where the Clipboard API is unavailable. */
  function copyCommand() {
    const text = state.run ? state.run.commandLine : '';
    const btn = $('copyCommand');
    const done = ok => {
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      clearTimeout(copyCommand.timer);
      copyCommand.timer = setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      btn.focus();
      done(ok);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  }

  function render() {
    if (!state.run) return;
    readColors();
    renderHeader();
    renderTable();
    renderCharts();
    renderEvents();
    renderFooter();
  }

  // Render at most twice per second however fast ticks arrive; skip work while the tab is hidden.
  let renderQueued = false, lastRender = 0, staleWhileHidden = false;
  function scheduleRender() {
    if (document.hidden) { staleWhileHidden = true; return; }
    if (renderQueued) return;
    renderQueued = true;
    const wait = Math.max(0, 500 - (performance.now() - lastRender));
    setTimeout(() => { renderQueued = false; lastRender = performance.now(); render(); }, wait);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && staleWhileHidden) { staleWhileHidden = false; scheduleRender(); }
  });

  // ---------------------------------------------------------------- controls

  function setRange(range) {
    state.range = range;
    state.zoom = null;
    document.querySelectorAll('#rangeButtons button').forEach(b => {
      b.setAttribute('aria-pressed', String(String(range) === b.dataset.range));
    });
    $('showBand').parentElement.hidden = state.mode === 'live' && range !== 'run';
    if (range === 'run' && state.mode === 'live') fetchSeries().then(render); else render();
  }

  function initControls() {
    document.querySelectorAll('#rangeButtons button').forEach(b => {
      b.addEventListener('click', () => setRange(b.dataset.range === 'run' ? 'run' : Number(b.dataset.range)));
    });
    $('showBand').addEventListener('change', e => { state.showBand = e.target.checked; render(); });
    $('resetZoom').addEventListener('click', () => { state.zoom = null; render(); });
    $('themeToggle').addEventListener('click', () => {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      try { localStorage.setItem('stat-theme', theme); } catch (e) { /* storage unavailable */ }
      applyTheme();
    });
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    $('exportCsv').addEventListener('click', exportCsv);
    $('copyCommand').addEventListener('click', copyCommand);
  }

  // ---------------------------------------------------------------- CSV export (report)

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from treating names as formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const names = ['CPU_Percent', 'RAM_MB', 'Private_MB', 'Threads', 'Handles', 'IO_Read_BytesPerSec', 'IO_Write_BytesPerSec', 'IO_Other_BytesPerSec'];
    const keys = state.order.concat(state.series[TOTAL] && showTotal() ? [TOTAL] : []);
    const aggregated = keys.some(k => state.series[k] && state.series[k].width > 0);
    const header = ['Time', 'PID', 'Process', 'Label', 'Source', 'BucketSec', 'Samples', 'CPU_Cores'].concat(names);
    if (aggregated) names.forEach(n => header.push(n + '_Min', n + '_Max'));
    const rows = [header.join(',')];
    for (const k of keys) {
      const p = state.procs.get(k), s = state.series[k];
      if (!s || !p) continue;
      for (const pt of s.points) {
        const isBucket = pt.length > 9;
        const vals = isBucket ? pt.slice(2, 2 + METRIC_COUNT) : pt.slice(1, 1 + METRIC_COUNT);
        const row = [fmtStamp(pt[0]), p.total ? '' : p.pid, p.name, p.label || '', p.total ? 'sum of all processes' : p.source, isBucket ? s.width / 1000 : 0, isBucket ? pt[1] : 1,
          coresOf(vals[0]) == null ? '' : Math.round(coresOf(vals[0]) * 100) / 100].concat(vals);
        if (aggregated) {
          for (let m = 0; m < METRIC_COUNT; m++) {
            row.push(isBucket ? pt[2 + METRIC_COUNT + m] : vals[m], isBucket ? pt[2 + 2 * METRIC_COUNT + m] : vals[m]);
          }
        }
        rows.push(row.map(csvCell).join(','));
      }
    }
    const blob = new Blob([rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'process-monitor-' + state.run.host + '-' + fmtDate(state.run.startedAt) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------------- live mode

  function fetchSeries() {
    return fetch('api/series', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { state.series = d.series; state.seriesFetchedAt = Date.now(); })
      .catch(() => { /* keep the previous data; the station lamp shows connection problems */ });
  }

  function onTick(tick) {
    state.lastTick = tick.t;
    state.lastTickAt = Date.now();
    for (const s of tick.samples) {
      let arr = state.recent.get(s.k);
      if (!arr) state.recent.set(s.k, arr = []);
      arr.push(s.p);
    }
    const cutoff = tick.t - RECENT_KEEP_MS;
    state.recent.forEach(arr => {
      let drop = 0;
      while (drop < arr.length && arr[drop][0] < cutoff) drop++;
      if (drop) arr.splice(0, drop);
    });
    setProcesses(tick.processes);
    addEvents(tick.events);
    if (tick.endedAt) state.run.endedAt = tick.endedAt;
    if (state.range === 'run' && Date.now() - state.seriesFetchedAt > 10000) fetchSeries().then(scheduleRender);
    scheduleRender();
  }

  function connect() {
    const es = new EventSource('events');
    es.onopen = () => { state.connected = true; scheduleRender(); };
    es.onmessage = e => {
      state.connected = true;
      try { onTick(JSON.parse(e.data)); } catch (err) { console.error('stat: bad tick', err); }
      if (state.run.endedAt) es.close();
    };
    es.onerror = () => {
      state.connected = false;
      if (state.run.endedAt) es.close();
      scheduleRender();
    };
  }

  function startLive() {
    fetch('api/state', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        state.run = d.run;
        setProcesses(d.processes);
        addEvents(d.events);
        Object.keys(d.recent).forEach(k => state.recent.set(k, d.recent[k]));
        state.lastTick = d.now || Date.now();
        state.lastTickAt = Date.now();
        setRange(300000);
        connect();
        setInterval(renderClock, 1000);
      })
      .catch(() => {
        $('lamp').className = 'lamp fault';
        $('stationText').textContent = 'Cannot reach process-monitor.exe. Check that it is still running, then reload this page.';
      });
  }

  // ---------------------------------------------------------------- report mode

  function startReport(d) {
    state.mode = 'report';
    state.run = d.run;
    state.generatedAt = d.generatedAt;
    state.series = d.series;
    setProcesses(d.processes);
    addEvents(d.events);
    $('rangeButtons').hidden = true;
    $('exportCsv').hidden = false;
    state.range = 'run';
    render();
  }

  // ---------------------------------------------------------------- boot

  Chart.defaults.font.family = FONT;
  initControls();
  if (theme !== 'auto') document.documentElement.setAttribute('data-theme', theme);
  // Canvas text is measured with whatever font is ready, and Chart.js caches those widths.
  // Rebuild the charts once B612 has loaded so axis labels are sized for it.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      charts.forEach(c => c.destroy());
      charts.clear();
      if (state.run) render();
    });
  }
  $('themeToggle').textContent = 'Theme: ' + theme;
  const inline = document.getElementById('stat-data');
  if (inline) startReport(JSON.parse(inline.textContent));
  else startLive();
})();
