/* Katalog: pretraga → serija (sezone, opsezi, skok na epizodu) → izvori → plejer.
 * Mora da radi u iOS 12 Safariju: bez ?. i ??, bez modula. */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var qInput = document.getElementById('q');
  var CHUNK = 50;
  var metaCache = {};
  var showState = {}; // izabrana sezona/opseg po seriji (dok je stranica otvorena)

  // ---------- pomoćne ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(url) {
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error) throw new Error(d.error);
      return d;
    });
  }
  function loading(text) {
    view.innerHTML = '<div class="wrap"><div class="msg"><span class="spinner"></span>' + esc(text) + '</div></div>';
  }
  function fail(e) {
    view.innerHTML = '<div class="wrap"><div class="msg err">' + esc(e.message || e) + '</div></div>';
  }
  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
    return null;
  }
  function showIdOf(videoId) {
    var p = String(videoId).split(':');
    return p[0] === 'kitsu' ? p[0] + ':' + p[1] : p[0];
  }
  function getMeta(type, id) {
    var k = type + '/' + id;
    if (metaCache[k]) return Promise.resolve(metaCache[k]);
    return api('/api/meta/' + type + '/' + encodeURIComponent(id)).then(function (m) {
      metaCache[k] = m;
      return m;
    });
  }
  function imgTag(src, alt) {
    return src ? '<img src="' + esc(src) + '" alt="' + esc(alt || '') + '" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' : '';
  }
  function card(m, extra) {
    return '<a class="card" href="#m/' + m.type + '/' + encodeURIComponent(m.id) + '">' +
      '<div class="poster">' + imgTag(m.poster, m.name) + (extra || '') + '</div>' +
      '<div class="name">' + esc(m.name) + '</div>' +
      (m.year ? '<div class="sub">' + esc(m.year) + '</div>' : '') + '</a>';
  }

  // ---------- rute ----------
  function route() {
    var h = location.hash.slice(1);
    var parts = h.split('/');
    var rest = decodeURIComponent(parts.slice(2).join('/'));
    window.scrollTo(0, 0);
    if (parts[0] === 'q') return doSearch(decodeURIComponent(parts.slice(1).join('/')));
    if (parts[0] === 'm') return showSeries(parts[1], rest);
    if (parts[0] === 's') return showSources(parts[1], rest);
    return showHome();
  }
  window.addEventListener('hashchange', route);
  document.getElementById('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = qInput.value.trim();
    if (q) location.hash = 'q/' + encodeURIComponent(q);
    qInput.blur();
  });

  // ---------- početna ----------
  function showHome() {
    qInput.value = '';
    var recent = store('recent') || [];
    var html = '<div class="wrap">';
    if (recent.length) {
      html += '<section class="section"><h2>Nastavi gledanje</h2><div class="row-scroll">' +
        recent.map(function (r) {
          return card({ id: r.showId, type: r.type, name: r.name, poster: r.poster, year: r.epLabel },
            '<span class="badge accent">' + esc(r.epShort || '▶') + '</span>');
        }).join('') + '</div></section>';
    }
    html += '<div id="catalogs"><div class="msg"><span class="spinner"></span>Učitavam…</div></div>' + footer() + '</div>';
    view.innerHTML = html;
    bindLinkForm();
    api('/api/home').then(function (groups) {
      var el = document.getElementById('catalogs');
      if (!el) return;
      el.innerHTML = groups.filter(function (g) { return g.items.length; }).map(function (g) {
        return '<section class="section"><h2>' + esc(g.name) + '</h2><div class="row-scroll">' + g.items.map(function (m) { return card(m); }).join('') + '</div></section>';
      }).join('');
    }).catch(function (e) {
      var el = document.getElementById('catalogs');
      if (el) el.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
    });
  }

  function footer() {
    return '<div class="foot">' +
      '<div>Direktan link (npr. RD download):</div>' +
      '<form class="link-form" id="linkForm"><input id="linkUrl" placeholder="https://…" autocapitalize="off"><button>Pusti</button></form>' +
      '<p id="addonInfo"></p></div>';
  }
  function bindLinkForm() {
    var f = document.getElementById('linkForm');
    if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      api('/api/link?u=' + encodeURIComponent(document.getElementById('linkUrl').value)).then(function (d) {
        location.href = '/watch/' + d.key;
      }).catch(function (err) { alert(err.message); });
    });
    api('/api/config').then(function (c) {
      var el = document.getElementById('addonInfo');
      if (el) el.innerHTML = 'Stremio addon: <code>' + esc(c.addonUrl) + '</code>';
    }).catch(function () {});
  }

  // ---------- pretraga ----------
  function doSearch(q) {
    qInput.value = q;
    loading('Tražim „' + q + '”…');
    api('/api/search?q=' + encodeURIComponent(q)).then(function (groups) {
      var found = groups.filter(function (g) { return g.items.length; });
      if (!found.length) return fail(new Error('Ništa nije nađeno za „' + q + '”.'));
      view.innerHTML = '<div class="wrap">' + found.map(function (g) {
        return '<section class="section"><h2>' + esc(g.name) + ' <span class="muted">' + g.items.length + '</span></h2><div class="grid">' +
          g.items.map(function (m) { return card(m); }).join('') + '</div></section>';
      }).join('') + '<div style="height:40px"></div></div>';
    }).catch(fail);
  }

  // ---------- serija ----------
  function showSeries(type, id) {
    loading('Učitavam…');
    getMeta(type, id).then(function (m) {
      if (!m.videos.length) return showSources(type, id, m);
      var last = (store('last:' + m.id) || {});
      var st = showState[m.id];
      if (!st) {
        st = showState[m.id] = { season: null, chunk: 0 };
        var lastVid = last.videoId && m.videos.filter(function (v) { return v.id === last.videoId; })[0];
        var seasons0 = seasonList(m.videos);
        st.season = lastVid ? lastVid.season : (seasons0.indexOf(1) >= 0 ? 1 : seasons0[0]);
        if (lastVid) st.chunk = Math.floor(episodesOf(m, st.season).indexOf(lastVid) / CHUNK);
      }
      renderSeries(type, m, st, last.videoId);
    }).catch(fail);
  }

  function seasonList(videos) {
    var seen = {};
    var list = [];
    videos.forEach(function (v) { if (!seen[v.season]) { seen[v.season] = 1; list.push(v.season); } });
    // Specijali (sezona 0) na kraj.
    return list.filter(function (s) { return s; }).concat(seen[0] ? [0] : []);
  }
  function episodesOf(m, season) {
    return m.videos.filter(function (v) { return v.season === season; });
  }

  function renderSeries(type, m, st, lastVideoId) {
    var seasons = seasonList(m.videos);
    var eps = episodesOf(m, st.season);
    var chunks = Math.ceil(eps.length / CHUNK);
    if (st.chunk >= chunks) st.chunk = 0;
    var shown = chunks > 1 ? eps.slice(st.chunk * CHUNK, (st.chunk + 1) * CHUNK) : eps;

    var html = '<div class="hero">' + (m.background ? '<div class="bg" style="background-image:url(\'' + esc(m.background) + '\')"></div>' : '') +
      '<div class="wrap"><div class="poster">' + imgTag(m.poster, m.name) + '</div><div>' +
      '<h1>' + esc(m.name) + '</h1><div class="muted">' + esc(m.year) + ' · ' + m.videos.length + ' epizoda</div>' +
      (m.description ? '<p>' + esc(m.description) + '</p>' : '') + '</div></div></div>';

    html += '<div class="wrap">';
    html += '<div class="toolbar">';
    if (seasons.length > 1) {
      html += '<div class="pills" id="seasonPills">' + seasons.map(function (s) {
        return '<button class="pill' + (s === st.season ? ' on' : '') + '" data-season="' + s + '">' + (s ? 'Sezona ' + s : 'Specijali') + '</button>';
      }).join('') + '</div>';
    }
    html += '<form class="jump" id="jumpForm"><input id="jumpInput" type="number" inputmode="numeric" placeholder="Epizoda #"><button>Idi</button></form>';
    html += '</div>';
    if (chunks > 1) {
      html += '<div class="pills small" id="chunkPills">';
      for (var c = 0; c < chunks; c++) {
        var a = eps[c * CHUNK].episode;
        var b = eps[Math.min(eps.length, (c + 1) * CHUNK) - 1].episode;
        html += '<button class="pill' + (c === st.chunk ? ' on' : '') + '" data-chunk="' + c + '">' + a + '–' + b + '</button>';
      }
      html += '</div>';
    }
    html += '<div class="episodes">' + shown.map(function (v) {
      var isLast = v.id === lastVideoId;
      return '<a class="ep' + (isLast ? ' last' : '') + '" id="ep-' + esc(v.id.replace(/[^\w]/g, '_')) + '" href="#s/' + type + '/' + encodeURIComponent(v.id) + '">' +
        '<div class="thumb">' + imgTag(v.thumb) + '<span class="num">' + v.episode + '</span></div>' +
        '<div class="body"><div class="t">' + esc(v.title || ('Epizoda ' + v.episode)) + '</div>' +
        '<div class="d">' + (isLast ? '<span class="badge accent">poslednje gledano</span> ' : '') + esc(v.released) + '</div></div></a>';
    }).join('') + '</div></div>';
    view.innerHTML = html;

    var sp = document.getElementById('seasonPills');
    if (sp) sp.addEventListener('click', function (e) {
      var s = e.target.getAttribute('data-season');
      if (s == null) return;
      st.season = Number(s);
      st.chunk = 0;
      renderSeries(type, m, st, lastVideoId);
    });
    var cp = document.getElementById('chunkPills');
    if (cp) {
      cp.addEventListener('click', function (e) {
        var c = e.target.getAttribute('data-chunk');
        if (c == null) return;
        st.chunk = Number(c);
        renderSeries(type, m, st, lastVideoId);
        var eh = document.querySelector('.episodes');
        if (eh) window.scrollTo(0, eh.getBoundingClientRect().top + window.pageYOffset - 140);
      });
      var on = cp.querySelector('.on');
      if (on) cp.scrollLeft = on.offsetLeft - 40;
    }
    document.getElementById('jumpForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var n = Number(document.getElementById('jumpInput').value);
      if (!n) return;
      var target = episodesOf(m, st.season).filter(function (v) { return v.episode === n; })[0] ||
        m.videos.filter(function (v) { return v.episode === n; })[0];
      if (!target) return alert('Nema epizode ' + n);
      st.season = target.season;
      st.chunk = Math.floor(episodesOf(m, target.season).indexOf(target) / CHUNK);
      renderSeries(type, m, st, lastVideoId);
      flashEpisode(target.id);
    });
    if (lastVideoId && !st.scrolled) {
      st.scrolled = true;
      flashEpisode(lastVideoId, true);
    }
  }

  function flashEpisode(videoId, quiet) {
    var el = document.getElementById('ep-' + videoId.replace(/[^\w]/g, '_'));
    if (!el) return;
    window.scrollTo(0, el.getBoundingClientRect().top + window.pageYOffset - 150);
    if (!quiet) {
      el.className = el.className.replace(' flash', '') + ' flash';
    }
  }

  // ---------- izvori ----------
  function showSources(type, videoId, metaIfMovie) {
    loading('Tražim izvore na Real-Debridu…');
    var showId = metaIfMovie ? metaIfMovie.id : showIdOf(videoId);
    var metaP = metaIfMovie ? Promise.resolve(metaIfMovie) : getMeta(type, showId).catch(function () { return null; });
    Promise.all([api('/api/sources/' + type + '/' + encodeURIComponent(videoId)), metaP]).then(function (res) {
      var data = res[0];
      var m = res[1];
      var v = m && m.videos.filter(function (x) { return x.id === videoId; })[0];
      var epLabel = v ? (v.season > 1 || (m.videos.length && seasonList(m.videos).length > 1) ? 'S' + v.season + ' · ' : '') + 'Epizoda ' + v.episode : '';
      var html = '<div class="wrap">';
      html += '<div class="crumbs">' + (m ? '<a href="#m/' + type + '/' + encodeURIComponent(m.id) + '">← ' + esc(m.name) + '</a>' : '<a href="javascript:history.back()">← Nazad</a>') + '</div>';
      html += '<h1 style="margin:6px 0 2px;font-size:26px">' + esc(epLabel || (m ? m.name : 'Izvori')) + '</h1>';
      if (v && v.title) html += '<div class="muted">' + esc(v.title) + '</div>';
      html += '<div class="muted" style="margin-top:10px;font-size:14px">⚡ = već je na Real-Debridu (kreće odmah) · samo fajlovi do ' + data.maxSizeGb + ' GB' +
        (data.tooBig ? ' (' + data.tooBig + ' većih sakriveno)' : '') + '</div>';
      if (!data.sources.length) {
        html += '<div class="msg">Nema izvora do ' + data.maxSizeGb + ' GB.</div>';
      } else {
        html += '<div class="sources">' + data.sources.map(function (s) {
          return '<a class="src" href="/watch/' + s.key + '" data-key="' + s.key + '">' +
            '<div class="head">' + (s.cached ? '<span class="badge good">⚡ RD</span>' : '<span class="badge">⏳ nije keširano</span>') +
            (s.quality ? '<span class="badge">' + esc(s.quality) + '</span>' : '') +
            (s.size ? '<span class="badge">' + esc(s.size) + '</span>' : '') +
            (s.subsHint > 0 ? '<span class="badge accent">verovatno EN titl</span>' : '') +
            (s.subsHint < 0 ? '<span class="badge warn">verovatno ruski</span>' : '') +
            (s.langs ? '<span class="muted" style="font-size:13px">' + esc(s.langs) + '</span>' : '') + '</div>' +
            '<div class="rel">' + esc(s.release) + '</div>' +
            (s.file && s.file !== s.release ? '<div class="file">' + esc(s.file) + '</div>' : '') + '</a>';
        }).join('') + '</div>';
      }
      html += '</div>';
      view.innerHTML = html;
      view.querySelector('.sources') && view.querySelector('.sources').addEventListener('click', function () {
        if (m) rememberWatch(type, m, v);
      });
    }).catch(fail);
  }

  function rememberWatch(type, m, v) {
    var entry = {
      showId: m.id, type: type, name: m.name, poster: m.poster,
      videoId: v ? v.id : m.id,
      epShort: v ? 'Ep ' + v.episode : '',
      epLabel: v ? 'Epizoda ' + v.episode : '',
    };
    store('last:' + m.id, { videoId: entry.videoId });
    var recent = (store('recent') || []).filter(function (r) { return r.showId !== m.id; });
    recent.unshift(entry);
    store('recent', recent.slice(0, 12));
  }

  route();
})();
