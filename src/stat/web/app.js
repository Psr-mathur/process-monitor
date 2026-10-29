/* stat dashboard: live view (served by stat.exe) and static report (data inlined). */
(function () {
  'use strict';

  // Metric slots, matching Store.cs: raw point = [t, ...8 values]; bucket = [t, n, avg x8, min x8, max x8].
  const M = { cpu: 0, ws: 1, priv: 2, threads: 3, handles: 4, ioR: 5, ioW: 6, ioO: 7 };
  const METRIC_COUNT = 8;
  const RECENT_KEEP_MS = 15 * 60 * 1000 + 30 * 1000;

  const CHARTS = [
    { id: 'cpu', m: M.cpu, title: 'CPU', unit: '% of total machine capacity', fmt: v => fmtPct(v) },
    { id: 'ws', m: M.ws, title: 'Working set', unit: 'physical memory in use', fmt: v => fmtMB(v) },
    { id: 'priv', m: M.priv, title: 'Private memory', unit: 'committed, not shared', fmt: v => fmtMB(v) },
    { id: 'threads', m: M.threads, title: 'Threads', unit: 'count', fmt: v => fmtInt(v) },
    { id: 'handles', m: M.handles, title: 'Handles', unit: 'count', fmt: v => fmtInt(v) },
    { id: 'ioR', m: M.ioR, title: 'I/O read', unit: 'per second, includes cached and network I/O', fmt: v => fmtRate(v) },
    { id: 'ioW', m: M.ioW, title: 'I/O write', unit: 'per second, includes cached and network I/O', fmt: v => fmtRate(v) },
    { id: 'ioO', m: M.ioO, title: 'I/O other', unit: 'per second, non read/write operations', fmt: v => fmtRate(v) },
  ];

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
    lastTick: 0,
  };

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
  function fmtDateTime(t) { return fmtDate(t) + ' ' + fmtTime(t); }
  function fmtStamp(t) { const p = partsOf(t); return fmtDate(t) + ' ' + fmtTime(t) + '.' + pad(p.ms, 3); }
  function fmtDuration(ms) {
    let s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm ' + s + 's';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }
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
  function colorFor(proc) { return proc && proc.color >= 0 ? cssVar('--series-' + (proc.color + 1)) : cssVar('--series-neutral'); }
  function withAlpha(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---------------------------------------------------------------- data

  function labelOf(p) { return p.name + ' (' + p.pid + ')'; }

  function setProcesses(list) {
    for (const p of list) {
      if (!state.procs.has(p.k)) state.order.push(p.k);
      state.procs.set(p.k, p);
    }
  }

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

  function visibleKeys() { return state.order.filter(k => !state.hidden.has(k)); }

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

  // Tooltip mode: for each visible series, the point nearest the pointer's time.
  Chart.Interaction.modes.statNearestX = function (chart, e) {
    const pos = Chart.helpers.getRelativePosition(e, chart);
    const area = chart.chartArea;
    if (!area || pos.x < area.left || pos.x > area.right || pos.y < area.top || pos.y > area.bottom) return [];
    const xVal = chart.scales.x.getValueForPixel(pos.x);
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
  };

  const crosshairPlugin = {
    id: 'statCrosshair',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx, area = chart.chartArea;
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (active && active.length && !drag) {
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = cssVar('--axis');
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke();
        ctx.restore();
      }
      if (drag && drag.chart === chart) {
        const x0 = Math.max(area.left, Math.min(drag.x0, drag.x1)), x1 = Math.min(area.right, Math.max(drag.x0, drag.x1));
        ctx.save();
        ctx.fillStyle = withAlpha(cssVar('--accent'), 0.12);
        ctx.strokeStyle = cssVar('--accent');
        ctx.fillRect(x0, area.top, x1 - x0, area.bottom - area.top);
        ctx.strokeRect(x0 + 0.5, area.top + 0.5, x1 - x0 - 1, area.bottom - area.top - 1);
        ctx.restore();
      }
    },
  };

  // Drag across any chart to zoom all charts to that time range.
  let drag = null;
  function attachZoom(chart) {
    const canvas = chart.canvas;
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const a = chart.chartArea, x = e.offsetX;
      if (x < a.left || x > a.right) return;
      drag = { chart, x0: x, x1: x };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag || drag.chart !== chart) return;
      drag.x1 = e.offsetX;
      chart.draw();
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

  function ensureChartCards() {
    const host = $('charts');
    if (host.childElementCount) return;
    for (const def of CHARTS) {
      const card = document.createElement('article');
      card.className = 'chart-card';
      card.innerHTML = '<header><h2></h2><span class="unit"></span></header><div class="chart-box"><canvas role="img"></canvas></div>';
      card.querySelector('h2').textContent = def.title;
      card.querySelector('.unit').textContent = def.unit;
      card.querySelector('canvas').id = 'chart-' + def.id;
      card.querySelector('canvas').setAttribute('aria-label', def.title + ' over time per process; values are listed in the Processes table.');
      host.appendChild(card);
    }
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.id = 'chartsEmpty';
    empty.textContent = 'Waiting for the first samples...';
    host.appendChild(empty);
  }

  function renderCharts() {
    ensureChartCards();
    const anyData = state.order.some(k => (state.procs.get(k) || {}).n > 0);
    $('chartsEmpty').hidden = anyData;
    document.querySelectorAll('.chart-card').forEach(c => { c.hidden = !anyData; });
    if (!anyData) return;

    const ext = xExtent();
    const span = ext.max - ext.min;
    const grid = cssVar('--grid'), axis = cssVar('--axis'), muted = cssVar('--muted'), text = cssVar('--text');
    const surface = cssVar('--surface'), alpha = parseFloat(cssVar('--band-alpha')) || 0.18;
    const keys = visibleKeys();
    let aggregatedAny = false;

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
            backgroundColor: withAlpha(color, alpha) });
        }
        datasets.push({
          key: k, label: labelOf(proc), data: pts.line,
          borderColor: color, backgroundColor: color, borderWidth: 2,
          pointRadius: pts.line.length <= 2 ? 3 : 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: color, pointHoverBorderColor: surface, pointHoverBorderWidth: 2,
          spanGaps: false, tension: 0, fill: false,
        });
      }

      let chart = charts.get(def.id);
      if (!chart) {
        chart = new Chart($('chart-' + def.id), {
          type: 'line',
          data: { datasets },
          plugins: [crosshairPlugin],
          options: {
            parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'statNearestX', intersect: false },
            scales: {
              x: { type: 'linear', afterBuildTicks: timeTicks, grid: { color: grid }, border: { color: axis }, ticks: { color: muted, maxRotation: 0, autoSkip: false, font: { size: 11 } } },
              y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, maxTicksLimit: 6, font: { size: 11 }, callback: v => axisLabel(def.fmt, v) } },
            },
            plugins: {
              legend: {
                position: 'top', align: 'start',
                labels: { color: text, usePointStyle: true, pointStyle: 'line', boxWidth: 18, font: { size: 11.5 }, filter: (item, data) => !data.datasets[item.datasetIndex].band },
                onClick: (e, item, legend) => { toggleProcess(legend.chart.data.datasets[item.datasetIndex].key); },
              },
              tooltip: {
                backgroundColor: surface, titleColor: muted, bodyColor: text, borderColor: axis, borderWidth: 1,
                padding: 10, boxWidth: 14, boxHeight: 2, usePointStyle: false, titleFont: { weight: 'normal', size: 11.5 }, bodyFont: { size: 12 },
                callbacks: {
                  title: items => items.length ? fmtStamp(items[0].raw.x).slice(0, 19) : '',
                  label: item => tooltipLabel(def, item),
                  labelColor: item => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor, borderWidth: 0 }),
                },
              },
            },
          },
        });
        attachZoom(chart);
        charts.set(def.id, chart);
      } else {
        chart.data.datasets = datasets;
      }
      chart.options.scales.x.min = ext.min;
      chart.options.scales.x.max = ext.max;
      chart.options.scales.x.ticks.callback = tickFormatter(span);
      chart.options.plugins.legend.display = keys.length > 1;
      chart.update('none');
    }

    const note = [];
    if (aggregatedAny) note.push('Long run: points are averages over time buckets' + (state.showBand ? '; the shaded band is the min-max range.' : '.'));
    note.push('Drag across a chart to zoom' + (state.zoom ? ', double-click to reset.' : '.'));
    $('viewNote').textContent = note.join(' ');
    $('resetZoom').hidden = !state.zoom;
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

  // ---------------------------------------------------------------- header, cards, table, events

  function renderHeader() {
    const r = state.run;
    const pill = $('status');
    if (state.mode === 'report') { pill.className = 'pill stopped'; pill.textContent = 'Report'; }
    else if (r.endedAt) { pill.className = 'pill stopped'; pill.textContent = 'Stopped'; }
    else if (state.connected) { pill.className = 'pill live'; pill.textContent = 'Live'; }
    else { pill.className = 'pill warn'; pill.textContent = 'Reconnecting'; }

    const meta = $('runMeta');
    meta.textContent = '';
    const add = (label, value) => {
      if (meta.childNodes.length) meta.appendChild(document.createTextNode('  ·  '));
      meta.appendChild(document.createTextNode(label + ' '));
      const b = document.createElement('b'); b.textContent = value; meta.appendChild(b);
    };
    add('Host', r.host);
    add('Cores', r.cores);
    add('Interval', r.interval + ' s');
    add('Started', fmtDateTime(r.startedAt) + ' ' + utcLabel());
    if (r.endedAt) add('Ended', fmtDateTime(r.endedAt));
    if (!r.admin) add('Admin', 'no');
  }

  function renderCards() {
    const r = state.run;
    const procs = state.order.map(k => state.procs.get(k));
    const end = r.endedAt || state.lastTick || Date.now();
    const sampled = procs.filter(p => p.n > 0);
    const peak = (field) => sampled.reduce((best, p) => (p[field] != null && (!best || p[field] > best[field]) ? p : best), null);
    const pc = peak('cpuMax'), pw = peak('wsMax'), pp = peak('privMax');
    const readTotal = procs.reduce((s, p) => s + (p.ioReadTotal || 0), 0);
    const writeTotal = procs.reduce((s, p) => s + (p.ioWriteTotal || 0), 0);
    const running = procs.filter(p => p.status === 'running').length;

    const cards = [
      ['Duration', fmtDuration(end - r.startedAt), r.endedAt ? 'monitoring finished' : 'monitoring'],
      ['Processes', running + (r.endedAt ? ' running at end' : ' running'), procs.length + ' seen in total'],
      ['Peak CPU', pc ? fmtPct(pc.cpuMax) : '-', pc ? fmtCores(coresOf(pc.cpuMax)) + ' cores · ' + labelOf(pc) : ''],
      ['Peak working set', pw ? fmtMB(pw.wsMax) : '-', pw ? labelOf(pw) : ''],
      ['Peak private memory', pp ? fmtMB(pp.privMax) : '-', pp ? labelOf(pp) : ''],
      ['I/O read', fmtBytes(readTotal), fmtBytes(writeTotal) + ' written, all processes'],
    ];
    const host = $('cards');
    if (host.childElementCount !== cards.length) {
      host.textContent = '';
      for (let i = 0; i < cards.length; i++) {
        const c = document.createElement('div');
        c.className = 'card';
        c.innerHTML = '<div class="label"></div><div class="value"></div><div class="sub"></div>';
        host.appendChild(c);
      }
    }
    cards.forEach((card, i) => {
      const el = host.children[i];
      el.querySelector('.label').textContent = card[0];
      el.querySelector('.value').textContent = card[1];
      el.querySelector('.sub').textContent = card[2];
      el.querySelector('.sub').title = card[2];
    });
  }

  const STATUS_TEXT = { running: 'Running', exited: 'Exited', 'not-listening': 'Stopped listening', unavailable: 'Unavailable' };

  function renderTable() {
    const tbody = document.querySelector('#procTable tbody');
    $('procEmpty').hidden = state.order.length > 0;
    for (const k of state.order) {
      const p = state.procs.get(k);
      let tr = tbody.querySelector('tr[data-key="' + CSS.escape(k) + '"]');
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.key = k;
        for (let i = 0; i < 17; i++) tr.appendChild(document.createElement('td'));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => toggleProcess(k));
        const key = document.createElement('label');
        key.className = 'key';
        const sw = document.createElement('span');
        sw.className = 'swatch';
        key.append(cb, sw);
        tr.children[0].appendChild(key);
        [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].forEach(i => tr.children[i].classList.add('num'));
        tbody.appendChild(tr);
      }
      const c = tr.children;
      const shown = !state.hidden.has(k);
      tr.classList.toggle('hidden-series', !shown);
      const cb = c[0].querySelector('input');
      cb.checked = shown;
      cb.setAttribute('aria-label', 'Show ' + labelOf(p) + ' in charts');
      c[0].querySelector('.swatch').style.background = colorFor(p);
      c[1].textContent = p.name;
      c[2].textContent = p.pid;
      c[3].textContent = p.source;
      c[4].innerHTML = '';
      const st = document.createElement('span');
      st.className = 'status ' + p.status;
      st.textContent = p.status === 'running' && state.run.endedAt ? 'Running at end' : (STATUS_TEXT[p.status] || p.status);
      if (p.endedAt) st.title = 'at ' + fmtDateTime(p.endedAt);
      c[4].appendChild(st);
      const has = p.n > 0;
      c[5].textContent = num(p.n, 0);
      c[6].textContent = has ? fmtPct(p.cpuAvg) : '-';
      c[7].textContent = has ? fmtPct(p.cpuP95) : '-';
      c[8].textContent = has ? fmtPct(p.cpuMax) : '-';
      c[9].textContent = has ? fmtCores(coresOf(p.cpuMax)) : '-';
      c[10].textContent = has ? fmtMB(p.wsLast) + ' / ' + fmtMB(p.wsMax) : '-';
      c[11].textContent = has ? fmtMB(p.privFirst) + ' → ' + fmtMB(p.privLast) : '-';
      c[12].textContent = has ? fmtMB(p.privMax) : '-';
      c[13].textContent = has ? fmtInt(p.threadsMax) : '-';
      c[14].textContent = has ? fmtInt(p.handlesMax) : '-';
      c[15].textContent = fmtBytes(p.ioReadTotal);
      c[16].textContent = fmtBytes(p.ioWriteTotal);
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
      const time = document.createElement('time');
      time.textContent = fmtDateTime(e.t);
      const lvl = document.createElement('span');
      lvl.className = 'lvl ' + e.level;
      lvl.textContent = e.level === 'warn' ? '! Warning' : 'Info';
      const msg = document.createElement('span');
      msg.textContent = e.msg;
      li.append(time, lvl, msg);
      list.appendChild(li);
    }
    let count = state.events.length + ' event' + (state.events.length === 1 ? '' : 's');
    if (state.events.length > shown.length) count += ', newest ' + shown.length + ' shown';
    $('eventCount').textContent = count + ', newest first';
  }

  function renderFooter() {
    const f = $('footer');
    f.textContent = '';
    let text = 'Generated by stat ' + state.run.version;
    if (state.mode === 'report' && state.generatedAt) text += ' on ' + fmtDateTime(state.generatedAt) + ' ' + utcLabel();
    text += '. ' + state.run.host + ' runs ' + state.run.os + '. Command: ' + state.run.commandLine + '. Charts by Chart.js (MIT licence).';
    f.textContent = text;
  }

  function render() {
    if (!state.run) return;
    renderHeader();
    renderCards();
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
  }

  // ---------------------------------------------------------------- CSV export (report)

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from treating names as formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const names = ['CPU_Percent', 'RAM_MB', 'Private_MB', 'Threads', 'Handles', 'IO_Read_BytesPerSec', 'IO_Write_BytesPerSec', 'IO_Other_BytesPerSec'];
    const aggregated = state.order.some(k => state.series[k] && state.series[k].width > 0);
    const header = ['Time', 'PID', 'Process', 'Source', 'BucketSec', 'Samples', 'CPU_Cores'].concat(names);
    if (aggregated) names.forEach(n => header.push(n + '_Min', n + '_Max'));
    const rows = [header.join(',')];
    for (const k of state.order) {
      const p = state.procs.get(k), s = state.series[k];
      if (!s) continue;
      for (const pt of s.points) {
        const isBucket = pt.length > 9;
        const vals = isBucket ? pt.slice(2, 2 + METRIC_COUNT) : pt.slice(1, 1 + METRIC_COUNT);
        const row = [fmtStamp(pt[0]), p.pid, p.name, p.source, isBucket ? s.width / 1000 : 0, isBucket ? pt[1] : 1,
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
    a.download = 'stat-' + state.run.host + '-' + fmtDate(state.run.startedAt) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------------- live mode

  function fetchSeries() {
    return fetch('api/series', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { state.series = d.series; state.seriesFetchedAt = Date.now(); })
      .catch(() => { /* keep the previous data; the status pill shows connection problems */ });
  }

  function onTick(tick) {
    state.lastTick = tick.t;
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
        state.lastTick = Date.now();
        setRange(300000);
        connect();
      })
      .catch(err => {
        $('runMeta').textContent = 'Could not reach stat.exe: ' + err.message;
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

  initControls();
  if (theme !== 'auto') document.documentElement.setAttribute('data-theme', theme);
  $('themeToggle').textContent = 'Theme: ' + theme;
  const inline = document.getElementById('stat-data');
  if (inline) startReport(JSON.parse(inline.textContent));
  else startLive();
})();
