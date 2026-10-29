/**
 * Comment Period Timer — the whole client.
 *
 * Four things and nothing else: a countdown to the comment deadline, the total
 * number of filed comments with the support/oppose/can't-tell split, a line
 * chart of that split over time, and a donut tied to a timeline dragger.
 *
 * Data comes from ./data/summary.json and ./data/history.json, both rewritten
 * by the sync workflow every six hours.
 */

                                                  

                          
                 
                       
                        
                                  
                                 
                                           
 

                        
            
                  
                 
                   
                
 

const FALLBACK_DEADLINE_ISO = '2026-11-11T04:59:59Z';
const DEADLINE_TIME_ZONE = 'America/New_York';

// Which docket this page shows; set on <body data-docket="…">.
const DOCKET_SLUG = document.body.dataset.docket || 'h1b';
// Pages live at the root or one directory down; data/ is always at the root.
const PAGE_BASE = document.body.dataset.base || './';
const DATA_BASE = `${PAGE_BASE}data/${DOCKET_SLUG}`;

let historyPoints                 = [];
let allPoints                 = [];
const tagSeries = new Map                        ();
let activeTag = 'all';
let historySource                           = 'snapshots';
let selectedIndex = 0;
let chartMode                  = 'pct';
let timerHandle                    ;

function byId                       (id        )           {
  return document.getElementById(id)            ;
}

function pad(value        )         {
  return String(value).padStart(2, '0');
}

function formatCount(value        )         {
  return value.toLocaleString('en-US');
}

function formatInEastern(iso                    , style                                                            )         {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  if (style === 'day') {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: DEADLINE_TIME_ZONE });
  }

  if (style === 'long') {
    // Build from parts rather than splitting one formatted string: Safari
    // renders "Nov 10, 2026 at 11:59 PM EST", where splitting on ", " yields
    // two elements and a literal "undefined" in the third.
    const day = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: DEADLINE_TIME_ZONE
    });
    const time = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEADLINE_TIME_ZONE,
      timeZoneName: 'short'
    });
    return `${day}, ${time}`;
  }

  if (style === 'short') {
    return date.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEADLINE_TIME_ZONE,
      timeZoneName: 'short'
    });
  }

  if (style === 'deadline') {
    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEADLINE_TIME_ZONE,
      timeZoneName: 'short'
    });
  }

  const base = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DEADLINE_TIME_ZONE
  });

  return style === 'synced' ? `${base} ET` : `${base} ET`;
}

function formatUtcDate(iso        , withYear         )         {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC'
  });
}

/**
 * Comment dates arrive at day granularity (midnight UTC), so they are shown as
 * a calendar date in UTC — formatting them in Eastern would slip a day back.
 * Snapshot points carry a real instant and keep the Eastern rendering.
 */
function historyDateLabel(iso        , withYear         )         {
  return historySource === 'comments'
    ? formatUtcDate(iso, withYear)
    : formatInEastern(iso, withYear ? 'point' : 'day');
}

function setText(id        , text        )       {
  const element = byId             (id);
  if (element) element.textContent = text;
}

/* — countdown — */

                    
                   
                      
                    
                
 

const FLIP_UNITS                          = [
  ['d', 'd'],
  ['h', 'h'],
  ['m', 'm'],
  ['s', 's']
];

const flipUnits = new Map                  ();

function buildFlipClock()       {
  const root = byId             ('countdown');
  if (!root || flipUnits.size > 0) return;
  root.textContent = '';

  for (const [key, label] of FLIP_UNITS) {
    const wrap = document.createElement('div');
    wrap.className = 'flip';
    wrap.innerHTML =
      '<div class="flip-card">' +
      '<div class="half top"><span class="v">—</span></div>' +
      '<div class="half bottom"><span class="v">—</span></div>' +
      '<div class="flap"><span class="v"></span></div>' +
      '</div>' +
      `<span class="flip-label">${label}</span>`;
    root.appendChild(wrap);

    flipUnits.set(key, {
      top: wrap.querySelector             ('.half.top .v') ,
      bottom: wrap.querySelector             ('.half.bottom .v') ,
      flap: wrap.querySelector             ('.flap') ,
      value: ''
    });
  }
}

function setFlip(key        , next        )       {
  const unit = flipUnits.get(key);
  if (!unit || unit.value === next) return;

  // First paint should not animate.
  if (unit.value === '') {
    unit.top.textContent = next;
    unit.bottom.textContent = next;
    unit.value = next;
    return;
  }

  const flapText = unit.flap.querySelector             ('.v');
  if (flapText) flapText.textContent = unit.value;
  unit.top.textContent = next;

  unit.flap.classList.remove('is-flipping');
  void unit.flap.offsetWidth;
  unit.flap.classList.add('is-flipping');

  window.setTimeout(() => {
    unit.bottom.textContent = next;
    unit.flap.classList.remove('is-flipping');
  }, 320);

  unit.value = next;
}

function tick(deadlineMs        )       {
  const root = byId             ('countdown');
  if (!root) return;

  const remaining = deadlineMs - Date.now();

  if (remaining <= 0) {
    root.classList.add('is-closed');
    root.textContent = 'Comment period closed';
    root.removeAttribute('role');
    if (timerHandle !== undefined) window.clearInterval(timerHandle);
    timerHandle = undefined;
    return;
  }

  const totalSeconds = Math.floor(remaining / 1000);
  const values                         = {
    d: formatCount(Math.floor(totalSeconds / 86400)),
    h: pad(Math.floor((totalSeconds % 86400) / 3600)),
    m: pad(Math.floor((totalSeconds % 3600) / 60)),
    s: pad(totalSeconds % 60)
  };

  for (const key of ['d', 'h', 'm', 's']) {
    setFlip(key, values[key]);
  }
}

function startTimer(deadlineMs        )       {
  if (timerHandle !== undefined) window.clearInterval(timerHandle);
  tick(deadlineMs);
  timerHandle = window.setInterval(() => tick(deadlineMs), 1000);
}

/* — the count — */

function renderCounts(summary                )       {
  const counts = summary.counts || {};
  const support = counts.Support || 0;
  const oppose = counts.Oppose || 0;
  const cantTell = counts["Can't tell"] || 0;
  const total =
    summary.totalPublishedOnDocket || summary.totalIndexedInTracker || support + oppose + cantTell;

  if (total <= 0) return;

  setText('n-total', formatCount(total));
  setText('n-support', formatCount(support));
  setText('n-oppose', formatCount(oppose));
  setText('n-cant', formatCount(cantTell));

  const share = (value        )         => (value / total) * 100;

  // Let the browser paint the zero-width bar first so the fill animates in.
  window.requestAnimationFrame(() => {
    const setWidth = (id        , percent        )       => {
      const element = byId             (id);
      if (element) element.style.width = `${percent.toFixed(3)}%`;
    };
    setWidth('bar-support', share(support));
    setWidth('bar-oppose', share(oppose));
    setWidth('bar-cant', share(cantTell));
  });

  const bar = byId             ('bar');
  if (bar) {
    bar.setAttribute(
      'aria-label',
      `Of ${formatCount(total)} comments: ${formatCount(support)} support, ` +
        `${formatCount(oppose)} oppose, ${formatCount(cantTell)} can't tell.`
    );
  }
}

/* — history: line chart — */

function niceCeil(value        )         {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const step = steps.find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

function setChartChromeVisible(visible         )       {
  const cap = byId             ('chart-cap');
  if (cap) cap.hidden = !visible;
  const toggle = byId             ('chart-toggle');
  if (toggle) toggle.hidden = !visible;
}

function renderLineChart()       {
  const host = byId             ('line-chart');
  if (!host) return;

  setChartChromeVisible(historyPoints.length > 1);

  if (historyPoints.length === 0) {
    host.classList.add('is-empty');
    host.innerHTML = '';
    return;
  }

  // A single observation is not a line. Say so plainly instead of drawing
  // three floating dots that look like a broken chart.
  if (historyPoints.length === 1) {
    host.classList.add('is-empty');
    host.innerHTML =
      `<p class="chart-empty">No history yet. The first snapshot was recorded ` +
      `${formatInEastern(historyPoints[0].t, 'point')}, and a new point is added every six hours.</p>`;
    host.setAttribute('aria-label', 'No history yet; one snapshot recorded.');
    return;
  }

  host.classList.remove('is-empty');

  const width = Math.max(260, Math.round(host.clientWidth || 320));
  const height = Math.round(host.clientHeight || 190);
  const padL = 38;
  const padR = 10;
  const padT = 10;
  const padB = 20;
  const innerW = Math.max(1, width - padL - padR);
  const innerH = Math.max(1, height - padT - padB);

  const count = historyPoints.length;
  const firstAt = new Date(historyPoints[0].t).getTime();
  const lastAt = new Date(historyPoints[count - 1].t).getTime();
  const span = Math.max(1, lastAt - firstAt);

  const pctMode = chartMode === 'pct';
  const peak = Math.max(
    ...historyPoints.map((p) => Math.max(p.support, p.oppose, p.cantTell)),
    1
  );
  const yMax = pctMode ? 100 : niceCeil(peak);

  const xOf = (time        )         => {
    if (count === 1) return padL + innerW / 2;
    return padL + ((time - firstAt) / span) * innerW;
  };

  const yOf = (value        )         => padT + innerH - (value / yMax) * innerH;

  const valueOf = (point              , key                                   )         => {
    const raw = point[key];
    if (!pctMode) return raw;
    return point.total > 0 ? (raw / point.total) * 100 : 0;
  };

  const parts           = [];
  parts.push(
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="presentation" focusable="false">`
  );

  for (const fraction of [0, 0.5, 1]) {
    const y = padT + innerH * fraction;
    const value = yMax * (1 - fraction);
    const label = pctMode ? `${Math.round(value)}%` : formatCount(Math.round(value));
    parts.push(
      `<line class="grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${(width - padR).toFixed(1)}" y2="${y.toFixed(1)}" />`
    );
    parts.push(
      `<text class="tick" x="${(padL - 9).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${label}</text>`
    );
  }

  const series                                                                 = [
    { key: 'support', cls: 's-support' },
    { key: 'oppose', cls: 's-oppose' },
    { key: 'cantTell', cls: 's-cant' }
  ];

  if (count > 1 && historyPoints[selectedIndex]) {
    const markerX = xOf(new Date(historyPoints[selectedIndex].t).getTime());
    parts.push(
      `<line class="marker" x1="${markerX.toFixed(1)}" y1="${padT}" x2="${markerX.toFixed(1)}" y2="${(padT + innerH).toFixed(1)}" />`
    );
  }

  for (const item of series) {
    const coords = historyPoints.map((point) => {
      const time = new Date(point.t).getTime();
      return `${xOf(time).toFixed(1)},${yOf(valueOf(point, item.key)).toFixed(1)}`;
    });

    if (count > 1) {
      parts.push(`<polyline class="line ${item.cls}" points="${coords.join(' ')}" />`);
    }

    const terminal = coords[coords.length - 1].split(',');
    parts.push(
      `<circle class="point ${item.cls}" cx="${terminal[0]}" cy="${terminal[1]}" r="${count > 1 ? 2.6 : 3.4}" />`
    );

    if (count > 1 && selectedIndex !== count - 1) {
      const selected = historyPoints[selectedIndex];
      const sx = xOf(new Date(selected.t).getTime()).toFixed(1);
      const sy = yOf(valueOf(selected, item.key)).toFixed(1);
      parts.push(`<circle class="point ${item.cls}" cx="${sx}" cy="${sy}" r="3" />`);
    }
  }

  const labelY = height - 4;
  if (count === 1) {
    parts.push(
      `<text class="tick" x="${(padL + innerW / 2).toFixed(1)}" y="${labelY}" text-anchor="middle">${historyDateLabel(historyPoints[0].t, false)}</text>`
    );
  } else {
    parts.push(
      `<text class="tick" x="${padL}" y="${labelY}" text-anchor="start">${historyDateLabel(historyPoints[0].t, false)}</text>`
    );
    parts.push(
      `<text class="tick" x="${(width - padR).toFixed(1)}" y="${labelY}" text-anchor="end">${historyDateLabel(historyPoints[count - 1].t, false)}</text>`
    );
  }

  parts.push('</svg>');
  host.innerHTML = parts.join('');
  host.setAttribute(
    'aria-label',
    `Support and oppose share of comments over ${count} snapshots. Latest: ` +
      `${formatCount(historyPoints[count - 1].support)} support, ` +
      `${formatCount(historyPoints[count - 1].oppose)} oppose.`
  );
}

/* — history: donut + timeline — */

function renderDonut(point              )       {
  const host = byId             ('donut');
  if (!host) return;

  const size = 132;
  const radius = 52;
  const thickness = 11;
  const circumference = 2 * Math.PI * radius;
  const total = point.total || 1;

  const arcs = [
    { value: point.support, cls: 's-support' },
    { value: point.oppose, cls: 's-oppose' },
    { value: point.cantTell, cls: 's-cant' }
  ];

  let offset = 0;
  const slices = arcs.map((arc) => {
    const length = (arc.value / total) * circumference;
    const slice =
      `<circle class="arc ${arc.cls}" cx="${size / 2}" cy="${size / 2}" r="${radius}" ` +
      `stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" ` +
      `stroke-dashoffset="${(-offset).toFixed(2)}" ` +
      `transform="rotate(-90 ${size / 2} ${size / 2})" />`;
    offset += length;
    return slice;
  });

  host.innerHTML =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<circle class="arc-track" cx="${size / 2}" cy="${size / 2}" r="${radius}" />` +
    slices.join('') +
    `<text class="num" x="${size / 2}" y="${size / 2 + 2}" text-anchor="middle">${formatCount(point.total)}</text>` +
    `<text class="sub" x="${size / 2}" y="${size / 2 + 15}" text-anchor="middle">comments</text>` +
    `</svg>`;

  host.setAttribute(
    'aria-label',
    `${formatCount(point.support)} support, ${formatCount(point.oppose)} oppose, ` +
      `${formatCount(point.cantTell)} can't tell, as of ${formatInEastern(point.t, 'point')}.`
  );
}

function renderDonutLegend(point              )       {
  const host = byId             ('donut-legend');
  if (!host) return;

  const total = point.total || 1;
  const rows = [
    { label: 'Support', value: point.support, cls: 'dot-support' },
    { label: 'Oppose', value: point.oppose, cls: 'dot-oppose' },
    { label: "Can't tell", value: point.cantTell, cls: 'dot-cant' }
  ];

  host.innerHTML = rows
    .map(
      (row) =>
        `<div class="row">` +
        `<dt><i class="dot ${row.cls}"></i>${row.label}</dt>` +
        `<dd>${formatCount(row.value)}<span class="pct">${((row.value / total) * 100).toFixed(1)}%</span></dd>` +
        `</div>`
    )
    .join('');
}

function updateTimelineLabel()       {
  const label = byId             ('timeline-range');
  if (!label) return;

  const count = historyPoints.length;
  if (count === 0) {
    label.textContent = '—';
    return;
  }

  const point = historyPoints[selectedIndex];
  label.textContent =
    count === 1
      ? '1 snapshot'
      : `${selectedIndex + 1} / ${count} · ${historyDateLabel(point.t, false)}`;
}

function updateShareBlock()       {
  const point = historyPoints[selectedIndex];
  if (!point) return;

  renderDonut(point);
  renderDonutLegend(point);
  setText('donut-date', historyDateLabel(point.t, true));
  updateTimelineLabel();
}

function renderHistoryStatus()       {
  const element = byId             ('history-status');
  if (!element) return;

  const count = historyPoints.length;
  if (count < 2) {
    element.textContent = '';
    return;
  }

  const basis =
    historySource === 'comments' ? `${count} days · by posted date` : `${count} snapshots · every six hours`;
  element.textContent = activeTag === 'all' ? basis : `${activeTag} · ${basis}`;
}

/* — wiring — */

function syncTimelineBounds()       {
  const slider = byId                  ('timeline');
  if (!slider) return;

  slider.max = String(Math.max(0, historyPoints.length - 1));
  slider.value = String(selectedIndex);
  slider.disabled = historyPoints.length < 2;

  const row = slider.closest('.slider-row');
  if (row instanceof HTMLElement) row.hidden = historyPoints.length < 2;
}

function wireTagFilter(tags             )       {
  const select = byId                   ('tag-select');
  if (!select || tags.length === 0) return;

  select.innerHTML =
    '<option value="all">All comments</option>' +
    tags
      .map((tag) => `<option value="${tag.id}">${tag.id} · ${formatCount(tag.count)}</option>`)
      .join('');
  select.hidden = false;

  select.addEventListener('change', () => {
    activeTag = select.value;
    historyPoints = activeTag === 'all' ? allPoints : tagSeries.get(activeTag) ?? allPoints;
    selectedIndex = Math.max(0, historyPoints.length - 1);
    renderLineChart();
    renderHistoryStatus();
    updateShareBlock();
    syncTimelineBounds();
  });
}

function wireTimeline()       {
  const slider = byId                  ('timeline');
  if (!slider) return;
  syncTimelineBounds();

  slider.addEventListener('input', () => {
    const next = Number(slider.value);
    const bounded = Number.isFinite(next) ? Math.min(historyPoints.length - 1, Math.max(0, next)) : 0;
    selectedIndex = bounded;
    updateShareBlock();
    renderLineChart();
  });
}

function wireChartToggle()       {
  const buttons = document.querySelectorAll                   ('.toggle-btn[data-mode]');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      chartMode = button.dataset.mode === 'count' ? 'count' : 'pct';
      buttons.forEach((peer) => {
        const active = peer === button;
        peer.classList.toggle('is-active', active);
        peer.setAttribute('aria-pressed', String(active));
      });
      renderLineChart();
    });
  });
}

function observeChartResize()       {
  const host = byId             ('line-chart');
  if (!host || typeof ResizeObserver === 'undefined') return;

  let frame = 0;
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => renderLineChart());
  });
  observer.observe(host);
}

/* — data — */

async function loadSummary()                          {
  try {
    const response = await fetch(`${DATA_BASE}/summary.json`, { cache: 'no-store' });
    if (!response.ok) return {};
    return (await response.json())                  ;
  } catch (error) {
    console.warn('Comment snapshot unavailable; showing an empty page.', error);
    return {};
  }
}

                     
             
                
                         
 

async function loadHistory(
  summary                
)                                                                                           {
  try {
    const response = await fetch(`${DATA_BASE}/history.json`, { cache: 'no-store' });
    if (response.ok) {
      const data = (await response.json())     
                                          
                                
                           
       ;
      const points = (data.points || [])
        .filter((point) => point && typeof point.t === 'string')
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
      if (points.length > 0) {
        return {
          points,
          source: data.source === 'comments' ? 'comments' : 'snapshots',
          tags: Array.isArray(data.tags) ? data.tags : []
        };
      }
    }
  } catch (error) {
    console.warn('History snapshot unavailable.', error);
  }

  // Before the first history write, fall back to the single current snapshot.
  const counts = summary.counts || {};
  const total = summary.totalPublishedOnDocket || summary.totalIndexedInTracker || 0;
  if (total <= 0) return { points: [], source: 'snapshots', tags: [] };

  return {
    points: [
      {
        t: summary.lastSyncedAt || new Date().toISOString(),
        support: counts.Support || 0,
        oppose: counts.Oppose || 0,
        cantTell: counts["Can't tell"] || 0,
        total
      }
    ],
    source: 'snapshots',
    tags: []
  };
}

async function init()                {
  buildFlipClock();
  startTimer(new Date(FALLBACK_DEADLINE_ISO).getTime());

  const summary = await loadSummary();

  if (summary.deadlineIso) {
    const deadlineMs = new Date(summary.deadlineIso).getTime();
    if (!Number.isNaN(deadlineMs)) {
      startTimer(deadlineMs);
      const deadline = byId                 ('deadline');
      if (deadline) {
        deadline.dateTime = new Date(deadlineMs).toISOString();
        deadline.textContent = formatInEastern(summary.deadlineIso, 'long');
      }
    }
  }

  renderCounts(summary);
  if (summary.model) setText('model-name', summary.model);
  setText('synced', formatInEastern(summary.lastSyncedAt, 'synced'));

  const history = await loadHistory(summary);
  allPoints = history.points;
  for (const tag of history.tags) tagSeries.set(tag.id, tag.points);
  historyPoints = allPoints;
  historySource = history.source;
  selectedIndex = Math.max(0, historyPoints.length - 1);

  renderLineChart();
  renderHistoryStatus();
  updateShareBlock();
  const methodDialog = byId                   ('method-dialog');
  byId             ('open-method')?.addEventListener('click', () => methodDialog?.showModal());
  methodDialog?.addEventListener('click', (event) => {
    if (event.target === methodDialog) methodDialog.close();
  });

  wireTimeline();
  wireTagFilter(history.tags);
  wireChartToggle();
  observeChartResize();

  // setInterval is throttled in background tabs, so re-sync the digits on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && timerHandle !== undefined) {
      tick(new Date(summary.deadlineIso || FALLBACK_DEADLINE_ISO).getTime());
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  void init();
});
