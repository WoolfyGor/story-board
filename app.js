/* Хроники мира — интерактивный таймлайн
 * События читаются из events.json при каждой загрузке страницы.
 * Начало и конец шкалы — год первого и последнего события в файле.
 */
(() => {
  'use strict';

  /* ================= настройки ================= */
  const DATA_URL = 'events.json';
  const MAX_PPY = 160;            // максимум пикселей на год
  const BASE_GAP = 38;            // отступ карточек от оси
  const GAP_X = 16, GAP_Y = 12;   // зазоры между карточками
  const ANCHOR = 22;              // где коннектор входит в карточку (px от левого края)
  const CLUSTER_FILL = 0.9;       // какую долю высоты экрана может занять стопка карточек до объединения в группу
  const STEPS = [1, 5, 10, 25, 50, 100, 250, 500];
  const MINOR = {1: 0, 5: 1, 10: 1, 25: 5, 50: 10, 100: 25, 250: 50, 500: 100};
  const TICK_MIN_PX = 72;         // минимальное расстояние между подписями линейки

  /* ================= элементы ================= */
  const $ = id => document.getElementById(id);
  const vp = $('viewport'), world = $('world'), axisEl = $('axis'), statusEl = $('status');
  const ruler = $('ruler'), evline = $('evline'), evDots = $('evDots'), evWin = $('evWin'), tip = $('tip');

  /* ================= состояние ================= */
  let S = 0, E = 1, SPAN = 1, PAD = 2;
  let events = [];      // {year, title, description, link, open, h, headH, bodyH, el, conn, node, idx}
  let yearNodes = [];   // {year, el, label, dot, events}
  const clusters = new Map(); // key -> {el, conn, span, h, items}
  const view = {start: 0, ppy: 2, panY: 0};
  let W = 0, H = 0, CW = 250;
  let layoutPPY = -1, layoutDirty = true;
  let extTop = 0, extBot = 0;
  let current = -1;
  let tween = null, raf = 0;

  /* ================= загрузка ================= */
  async function load() {
    let json;
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now(), {cache: 'no-store'});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
    } catch (err) {
      showStatus('Не удалось загрузить летопись',
        'Файл <code>events.json</code> должен лежать рядом с <code>index.html</code> и <code>app.js</code>. ' +
        'Если страница открыта двойным щелчком (file://), браузер блокирует чтение файла — ' +
        'запустите локальный сервер, например <code>npx serve</code> или <code>python -m http.server</code>.' +
        '<br><br><code>' + escapeHtml(String(err.message || err)) + '</code>');
      return;
    }
    build(json);
  }

  function showStatus(title, html) {
    statusEl.innerHTML = `<div class="box"><h2>${title}</h2>${html}</div>`;
  }
  const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  function build(json) {
    if (json.title) { $('title').textContent = json.title; document.title = json.title + ' — таймлайн'; }
    if (json.subtitle) $('subtitle').textContent = json.subtitle;
    const yearsObj = json.years || json;
    const keys = Object.keys(yearsObj).filter(k => /^-?\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    if (!keys.length) { showStatus('Летопись пуста', 'В <code>events.json</code> нет ни одного года с событиями.'); return; }
    statusEl.remove();

    // границы шкалы — первое и последнее событие
    S = keys[0]; E = keys[keys.length - 1];
    SPAN = Math.max(1, E - S);
    PAD = Math.max(2, SPAN * 0.04);
    $('evStart').textContent = S;
    $('evEnd').textContent = E;
    if (E === S) $('evEnd').style.display = 'none';

    for (const y of keys) {
      const list = (Array.isArray(yearsObj[y]) ? yearsObj[y] : [yearsObj[y]]).filter(Boolean);
      if (!list.length) continue;
      const node = {year: y, events: []};
      node.el = document.createElement('div'); node.el.className = 'node';
      node.el.innerHTML = '<i></i><b></b>';
      node.label = node.el.querySelector('b');
      node.label.textContent = list.length > 1 ? `${y} · ${list.length}` : String(y);
      world.appendChild(node.el);
      yearNodes.push(node);

      for (const raw of list) {
        const ev = {year: y, title: raw.title || 'Без названия', description: raw.description || '', link: raw.link || '', open: false, node, idx: events.length};
        ev.conn = document.createElement('div'); ev.conn.className = 'conn';
        ev.el = makeCard(ev);
        world.appendChild(ev.conn);
        world.appendChild(ev.el);
        node.events.push(ev);
        events.push(ev);
      }
      node.dot = makeDot(node);
    }
    resize();
    fitAll(false);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); schedule(); });
  }

  /* ================= карточки ================= */
  function makeCard(ev) {
    const el = document.createElement('article');
    el.className = 'card';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-expanded', 'false');
    el.innerHTML =
      '<div class="frame"><div class="head"><span class="c-year"></span><h3></h3><span class="chev"></span></div>' +
      '<div class="body"><div class="inner"><div class="pad"></div></div></div></div>';
    el.querySelector('.c-year').textContent = ev.year + ' г.';
    el.querySelector('h3').textContent = ev.title;
    const pad = el.querySelector('.pad');
    if (ev.description) { const p = document.createElement('p'); p.textContent = ev.description; pad.appendChild(p); }
    let a;
    if (ev.link) {
      a = document.createElement('a'); a.className = 'read'; a.href = ev.link; a.target = '_blank'; a.rel = 'noopener';
      a.innerHTML = 'Читать статью <span aria-hidden="true">→</span>';
      a.addEventListener('click', e => e.stopPropagation());
      a.addEventListener('pointerdown', e => e.stopPropagation());
    } else {
      a = document.createElement('span'); a.className = 'read disabled'; a.textContent = 'Статья в разработке';
    }
    pad.appendChild(a);
    ev.headEl = el.querySelector('.head');
    ev.innerEl = el.querySelector('.inner');
    el.addEventListener('click', () => { if (!suppressClick) toggle(ev); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(ev); } });
    return el;
  }

  function getCluster(key, group) {
    let c = clusters.get(key);
    if (c) return c;
    const evs = group.flatMap(n => n.events);
    const first = group[0].year, last = group[group.length - 1].year;
    c = {key, first, last, nodes: group, events: evs};
    c.el = document.createElement('article');
    c.el.className = 'card cluster gone';
    c.el.tabIndex = 0;
    c.el.setAttribute('role', 'button');
    c.el.setAttribute('aria-label', `Группа: ${evs.length} ${eventsWord(evs.length)}, ${first}–${last} гг. Нажмите, чтобы приблизить`);
    const shown = evs.slice(0, 4);
    c.el.innerHTML =
      `<div class="frame"><div class="head"><span class="c-year">${first}–${last} гг.</span><h3>${evs.length} ${eventsWord(evs.length)}</h3><span class="chev"></span></div>` +
      '<ul class="clist">' +
      shown.map(e => `<li><span class="y">${e.year}</span>${escapeHtml(e.title)}</li>`).join('') +
      (evs.length > shown.length ? `<li class="more">и ещё ${evs.length - shown.length}…</li>` : '') +
      '</ul></div>';
    c.conn = document.createElement('div'); c.conn.className = 'conn gone';
    c.span = document.createElement('div'); c.span.className = 'span gone';
    c.el.addEventListener('click', () => { if (!suppressClick) zoomToCluster(c); });
    c.el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zoomToCluster(c); } });
    world.append(c.span, c.conn, c.el);
    c.el.classList.remove('gone');
    c.h = c.el.offsetHeight;
    c.el.classList.add('gone');
    clusters.set(key, c);
    return c;
  }

  const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  };
  const eventsWord = n => plural(n, 'событие', 'события', 'событий');
  const yearsWord = n => plural(n, 'год', 'года', 'лет');

  /* ================= измерение ================= */
  function measure() {
    CW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 250;
    // скрытые (свёрнутые в группу) карточки на время измерения показываем, иначе их высота = 0
    for (const ev of events) ev.el.classList.remove('gone');
    for (const ev of events) {
      ev.headH = ev.headEl.offsetHeight + 2;
      ev.bodyH = ev.innerEl.scrollHeight;
    }
    for (const ev of events) ev.el.classList.add('gone');
    for (const c of clusters.values()) {
      const hidden = c.el.classList.contains('gone');
      c.el.classList.remove('gone');
      c.h = c.el.offsetHeight;
      if (hidden) c.el.classList.add('gone');
    }
    updateHeights();
  }
  function updateHeights() {
    for (const ev of events) ev.h = ev.headH + (ev.open ? ev.bodyH : 0);
    layoutDirty = true;
  }

  /* ================= раскладка ================= */
  // 1) Соседние годы, которые на этом масштабе стоят почти в одной точке, объединяются в группу.
  //    Если в группе столько событий, что их свёрнутые карточки не помещаются по высоте экрана,
  //    вместо них показывается одна карточка-группа. Нажатие на неё приближает этот участок.
  function computeItems(ppy) {
    const D = CW + GAP_X;   // события, чьи карточки перекрылись бы по горизонтали, — «соседи»
    const capacity = 2 * Math.max(60, H / 2 - BASE_GAP - 10) * CLUSTER_FILL;
    const groups = [];
    let g = null;
    for (const n of yearNodes) {
      const x = n.year * ppy;
      if (g && x - g.firstX < D) g.nodes.push(n);
      else { g = {nodes: [n], firstX: x}; groups.push(g); }
    }
    const items = [];
    for (const grp of groups) {
      const evs = grp.nodes.flatMap(n => n.events);
      const need = evs.reduce((s, e) => s + e.headH + GAP_Y, 0);
      if (grp.nodes.length > 1 && need > capacity) {
        const key = grp.nodes.map(n => n.year).join(',');
        const c = getCluster(key, grp.nodes);
        items.push({type: 'cluster', c, year: c.first, h: c.h});
      } else {
        for (const ev of evs) items.push({type: 'event', ev, year: ev.year, h: ev.h});
      }
    }
    return items;
  }

  // 2) Жадная упаковка: каждая карточка встаёт как можно ближе к оси — сверху или снизу —
  //    и никогда не пересекается с уже поставленными.
  function computeLayout(ppy) {
    const items = computeItems(ppy);
    const sides = [[], []];
    let alt = 0;
    for (const it of items) {
      const x0 = it.year * ppy - ANCHOR - GAP_X / 2, x1 = x0 + CW + GAP_X;
      let best = null;
      for (const s of (alt % 2 ? [1, 0] : [0, 1])) {
        const over = sides[s].filter(p => p.x1 > x0 && p.x0 < x1);
        const cands = [BASE_GAP, ...over.map(p => p.d1 + GAP_Y)].sort((a, b) => a - b);
        let d = cands[cands.length - 1];
        for (const c of cands) {
          if (!over.some(p => c < p.d1 + GAP_Y && c + it.h + GAP_Y > p.d0)) { d = c; break; }
        }
        if (!best || d < best.d) best = {side: s, d};
      }
      alt++;
      it.side = best.side; it.d = best.d;
      sides[best.side].push({x0, x1, d0: best.d, d1: best.d + it.h});
    }
    let top = 0, bot = 0;
    for (const p of sides[0]) top = Math.max(top, p.d1);
    for (const p of sides[1]) bot = Math.max(bot, p.d1);
    return {items, top, bot};
  }

  function place(el, conn, x, side, d) {
    el.style.left = (x - ANCHOR) + 'px';
    el.classList.toggle('up', side === 0);
    el.style.top = (side === 0 ? -d : d) + 'px';
    conn.style.left = x + 'px';
    conn.classList.toggle('up', side === 0);
    conn.classList.toggle('down', side === 1);
    conn.style.top = (side === 0 ? -d : 0) + 'px';
    conn.style.height = d + 'px';
  }

  function applyLayout() {
    const ppy = view.ppy;
    const L = computeLayout(ppy);
    extTop = L.top; extBot = L.bot;

    const visible = new Set(), shownClusters = new Set();
    for (const it of L.items) {
      if (it.type === 'event') {
        visible.add(it.ev);
        place(it.ev.el, it.ev.conn, it.year * ppy, it.side, it.d);
      } else {
        const c = it.c;
        shownClusters.add(c);
        place(c.el, c.conn, c.first * ppy, it.side, it.d);
        c.span.style.left = (c.first * ppy) + 'px';
        c.span.style.width = ((c.last - c.first) * ppy) + 'px';
      }
    }
    for (const ev of events) {
      const on = visible.has(ev);
      ev.el.classList.toggle('gone', !on);
      ev.conn.classList.toggle('gone', !on);
    }
    for (const c of clusters.values()) {
      const on = shownClusters.has(c);
      c.el.classList.toggle('gone', !on);
      c.conn.classList.toggle('gone', !on);
      c.span.classList.toggle('gone', !on);
    }

    let lastX = -1e9;
    for (const n of yearNodes) {
      const x = n.year * ppy;
      n.el.style.left = x + 'px';
      const show = x - lastX >= 52;
      n.label.classList.toggle('hide', !show);
      if (show) lastX = x;
      n.el.classList.toggle('lit', n.events.some(e => e.open));
    }
    axisEl.style.left = ((S - PAD) * ppy) + 'px';
    axisEl.style.width = ((E - S + 2 * PAD) * ppy + CW) + 'px';
    layoutPPY = ppy; layoutDirty = false;
  }

  /* ================= камера ================= */
  const EDGE_L = ANCHOR + 12;     // запас слева, чтобы первая карточка не обрезалась
  const minPPY = () => Math.max(0.05, (W - CW - 30 - EDGE_L) / (SPAN + 2 * PAD));
  const clampPPY = p => Math.min(MAX_PPY, Math.max(minPPY(), p));
  const viewSpan = () => W / view.ppy;

  function clampView() {
    const span = viewSpan();
    const lo = S - PAD - EDGE_L / view.ppy, hi = E + PAD + (CW + 30) / view.ppy;
    if (span >= hi - lo) view.start = lo - (span - (hi - lo)) / 2;
    else view.start = Math.min(hi - span, Math.max(lo, view.start));
    const half = H / 2 - 24;
    const maxUp = Math.max(0, extTop - half), maxDown = Math.max(0, extBot - half);
    view.panY = Math.min(maxUp, Math.max(-maxDown, view.panY));
  }

  function zoomAt(factor, sx) {
    const yr = view.start + sx / view.ppy;
    view.ppy = clampPPY(view.ppy * factor);
    view.start = yr - sx / view.ppy;
    schedule();
  }

  function fitAll(animate = true) {
    const ppy = minPPY();
    const target = {ppy, start: S - PAD - EDGE_L / ppy, panY: 0};
    if (animate) tweenTo(target);
    else { Object.assign(view, target); schedule(); }
  }

  function tweenTo(target, ms = 650) {
    tween = {from: {...view}, target, t0: performance.now(), ms};
    schedule();
  }
  const ease = t => 1 - Math.pow(1 - t, 3);
  function stepTween(now) {
    if (!tween) return;
    const k = Math.min(1, (now - tween.t0) / tween.ms), e = ease(k);
    const {from, target} = tween;
    view.ppy = Math.exp(Math.log(from.ppy) + (Math.log(target.ppy) - Math.log(from.ppy)) * e);
    const c0 = from.start + W / 2 / from.ppy, c1 = target.start + W / 2 / target.ppy;
    view.start = c0 + (c1 - c0) * e - W / 2 / view.ppy;
    view.panY = from.panY + (target.panY - from.panY) * e;
    if (k >= 1) tween = null;
  }

  // масштаб, при котором событие стоит отдельной карточкой, а не внутри группы
  function ppyShowing(ev, startPPY) {
    let p = clampPPY(startPPY);
    for (let i = 0; i < 20; i++) {
      if (computeItems(p).some(it => it.type === 'event' && it.ev === ev) || p >= MAX_PPY) break;
      p = clampPPY(p * 1.5);
    }
    return p;
  }

  function focusEvent(i) {
    if (!events.length) return;
    i = (i + events.length) % events.length;
    if (events[current]) events[current].el.classList.remove('focus');
    current = i;
    const ev = events[i];
    if (!ev.open) setOpen(ev, true);
    const ppy = ppyShowing(ev, Math.max(view.ppy, W < 700 ? 8 : 14));
    const L = computeLayout(ppy);
    const it = L.items.find(x => x.type === 'event' && x.ev === ev);
    const half = H / 2 - 24;
    let panY = 0;
    if (it) {
      const centerY = it.side === 0 ? -(it.d + ev.h / 2) : it.d + ev.h / 2;
      panY = Math.min(Math.max(0, L.top - half), Math.max(-Math.max(0, L.bot - half), -centerY));
    }
    const start = ev.year - (W / 2 - CW / 2 + ANCHOR) / ppy;
    tweenTo({ppy, start, panY});
    void ev.el.offsetWidth; ev.el.classList.add('focus');
    updateDots();
  }

  function zoomToCluster(c) {
    // приближаем, пока группа не распадётся на отдельные карточки или более мелкие группы
    let ppy = clampPPY(view.ppy * 1.3);
    for (let i = 0; i < 30 && ppy < MAX_PPY; i++) {
      if (!computeItems(ppy).some(it => it.type === 'cluster' && it.c === c)) break;
      ppy = clampPPY(ppy * 1.25);
    }
    const center = (c.first + c.last) / 2;
    const start = c.last - c.first < W / ppy - CW / ppy
      ? center - W / 2 / ppy                               // группа целиком помещается — ставим её в центр
      : c.first - (ANCHOR + 20) / ppy;                     // не помещается — начинаем с её первого события
    tweenTo({ppy, start, panY: 0});
  }

  function setOpen(ev, open) {
    ev.open = open;
    ev.el.classList.toggle('open', open);
    ev.el.setAttribute('aria-expanded', String(open));
  }

  function toggle(ev) {
    setOpen(ev, !ev.open);
    if (events[current]) events[current].el.classList.remove('focus');
    current = ev.idx;
    updateHeights();
    schedule();
  }

  /* ================= отрисовка ================= */
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    stepTween(now);
    if (layoutDirty || view.ppy !== layoutPPY) applyLayout();
    clampView();
    const x0 = view.start * view.ppy;
    world.style.transform = `translate3d(${-x0}px, ${H / 2 + view.panY}px, 0)`;
    $('starsFar').style.backgroundPosition = `${-x0 * 0.02}px ${view.panY * 0.05}px`;
    $('starsNear').style.backgroundPosition = `${-x0 * 0.06}px ${view.panY * 0.12}px`;
    drawRuler();
    updateEventLine();
    updateLabels();
    if (tween) schedule();
  }

  function pickStep() {
    for (const s of STEPS) if (s * view.ppy >= TICK_MIN_PX) return s;
    return STEPS[STEPS.length - 1];
  }

  function updateLabels() {
    const a = Math.max(S, Math.round(view.start)), b = Math.min(E, Math.round(view.start + viewSpan()));
    $('range').innerHTML = a <= b ? `<em>${a}</em> — <em>${b}</em> гг.` : '—';
    const s = pickStep();
    $('stepLbl').textContent = `шаг: ${s} ${yearsWord(s)}`;
  }

  function setupCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return {ctx, w, h};
  }

  // Линейка с делениями: показывает только отрезок от первого до последнего события
  function drawRuler() {
    const {ctx, w} = setupCanvas(ruler);
    const ppy = view.ppy, y0 = view.start, y1 = view.start + w / ppy;
    const X = y => (y - y0) * ppy;
    const base = 10;
    const xs = Math.max(0, X(S)), xe = Math.min(w, X(E));
    if (xe >= xs) {
      ctx.strokeStyle = 'rgba(233,197,127,.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xs, base + .5); ctx.lineTo(xe, base + .5); ctx.stroke();
    }
    const step = pickStep(), minor = MINOR[step];
    const from = Math.max(y0 - step, S), to = Math.min(y1 + step, E);
    if (minor && minor * ppy >= 7) {
      ctx.strokeStyle = 'rgba(154,163,192,.35)';
      ctx.beginPath();
      for (let y = Math.ceil(from / minor) * minor; y <= to; y += minor) {
        if (y % step === 0) continue;
        const x = Math.round(X(y)) + .5;
        ctx.moveTo(x, base); ctx.lineTo(x, base + 6);
      }
      ctx.stroke();
    }
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = 'rgba(233,197,127,.75)';
    ctx.fillStyle = '#d9dcea';
    ctx.beginPath();
    for (let y = Math.ceil(from / step) * step; y <= to; y += step) {
      const x = Math.round(X(y)) + .5;
      ctx.moveTo(x, base); ctx.lineTo(x, base + 12);
      if (X(y) > 14 && X(y) < w - 14) ctx.fillText(String(y), X(y), base + 15);
    }
    ctx.stroke();
    // события на линейке
    for (const n of yearNodes) {
      const x = X(n.year);
      if (x < -6 || x > w + 6) continue;
      ctx.save(); ctx.translate(x, base); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = n.events.some(e => e.open) ? '#e9c57f' : '#0d1124';
      ctx.strokeStyle = '#e9c57f'; ctx.lineWidth = 1.5;
      ctx.fillRect(-3.5, -3.5, 7, 7); ctx.strokeRect(-3.5, -3.5, 7, 7);
      ctx.restore();
    }
  }

  /* ================= линия событий ================= */
  const pct = y => (E === S ? 50 : (y - S) / (E - S) * 100);

  function makeDot(node) {
    const b = document.createElement('button');
    b.className = 'dot' + (node.events.length > 1 ? ' multi' : '');
    b.style.left = pct(node.year) + '%';
    b.setAttribute('aria-label', `${node.year}: ${node.events.map(e => e.title).join(', ')}`);
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', () => { hideTip(); focusEvent(node.events[0].idx); });
    b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') showTip(node, b); });
    b.addEventListener('pointerleave', hideTip);
    b.addEventListener('focus', () => showTip(node, b));
    b.addEventListener('blur', hideTip);
    evDots.appendChild(b);
    return b;
  }

  function showTip(node, el) {
    const r = el.getBoundingClientRect();
    tip.innerHTML = `<b>${node.year} г.</b>` + node.events.map(e => escapeHtml(e.title)).join('<br>');
    tip.style.left = Math.min(window.innerWidth - 140, Math.max(140, r.left + r.width / 2)) + 'px';
    tip.style.top = (r.top - 6) + 'px';
    tip.classList.add('show');
  }
  function hideTip() { tip.classList.remove('show'); }

  function updateDots() {
    const cur = events[current];
    for (const n of yearNodes) {
      n.dot.classList.toggle('lit', n.events.some(e => e.open));
      n.dot.classList.toggle('cur', !!cur && cur.node === n);
    }
  }

  function updateEventLine() {
    const a = Math.max(0, pct(view.start)), b = Math.min(100, pct(view.start + viewSpan()));
    evWin.style.left = a + '%';
    evWin.style.width = Math.max(0, b - a) + '%';
    evWin.style.display = b <= 0 || a >= 100 ? 'none' : '';
    updateDots();
  }

  /* ================= ввод ================= */
  let suppressClick = false;
  const pointers = new Map();
  let drag = null, pinch = null;

  vp.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    tween = null;
    if (pointers.size === 1) {
      drag = {x: e.clientX, y: e.clientY, moved: false};
      suppressClick = false;
    } else if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinch = {dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), ppy: view.ppy};
      drag = null; suppressClick = true;
    }
  });
  window.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pinch && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const rect = vp.getBoundingClientRect();
      zoomAt((pinch.ppy * dist / pinch.dist) / view.ppy, (p1.x + p2.x) / 2 - rect.left);
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
      drag.moved = true; suppressClick = true; vp.classList.add('dragging');
      try { vp.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (drag.moved) {
      view.start -= (e.clientX - prev.x) / view.ppy;
      view.panY += (e.clientY - prev.y);
      schedule();
    }
  });
  const endPointer = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      drag = null; vp.classList.remove('dragging');
      setTimeout(() => { suppressClick = false; }, 0);
    }
  };
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  vp.addEventListener('wheel', e => {
    e.preventDefault();
    tween = null;
    const rect = vp.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    if (e.shiftKey) { view.start += (dy || dx) / view.ppy; schedule(); return; }
    if (Math.abs(dx) > Math.abs(dy) && !e.ctrlKey) { view.start += dx / view.ppy; schedule(); return; }
    zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - rect.left);
  }, {passive: false});

  // линейка: перетаскивание прокручивает, колесо — масштаб
  let rulerDrag = null;
  ruler.addEventListener('pointerdown', e => { rulerDrag = e.clientX; tween = null; ruler.setPointerCapture(e.pointerId); });
  ruler.addEventListener('pointermove', e => { if (rulerDrag == null) return; view.start -= (e.clientX - rulerDrag) / view.ppy; rulerDrag = e.clientX; schedule(); });
  ruler.addEventListener('pointerup', () => { rulerDrag = null; });
  ruler.addEventListener('wheel', e => { e.preventDefault(); tween = null; const r = ruler.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - r.left); }, {passive: false});

  // линия событий: клик или перетаскивание по линии переносит окно просмотра
  let lineDrag = false;
  const lineJump = e => {
    const r = evline.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    view.start = S + t * (E - S) - viewSpan() / 2;
    schedule();
  };
  evline.addEventListener('pointerdown', e => { lineDrag = true; tween = null; evline.setPointerCapture(e.pointerId); lineJump(e); });
  evline.addEventListener('pointermove', e => { if (lineDrag) lineJump(e); });
  evline.addEventListener('pointerup', () => { lineDrag = false; });
  evline.addEventListener('pointercancel', () => { lineDrag = false; });

  // кнопки
  function zoomTarget(f) {
    const ppy = clampPPY(view.ppy * f);
    const c = view.start + W / 2 / view.ppy;
    return {ppy, start: c - W / 2 / ppy, panY: view.panY};
  }
  $('zoomIn').onclick = () => tweenTo(zoomTarget(1.8), 350);
  $('zoomOut').onclick = () => tweenTo(zoomTarget(1 / 1.8), 350);
  $('fit').onclick = () => fitAll(true);
  $('prev').onclick = () => focusEvent(current < 0 ? events.length - 1 : current - 1);
  $('next').onclick = () => focusEvent(current < 0 ? 0 : current + 1);
  $('expandAll').onclick = () => {
    const open = !events.every(e => e.open);
    for (const ev of events) setOpen(ev, open);
    $('expandAll').classList.toggle('on', open);
    $('expandAll').querySelector('.lbl').textContent = open ? 'Свернуть все' : 'Раскрыть все';
    updateHeights(); schedule();
  };

  window.addEventListener('keydown', e => {
    const k = e.key;
    if (k === '+' || k === '=') tweenTo(zoomTarget(1.5), 250);
    else if (k === '-' || k === '_') tweenTo(zoomTarget(1 / 1.5), 250);
    else if (k === '0') fitAll(true);
    else if (k === 'ArrowRight' || 'eEуУ'.includes(k) && k.length === 1) focusEvent(current < 0 ? 0 : current + 1);
    else if (k === 'ArrowLeft' || 'qQйЙ'.includes(k) && k.length === 1) focusEvent(current < 0 ? events.length - 1 : current - 1);
    else if (k === 'ArrowUp') { view.panY += 80; schedule(); }
    else if (k === 'ArrowDown') { view.panY -= 80; schedule(); }
    else return;
    e.preventDefault();
  });

  /* ================= размеры и звёзды ================= */
  function resize() {
    const r = vp.getBoundingClientRect();
    const centerYear = W ? view.start + W / 2 / view.ppy : null;
    W = r.width; H = r.height;
    if (events.length) measure();
    if (centerYear != null) { view.ppy = clampPPY(view.ppy); view.start = centerYear - W / 2 / view.ppy; }
    layoutDirty = true;
    schedule();
  }
  window.addEventListener('resize', resize);

  function starTile(size, count, maxR, alpha) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    for (let i = 0; i < count; i++) {
      const x = Math.random() * size, y = Math.random() * size, r = Math.random() * maxR + .2;
      const tint = Math.random();
      ctx.fillStyle = tint > .85 ? `rgba(233,197,127,${alpha})` : tint > .7 ? `rgba(143,216,255,${alpha})` : `rgba(255,255,255,${alpha * (0.4 + Math.random() * .6)})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    return c.toDataURL();
  }
  $('starsFar').style.backgroundImage = `url(${starTile(420, 140, .7, .7)})`;
  $('starsNear').style.backgroundImage = `url(${starTile(640, 60, 1.3, .9)})`;

  load();
})();
