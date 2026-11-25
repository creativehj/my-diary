(function () {
  var WEATHER = [
    ['sunny', '☀️', '맑음'], ['partly', '⛅', '구름조금'], ['cloudy', '☁️', '흐림'], ['rain', '🌧️', '비'],
    ['snow', '❄️', '눈'], ['wind', '💨', '바람'], ['fog', '🌫️', '안개'], ['storm', '⛈️', '천둥번개']
  ];
  var WMAP = {}; WEATHER.forEach(function (w) { WMAP[w[0]] = w; });

  var $ = function (id) { return document.getElementById(id); };
  var db = null, entries = [], ready = false, query = '', listUrls = [], shotUrls = [], draft = null, deferredInstall = null, opening = false;
  var mem = { photos: {}, thumbs: {} };
  var PAGE = 20, view = { rows: [], shown: 0, lastMonth: '', list: null, cards: [], holders: {}, gen: 0 };
  var isStandalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  /* ---------- 날짜 표시 ---------- */
  var fDay = new Intl.DateTimeFormat('ko-KR', { weekday: 'short' });
  var fTime = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
  var fLong = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  var fMonth = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' });
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function revokeAll(arr) { arr.forEach(function (u) { URL.revokeObjectURL(u); }); arr.length = 0; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* ---------- 저장소 ----------
     entries: 일기 글과 정보만 (가벼움). photos: 원본 사진. thumbs: 목록용 작은 사진. 사진은 일기를 열 때만 읽습니다. */
  function openDb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open('diary-v1', 2);
        r.onupgradeneeded = function () {
          var d = r.result;
          if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
          if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function txn(stores, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(stores, mode), out = fn(t);
      t.oncomplete = function () { res(typeof out === 'function' ? out() : (out && out.result)); };
      t.onerror = t.onabort = function () { rej(t.error); };
    });
  }
  function keyRange(id) { return IDBKeyRange.bound(id + '|', id + '|￿'); }
  function dbAllEntries() { return txn('entries', 'readonly', function (t) { return t.objectStore('entries').getAll(); }); }
  /* photos/thumbs 가 null 이면 사진은 그대로 두고 글 정보만 저장합니다. */
  function dbSaveEntry(meta, photos, thumbs) {
    if (!db) { if (photos) { mem.photos[meta.id] = photos; mem.thumbs[meta.id] = thumbs || []; } return Promise.resolve(); }
    return txn(photos ? ['entries', 'photos', 'thumbs'] : ['entries'], 'readwrite', function (t) {
      t.objectStore('entries').put(meta);
      if (photos) {
        var ps = t.objectStore('photos'), ts = t.objectStore('thumbs'), r = keyRange(meta.id);
        ps.delete(r); ts.delete(r);
        photos.forEach(function (b, i) { ps.put(b, meta.id + '|' + i); });
        (thumbs || []).forEach(function (b, i) { if (b) ts.put(b, meta.id + '|' + i); });
      }
    });
  }
  function dbDeleteEntry(id) {
    if (!db) { delete mem.photos[id]; delete mem.thumbs[id]; return Promise.resolve(); }
    return txn(['entries', 'photos', 'thumbs'], 'readwrite', function (t) {
      t.objectStore('entries').delete(id); t.objectStore('photos').delete(keyRange(id)); t.objectStore('thumbs').delete(keyRange(id));
    });
  }
  function dbPhotos(id, n) {
    if (!db) return Promise.resolve((mem.photos[id] || []).slice());
    return txn('photos', 'readonly', function (t) {
      var s = t.objectStore('photos'), rs = [];
      for (var i = 0; i < n; i++) rs.push(s.get(id + '|' + i));
      return function () { return rs.map(function (r) { return r.result; }).filter(Boolean); };
    });
  }
  function dbThumbs(list) {
    if (!db) { var m0 = {}; list.forEach(function (e) { m0[e.id] = (mem.thumbs[e.id] || []).slice(0, 3); }); return Promise.resolve(m0); }
    return txn('thumbs', 'readonly', function (t) {
      var s = t.objectStore('thumbs');
      var reqs = list.map(function (e) { var n = Math.min(3, e.photoCount || 0), rs = []; for (var i = 0; i < n; i++) rs.push(s.get(e.id + '|' + i)); return { id: e.id, rs: rs }; });
      return function () { var m = {}; reqs.forEach(function (q) { m[q.id] = q.rs.map(function (r) { return r.result; }); }); return m; };
    });
  }
  function photosOf(e) { return e.photos ? Promise.resolve(e.photos) : dbPhotos(e.id, e.photoCount || 0); }
  function metaOf(e, count) {
    return { id: e.id, at: e.at, weather: e.weather || '', temp: e.temp == null ? '' : e.temp, place: e.place || '', text: e.text || '', updated: e.updated || e.at, photoCount: count };
  }

  /* 목록용 작은 사진 (긴 변 240px) */
  function makeThumb(blob) {
    return new Promise(function (res) {
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () {
        var s = Math.min(1, 240 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.naturalWidth * s)); c.height = Math.max(1, Math.round(im.naturalHeight * s));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        c.toBlob(function (b) { res(b || null); }, 'image/jpeg', 0.72);
      };
      im.onerror = function () { URL.revokeObjectURL(u); res(null); };
      im.src = u;
    });
  }
  function makeThumbs(photos) {
    var out = [], chain = Promise.resolve();
    photos.slice(0, 3).forEach(function (b, i) { chain = chain.then(function () { return makeThumb(b); }).then(function (t) { out[i] = t; }); });
    return chain.then(function () { return out; });
  }

  /* 예전 방식(일기 안에 사진이 들어 있던 저장)을 새 방식으로 옮깁니다. 한 번만 실행됩니다. */
  function migrateLegacy(all) {
    var legacy = all.filter(function (e) { return Array.isArray(e.photos); });
    if (!legacy.length) return Promise.resolve(all);
    $('migNotice').hidden = false;
    var byId = {}; all.forEach(function (e) { byId[e.id] = e; });
    var chain = Promise.resolve();
    legacy.forEach(function (e) {
      chain = chain.then(function () {
        var ph = e.photos;
        return makeThumbs(ph).then(function (th) { var m = metaOf(e, ph.length); return dbSaveEntry(m, ph, th).then(function () { byId[e.id] = m; }); });
      }).catch(function () {});
    });
    return chain.then(function () { $('migNotice').hidden = true; return all.map(function (e) { return byId[e.id]; }); });
  }

  /* ---------- 검색어 강조 ---------- */
  function escRe(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function setHl(node, text, q) {
    node.textContent = '';
    if (!q) { node.textContent = text; return node; }
    var re = new RegExp(escRe(q), 'gi'), last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      node.appendChild(el('mark', null, m[0])); last = m.index + m[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
    return node;
  }
  function snippet(text, q) {
    if (!q) return text;
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    var st = Math.max(0, i - 30);
    return (st > 0 ? '…' : '') + text.slice(st, st + 220);
  }

  /* ---------- 목록 (20개씩) ---------- */
  function buildCard(e, q) {
    var d = new Date(e.at), card = el('button', 'card'); card.type = 'button';
    card.dataset.m = fMonth.format(d); card.dataset.ym = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    var day = el('div', 'day'); day.appendChild(el('b', null, String(d.getDate()))); day.appendChild(el('span', null, fDay.format(d)));
    var body = el('div'); body.style.minWidth = '0';
    var meta = el('div', 'meta'); meta.appendChild(el('span', null, fTime.format(d)));
    var w = WMAP[e.weather], hasT = e.temp !== '' && e.temp != null;
    if (w || hasT) meta.appendChild(setHl(el('span'), (w ? w[1] + ' ' + w[2] : '') + (hasT ? (w ? ' ' : '') + e.temp + '°C' : ''), q));
    if (e.place) meta.appendChild(setHl(el('span'), '📍 ' + e.place, q));
    body.appendChild(meta);
    if (e.text) body.appendChild(setHl(el('p', 'excerpt'), snippet(e.text, q), q));
    var n = e.photoCount || (e.photos ? e.photos.length : 0);
    if (n) { var th = el('div', 'thumbs'); body.appendChild(th); view.holders[e.id] = th; }
    card.appendChild(day); card.appendChild(body);
    card.addEventListener('click', function () { openEditor(e); });
    return card;
  }
  function fillThumbs(e, blobs) {
    var th = view.holders[e.id]; if (!th) return;
    th.textContent = '';
    blobs.forEach(function (b) { if (!b) return; var u = URL.createObjectURL(b); listUrls.push(u); var im = el('img'); im.src = u; im.alt = ''; th.appendChild(im); });
    var n = e.photoCount || (e.photos ? e.photos.length : 0);
    if (n > 3) th.appendChild(el('div', 'more', '+' + (n - 3)));
  }
  function loadThumbsFor(batch, gen) {
    var legacy = batch.filter(function (e) { return e.photos && e.photos.length; });
    var fresh = batch.filter(function (e) { return !e.photos && e.photoCount > 0; });
    legacy.forEach(function (e) { fillThumbs(e, e.photos.slice(0, 3)); });
    if (!fresh.length) return;
    dbThumbs(fresh).then(function (map) {
      if (gen !== view.gen) return;
      fresh.forEach(function (e) { fillThumbs(e, map[e.id] || []); });
    }).catch(function () {});
  }
  function showMore(n) {
    if (view.shown >= view.rows.length) return false;
    var q = query.trim(), root = $('listRoot'), end = Math.min(view.rows.length, view.shown + n), batch = view.rows.slice(view.shown, end);
    batch.forEach(function (e) {
      var m = fMonth.format(new Date(e.at));
      if (m !== view.lastMonth) {
        root.appendChild(el('div', 'month', m));
        view.list = el('div', 'list'); root.appendChild(view.list); view.lastMonth = m;
      }
      var card = buildCard(e, q); view.list.appendChild(card); view.cards.push(card);
    });
    view.shown = end;
    loadThumbsFor(batch, view.gen);
    return true;
  }
  /* 목록 끝이 화면 근처에 오면 다음 20개를 이어 붙입니다. */
  function fill() {
    var guard = 0;
    while (view.shown < view.rows.length && $('sentinel').getBoundingClientRect().top < window.innerHeight + 900 && guard++ < 10) showMore(PAGE);
  }
  function updateJumpLabel() {
    var top = $('header').getBoundingClientRect().bottom, label = null;
    for (var i = 0; i < view.cards.length; i++) {
      if (view.cards[i].getBoundingClientRect().bottom > top + 4) { label = view.cards[i].dataset.m; break; }
    }
    $('jumpLabel').textContent = label || fMonth.format(new Date());
  }
  function rebuild(keep) {
    var prevShown = view.shown, prevY = window.scrollY, q = query.trim(), root = $('listRoot');
    view.gen++; revokeAll(listUrls); root.textContent = '';
    view.shown = 0; view.lastMonth = ''; view.list = null; view.cards = []; view.holders = {};
    var all = entries.slice().sort(function (a, b) { return (b.at - a.at) || ((b.updated || 0) - (a.updated || 0)); }), ql = q.toLowerCase();
    view.rows = !q ? all : all.filter(function (e) {
      var w = WMAP[e.weather] ? WMAP[e.weather][2] : '';
      return (e.text || '').toLowerCase().indexOf(ql) > -1 || w.indexOf(q) > -1 || (e.place || '').toLowerCase().indexOf(ql) > -1;
    });
    if (!ready) { updateJumpLabel(); return; }
    if (!view.rows.length) {
      var em = el('div', 'empty');
      if (q) { em.appendChild(el('h2', null, '찾는 일기가 없어요')); em.appendChild(el('p', null, '다른 단어로 검색해 보세요.')); }
      else { em.appendChild(el('h2', null, '아직 쓴 일기가 없어요')); em.appendChild(el('p', null, '아래 "오늘 쓰기"를 눌러 첫 일기를 남겨 보세요.')); }
      root.appendChild(em); updateJumpLabel(); return;
    }
    showMore(keep ? Math.max(PAGE, prevShown) : PAGE);
    if (keep) window.scrollTo(0, prevY);
    fill(); updateJumpLabel();
  }
  var scrollTick = false;
  window.addEventListener('scroll', function () {
    if (scrollTick) return; scrollTick = true;
    requestAnimationFrame(function () { scrollTick = false; fill(); updateJumpLabel(); });
  }, { passive: true });

  /* ---------- 날짜로 이동 ---------- */
  var cal = { y: 0, m: 0, mode: 'days' };
  function indexEntries() {
    var days = {}, months = {};
    entries.forEach(function (e) {
      var d = new Date(e.at), mk = d.getFullYear() + '-' + pad(d.getMonth() + 1), dk = mk + '-' + pad(d.getDate());
      days[dk] = (days[dk] || 0) + 1; months[mk] = (months[mk] || 0) + 1;
    });
    return { days: days, months: months };
  }
  function renderCal() {
    var ix = indexEntries(), body = $('calBody'), now = new Date(), todayKey = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    body.textContent = '';
    if (cal.mode === 'days') {
      $('calTitle').textContent = cal.y + '년 ' + (cal.m + 1) + '월';
      var wk = el('div', 'cal-week'); ['일', '월', '화', '수', '목', '금', '토'].forEach(function (w) { wk.appendChild(el('span', null, w)); });
      var grid = el('div', 'cal-grid'), first = new Date(cal.y, cal.m, 1).getDay(), dim = new Date(cal.y, cal.m + 1, 0).getDate();
      for (var i = 0; i < first; i++) grid.appendChild(el('span'));
      for (var d = 1; d <= dim; d++) {
        (function (d) {
          var key = cal.y + '-' + pad(cal.m + 1) + '-' + pad(d), n = ix.days[key] || 0;
          var b = el('button', 'cal-day' + (key === todayKey ? ' today' : '')); b.type = 'button';
          b.appendChild(el('b', null, String(d)));
          if (n) { b.appendChild(el('i', 'dot')); b.setAttribute('aria-label', cal.m + 1 + '월 ' + d + '일, 일기 ' + n + '개'); b.addEventListener('click', function () { jumpTo({ day: key }); }); }
          else b.disabled = true;
          grid.appendChild(b);
        })(d);
      }
      body.appendChild(wk); body.appendChild(grid);
    } else {
      $('calTitle').textContent = cal.y + '년';
      var gm = el('div', 'cal-months');
      for (var m = 0; m < 12; m++) {
        (function (m) {
          var key = cal.y + '-' + pad(m + 1), n = ix.months[key] || 0;
          var b = el('button', 'cal-mon'); b.type = 'button'; b.appendChild(el('span', null, (m + 1) + '월')); b.appendChild(el('small', null, n ? n + '개' : '-'));
          if (n) b.addEventListener('click', function () { jumpTo({ month: key }); }); else b.disabled = true;
          gm.appendChild(b);
        })(m);
      }
      body.appendChild(gm);
    }
  }
  function openCal() {
    var ym = view.cards.length ? (view.cards.filter(function (c) { return c.getBoundingClientRect().bottom > $('header').getBoundingClientRect().bottom; })[0] || view.cards[0]).dataset.ym : null;
    var now = new Date(); cal.y = ym ? Number(ym.slice(0, 4)) : now.getFullYear(); cal.m = ym ? Number(ym.slice(5)) - 1 : now.getMonth(); cal.mode = 'days';
    renderCal(); $('calWrap').hidden = false;
  }
  function calStep(dir) {
    if (cal.mode === 'days') { cal.m += dir; if (cal.m < 0) { cal.m = 11; cal.y--; } if (cal.m > 11) { cal.m = 0; cal.y++; } } else cal.y += dir;
    renderCal();
  }
  function jumpTo(t) {
    if (query.trim()) { $('search').value = ''; query = ''; $('clearSearch').hidden = true; rebuild(false); }
    var idx = -1;
    for (var i = 0; i < view.rows.length; i++) {
      var d = new Date(view.rows[i].at), mk = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      if (t.day ? (mk + '-' + pad(d.getDate())) === t.day : mk === t.month) { idx = i; break; }
    }
    $('calWrap').hidden = true;
    if (idx < 0) return;
    if (view.shown <= idx) showMore(idx + 1 - view.shown + 4);
    var card = view.cards[idx], anchor = t.month ? (card.parentNode.previousSibling || card) : card;
    window.scrollTo(0, anchor.getBoundingClientRect().top + window.scrollY - $('header').getBoundingClientRect().bottom - 8);
    fill(); updateJumpLabel();
  }
  $('jumpBtn').addEventListener('click', openCal);
  $('calPrev').addEventListener('click', function () { calStep(-1); });
  $('calNext').addEventListener('click', function () { calStep(1); });
  $('calTitle').addEventListener('click', function () { cal.mode = cal.mode === 'days' ? 'months' : 'days'; renderCal(); });
  $('calTop').addEventListener('click', function () { $('calWrap').hidden = true; window.scrollTo(0, 0); });
  $('calClose').addEventListener('click', function () { $('calWrap').hidden = true; });
  $('calWrap').addEventListener('click', function (e) { if (e.target === $('calWrap')) $('calWrap').hidden = true; });

  /* ---------- 쓰기 화면 ---------- */
  function renderChips() {
    var box = $('chips'); box.textContent = '';
    WEATHER.forEach(function (w) {
      var b = el('button', 'chip'); b.type = 'button';
      b.setAttribute('aria-pressed', draft.weather === w[0] ? 'true' : 'false');
      b.appendChild(el('i', null, w[1])); b.appendChild(document.createTextNode(w[2]));
      b.disabled = draft.mode !== 'edit';
      b.addEventListener('click', function () { if (draft.mode !== 'edit') return; draft.weather = draft.weather === w[0] ? '' : w[0]; draft.dirty = true; renderChips(); });
      box.appendChild(b);
    });
    updateSave();
  }
  function renderShots() {
    revokeAll(shotUrls);
    var g = $('shots'); g.textContent = '';
    draft.photos.forEach(function (b, i) {
      var u = URL.createObjectURL(b); shotUrls.push(u);
      var s = el('div', 'shot'), im = el('img'); im.src = u; im.alt = '첨부한 사진 ' + (i + 1);
      var x = el('button', null, '×'); x.type = 'button'; x.setAttribute('aria-label', '사진 ' + (i + 1) + ' 지우기');
      x.addEventListener('click', function () { draft.photos.splice(i, 1); draft.dirty = true; renderShots(); });
      s.appendChild(im); if (draft.mode === 'edit') s.appendChild(x); g.appendChild(s);
    });
    updateSave();
  }
  function autosize() { var t = $('text'); t.style.height = 'auto'; t.style.height = Math.max(draft && draft.mode === 'view' ? 60 : 240, t.scrollHeight + 2) + 'px'; }


  /* ---------- 오늘의 주제 (기기 안에서만 만듭니다) ---------- */
  var TOPICS = [
    '오늘 가장 오래 눈에 남은 장면은 무엇이었나요?', '오늘 먹은 것 중 기억에 남는 맛이 있나요?', '오늘 누구와 가장 많은 말을 했나요? 어떤 이야기였나요?',
    '오늘 나를 웃게 만든 작은 일은 무엇이었나요?', '오늘 하지 않아도 됐는데 해서 잘했다 싶은 일이 있나요?', '오늘 마음이 가장 무거웠던 순간은 언제였나요?',
    '오늘 하루를 한 단어로 말한다면? 그 이유는요?', '요즘 자꾸 떠오르는 사람이 있나요? 왜 떠오를까요?', '요즘 내가 미루고 있는 일은 무엇인가요?',
    '지금 내 방에서 가장 마음에 드는 물건은 무엇인가요?', '어제의 나에게 한마디 해준다면?', '내일의 나에게 부탁하고 싶은 것은 무엇인가요?',
    '요즘 반복해서 듣는 노래나 소리가 있나요?', '오늘 몸은 어땠나요? 어디가 편했고 어디가 불편했나요?', '최근에 처음 해본 일이 있나요?',
    '오늘 들은 말 중에 마음에 남은 한마디는 무엇인가요?', '요즘 나를 가장 지치게 하는 것은 무엇인가요?', '요즘 나를 가장 쉬게 해주는 것은 무엇인가요?',
    '오늘 가장 잘 쓴 시간은 언제였나요?', '오늘 가장 아깝게 쓴 시간은 언제였나요?', '지금 가장 사고 싶은 것과 그 이유는요?',
    '어릴 때 좋아했는데 지금은 잊고 있던 것이 있나요?', '오늘 걸으면서 무슨 생각을 했나요?', '요즘 내가 자주 하는 걱정은 무엇인가요? 그 걱정은 정말 일어날까요?',
    '오늘 고마웠던 사람이나 일을 세 가지 적어 본다면?', '오늘 내가 참았던 말이 있나요?', '지금 이 순간 들리는 소리를 모두 적어 본다면?',
    '1년 뒤에 이 시기를 떠올리면 무엇이 기억날 것 같나요?', '요즘 내가 바라는 하루는 어떤 모습인가요?', '요즘 가장 자주 쓰는 말버릇은 무엇인가요?',
    '오늘 내가 한 선택 중 가장 작지만 의미 있던 것은 무엇인가요?', '오늘 나에게 해준 가장 다정한 일은 무엇인가요?', '오늘 기대했던 것과 실제는 어떻게 달랐나요?',
    '요즘 시간이 가장 빨리 가는 순간은 언제인가요?', '요즘 가장 느리게 가는 시간은 언제인가요?', '최근에 본 것(영상, 책, 글) 중 오래 남은 것은 무엇인가요?',
    '지금 내가 가장 원하는 한 가지는 무엇인가요?', '오늘 마주친 낯선 사람 중 기억나는 사람이 있나요?', '오늘의 나는 어떤 색이었나요?',
    '이번 주에 잘 지켜낸 것은 무엇인가요?', '요즘 나는 어떤 사람이 되고 싶은가요?', '내가 요즘 가장 자주 있는 장소는 어디인가요? 그곳에서의 나는 어떤가요?'
  ];
  var T_RAIN = ['비 오는 날의 소리와 냄새를 적어 본다면?', '비가 오면 떠오르는 기억이 있나요?', '오늘 비를 맞았다면 어떤 기분이었나요? 맞지 않았다면 창밖은 어땠나요?'];
  var T_SUN = ['오늘 하늘은 어떤 모습이었나요?', '햇빛이 가장 좋았던 순간은 언제였나요?', '이런 날씨에 하고 싶었던 일은 무엇이었나요?'];
  var T_COLD = ['오늘 가장 따뜻했던 순간은 언제였나요?', '추운 날 생각나는 음식이나 장소가 있나요?'];
  var T_SNOW = ['눈이 오면 가장 먼저 하고 싶은 일은 무엇인가요?'];
  var T_CLOUD = ['오늘 같은 흐린 날, 마음은 어땠나요?', '흐린 날엔 어떤 음악이나 음식이 어울리나요?'];
  var T_MORN = ['오늘 아침 눈을 뜨고 처음 든 생각은 무엇이었나요?', '아침에 가장 먼저 한 일은 무엇이었나요?'];
  var T_NIGHT = ['잠들기 전 오늘 하루를 돌아본다면, 한 장면만 고른다면요?', '오늘 밤 내 마음은 어떤가요?', '오늘 하루 중 다시 돌려보고 싶은 순간은 언제인가요?'];
  var T_SEASON = { 3: '봄이 오고 있어요. 요즘 달라졌다고 느끼는 것은 무엇인가요?', 4: '요즘 바깥 공기에서 가장 달라진 점은 무엇인가요?', 9: '선선해진 요즘, 계절이 바뀌는 걸 어디서 느끼나요?', 10: '가을이 깊어요. 올가을에 꼭 하고 싶은 것은 무엇인가요?', 11: '한 해가 저물어 가요. 올해 가장 기억에 남는 일은 무엇인가요?', 12: '올해를 정리한다면 한 문장으로 무엇이라 쓰고 싶나요?', 1: '새해에 마음에 두고 있는 것은 무엇인가요?', 6: '한 해의 절반이 지났어요. 지금까지 가장 달라진 점은 무엇인가요?', 7: '더운 날 가장 시원했던 순간은 언제였나요?' };
  var STOP = {};
  '일기 번째 테스트 기록 오늘 어제 내일 그리고 그래서 하지만 그런데 너무 정말 진짜 조금 많이 하루 생각 느낌 사람 시간 이후 아주 다시 같은 이번 그냥 계속 먼저 바로 아직 이미 오히려 정도'.split(' ').forEach(function (w) { STOP[w] = 1; });
  function stem(w) { var m = w.match(/^(.{2,}?)(에서는|에서|으로|까지|부터|이랑|이나|처럼|보다|에게|한테|이다|했다|한다|했던|하는|해서|하고|이고|이는|에는|에도|을|를|은|는|이|가|도|에|의|과|와|로|만|고|서)$/); return m ? m[1] : w; }
  var recentTopics = [];
  function daysAgoLabel(ms) { var d = Math.round((Date.now() - ms) / 86400000); return d <= 0 ? '오늘' : d + '일 전'; }
  function snip(t, n) { t = t.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t; }
  function topicCandidates() {
    var gen = [], mine = [];
    var now = draft && draft.at ? new Date(draft.at) : new Date(), h = now.getHours(), mo = now.getMonth() + 1;
    var wx = draft ? draft.weather : '';
    var pool = TOPICS.slice();
    if (wx === 'rain' || wx === 'storm') pool = pool.concat(T_RAIN, T_RAIN);
    else if (wx === 'sunny' || wx === 'partly') pool = pool.concat(T_SUN, T_SUN);
    else if (wx === 'snow') pool = pool.concat(T_SNOW, T_SNOW, T_COLD);
    else if (wx === 'cloudy' || wx === 'fog') pool = pool.concat(T_CLOUD, T_CLOUD);
    var tp = draft && draft.temp !== '' ? Number(draft.temp) : null;
    if (tp != null && !isNaN(tp) && tp <= 5) pool = pool.concat(T_COLD, T_COLD);
    if (h >= 5 && h < 11) pool = pool.concat(T_MORN, T_MORN); else if (h >= 20 || h < 3) pool = pool.concat(T_NIGHT, T_NIGHT);
    if (T_SEASON[mo]) pool.push(T_SEASON[mo], T_SEASON[mo]);
    pool.forEach(function (q) { gen.push({ q: q, why: '' }); });

    var list = entries.filter(function (e) { return !draft || e.id !== draft.id; });
    if (list.length) {
      /* 1년 전 오늘 (±3일) */
      list.forEach(function (e) {
        var d = new Date(e.at), y = now.getFullYear() - d.getFullYear();
        if (y >= 1 && e.text) {
          var same = new Date(d); same.setFullYear(now.getFullYear());
          if (Math.abs(same - now) <= 3 * 86400000) mine.push({ q: y + '년 전 이맘때 이렇게 썼어요: “' + snip(e.text, 40) + '” 지금은 어떤가요?', why: fLong.format(d) + '의 일기에서', w: 3 });
        }
      });
      /* 자주 가는 장소 */
      var pc = {}; list.forEach(function (e) { if (e.place) pc[e.place] = (pc[e.place] || 0) + 1; });
      Object.keys(pc).forEach(function (k) { if (pc[k] >= 3) mine.push({ q: k + '에서 일기를 자주 쓰셨네요. 요즘 그곳은 어떤가요?', why: '내 일기 속 장소에서', w: 1 }); });
      /* 자주 쓴 단어 */
      var wc = {}, last = {};
      list.forEach(function (e) {
        var seen = {};
        ((e.text || '').match(/[가-힣]{2,}/g) || []).forEach(function (w) {
          w = stem(w); if (w.length < 2 || STOP[w] || seen[w] || /(다|고|어|아|해|서|으|게|니|요|지|면|며|듯|리|던|은|는|한|된|인|할|함|임|럼|께|도|만|나|을|를|이|가|에)$/.test(w)) return; seen[w] = 1; wc[w] = (wc[w] || 0) + 1; if (!last[w] || last[w] < e.at) last[w] = e.at;
        });
      });
      Object.keys(wc).forEach(function (k) { if (wc[k] >= 4 && wc[k] / list.length >= 0.05) mine.push({ q: '“' + k + '” — 일기에 자주 나오는 말이에요. 요즘 이 말에 얽힌 일이 있나요?', why: '내 일기 속 단어에서', w: 1 }); });
      /* 마지막으로 쓴 일기 */
      var lastE = list.slice().sort(function (a, b) { return b.at - a.at; })[0];
      if (lastE && lastE.text && Date.now() - lastE.at > 3600000) mine.push({ q: daysAgoLabel(lastE.at) + ' 쓴 일기는 “' + snip(lastE.text, 36) + '”였어요. 그 뒤로 달라진 점이 있나요?', why: '가장 최근 일기에서', w: 1 });
    }
    return { gen: gen, mine: mine };
  }
  function pickTopic() {
    var c = topicCandidates(), pick;
    for (var tries = 0; tries < 12; tries++) {
      var usePersonal = c.mine.length && Math.random() < 0.45;
      if (usePersonal) {
        var bag = []; c.mine.forEach(function (m) { for (var i = 0; i < (m.w || 1); i++) bag.push(m); });
        pick = bag[Math.floor(Math.random() * bag.length)];
      } else pick = c.gen[Math.floor(Math.random() * c.gen.length)];
      if (recentTopics.indexOf(pick.q) < 0) break;
    }
    recentTopics.push(pick.q); if (recentTopics.length > 30) recentTopics.shift();
    return pick;
  }
  var topic = null;
  function showTopic() {
    topic = pickTopic();
    $('topicQ').textContent = topic.q; $('topicWhy').textContent = topic.why; $('topicWhy').hidden = !topic.why;
    $('topicCard').hidden = false; $('topicBtn').hidden = true;
  }
  function useTopic() {
    if (!topic || !draft) return;
    var t = $('text'), line = 'Q. ' + topic.q, cur = t.value;
    if (draft.topicLine && cur.indexOf(draft.topicLine) === 0) cur = cur.slice(draft.topicLine.length).replace(/^\n+/, '');
    draft.topicLine = line;
    t.value = line + '\n\n' + cur; draft.dirty = true;
    updateSave(); autosize();
    try { t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.scrollTop = t.scrollHeight; } catch (x) {}
    $('topicCard').hidden = true; $('topicBtn').hidden = false; $('topicBtn').lastChild.textContent = ' 다른 주제로 바꾸기';
  }
  $('topicBtn').addEventListener('click', showTopic);
  $('topicAgain').addEventListener('click', showTopic);
  $('topicUse').addEventListener('click', useTopic);
  function resetTopic() { topic = null; $('topicCard').hidden = true; $('topicBtn').hidden = false; $('topicBtn').lastChild.textContent = ' 주제 뽑기'; }

  function openTopicList() {
    var box = $('topicList'); box.textContent = '';
    TOPICS.concat(T_RAIN, T_SUN, T_COLD, T_SNOW, T_CLOUD, T_MORN, T_NIGHT).forEach(function (q) {
      var b = el('button', null, q); b.type = 'button';
      b.addEventListener('click', function () { topic = { q: q, why: '' }; $('topicWrap').hidden = true; useTopic(); });
      box.appendChild(b);
    });
    $('topicWrap').hidden = false; box.scrollTop = 0;
  }
  $('topicListBtn').addEventListener('click', openTopicList);
  $('topicListClose').addEventListener('click', function () { $('topicWrap').hidden = true; });
  $('topicWrap').addEventListener('click', function (e) { if (e.target === $('topicWrap')) $('topicWrap').hidden = true; });
  /* 읽기 화면에서 왼쪽→오른쪽으로 밀면 닫기 */
  (function () {
    var sx = 0, sy = 0, on = false;
    var ed = $('editor');
    ed.addEventListener('touchstart', function (e) { on = !!draft && draft.mode === 'view' && $('lightbox').hidden && e.touches.length === 1; if (on) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
    ed.addEventListener('touchend', function (e) {
      if (!on) return; on = false;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (dx > 80 && Math.abs(dy) < 60 && dx > Math.abs(dy) * 2 && draft && draft.mode === 'view') closeEditor();
    }, { passive: true });
    ed.addEventListener('touchcancel', function () { on = false; }, { passive: true });
  })();

  var closeTimer = null, delTimer = null;
  function resetConfirms() {
    clearTimeout(closeTimer); clearTimeout(delTimer);
    $('closeBtn').textContent = '닫기'; $('delBtn').textContent = '이 일기 삭제';
  }
  function openEditor(e) {
    if (opening) return;
    if (!e) { doOpen(null, []); return; }
    opening = true;
    (e.photos ? Promise.resolve(e.photos) : (e.photoCount ? dbPhotos(e.id, e.photoCount) : Promise.resolve([])))
      .then(function (blobs) { doOpen(e, blobs); })
      .catch(function () { toast('일기를 열지 못했어요'); })
      .then(function () { opening = false; });
  }
  function doOpen(e, blobs) {
    resetConfirms();
    draft = e ? { id: e.id, isNew: false, legacy: !!e.photos, at: e.at, weather: e.weather || '', temp: e.temp == null ? '' : String(e.temp), text: e.text || '', photos: blobs.slice(), dirty: false }
              : { id: uid(), isNew: true, legacy: false, at: Date.now(), weather: '', temp: '', text: '', photos: [], dirty: false };
    $('when').value = toLocalInput(draft.at);
    $('temp').value = draft.temp; $('text').value = draft.text; $('place').value = e ? (e.place || '') : '';
    $('hint').textContent = '';
    draft.mode = e ? 'view' : 'edit';
    draft.orig = e ? { at: e.at, weather: e.weather || '', temp: e.temp == null ? '' : String(e.temp), place: e.place || '', text: e.text || '', photos: blobs.slice() } : null;
    resetTopic(); $('fTopic').hidden = !!e;
    applyMode();
    $('wxStatus').textContent = '';
    $('editor').hidden = false; $('editor').scrollTop = 0; document.body.style.overflow = 'hidden';
    autosize();
    if (!e) { loadHere(true); try { $('text').focus({ preventScroll: true }); } catch (x) {} }
  }
  function closeEditor() {
    resetConfirms(); revokeAll(shotUrls); revokeAll(readUrls); closeLightbox();
    $('editor').hidden = true; document.body.style.overflow = ''; draft = null;
  }

  /* 사진: 긴 변 1600px, JPEG 로 줄여서 저장 */
  function shrink(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var max = 1600, s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
        var c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        c.toBlob(function (b) { b ? res(b) : rej(new Error('변환 실패')); }, 'image/jpeg', 0.82);
      };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('불러오기 실패')); };
      im.src = u;
    });
  }
  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    $('hint').textContent = '';
    Promise.all(list.map(function (f) { return shrink(f).catch(function () { return null; }); })).then(function (out) {
      var ok = out.filter(Boolean);
      if (ok.length < list.length) $('hint').textContent = '일부 사진을 불러오지 못했어요.';
      if (draft && ok.length) { draft.photos = draft.photos.concat(ok); draft.dirty = true; renderShots(); }
    });
  }

  function samePhotos(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function saveDraft() {
    if (draft.isNew && topic && !$('topicCard').hidden && !draft.topicLine) useTopic();
    var text = $('text').value.trim();
    if (!text && !draft.photos.length) { $('hint').textContent = '글이나 사진을 하나 이상 남겨 주세요.'; return; }
    var at = new Date($('when').value).getTime();
    if (isNaN(at)) { $('hint').textContent = '날짜와 시간을 확인해 주세요.'; return; }
    var t = $('temp').value.trim();
    var meta = { id: draft.id, at: at, weather: draft.weather, temp: t === '' ? '' : Number(t), place: $('place').value.trim(), text: text, photoCount: draft.photos.length, updated: Date.now() };
    var photosChanged = draft.isNew ? draft.photos.length > 0 : (draft.legacy || !samePhotos(draft.photos, draft.orig.photos));
    var photos = draft.photos.slice();
    $('saveBtn').disabled = true;
    (photosChanged ? makeThumbs(photos).then(function (th) { return dbSaveEntry(meta, photos, th); }) : dbSaveEntry(meta, null, null)).then(function () {
      var i = entries.findIndex(function (x) { return x.id === meta.id; });
      if (i > -1) entries[i] = meta; else entries.push(meta);
      closeEditor(); if (query.trim()) rebuild(true); else { rebuild(false); window.scrollTo(0, 0); } toast('저장했어요');
    }).catch(function () {
      $('hint').textContent = '저장하지 못했어요. 저장 공간이 부족할 수 있어요. 사진을 줄이고 다시 시도해 주세요.';
    }).then(function () { $('saveBtn').disabled = false; });
  }

  /* ---------- 백업 (연도별 파일) ---------- */
  var BK_LIMIT = 80 * 1024 * 1024, prepared = [];
  function blobToDataUrl(b) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; r.readAsDataURL(b); }); }
  function dataUrlToBlob(s) {
    var i = s.indexOf(','), head = s.slice(0, i), bin = atob(s.slice(i + 1)), mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    var u = new Uint8Array(bin.length); for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    return new Blob([u], { type: mime });
  }
  function status(msg) { $('sheetStatus').textContent = msg; }
  function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB'; }

  /* ---------- 백업 암호화: PBKDF2(SHA-256, 60만 회) → AES-256-GCM. 파일 형식: "MYDIARY1" + 반복횟수(4) + salt(16) + iv(12) + 암호문 ---------- */
  var MAGIC = [77, 89, 68, 73, 65, 82, 89, 49], ITER = 600000;
  function deriveKey(pw, salt, iter) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']).then(function (k) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  function encryptBlob(blob, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), it = new Uint8Array(4);
    new DataView(it.buffer).setUint32(0, ITER);
    return Promise.all([deriveKey(pw, salt, ITER), blob.arrayBuffer()]).then(function (r) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, r[0], r[1]);
    }).then(function (ct) { return new Blob([new Uint8Array(MAGIC), it, salt, iv, ct], { type: 'application/octet-stream' }); });
  }
  function isEncrypted(buf) {
    var u = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    return u.length === 8 && MAGIC.every(function (b, i) { return u[i] === b; });
  }
  function decryptBuf(buf, pw) {
    var dv = new DataView(buf), iter = dv.getUint32(8), salt = new Uint8Array(buf, 12, 16), iv = new Uint8Array(buf, 28, 12);
    if (iter < 100000 || iter > 5000000) return Promise.reject(new Error('format'));
    return deriveKey(pw, salt, iter).then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, k, buf.slice(40)); })
      .then(function (pt) { return new TextDecoder().decode(pt); });
  }

  /* 1단계: 파일을 만들어 둡니다. 일기를 하나씩 읽어 조각으로 넘기므로 한꺼번에 메모리를 쓰지 않습니다. */
  function doPrepare() {
    if (!entries.length) { status('아직 백업할 일기가 없어요.'); return; }
    var pw = $('bkPw').value, pw2 = $('bkPw2').value;
    if (pw || pw2) {
      if (pw !== pw2) { status('비밀번호 두 칸이 서로 달라요.'); return; }
      if (pw.length < 8) { status('비밀번호는 8자 이상으로 해 주세요.'); return; }
      if (!(window.crypto && crypto.subtle)) { status('이 브라우저에서는 암호화를 쓸 수 없어요.'); return; }
    }
    $('bkOut').hidden = true; prepared = []; $('exportBtn').disabled = true;
    var rows = entries.slice().sort(function (a, b) { return a.at - b.at; }), chunks = [], cur = null, n = 0, chain = Promise.resolve();
    rows.forEach(function (e) {
      chain = chain.then(function () { return photosOf(e); }).then(function (ph) {
        var size = ph.reduce(function (s, b) { return s + b.size; }, 0), yr = new Date(e.at).getFullYear();
        if (!cur || cur.year !== yr || (cur.count && cur.bytes + size > BK_LIMIT)) { cur = { year: yr, bytes: 0, parts: [], count: 0 }; chunks.push(cur); }
        return Promise.all(ph.map(blobToDataUrl)).then(function (urls) {
          var frag = JSON.stringify({ id: e.id, at: e.at, weather: e.weather || '', temp: e.temp == null ? '' : e.temp, place: e.place || '', text: e.text || '', updated: e.updated || e.at, photos: urls });
          cur.parts.push(new Blob([(cur.count ? ',' : '') + frag])); cur.count++; cur.bytes += size;
          n++; if (n % 5 === 0 || n === rows.length) status('백업 파일 만드는 중… ' + n + ' / ' + rows.length);
        });
      });
    });
    chain.then(function () {
      var per = {}, seen = {}, exportedAt = Date.now();
      chunks.forEach(function (c) { per[c.year] = (per[c.year] || 0) + 1; });
      var made = chunks.map(function (c) {
        seen[c.year] = (seen[c.year] || 0) + 1;
        var head = new Blob(['{"app":"my-diary","version":2,"exportedAt":' + exportedAt + ',"entries":[']), tail = new Blob([']}']);
        var base = '내-일기장-' + c.year + (per[c.year] > 1 ? '-' + seen[c.year] : ''), plain = new Blob([head].concat(c.parts, [tail]), { type: 'application/json' });
        if (!pw) return Promise.resolve({ name: base + '.json', blob: plain, count: c.count });
        status('암호화하는 중…');
        return encryptBlob(plain, pw).then(function (b) { return { name: base + '.diary', blob: b, count: c.count, enc: true }; });
      });
      return Promise.all(made).then(function (list) { prepared = list; showBackupFiles(); status(''); });
    }).catch(function () { status('백업 파일을 만들지 못했어요.'); }).then(function () { $('exportBtn').disabled = false; });
  }
  function resetBackup() { prepared = []; var o = $('bkOut'); o.textContent = ''; o.hidden = true; $('bkPw').value = ''; $('bkPw2').value = ''; $('exportBtn').disabled = false; }
  function showBackupFiles() {
    var out = $('bkOut'); out.textContent = ''; out.hidden = false;
    var total = prepared.reduce(function (s, p) { return s + p.blob.size; }, 0);
    out.appendChild(el('p', null, '파일 ' + prepared.length + '개 · 합계 ' + fmtSize(total) + (prepared[0] && prepared[0].enc ? ' · 🔒 암호화됨' : ' · 암호화 안 됨') + '. 아래 버튼을 눌러 파일 앱, iCloud Drive, 맥(AirDrop) 등으로 보내 주세요.'));
    var cancel = el('button', 'btn bk-cancel', '백업 취소하고 닫기'); cancel.type = 'button'; cancel.addEventListener('click', function () { resetBackup(); status('백업을 취소했어요. 파일은 만들어지지 않았고 비밀번호도 지웠어요.'); });
    var all = el('button', 'btn', '모두 저장'); all.type = 'button'; all.addEventListener('click', function () { sendFiles(prepared); }); out.appendChild(all);
    if (prepared.length > 1) prepared.forEach(function (p) {
      var row = el('div', 'bk-row'); row.appendChild(el('span', null, p.name + ' (' + fmtSize(p.blob.size) + ', 일기 ' + p.count + '개)'));
      var b = el('button', 'btn', '저장'); b.type = 'button'; b.addEventListener('click', function () { sendFiles([p]); }); row.appendChild(b); out.appendChild(row);
    });
    out.appendChild(cancel);
  }
  /* 2단계: 버튼을 누른 바로 그 순간에 공유 창을 엽니다. (아이폰은 시간이 지나면 공유 창을 막아요) */
  function sendFiles(list) {
    var files = list.map(function (p) { return new File([p.blob], p.name, { type: p.enc ? 'application/octet-stream' : 'application/json' }); });
    var done = function () { try { localStorage.setItem('diary-last-backup', String(Date.now())); } catch (x) {} status('저장 창을 열었어요. 저장을 마치면 백업이 끝나요.'); };
    if (navigator.canShare && navigator.canShare({ files: files })) {
      navigator.share({ files: files }).then(done).catch(function (err) {
        if (err && err.name === 'AbortError') { status('저장을 취소했어요.'); return; }
        downloadFiles(list); done();
      });
      return;
    }
    downloadFiles(list); done();
  }
  function downloadFiles(list) {
    list.forEach(function (p, i) {
      setTimeout(function () {
        var u = URL.createObjectURL(p.blob), a = document.createElement('a');
        a.href = u; a.download = p.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
      }, i * 400);
    });
  }

  /* 불러오기: 여러 파일을 한꺼번에. 같은 일기는 더 최근에 고친 쪽을 남깁니다. */
  function importOne(r, stats) {
    if (!r || !r.id || !isFinite(r.at)) { stats.bad++; return Promise.resolve(); }
    var id = String(r.id), inUp = Number(r.updated) || Number(r.at), cur = entries.filter(function (x) { return x.id === id; })[0];
    if (cur && (cur.updated || 0) >= inUp) { stats.skipped++; return Promise.resolve(); }
    var photos;
    try { photos = (r.photos || []).map(dataUrlToBlob); } catch (x) { stats.bad++; return Promise.resolve(); }
    var meta = { id: id, at: Number(r.at), weather: r.weather || '', temp: r.temp == null ? '' : r.temp, place: r.place || '', text: r.text || '', updated: inUp, photoCount: photos.length };
    return makeThumbs(photos).then(function (th) { return dbSaveEntry(meta, photos, th); }).then(function () {
      var i = entries.findIndex(function (x) { return x.id === id; });
      if (i > -1) { entries[i] = meta; stats.updated++; } else { entries.push(meta); stats.added++; }
    }).catch(function () { stats.bad++; });
  }
  function doImport(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var stats = { added: 0, updated: 0, skipped: 0, bad: 0 }, chain = Promise.resolve();
    files.forEach(function (f, fi) {
      chain = chain.then(function () {
        status('불러오는 중… 파일 ' + (fi + 1) + ' / ' + files.length);
        return f.arrayBuffer().then(function (buf) {
          if (!isEncrypted(buf)) return new TextDecoder().decode(buf);
          var pw = $('bkPw').value;
          if (!pw) { stats.needPw = true; throw new Error('pw'); }
          return decryptBuf(buf, pw).catch(function () { stats.wrongPw = true; throw new Error('pw'); });
        }).then(function (s) {
          var data = JSON.parse(s);
          if (!data || !Array.isArray(data.entries)) throw new Error('format');
          var c2 = Promise.resolve();
          data.entries.forEach(function (r) { c2 = c2.then(function () { return importOne(r, stats); }); });
          return c2;
        }).catch(function (er) { if (!(er && er.message === 'pw')) stats.bad++; });
      });
    });
    chain.then(function () {
      rebuild(true);
      var msg = '새 일기 ' + stats.added + '개, 갱신 ' + stats.updated + '개, 건너뜀 ' + stats.skipped + '개 (이미 있거나 더 오래된 일기)';
      if (stats.bad) msg += '. 읽지 못한 항목 ' + stats.bad + '개가 있어요. 이 앱에서 저장한 백업 파일인지 확인해 주세요.';
      if (stats.needPw) msg += '. 암호화된 파일이 있어요. 위 비밀번호 칸에 입력하고 다시 불러오세요.';
      if (stats.wrongPw) msg += '. 비밀번호가 맞지 않는 파일이 있어요.';
      status(msg);
    });
  }

  /* 읽기 모드와 수정 모드 */
  function changed() {
    var o = draft && draft.orig;
    if (!o) return false;
    if ($('when').value !== toLocalInput(o.at)) return true;
    if (draft.weather !== o.weather) return true;
    if ($('temp').value.trim() !== o.temp) return true;
    if ($('place').value.trim() !== o.place) return true;
    if ($('text').value.trim() !== o.text.trim()) return true;
    if (draft.photos.length !== o.photos.length) return true;
    for (var i = 0; i < o.photos.length; i++) if (draft.photos[i] !== o.photos[i]) return true;
    return false;
  }
  function updateSave() {
    if (!draft) return;
    var edit = draft.mode === 'edit';
    $('saveBtn').hidden = !edit; $('editBtn').hidden = edit;
    $('saveBtn').disabled = !(draft.isNew ? ($('text').value.trim() !== '' || draft.photos.length > 0) : changed());
  }
  function applyMode() {
    var edit = draft.mode === 'edit';
    $('editorTitle').textContent = draft.isNew ? '새 일기' : (edit ? '일기 수정' : '일기');
    $('form').hidden = !edit; $('reader').hidden = edit;
    $('delBtn').hidden = draft.isNew || !edit;
    if (edit) { revokeAll(readUrls); $('reader').textContent = ''; } else { renderReader(); }
    resetConfirms(); renderChips(); renderShots(); autosize();
  }

  /* 읽기 화면 */
  var readUrls = [];
  function renderReader() {
    var o = draft.orig, r = $('reader'), d = new Date(o.at);
    revokeAll(readUrls); r.textContent = '';
    r.appendChild(el('h2', 'r-date', fLong.format(d)));
    var hq = query.trim();
    var meta = el('p', 'r-meta'); meta.appendChild(el('span', 'm', fTime.format(d)));
    var w = WMAP[o.weather], wt = (w ? w[1] + ' ' + w[2] : '') + (o.temp !== '' ? (w ? ' ' : '') + o.temp + '°C' : '');
    if (wt) meta.appendChild(setHl(el('span', 'm'), wt, hq));
    if (o.place) meta.appendChild(setHl(el('span', 'm'), '📍 ' + o.place, hq));
    r.appendChild(meta);
    if (o.text) r.appendChild(setHl(el('div', 'r-text'), o.text, hq));
    var n = o.photos.length;
    if (n) {
      var g = el('div', 'r-photos');
      o.photos.forEach(function (b, i) {
        var u = URL.createObjectURL(b); readUrls.push(u);
        var btn = el('button'); btn.type = 'button'; btn.setAttribute('aria-label', '사진 ' + (i + 1) + ' 크게 보기');
        var im = el('img'); im.src = u; im.alt = ''; btn.appendChild(im);
        var span = 6, ratio = '';
        if (n === 1) { btn.className = 'nat'; }
        else if (n === 2) { span = 3; ratio = '1'; }
        else if (i === 0) { ratio = '4 / 3'; }
        else { var rest = n - 1; span = rest === 1 ? 6 : (rest % 3 === 0 ? 2 : (rest % 2 === 0 ? 3 : 2)); ratio = rest === 1 ? '16 / 9' : '1'; }
        btn.style.gridColumn = 'span ' + span; if (ratio) btn.style.aspectRatio = ratio;
        btn.addEventListener('click', function () { openLightbox(i); });
        g.appendChild(btn);
      });
      r.appendChild(g);
    }
  }
  function openLightbox(i) {
    var t = $('lbTrack'); t.textContent = '';
    readUrls.forEach(function (u) { var im = el('img'); im.src = u; im.alt = ''; t.appendChild(im); });
    $('lightbox').hidden = false;
    var upd = function () { $('lbCount').textContent = (Math.round(t.scrollLeft / Math.max(1, t.clientWidth)) + 1) + ' / ' + readUrls.length; };
    t.onscroll = upd; t.scrollLeft = i * t.clientWidth; upd();
  }
  function closeLightbox() { $('lightbox').hidden = true; $('lbTrack').textContent = ''; }
  $('lbClose').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });

  $('editBtn').addEventListener('click', function () { if (draft) { draft.mode = 'edit'; applyMode(); } });
  ['text', 'when', 'temp', 'place'].forEach(function (id) { $(id).addEventListener('input', updateSave); });
  $('when').addEventListener('change', updateSave);

  /* ---------- 파일 저장, 날씨, 설치 ---------- */
  function saveFile(name, json) {
    var blob = new Blob([json], { type: 'application/json' });
    try {
      var f = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        return navigator.share({ files: [f] }).catch(function (err) {
          if (err && err.name === 'AbortError') { var c = new Error('cancel'); c.code = 'declined'; throw c; }
          throw err;
        });
      }
    } catch (x) {}
    return new Promise(function (res) {
      var u = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000); res();
    });
  }
  function wmo(c) {
    if (c === 0) return 'sunny'; if (c <= 2) return 'partly'; if (c === 3) return 'cloudy';
    if (c === 45 || c === 48) return 'fog';
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
    if (c >= 95) return 'storm';
    return '';
  }
  /* 위치는 앱을 켠 뒤 한 번만 받아서 30분 동안 다시 씁니다. 소수 둘째 자리(약 1km)로만 사용합니다. */
  var lastPos = null;
  try { var sp = JSON.parse(sessionStorage.getItem('diary-pos') || 'null'); if (sp && Date.now() - sp.t < 30 * 60000) lastPos = sp; } catch (x) {}
  function getPos(force) {
    return new Promise(function (res, rej) {
      if (force) { lastPos = null; try { sessionStorage.removeItem('diary-pos'); } catch (x) {} }
      if (lastPos && Date.now() - lastPos.t < 30 * 60000) { res(lastPos); return; }
      if (!navigator.geolocation) { rej(new Error('nogeo')); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        lastPos = { lat: p.coords.latitude.toFixed(2), lon: p.coords.longitude.toFixed(2), t: Date.now() };
        try { sessionStorage.setItem('diary-pos', JSON.stringify(lastPos)); } catch (x) {}
        res(lastPos);
      }, rej, { timeout: 10000, maximumAge: 600000 });
    });
  }
  function getJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); }); }
  function fetchWeather(pos) {
    return getJson('https://api.open-meteo.com/v1/forecast?latitude=' + pos.lat + '&longitude=' + pos.lon + '&current=temperature_2m,weather_code&timezone=auto')
      .then(function (j) { return j.current; });
  }
  function fetchPlace(pos) {
    return getJson('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=ko&lat=' + pos.lat + '&lon=' + pos.lon)
      .then(function (j) {
        var a = j.address || {};
        var area = a.borough || a.city_district || a.city || a.town || a.county || a.state || '';
        var sub = a.suburb || a.quarter || a.neighbourhood || a.village || '';
        var out = [area, sub].filter(function (x, i, arr) { return x && arr.indexOf(x) === i; }).join(' ');
        if (!out) throw new Error('noplace');
        return out;
      });
  }
  function loadHere(auto, force) {
    var st = $('wxStatus'), mine = draft;
    if (navigator.onLine === false) { st.textContent = auto ? '' : '인터넷에 연결되어 있지 않아요.'; return; }
    st.textContent = '날씨와 장소 불러오는 중…';
    getPos(force).then(function (pos) {
      return Promise.all([fetchWeather(pos).catch(function () { return null; }), fetchPlace(pos).catch(function () { return null; })]).then(function (r) {
        if (draft !== mine) return;
        var w = r[0], pl = r[1], did = [];
        if (w && (!auto || (draft.weather === '' && $('temp').value === ''))) { draft.weather = wmo(w.weather_code); $('temp').value = String(Math.round(w.temperature_2m)); did.push('날씨'); }
        if (pl && (!auto || $('place').value === '')) { $('place').value = pl; did.push('장소'); }
        if (did.length && !auto) draft.dirty = true;
        renderChips();
        st.textContent = did.length ? '현재 위치의 ' + did.join('·') + '를 넣었어요.' : (auto ? '' : '날씨와 장소를 불러오지 못했어요. 직접 입력해 주세요.');
      });
    }).catch(function (err) {
      if (draft !== mine) return;
      st.textContent = auto ? '' : (err && err.code === 1 ? '위치 권한이 꺼져 있어요. 아이폰 설정에서 허용해 주세요.' : '위치를 가져오지 못했어요.');
    });
  }
  $('wxBtn').addEventListener('click', function () { if (draft) loadHere(false, true); });
  $('place').addEventListener('input', function () { if (draft) draft.dirty = true; });

  /* 입력칸 밖을 누르거나 화면을 끌기 시작하면 키보드를 내립니다. */
  document.addEventListener('pointerdown', function (e) {
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !(e.target.closest && e.target.closest('input, textarea, select, #clearSearch'))) a.blur();
  }, { passive: true });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; });
  window.addEventListener('appinstalled', function () { deferredInstall = null; $('installBtn').hidden = true; });
  $('installBtn').addEventListener('click', function () {
    if (!deferredInstall) return;
    deferredInstall.prompt(); deferredInstall = null; $('installBtn').hidden = true;
  });

  /* ---------- 화면 모드 (자동 / 라이트 / 다크) ---------- */
  var THEME_KEY = 'diary-theme', BG = { light: '#E8E0EF', dark: '#100C13' };
  var mqDark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  var ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  function themeMode() { try { var t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (x) { return 'auto'; } }
  function effectiveTheme() { var m = themeMode(); return m === 'auto' ? (mqDark.matches ? 'dark' : 'light') : m; }
  function syncThemeUi() {
    var eff = effectiveTheme(), m = themeMode();
    $('themeBtn').innerHTML = eff === 'dark' ? ICON_SUN : ICON_MOON;
    $('themeBtn').setAttribute('aria-label', eff === 'dark' ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기');
    Array.prototype.forEach.call($('themeSeg').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === m ? 'true' : 'false'); });
  }
  function applyTheme(m) {
    try { if (m === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, m); } catch (x) {}
    var root = document.documentElement;
    if (m === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', m);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length === 2) { metas[0].setAttribute('content', m === 'auto' ? BG.light : BG[m]); metas[1].setAttribute('content', m === 'auto' ? BG.dark : BG[m]); }
    syncThemeUi();
  }
  $('themeBtn').addEventListener('click', function () { applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); });
  $('themeSeg').addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('button'); if (b) applyTheme(b.getAttribute('data-mode')); });
  if (mqDark.addEventListener) mqDark.addEventListener('change', syncThemeUi); else if (mqDark.addListener) mqDark.addListener(syncThemeUi);
  applyTheme(themeMode());

  /* ---------- 공통 ---------- */
  var toastTimer;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 1800); }

  $('today').textContent = fLong.format(new Date());
  var searchTimer;
  $('search').addEventListener('input', function (e) {
    var v = e.target.value; $('clearSearch').hidden = !v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { query = v; window.scrollTo(0, 0); rebuild(false); }, 150);
  });
  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });
  $('clearSearch').addEventListener('click', function () {
    clearTimeout(searchTimer); $('search').value = ''; query = ''; $('clearSearch').hidden = true; window.scrollTo(0, 0); rebuild(false); $('search').focus();
  });
  $('newBtn').addEventListener('click', function () { openEditor(null); });
  $('saveBtn').addEventListener('click', saveDraft);
  $('text').addEventListener('input', function () { if (draft) draft.dirty = true; autosize(); });
  $('when').addEventListener('input', function () { if (draft) draft.dirty = true; });
  $('temp').addEventListener('input', function () { if (draft) draft.dirty = true; });
  $('closeBtn').addEventListener('click', function () {
    if (draft && draft.mode === 'edit' && (draft.isNew ? draft.dirty : changed()) && $('closeBtn').textContent === '닫기') {
      $('closeBtn').textContent = '저장 안 하고 닫기';
      closeTimer = setTimeout(function () { $('closeBtn').textContent = '닫기'; }, 3000); return;
    }
    closeEditor();
  });
  $('delBtn').addEventListener('click', function () {
    if ($('delBtn').textContent === '이 일기 삭제') {
      $('delBtn').textContent = '정말 삭제할까요? 한 번 더 누르면 지워져요';
      delTimer = setTimeout(function () { $('delBtn').textContent = '이 일기 삭제'; }, 3500); return;
    }
    var id = draft.id;
    dbDeleteEntry(id).then(function () {
      entries = entries.filter(function (x) { return x.id !== id; });
      closeEditor(); rebuild(true); toast('삭제했어요');
    });
  });
  $('camBtn').addEventListener('click', function () { $('camInput').click(); });
  $('pickBtn').addEventListener('click', function () { $('pickInput').click(); });
  $('camInput').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  $('pickInput').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });

  $('verLabel').textContent = '앱 버전 14 (화면 코드 기준)';
  $('openBackup').addEventListener('click', function () {
    var last = null; try { last = localStorage.getItem('diary-last-backup'); } catch (e) {}
    status(entries.length + '개의 일기가 있어요.' + (last ? ' 마지막 백업: ' + new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(new Date(Number(last))) : ' 아직 백업한 적이 없어요.'));
    $('installBtn').hidden = !deferredInstall || isStandalone;
    $('iosHint').hidden = isStandalone || !!deferredInstall || !/iphone|ipad/i.test(navigator.userAgent);
    $('sheetWrap').hidden = false;
  });
  $('sheetClose').addEventListener('click', function () { $('sheetWrap').hidden = true; resetBackup(); });
  $('sheetWrap').addEventListener('click', function (e) { if (e.target === $('sheetWrap')) { $('sheetWrap').hidden = true; resetBackup(); } });
  $('exportBtn').addEventListener('click', doPrepare);
  $('importBtn').addEventListener('click', function () { $('importInput').click(); });
  $('importInput').addEventListener('change', function (e) { doImport(e.target.files); e.target.value = ''; });

  /* 시작 */
  rebuild(false);
  openDb().then(function (d) {
    db = d;
    return dbAllEntries();
  }).then(function (all) {
    return migrateLegacy(all || []);
  }).then(function (list) {
    entries = list; ready = true; rebuild(false);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }).catch(function () { $('memNotice').hidden = false; ready = true; rebuild(false); });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
