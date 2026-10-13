/* Plejer: HLS video + titlovi koje crtamo sami (biranje, sinhronizacija, veličina).
 * Mora da radi u iOS 12 Safariju: bez ?. i ??, bez Pointer Events. */
(function () {
  'use strict';

  var KEY = location.pathname.split('/').pop();
  var $ = function (id) { return document.getElementById(id); };
  var v = $('v');
  var stage = $('stage');

  var st = {
    status: null,
    playlist: '',
    origin: 0, // vreme izvora koje odgovara v.currentTime = 0
    duration: 0,
    encodedEnd: 0,
    audioIndex: -1,
    pendingSeek: null, // apsolutno vreme na koje skačemo kada novi playlist bude spreman
    wantPlay: false,
  };
  var subs = { list: [], sid: '', cues: [], picked: false, gen: 0, timer: null, lastHtml: null };
  var prefs = load('prefs') || { size: 5, offset: 0 };
  var pollTimer = null;
  var hideTimer = null;

  // ---------- pomoćne ----------
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function save(k, val) { try { localStorage.setItem(k, JSON.stringify(val)); } catch (e) {} }
  function api(url) {
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error) throw new Error(d.error);
      return d;
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + sec).slice(-2);
  }
  function absNow() { return st.origin + (v.currentTime || 0); }
  function setWait(text) {
    $('wait').hidden = !text;
    if (text) $('waitText').textContent = text;
  }

  // ---------- pokretanje / restart konverzije ----------
  function start(t, audio) {
    clearInterval(pollTimer);
    setWait('Pripremam…');
    $('bigPlay').hidden = true;
    var q = '?t=' + Math.floor(t || 0) + (audio >= 0 ? '&audio=' + audio : '');
    api('/api/start/' + KEY + q).then(function (s) {
      onStatus(s);
      pollTimer = setInterval(poll, 1500);
    }).catch(function (e) { setWait('Greška: ' + e.message); });
  }
  function poll() {
    api('/api/status').then(onStatus).catch(function () {});
  }

  var PHASE = { resolve: 'Tražim Real-Debrid link…', probe: 'Čitam fajl…', encode: 'Konvertujem…', done: 'Konvertovano do kraja' };

  function onStatus(s) {
    st.status = s;
    if (s.error) {
      setWait('');
      $('status').innerHTML = '<span style="color:var(--warn)">' + esc(s.error) + '</span>';
      clearInterval(pollTimer);
      return;
    }
    document.title = s.label || 'Gledaj';
    $('title').textContent = s.label || '';
    if (s.info && s.info.duration) st.duration = s.info.duration;
    if (s.origin != null) st.encodedEnd = s.origin + s.encodedSec;
    st.audioIndex = s.audioIndex;
    $('status').textContent = (PHASE[s.state] || s.state) +
      (st.duration ? ' · spremno do ' + fmt(st.encodedEnd) + ' / ' + fmt(st.duration) : '');
    if (s.info && s.info.video) {
      $('tracks').textContent = 'Video: ' + s.info.video + ' · Zvuk: ' + s.info.audio + (s.info.burned ? ' · Upečen titl: ' + s.info.burned : '');
    }
    renderAudio(s.audios || []);
    if (!st.playlist && s.state !== 'resolve' && s.state !== 'probe') setWait('Konvertujem prve sekunde…');

    if (s.ready && s.playlist !== st.playlist) {
      st.playlist = s.playlist;
      st.origin = s.origin;
      v.src = s.playlist;
      v.load();
      setWait('');
      if (st.wantPlay) {
        var p = v.play();
        if (p && p.catch) p.catch(function () { $('bigPlay').hidden = false; });
      } else {
        $('bigPlay').hidden = false;
      }
      loadSubsList();
      setTimeout(loadSubsList, 15000);
      setTimeout(loadSubsList, 45000);
      offerResume();
    }
    if (s.state === 'done' && st.playlist) clearInterval(pollTimer);
  }

  // ---------- premotavanje ----------
  function seekAbs(t) {
    t = Math.max(0, Math.min(t, (st.duration || t) - 1));
    st.wantPlay = !v.paused || st.wantPlay;
    if (st.playlist && t >= st.origin && t <= st.encodedEnd - 2) {
      v.currentTime = t - st.origin;
      return;
    }
    // Van konvertovanog dela → nova konverzija od tog trenutka.
    st.playlist = '';
    v.removeAttribute('src');
    v.load();
    st.origin = t;
    start(t, st.audioIndex);
  }

  function offerResume() {
    var pos = load('pos:' + KEY);
    var el = $('resume');
    if (!pos || pos < 30 || st.resumeOffered || absNow() > 10) return;
    st.resumeOffered = true;
    el.innerHTML = '<button id="resumeYes">Nastavi od ' + fmt(pos) + '</button><button id="resumeNo">Od početka</button>';
    el.hidden = false;
    $('resumeYes').onclick = function () { el.hidden = true; st.wantPlay = true; seekAbs(pos); if (st.playlist) v.play(); };
    $('resumeNo').onclick = function () { el.hidden = true; };
    setTimeout(function () { el.hidden = true; }, 15000);
  }

  // ---------- kontrole ----------
  function togglePlay() {
    if (!st.playlist) return;
    if (v.paused) { st.wantPlay = true; v.play(); } else { st.wantPlay = false; v.pause(); }
  }
  $('bigPlay').onclick = function (e) { e.stopPropagation(); togglePlay(); };
  $('playBtn').onclick = togglePlay;
  $('backBtn10').onclick = function () { seekAbs(absNow() - 10); };
  $('fwdBtn30').onclick = function () { seekAbs(absNow() + 30); };
  v.addEventListener('play', function () { $('playBtn').textContent = '❚❚'; $('bigPlay').hidden = true; poke(); });
  v.addEventListener('pause', function () { $('playBtn').textContent = '▶'; showUi(true); });
  v.addEventListener('waiting', function () { if (st.playlist) setWait('Učitavam…'); });
  v.addEventListener('playing', function () { setWait(''); });
  v.addEventListener('ended', function () { if (!$('nextBtn').hidden) showUi(true); });

  function showUi(stay) {
    stage.className = stage.className.replace(/ ?show-ui/, '') + ' show-ui';
    clearTimeout(hideTimer);
    if (!stay) hideTimer = setTimeout(hideUi, 3500);
  }
  function hideUi() {
    if (v.paused || !$('panel').hidden) return;
    stage.className = stage.className.replace(/ ?show-ui/, '');
  }
  function poke() { showUi(false); }
  var lastTouch = 0;
  stage.addEventListener('touchstart', function (e) {
    lastTouch = Date.now();
    if (e.target === v || e.target === stage) {
      if (/show-ui/.test(stage.className) && !v.paused) { hideUi(); e.preventDefault(); } else poke();
    } else poke();
  });
  stage.addEventListener('mousemove', poke);
  v.addEventListener('click', function () { if (Date.now() - lastTouch > 800) togglePlay(); });

  // Traka za premotavanje (touch + miš; iOS 12 nema Pointer Events).
  var bar = $('bar');
  var dragging = false;
  function barFrac(clientX) {
    var r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }
  function barMove(x) {
    var f = barFrac(x);
    $('barTip').hidden = false;
    $('barTip').style.left = (f * 100) + '%';
    $('barTip').textContent = fmt(f * st.duration) + (f * st.duration > st.encodedEnd ? ' (nova konverzija)' : '');
    $('barKnob').style.left = (f * 100) + '%';
    return f;
  }
  function barEnd(x) {
    dragging = false;
    $('barTip').hidden = true;
    if (st.duration) seekAbs(barFrac(x) * st.duration);
  }
  bar.addEventListener('touchstart', function (e) { dragging = true; barMove(e.touches[0].clientX); e.preventDefault(); clearTimeout(hideTimer); });
  bar.addEventListener('touchmove', function (e) { barMove(e.touches[0].clientX); e.preventDefault(); });
  bar.addEventListener('touchend', function (e) { barEnd(e.changedTouches[0].clientX); poke(); });
  bar.addEventListener('mousedown', function (e) { dragging = true; barMove(e.clientX); });
  window.addEventListener('mousemove', function (e) { if (dragging) barMove(e.clientX); });
  window.addEventListener('mouseup', function (e) { if (dragging) barEnd(e.clientX); });

  // Fullscreen: pravi (iPad iOS 12 podržava webkitRequestFullscreen na elementu) + CSS rezerva.
  function isFs() { return /\bfs\b/.test(document.body.className); }
  function setFs(on) {
    document.body.className = on ? 'fs' : '';
    try {
      if (on && stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
      else if (on && stage.requestFullscreen) stage.requestFullscreen();
      else if (!on && document.webkitFullscreenElement) document.webkitExitFullscreen();
      else if (!on && document.fullscreenElement) document.exitFullscreen();
    } catch (e) {}
    setTimeout(sizeSubs, 300);
  }
  $('fsBtn').onclick = function () { setFs(!isFs()); };
  document.addEventListener('webkitfullscreenchange', function () { if (!document.webkitFullscreenElement && isFs()) { document.body.className = ''; sizeSubs(); } });
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && isFs()) { document.body.className = ''; sizeSubs(); } });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ') { togglePlay(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') seekAbs(absNow() - 10);
    else if (e.key === 'ArrowRight') seekAbs(absNow() + 10);
    else if (e.key === 'f') setFs(!isFs());
  });

  // ---------- panel: titl / sinhronizacija / veličina / zvuk ----------
  $('ccBtn').onclick = function () { $('panel').hidden = !$('panel').hidden; showUi(!$('panel').hidden); };
  $('panelClose').onclick = function () { $('panel').hidden = true; poke(); };
  $('panel').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : e.target;
    if (!b) return;
    var off = b.getAttribute('data-off');
    var size = b.getAttribute('data-size');
    var sid = b.getAttribute('data-sid');
    var aud = b.getAttribute('data-audio');
    if (off != null) {
      prefs.offset = Number(off) === 0 ? 0 : Math.round((prefs.offset + Number(off)) * 100) / 100;
      save('prefs', prefs);
      renderPrefs();
    } else if (size != null) {
      prefs.size = Math.max(2, Math.min(10, prefs.size + Number(size)));
      save('prefs', prefs);
      sizeSubs();
    } else if (sid != null) {
      subs.picked = true;
      selectSub(sid);
    } else if (aud != null && Number(aud) !== st.audioIndex) {
      st.wantPlay = !v.paused;
      var t = absNow();
      st.playlist = '';
      st.origin = t;
      start(t, Number(aud));
    }
  });
  function renderPrefs() {
    $('offsetVal').textContent = (prefs.offset > 0 ? '+' : '') + prefs.offset.toFixed(2) + ' s';
  }
  function sizeSubs() {
    var h = stage.clientHeight || 400;
    $('subs').style.fontSize = Math.round(h * (0.028 + prefs.size * 0.004)) + 'px';
  }
  window.addEventListener('resize', sizeSubs);

  function renderAudio(audios) {
    $('audioSec').hidden = audios.length < 2;
    $('audioList').innerHTML = audios.map(function (a) {
      return '<button class="opt' + (a.index === st.audioIndex ? ' on' : '') + '" data-audio="' + a.index + '">' + esc(a.label) + '</button>';
    }).join('');
  }

  // ---------- titlovi ----------
  function loadSubsList() {
    api('/api/subs').then(function (d) {
      subs.list = d.subs;
      if (!subs.picked && d.default !== subs.sid) {
        var saved = load('sub:' + KEY);
        selectSub(saved && d.subs.some(function (s) { return s.sid === saved; }) ? saved : d.default);
      }
      renderSubList();
    }).catch(function () {});
  }
  function renderSubList() {
    var html = '<button class="opt' + (!subs.sid ? ' on' : '') + '" data-sid="">Isključeno</button>';
    html += subs.list.map(function (s) {
      return '<button class="opt' + (s.sid === subs.sid ? ' on' : '') + '" data-sid="' + s.sid + '">' +
        (s.kind === 'external' ? '🌐 ' : '') + esc(s.label) + (s.sample ? '<span class="s" data-sid="' + s.sid + '">„' + esc(s.sample) + '”</span>' : '') + '</button>';
    }).join('');
    if (!subs.list.length) html += '<div class="muted small">Nema titlova u fajlu ni na OpenSubtitles.</div>';
    $('subList').innerHTML = html;
    $('ccBtn').className = 'ui-btn wide' + (subs.sid ? ' on' : '');
  }
  function selectSub(sid) {
    subs.sid = sid || '';
    subs.cues = [];
    subs.gen += 1;
    clearTimeout(subs.timer);
    if (subs.picked) save('sub:' + KEY, subs.sid);
    renderSubList();
    if (subs.sid) fetchCues(subs.gen);
  }
  function fetchCues(gen) {
    api('/api/sub/' + subs.sid).then(function (d) {
      if (gen !== subs.gen) return;
      subs.cues = d.cues;
      if (!d.complete) subs.timer = setTimeout(function () { fetchCues(gen); }, 8000);
    }).catch(function () {
      if (gen === subs.gen) subs.timer = setTimeout(function () { fetchCues(gen); }, 8000);
    });
  }
  function activeText(t) {
    var c = subs.cues;
    var lo = 0, hi = c.length - 1, idx = -1;
    while (lo <= hi) { // poslednji cue sa početkom <= t
      var mid = (lo + hi) >> 1;
      if (c[mid][0] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    var out = [];
    for (var i = idx; i >= 0 && i > idx - 12; i--) {
      if (c[i][1] > t && out.indexOf(c[i][2]) < 0) out.unshift(c[i][2]);
    }
    return out;
  }

  // ---------- petlja: titlovi + traka ----------
  var lastSave = 0;
  setInterval(function () {
    var t = absNow();
    var lines = subs.sid && st.playlist ? activeText(t - prefs.offset) : [];
    var html = lines.map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('<br>');
    if (html !== subs.lastHtml) { $('subs').innerHTML = html; subs.lastHtml = html; }

    if (st.duration) {
      if (!dragging) {
        var f = Math.min(1, t / st.duration);
        $('barPlayed').style.width = (f * 100) + '%';
        $('barKnob').style.left = (f * 100) + '%';
      }
      $('barEnc').style.left = (st.origin / st.duration * 100) + '%';
      $('barEnc').style.width = (Math.max(0, st.encodedEnd - st.origin) / st.duration * 100) + '%';
      $('time').textContent = fmt(t) + ' / ' + fmt(st.duration);
    }
    if (!v.paused && Date.now() - lastSave > 5000) {
      lastSave = Date.now();
      save('pos:' + KEY, st.duration && t > st.duration - 90 ? 0 : Math.floor(t));
    }
  }, 150);

  // ---------- sledeća epizoda / nazad na seriju ----------
  function setupNav() {
    var s = st.status;
    if (!s || !s.videoId || st.navReady) return;
    st.navReady = true;
    var parts = s.videoId.split(':');
    var showId = parts[0] === 'kitsu' ? parts[0] + ':' + parts[1] : parts[0];
    var type = s.videoType === 'movie' ? 'movie' : 'series';
    $('backBtn').href = '/#m/' + type + '/' + encodeURIComponent(showId);
    if (type === 'movie') return;
    api('/api/meta/' + type + '/' + encodeURIComponent(showId)).then(function (m) {
      var i = -1;
      m.videos.forEach(function (x, n) { if (x.id === s.videoId) i = n; });
      var next = i >= 0 ? m.videos[i + 1] : null;
      if (!next) return;
      $('nextBtn').hidden = false;
      $('nextBtn').onclick = function () { location.href = '/#s/' + type + '/' + encodeURIComponent(next.id); };
    }).catch(function () {});
  }
  setInterval(setupNav, 2000);

  renderPrefs();
  sizeSubs();
  showUi(true);
  start(0, -1);
})();
