/* 地震の時系列地図：画面。計算は core.js（QC）。
 * 時刻の状態は T（UTC ms）ただ 1 つ。つまみ・地図・グラフ・左上の表示・動画はすべて T から描く。
 */
(function () {
  'use strict';
  var QC = window.QC, DAY = QC.DAY, HOUR = QC.HOUR;
  var GSI = 'https:' + '/' + '/cyberjapandata.gsi.go.jp/xyz/';
  var BASES = {
    pale: { url: GSI + 'pale/{z}/{x}/{y}.png', maxZoom: 18, minZoom: 2 },
    blank: { url: GSI + 'blank/{z}/{x}/{y}.png', maxZoom: 14, minZoom: 5 },
    photo: { url: GSI + 'seamlessphoto/{z}/{x}/{y}.jpg', maxZoom: 18, minZoom: 2 }
  };
  var CREDIT = '出典：気象庁（震源データ・震源リスト・震度データベース）　地図：地理院タイル';
  // カタログの作り方が変わった時点（2026-10-11 にデータから実測）。期間がまたぐとグラフに線を引く
  var CATALOG_CHANGES = [
    { t: '2016-04-01', label: '自動処理の震源が加わる', note: '2016年4月から自動処理で決めた震源が加わり、主に M1 未満の回数が増えています。年をまたいで回数を比べるなら M2 以上が目安です。' }];

  var DEFAULTS = {
    magMin: 1, intMin: 0, depMin: 0, depMax: 1000, lowFreq: true, reference: true,
    colorMode: 'mag', sizeScale: 'exp', r1: 1.5, sizeGrowth: 1.7,
    life1: 3, lifeGrowth: 1.8, lifeMin: 1 / 24, lifeMax: 120,
    ripple: true, rippleMinM: 3, rippleFrames: 12,
    shape: 'circle', sphereKind: 'est', sphereInt: '4', sphereAmp: 1.31, sphereFade: 300, sphereR5: 30, sphereGrowth: 2,
    ringFrom: '3', ringMinM: 3.5,
    fillAlpha: 0.55, strokeAlpha: 0.9, fadePow: 0.7,
    step: 6 * HOUR, fps: 30, base: 'pale', t0: '', t1: '',
    bbox: [20, 120, 50, 156]
  };
  var NUM = ['magMin', 'intMin', 'depMin', 'depMax', 'r1', 'sizeGrowth', 'life1', 'lifeGrowth', 'lifeMax',
             'rippleMinM', 'step', 'fps', 'sphereAmp', 'sphereFade', 'sphereR5', 'sphereGrowth', 'ringMinM'];
  var BOOL = ['lowFreq', 'reference', 'ripple'];
  var STR = ['colorMode', 'sizeScale', 'base', 't0', 't1', 'shape', 'sphereInt', 'sphereKind', 'ringFrom'];

  var S = Object.assign({}, DEFAULTS);
  var st = {
    manifest: null, cache: {}, ev: null, f: null, life: null, px: null, py: null,
    t0: 0, t1: 0, T: 0, playing: false, lastTs: 0, loadSeq: 0, maxLife: 0,
    drawn: null, mtBase: null, cntBase: null, rec: null, dataEnd: 0
  };
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- 設定（URL の # に残す）
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    NUM.forEach(function (k) { if (p.has(k) && isFinite(+p.get(k))) S[k] = +p.get(k); });
    BOOL.forEach(function (k) { if (p.has(k)) S[k] = p.get(k) === '1'; });
    STR.forEach(function (k) { if (p.has(k)) S[k] = p.get(k); });
    if (p.has('T')) st.hashT = QC.parseJst(p.get('T'));
  }
  function writeHash() {
    var p = new URLSearchParams();
    NUM.concat(STR).forEach(function (k) { if (S[k] !== DEFAULTS[k] && S[k] !== '') p.set(k, S[k]); });
    BOOL.forEach(function (k) { if (S[k] !== DEFAULTS[k]) p.set(k, S[k] ? '1' : '0'); });
    if (st.T) p.set('T', QC.formatDate(st.T) + 'T' + QC.formatDateTime(st.T).slice(11, 16));
    history.replaceState(null, '', '#' + p.toString());
  }
  function bindControls() {
    NUM.concat(STR).forEach(function (k) {
      var el = $(k);
      if (!el) return;
      if (k !== 't0' && k !== 't1') el.value = S[k];
      el.addEventListener('change', function () {
        if (k === 't0' || k === 't1') return onPeriodChange();
        var v = NUM.indexOf(k) >= 0 ? +el.value : el.value;
        if (NUM.indexOf(k) >= 0 && !isFinite(v)) { el.value = S[k]; return; }
        S[k] = v;
        if (k === 'base') setBase();
        settingsChanged(k);
      });
    });
    BOOL.forEach(function (k) {
      var el = $(k);
      el.checked = S[k];
      el.addEventListener('change', function () { S[k] = el.checked; settingsChanged(k); });
    });
  }
  var REFILTER = ['magMin', 'intMin', 'depMin', 'depMax', 'lowFreq', 'reference'];
  var RELIFE = ['life1', 'lifeGrowth', 'lifeMax'];
  var RESPHERE = ['sphereInt', 'sphereAmp', 'sphereKind', 'sphereR5', 'sphereGrowth', 'ringFrom', 'ringMinM'];
  function settingsChanged(k) {
    if (REFILTER.indexOf(k) >= 0) rebuild();
    else if (RELIFE.indexOf(k) >= 0) { computeLife(); }
    else if (RESPHERE.indexOf(k) >= 0) { computeSpheres(); }
    if (k === 'shape' || k === 'sphereKind') applyShapeClass();
    if (k === 'colorMode' || REFILTER.indexOf(k) >= 0) renderChartBases();
    if (k === 'step') syncSlider();
    renderLegend();
    drawAll();
    writeHash();
  }

  // ---------------------------------------------------------------- 地図
  var map, baseLayer;
  function initMap() {
    map = L.map('map', { center: [37.5, 137.5], zoom: 5, minZoom: 2, maxZoom: 18, zoomSnap: 0.5,
                         preferCanvas: true, attributionControl: true, zoomControl: false });
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.attributionControl.setPrefix(false);
    setBase();
    var c = $('quakeCanvas');
    map.on('move zoomend resize viewreset', function () { sizeCanvas(); drawMap(); });
    map.on('zoomstart', function () { c.style.visibility = 'hidden'; });
    map.on('zoomend', function () { c.style.visibility = ''; });
    map.getContainer().addEventListener('mousemove', onHover);
    map.getContainer().addEventListener('mouseleave', function () { $('tip').style.display = 'none'; });
    sizeCanvas();
    // 地図の枠の大きさが変わったら Leaflet に知らせる（知らせないとタイルが欠ける）
    if (window.ResizeObserver) new ResizeObserver(function () { map.invalidateSize(false); }).observe($('map'));
  }
  function setBase() {
    var b = BASES[S.base] || BASES.pale;
    var opt = { maxZoom: 18, maxNativeZoom: b.maxZoom, minZoom: b.minZoom, crossOrigin: 'anonymous',
                attribution: '<a href="https:' + '/' + '/maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>｜震源：気象庁' };
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(b.url, opt).addTo(map);
    baseLayer.bringToBack();
  }
  function sizeCanvas() {
    var c = $('quakeCanvas'), w = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w.x * dpr) || c.height !== Math.round(w.y * dpr)) {
      c.width = Math.round(w.x * dpr); c.height = Math.round(w.y * dpr);
      c.style.width = w.x + 'px'; c.style.height = w.y + 'px';
    }
  }
  /** 今の地図の見え方で、zoom 0 の画素 → 画面の画素 */
  function viewTransform() {
    var z = map.getZoom(), k = Math.pow(2, z), o = map.getPixelBounds().min;
    return { k: k, ox: o.x, oy: o.y };
  }

  // ---------------------------------------------------------------- データ
  function setStatus(msg, err) { var s = $('status'); s.textContent = msg; s.className = err ? 'err' : ''; }
  function fetchJson(u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.json(); }); }
  function fetchText(u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.text(); }); }

  function loadPeriod() {
    var seq = ++st.loadSeq, months = QC.monthsBetween(st.t0, st.t1);
    var have = months.filter(function (m) { return st.manifest.months[m]; });
    var missing = months.length - have.length, done = 0, failed = [];
    setStatus('読み込み中… 0 / ' + have.length + ' か月');
    return Promise.all(have.map(function (m) {
      if (st.cache[m]) { done++; return Promise.resolve(); }
      return fetchText('data/' + st.manifest.months[m].file).then(function (txt) {
        st.cache[m] = QC.parseMonthCsv(txt);
      }).catch(function (e) { failed.push(m + '（' + e.message + '）'); })
        .then(function () { done++; if (seq === st.loadSeq) setStatus('読み込み中… ' + done + ' / ' + have.length + ' か月'); });
    })).then(function () {
      if (seq !== st.loadSeq) return;
      var parts = have.filter(function (m) { return st.cache[m]; }).map(function (m) { return st.cache[m]; });
      st.ev = parts.length ? QC.concatColumns(parts) : QC.concatColumns([]);
      var bad = parts.reduce(function (a, p) { return a + p.bad.length; }, 0);
      st.px = new Float64Array(st.ev.n); st.py = new Float64Array(st.ev.n);
      for (var i = 0; i < st.ev.n; i++) { var p = QC.project0(st.ev.lat[i], st.ev.lon[i]); st.px[i] = p[0]; st.py[i] = p[1]; }
      var msg = QC.formatDate(st.t0) + ' 〜 ' + QC.formatDate(st.t1 - 1) + '：' + st.ev.n.toLocaleString() + ' 件を読み込み';
      var probs = [];
      if (missing) probs.push('データの無い月 ' + missing);
      if (failed.length) probs.push('読めなかった月 ' + failed.join('、'));
      if (bad) probs.push('読めなかった行 ' + bad);
      setStatus(msg + (probs.length ? '。' + probs.join('。') : ''), failed.length > 0 || bad > 0);
      rebuild();
      renderChartBases();
      drawAll();
    });
  }
  function rebuild() {
    if (!st.ev) return;
    st.f = QC.filterEvents(st.ev, S, st.t0, st.t1);
    computeLife();
    renderDropped();
  }
  function computeLife() {
    if (!st.f) return;
    var idx = st.f.idx, life = new Float64Array(idx.length), mx = 0;
    for (var k = 0; k < idx.length; k++) { life[k] = QC.lifeMs(st.ev.mag[idx[k]], S); if (life[k] > mx) mx = life[k]; }
    st.life = life; st.maxLife = mx;
    computeSpheres();
  }
  function applyShapeClass() {
    document.body.classList.toggle('sphere', S.shape === 'sphere');
    document.body.classList.toggle('rings', S.shape === 'rings');
    document.body.classList.toggle('sphereGeom', S.sphereKind === 'geom');
  }
  /** 球の半径と地表の円の半径（km）を、描く対象の地震ごとに求めておく */
  function computeSpheres() {
    if (!st.f) return;
    var idx = st.f.idx, ev = st.ev, thr = QC.INT_THRESHOLDS[S.sphereInt] || 3.5;
    var R = new Float32Array(idx.length), rs = new Float32Array(idx.length);
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], d = isNaN(ev.dep[i]) ? NaN : Math.max(ev.dep[i], 0);
      if (isNaN(d)) continue;                     // 深さ不明は球を描かない（点だけ）
      R[k] = S.sphereKind === 'geom' ? QC.geomSphereRadiusKm(ev.mag[i], S.sphereR5, S.sphereGrowth)
        : QC.sphereRadiusKm(ev.mag[i], d, thr, S.sphereAmp);
      rs[k] = QC.surfaceRadiusKm(R[k], d);
    }
    st.sphR = R; st.sphS = rs;
    // 同心円：M が ringMinM 以上の地震だけ、ringFrom 以上の震度の境目ごとに地表の円の半径を持つ
    var lv = QC.RING_LEVELS.slice(Math.max(0, QC.RING_LEVELS.indexOf(S.ringFrom))), nl = lv.length;
    var rr = new Float32Array(idx.length * nl);
    for (k = 0; k < idx.length; k++) {
      var j = idx[k];
      if (ev.mag[j] < S.ringMinM || isNaN(ev.dep[j])) continue;
      var a = QC.ringRadiiKm(ev.mag[j], Math.max(ev.dep[j], 0), S.sphereAmp, lv);
      for (var n = 0; n < nl; n++) rr[k * nl + n] = a[n];
    }
    st.ringLv = lv; st.rings = rr;
  }
  function renderDropped() {
    var w = st.f.why, L = [];
    var names = { outside: '日本の周辺の外', artificial: '人工地震（発破など）', lowFreq: '低周波地震',
                  poorQuality: '精度の低い震源', magUnknown: 'M 不明', magLow: 'M が下限未満',
                  intUnknown: '震度が不明', intLow: '震度が下限未満', depth: '深さが範囲外' };
    Object.keys(names).forEach(function (k) { if (w[k]) L.push(names[k] + ' ' + w[k].toLocaleString()); });
    $('dropped').innerHTML = '期間内 ' + st.f.total.toLocaleString() + ' 件のうち <b>' +
      st.f.idx.length.toLocaleString() + ' 件</b>を描く。' + (L.length ? '<br>描かない：' + L.join('、') : '');
  }

  // ---------------------------------------------------------------- 時刻
  function sliderToT(v) { return st.t0 + (st.t1 - st.t0) * v / 100000; }
  function syncSlider() { $('timeSl').value = Math.round((st.T - st.t0) / (st.t1 - st.t0) * 100000); }
  function setT(T, fromSlider) {
    st.T = Math.max(st.t0, Math.min(st.t1, T));
    if (!fromSlider) syncSlider();
    drawAll();
  }
  function dayInfo(T) {
    var d = QC.formatDate(T), info = st.manifest.days[d];
    if (T > st.dataEnd) return { cls: 'warn', text: 'この時刻のデータはまだありません' };
    if (!info) return { cls: 'warn', text: 'この日のデータがありません' };
    var t = { C: '確定値', P: '速報値（後で変わることがあります）', Q: '発表直後の値（座標0.1度・時刻は分まで）' }[info.src] || '';
    if (info.src === 'P' && info.intensity === 'failed') t += '・震度は取得できず不明';
    if (info.src === 'P' && info.intensity === 'pending') t += '・震度はまだ集計されておらず不明';
    return { cls: info.src === 'C' ? '' : 'warn', text: t };
  }

  // ---------------------------------------------------------------- 描画
  function drawAll() {
    if (!st.f) return;
    drawMap();
    drawCharts();
    var di = dayInfo(st.T);
    $('clock').textContent = QC.formatClock(st.T, S.step);
    $('clockNote').textContent = di.text;
  }
  function drawMap() {
    if (!st.f || !map) return;
    var c = $('quakeCanvas'), ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    var tr = viewTransform(), sz = map.getSize();
    st.drawn = drawQuakes(ctx, st.T, function (i) { return [st.px[i] * tr.k - tr.ox, st.py[i] * tr.k - tr.oy]; },
                          1, sz.x, sz.y);
  }
  /** 地震を描く（画面と動画で共通）。描いたものの位置を返す（吹き出し用）。 */
  function drawQuakes(ctx, T, proj, scale, W, H) {
    var ev = st.ev, idx = st.f.idx, vis = QC.visibleAt(ev, idx, st.life, T, st.maxLife);
    var rippleDur = S.rippleFrames * S.step, drawn = [];
    if (S.shape === 'rings') drawRingLayers(ctx, vis, T, proj, scale, W, H);
    for (var n = 0; n < vis.length; n++) {
      var k = vis[n], i = idx[k], m = ev.mag[i], age = T - ev.t[i], f = age / st.life[k];
      var p = proj(i), r = QC.radius(m, S) * scale;
      var sty = QC.styleOf(S.colorMode, m, ev.dep[i], f, ev.maxi[i]), a = QC.alphas(m, f, S);
      if (S.shape === 'sphere' || S.shape === 'rings') {
        r = S.shape === 'rings' ? drawRings(ctx, k, i, p, f, sty, scale, W, H) : drawSphere(ctx, k, i, p, f, sty, scale, W, H);
        if (r < 0) continue;
      } else {
      if (p[0] < -r - 60 || p[1] < -r - 60 || p[0] > W + r + 60 || p[1] > H + r + 60) continue;
      ctx.fillStyle = sty.fill; ctx.strokeStyle = sty.stroke;
      if (r < 1.2 && !sty.dash) { ctx.globalAlpha = Math.max(a.fill, a.stroke); ctx.fillRect(p[0] - r, p[1] - r, 2 * r, 2 * r); }
      else {
        ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(r, 1.5 * scale), 0, 2 * Math.PI);
        ctx.globalAlpha = a.fill; ctx.fill();
        if (sty.dash) ctx.setLineDash([3 * scale, 2 * scale]);
        ctx.globalAlpha = a.stroke; ctx.lineWidth = (m >= 5 ? 1.6 : 1) * scale; ctx.stroke();
        if (sty.dash) ctx.setLineDash([]);
      }
      }
      if (S.ripple && m >= S.rippleMinM && age < rippleDur) {
        var g = age / rippleDur;
        ctx.beginPath(); ctx.arc(p[0], p[1], r + g * (12 + 2.5 * r) * 1, 0, 2 * Math.PI);
        ctx.globalAlpha = 0.9 * (1 - g); ctx.lineWidth = 2 * scale; ctx.stroke();
      }
      drawn.push([p[0], p[1], r, i]);
    }
    ctx.globalAlpha = 1;
    return drawn;
  }

  /** 球の表示：外の輪＝推定震度が境目になる距離の球（深いほど薄く）、塗り＝球が地表に出る円、点＝震央。
   *  画面外なら −1。戻り値は吹き出しの当たり判定に使う半径（px）。 */
  function drawSphere(ctx, k, i, p, f, sty, scale, W, H) {
    var ev = st.ev, ppk = QC.pxPerKm(ev.lat[i], map.getZoom()) * scale;
    var R = st.sphR[k] * ppk, rs = st.sphS[k] * ppk, dep = ev.dep[i];
    var reach = Math.max(R, 2 * scale);
    if (p[0] < -reach || p[1] < -reach || p[0] > W + reach || p[1] > H + reach) return -1;
    var fade = Math.pow(1 - Math.max(0, Math.min(1, f)), S.fadePow);
    var deep = isNaN(dep) ? 1 : Math.max(0.12, 1 - dep / S.sphereFade);   // 深いほど外の輪を薄く
    ctx.strokeStyle = sty.stroke; ctx.fillStyle = sty.fill;
    if (R > 0) {
      ctx.beginPath(); ctx.arc(p[0], p[1], R, 0, 2 * Math.PI);
      ctx.globalAlpha = 0.05 * deep * fade; ctx.fill();
      ctx.globalAlpha = 0.8 * deep * fade; ctx.lineWidth = 1.2 * scale; ctx.stroke();
    }
    if (rs > 0) {
      ctx.beginPath(); ctx.arc(p[0], p[1], rs, 0, 2 * Math.PI);
      var m = ev.mag[i];   // 大きな球ほど塗りを薄く（下の小さな地震と下地を隠さない）
      ctx.globalAlpha = 0.38 * fade * (m >= 8 ? 0.35 : m >= 7 ? 0.55 : m >= 6 ? 0.75 : 1); ctx.fill();
    }
    ctx.globalAlpha = Math.max(0.35, fade);       // 震央の点（球が無い小さな地震も、ここで見える）
    var d = Math.max(1.2, Math.min(2.5, 0.6 + ev.mag[i] * 0.3)) * scale;
    ctx.fillRect(p[0] - d / 2, p[1] - d / 2, d, d);
    return Math.max(rs, 3 * scale);
  }

  /** 同心円：震度の段ごとに、見えている全部の地震の輪をまとめて塗る（弱い段から順に、強い段を上へ）。
   *  一枚の下書きに重ね塗りしてから一度だけ半透明で貼るので、輪が何重に重なっても濃くなりすぎず、
   *  各地点で推定震度がいちばん高い段の色が見える。強い段の境目には線を引く。 */
  function drawRingLayers(ctx, vis, T, proj, scale, W, H) {
    var ev = st.ev, idx = st.f.idx, lv = st.ringLv, nl = lv.length, z = map.getZoom();
    var cv = st.ringCanvas || (st.ringCanvas = document.createElement('canvas'));
    if (cv.width !== ctx.canvas.width || cv.height !== ctx.canvas.height) { cv.width = ctx.canvas.width; cv.height = ctx.canvas.height; }
    var c2 = cv.getContext('2d');
    c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, cv.width, cv.height);
    c2.setTransform(ctx.getTransform());
    var items = [];
    for (var q = 0; q < vis.length; q++) {
      var k = vis[q], i = idx[k];
      if (!(st.rings[k * nl] > 0)) continue;
      var p = proj(i), ppk = QC.pxPerKm(ev.lat[i], z) * scale, outer = st.rings[k * nl] * ppk;
      if (p[0] < -outer || p[1] < -outer || p[0] > W + outer || p[1] > H + outer) continue;
      var f = (T - ev.t[i]) / st.life[k];
      items.push([k, p, ppk, 0.3 + 0.7 * Math.pow(1 - Math.max(0, Math.min(1, f)), S.fadePow)]);
    }
    for (var n = 0; n < nl; n++) {
      var is = QC.intensityStyle(QC.MAXI[lv[n]]);
      c2.fillStyle = is.fill;
      for (var a = 0; a < items.length; a++) {
        var rr = st.rings[items[a][0] * nl + n] * items[a][2];
        if (rr <= 0) continue;
        c2.globalAlpha = items[a][3];
        c2.beginPath(); c2.arc(items[a][1][0], items[a][1][1], rr, 0, 2 * Math.PI); c2.fill();
      }
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.5; ctx.drawImage(cv, 0, 0); ctx.restore();
    // 境目の線：震度4以上の段だけ（弱い段の線は数が多く、地図を埋めるので引かない）
    for (n = 0; n < nl; n++) {
      if (QC.MAXI[lv[n]] < 4) continue;
      var s2 = QC.intensityStyle(QC.MAXI[lv[n]]);
      ctx.strokeStyle = s2.stroke; ctx.lineWidth = 1 * scale;
      for (a = 0; a < items.length; a++) {
        var r2 = st.rings[items[a][0] * nl + n] * items[a][2];
        if (r2 <= 0) continue;
        ctx.globalAlpha = 0.7 * items[a][3];
        ctx.beginPath(); ctx.arc(items[a][1][0], items[a][1][1], r2, 0, 2 * Math.PI); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  /** 同心円の表示で、1 地震分の点（震央。色は「色の意味」）。輪は drawRingLayers がまとめて描く。 */
  function drawRings(ctx, k, i, p, f, sty, scale, W, H) {
    var ev = st.ev, nl = st.ringLv.length, ppk = QC.pxPerKm(ev.lat[i], map.getZoom()) * scale;
    if (p[0] < -4 || p[1] < -4 || p[0] > W + 4 || p[1] > H + 4) return -1;
    var fade = Math.pow(1 - Math.max(0, Math.min(1, f)), S.fadePow);
    ctx.fillStyle = sty.fill; ctx.strokeStyle = sty.stroke;
    var d = Math.max(1.4, Math.min(4, 0.5 + ev.mag[i] * 0.45)) * scale;
    ctx.globalAlpha = Math.max(0.4, fade);
    ctx.beginPath(); ctx.arc(p[0], p[1], d, 0, 2 * Math.PI); ctx.fill();
    if (sty.stroke !== sty.fill || sty.dash) { ctx.lineWidth = 0.8 * scale; ctx.stroke(); }
    return Math.max(d, 3 * scale);
  }

  function onHover(e) {
    if (!st.drawn || st.rec) return;
    var rc = map.getContainer().getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    var best = null, bd = Infinity;
    for (var n = st.drawn.length - 1; n >= 0; n--) {   // 上に描いた（小さい）ものを先に
      var d = st.drawn[n], dist = Math.hypot(d[0] - x, d[1] - y);
      if (dist <= Math.max(d[2], 4) && dist < bd) { bd = dist; best = d; }
    }
    var tip = $('tip');
    if (!best) { tip.style.display = 'none'; return; }
    var ev = st.ev, i = best[3], dep = ev.dep[i], mx = ev.maxi[i];
    var sph = '';
    if (S.shape === 'rings' && st.rings) {
      var kr = QC.lowerBound(st.f.idx, i), nl = st.ringLv.length, parts = [];
      for (var n = 0; n < nl; n++) {
        var v = st.rings[kr * nl + n];
        if (v > 0) parts.push('震度' + st.ringLv[n].replace('-', '弱').replace('+', '強') + '以上 ' + Math.round(v) + 'km');
      }
      sph = parts.length ? '　推定の輪：' + parts.join('・') : (ev.mag[i] < S.ringMinM ? '　（輪は M' + S.ringMinM + '以上）' : '　推定では震度' + S.ringFrom + 'に届かない');
    } else if (S.shape === 'sphere' && st.sphR && S.sphereKind === 'geom') {
      var kg = QC.lowerBound(st.f.idx, i);
      sph = '　図式：球の半径' + Math.round(st.sphR[kg]) + 'km、地表の円の半径' + Math.round(st.sphS[kg]) + 'km';
    } else if (S.shape === 'sphere' && st.sphR) {
      var kk = QC.lowerBound(st.f.idx, i);
      sph = '　推定：震度' + S.sphereInt.replace('-', '弱').replace('+', '強') + '以上が地表で半径' +
        Math.round(st.sphS[kk]) + 'km（球の半径' + Math.round(st.sphR[kk]) + 'km）';
    }
    tip.textContent = QC.formatDateTime(ev.t[i]) + '　M' + ev.mag[i].toFixed(1) + '　深さ' +
      (isNaN(dep) ? '不明' : (Math.round(dep * 10) / 10) + 'km') + '　観測' + QC.MAXI_LABEL[mx] +
      '　（' + QC.SRC_LABEL[ev.src[i]] + '）' + sph;
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 12, rc.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = (y + 14) + 'px';
  }

  // ---------------------------------------------------------------- 凡例
  function legendItems() {
    if (S.colorMode === 'depth') return { title: '深さ', items: QC.DEP_COLORS.map(function (b) { return { c: b.c, label: b.label }; }) };
    if (S.colorMode === 'maxi') return { title: '最大震度', items: QC.INT_STYLES.concat([QC.INT_UNKNOWN]).map(function (s) {
      return { c: s.fill, stroke: s.stroke, dash: s.dash, label: s.label }; }) };
    if (S.colorMode === 'age') return { title: '発生からの経過', items: [0, 0.5, 1].map(function (f) {
      return { c: QC.ageColor(f), label: f === 0 ? '発生直後' : f === 1 ? '消える直前' : '半ば' }; }) };
    return { title: 'マグニチュード', items: QC.MAG_COLORS.filter(function (b) { return b.lo === -Infinity ? S.magMin < 1 : true; })
      .map(function (b) { return { c: b.c, label: b.label, m: b.lo === -Infinity ? 0.5 : b.lo }; }) };
  }
  function renderLegend() {
    var L = legendItems(), h = '<div class="ttl">' + L.title + '</div>';
    L.items.forEach(function (it) {
      var r = it.m != null && S.shape === 'circle' ? Math.max(3, Math.min(QC.radius(it.m, S), 14)) : 5;
      h += '<div class="row"><span class="sw" style="width:' + 2 * r + 'px;height:' + 2 * r + 'px;background:' +
        it.c + '99;border-color:' + (it.stroke || it.c) + (it.dash ? ';border-style:dashed' : '') + '"></span>' + it.label + '</div>';
    });
    if (S.shape === 'rings') {
      h += '<div class="ttl" style="margin-top:6px">推定震度の輪</div><div style="display:flex;flex-wrap:wrap;gap:2px 6px;max-width:150px">';
      QC.RING_LEVELS.slice(QC.RING_LEVELS.indexOf(S.ringFrom)).forEach(function (lv) {
        var is = QC.intensityStyle(QC.MAXI[lv]);
        h += '<span style="display:inline-flex;align-items:center;gap:2px"><span class="sw" style="width:10px;height:10px;background:' + is.fill + '55;border-color:' + is.stroke + '"></span>' + lv.replace('-', '弱').replace('+', '強') + '</span>';
      });
      h += '</div><div class="note" style="color:#333;max-width:150px">' + ringNote() + '</div>';
    }
    if (S.shape === 'sphere') h += '<svg width="150" height="62" viewBox="0 0 150 62" aria-hidden="true">' +
      '<circle cx="31" cy="31" r="28" fill="#7a2bb3" fill-opacity=".06" stroke="#7a2bb3" stroke-opacity=".8"/>' +
      '<circle cx="31" cy="31" r="15" fill="#7a2bb3" fill-opacity=".38"/><rect x="29.5" y="29.5" width="3" height="3" fill="#7a2bb3"/>' +
      '<text x="64" y="16" font-size="10" fill="#333">外の輪＝球</text><text x="64" y="34" font-size="10" fill="#333">塗り＝地表</text>' +
      '<text x="64" y="52" font-size="10" fill="#333">点＝震央</text></svg>' +
      '<div class="note" style="color:#333;max-width:150px">' + sphereNote() + '</div>';
    else if (S.colorMode !== 'mag' && S.shape === 'circle') h += '<div class="note" style="color:#333">円の大きさ＝M</div>';
    $('legend').innerHTML = h;
  }
  function ringNote() {
    return '推定（司・翠川1999）：震源から推定震度の境目ごとの範囲を地表に描いた輪。M' + S.ringMinM + '以上の地震だけ。点＝震央（色は' + legendItems().title + '）';
  }
  function sphereNote() {
    if (S.sphereKind === 'geom') return '図式（揺れの推定ではない）：外の輪＝M で大きさを決めた震源の球（深いほど薄く）、塗り＝球が地表に出る円（深いほど小さい）、点＝震央';
    var k = S.sphereInt.replace('-', '弱').replace('+', '強');
    return '推定（司・翠川1999）：外の輪＝震源から震度' + k + '以上が届く距離の球（深いほど薄く）、塗り＝地表で震度' + k + '以上の範囲、点＝震央';
  }
  /** 動画用：凡例を canvas に描く */
  function drawLegendCanvas(ctx, x, y, scale) {
    var L = legendItems(), rowH = 20 * scale, w = 118 * scale, h = (24 + L.items.length * 20 + (S.colorMode !== 'mag' ? 18 : 0)) * scale;
    ctx.globalAlpha = 0.88; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
    ctx.fillStyle = '#1d2433'; ctx.font = 'bold ' + 12 * scale + 'px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(L.title, x + 8 * scale, y + 12 * scale);
    L.items.forEach(function (it, n) {
      var cy = y + 24 * scale + n * rowH + rowH / 2, r = (it.m != null && S.shape === 'circle' ? Math.max(3, Math.min(QC.radius(it.m, S), 9)) : 5) * scale;
      ctx.beginPath(); ctx.arc(x + 18 * scale, cy, r, 0, 2 * Math.PI);
      ctx.fillStyle = it.c; ctx.globalAlpha = 0.6; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = it.stroke || it.c; ctx.lineWidth = 1.5 * scale;
      if (it.dash) ctx.setLineDash([3 * scale, 2 * scale]);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#1d2433'; ctx.font = 12 * scale + 'px sans-serif'; ctx.fillText(it.label, x + 34 * scale, cy);
    });
    if (S.colorMode !== 'mag' && S.shape === 'circle') ctx.fillText('円の大きさ＝M', x + 8 * scale, y + h - 10 * scale);
    if (S.shape === 'sphere' || S.shape === 'rings') {
      var words = S.shape === 'rings' ? '輪の色＝推定震度（' + QC.RING_LEVELS.slice(QC.RING_LEVELS.indexOf(S.ringFrom)).map(function (lv) { return lv.replace('-', '弱').replace('+', '強'); }).join('・') + '）。' + ringNote() : sphereNote(), lines = [], cur = '', maxW = 230 * scale;
      ctx.font = 11 * scale + 'px sans-serif';
      for (var c = 0; c < words.length; c++) { if (ctx.measureText(cur + words[c]).width > maxW) { lines.push(cur); cur = ''; } cur += words[c]; }
      lines.push(cur);
      var by = y + h + 4 * scale;
      ctx.globalAlpha = 0.88; ctx.fillStyle = '#fff'; ctx.fillRect(x, by, maxW + 12 * scale, (lines.length * 15 + 6) * scale); ctx.globalAlpha = 1;
      ctx.fillStyle = '#1d2433'; ctx.textBaseline = 'top';
      lines.forEach(function (L, n) { ctx.fillText(L, x + 6 * scale, by + (3 + n * 15) * scale); });
    }
  }

  // ---------------------------------------------------------------- グラフ（M-T 図と 1 日の回数）
  var CH = { left: 34, right: 8, top: 8, bottom: 16 };
  function chartX(t, W) { return CH.left + (W - CH.left - CH.right) * (t - st.t0) / (st.t1 - st.t0); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }
  function fitCanvas(c) {
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = +c.getAttribute('height');
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px'; }
    return { W: w, H: h, dpr: dpr };
  }
  var MT_YMIN = -1, MT_YMAX = 9.6;
  /** M-T 図の土台（点・目盛り・出どころの帯）を、W×H の大きさで新しい canvas に描く */
  function buildMtBase(W, H, dpr, ink, sub) {
    var c = document.createElement('canvas'); c.width = W * dpr; c.height = H * dpr;
    var ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
    var y0 = Math.min(MT_YMIN, Math.floor(S.magMin)), ih = H - CH.top - CH.bottom;
    var yOf = function (m) { return CH.top + ih * (1 - (m - y0) / (MT_YMAX - y0)); };
    ctx.font = '10px sans-serif'; ctx.fillStyle = sub; ctx.strokeStyle = sub; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    for (var m = Math.ceil(y0); m <= MT_YMAX; m++) {
      if (m % 2 && MT_YMAX - y0 > 9) continue;
      ctx.beginPath(); ctx.moveTo(CH.left, yOf(m)); ctx.lineTo(W - CH.right, yOf(m)); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (m = Math.ceil(y0); m <= MT_YMAX; m++) if (!(m % 2 && MT_YMAX - y0 > 9)) ctx.fillText('M' + m, CH.left - 4, yOf(m));
    drawTimeAxis(ctx, W, H, sub);
    // 出どころの帯（上端）：確定 灰、速報 橙、発表直後 赤
    var srcCol = { C: '#9e9e9e', P: '#f08c00', Q: '#d32f2f' };
    for (var d = QC.floorDayJst(st.t0); d < st.t1; d += DAY) {
      var info = st.manifest.days[QC.formatDate(d)];
      if (!info) continue;
      ctx.fillStyle = srcCol[info.src] || '#000';
      var xa = Math.max(chartX(d, W), CH.left), xb = chartX(Math.min(d + DAY, st.t1), W);
      ctx.fillRect(xa, 0, Math.max(xb - xa, 0.5), 3);
    }
    drawCatalogChanges(ctx, W, H, sub, false);
    var ev = st.ev, idx = st.f.idx;
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], mg = ev.mag[i];
      ctx.fillStyle = S.colorMode === 'age' ? sub : S.colorMode === 'maxi' ? QC.styleOf('maxi', mg, 0, 0, ev.maxi[i]).stroke
        : QC.colorOf(S.colorMode, mg, ev.dep[i], 0);
      ctx.globalAlpha = mg >= 4 ? 0.9 : 0.45;
      var s = mg >= 5 ? 3 : mg >= 3 ? 2 : 1.2;
      ctx.fillRect(chartX(ev.t[i], W) - s / 2, yOf(mg) - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    return c;
  }
  function drawCatalogChanges(ctx, W, H, sub, withLabel) {
    CATALOG_CHANGES.forEach(function (c) {
      var t = QC.dateToMs(c.t);
      if (t <= st.t0 || t >= st.t1) return;
      var x = chartX(t, W);
      ctx.save(); ctx.strokeStyle = sub; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, CH.top); ctx.lineTo(x, H - CH.bottom); ctx.stroke(); ctx.restore();
      if (withLabel) { ctx.fillStyle = sub; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(c.label, x + 3, CH.top + 10); }
    });
  }
  function drawTimeAxis(ctx, W, H, sub) {
    ctx.fillStyle = sub; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '10px sans-serif';
    QC.timeTicks(st.t0, st.t1, Math.max(3, Math.floor(W / 70))).forEach(function (tk) {
      var x = chartX(tk.t, W);
      ctx.fillRect(x, H - CH.bottom, 1, 3); ctx.fillText(tk.label, x, H - 3);
    });
  }
  function buildCntBase(W, H, dpr, sub) {
    var c = document.createElement('canvas'); c.width = W * dpr; c.height = H * dpr;
    var ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
    var dc = QC.dailyCounts(st.ev, st.f.idx, st.t0, st.t1), mx = 1;
    for (var j = 0; j < dc.counts.length; j++) mx = Math.max(mx, dc.counts[j]);
    var ih = H - CH.top - CH.bottom;
    ctx.fillStyle = cssVar('--accent');
    for (j = 0; j < dc.counts.length; j++) {
      if (!dc.counts[j]) continue;
      var xa = chartX(dc.day0 + j * DAY, W), xb = chartX(dc.day0 + (j + 1) * DAY, W), h = ih * dc.counts[j] / mx;
      ctx.fillRect(Math.max(xa, CH.left), CH.top + ih - h, Math.max(xb - Math.max(xa, CH.left) - 0.3, 0.6), h);
    }
    ctx.fillStyle = sub; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(mx.toLocaleString(), CH.left - 4, CH.top - 2);
    ctx.textBaseline = 'bottom'; ctx.fillText('0', CH.left - 4, CH.top + ih + 4);
    ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('1日あたりの回数（描く対象）', CH.left + 4, CH.top - 2); ctx.restore();
    drawCatalogChanges(ctx, W, H, sub, true);
    drawTimeAxis(ctx, W, H, sub);
    return c;
  }
  function renderChartBases() {
    if (!st.f) return;
    var ink = cssVar('--ink'), sub = cssVar('--sub');
    var a = fitCanvas($('mtChart')), b = fitCanvas($('cntChart'));
    st.mtBase = buildMtBase(a.W, a.H, a.dpr, ink, sub);
    st.cntBase = buildCntBase(b.W, b.H, b.dpr, sub);
  }
  function drawCharts() {
    if (!st.mtBase) return;
    [['mtChart', st.mtBase], ['cntChart', st.cntBase]].forEach(function (p) {
      var c = $(p[0]), g = fitCanvas(c), ctx = c.getContext('2d');
      if (p[1].width !== c.width) { renderChartBases(); return drawCharts(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(p[1], 0, 0);
      ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
      var x = chartX(st.T, g.W);
      ctx.globalAlpha = 0.12; ctx.fillStyle = cssVar('--sub');      // まだ来ていない時間を薄く覆う
      ctx.fillRect(x, 0, g.W - CH.right - x, g.H - CH.bottom); ctx.globalAlpha = 1;
      ctx.fillStyle = cssVar('--cursor'); ctx.fillRect(x - 1, 0, 2, g.H - CH.bottom);
    });
  }
  function bindCharts() {
    ['mtChart', 'cntChart'].forEach(function (id) {
      var c = $(id), down = false;
      var go = function (e) {
        var rc = c.getBoundingClientRect(), W = rc.width, x = e.clientX - rc.left;
        setT(st.t0 + (st.t1 - st.t0) * (x - CH.left) / (W - CH.left - CH.right));
        writeHash();
      };
      c.addEventListener('pointerdown', function (e) { if (st.rec) return; down = true; c.setPointerCapture(e.pointerId); go(e); });
      c.addEventListener('pointermove', function (e) { if (down) go(e); });
      c.addEventListener('pointerup', function () { down = false; });
    });
  }

  // ---------------------------------------------------------------- 再生
  function play(on) {
    st.playing = on;
    $('playBtn').textContent = on ? '❚❚ 止める' : '▶ 再生';
    if (on) {
      if (st.T >= st.t1) setT(st.t0);
      st.lastTs = 0; requestAnimationFrame(tick);
    } else writeHash();
  }
  function tick(ts) {
    if (!st.playing) return;
    if (st.lastTs) {
      var dt = Math.min((ts - st.lastTs) / 1000, 0.25);
      setT(st.T + S.step * S.fps * dt);
      if (st.T >= st.t1) { play(false); return; }
    }
    st.lastTs = ts;
    requestAnimationFrame(tick);
  }
  function bindTime() {
    $('playBtn').onclick = function () { play(!st.playing); };
    $('fwdBtn').onclick = function () { play(false); setT(st.T + S.step); writeHash(); };
    $('backBtn').onclick = function () { play(false); setT(st.T - S.step); writeHash(); };
    $('startBtn').onclick = function () { play(false); setT(st.t0); writeHash(); };
    $('timeSl').addEventListener('input', function () { setT(sliderToT(+this.value), true); });
    $('timeSl').addEventListener('change', writeHash);
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || st.rec) return;
      if (e.key === ' ') { e.preventDefault(); play(!st.playing); }
      if (e.key === 'ArrowRight') { setT(st.T + S.step); }
      if (e.key === 'ArrowLeft') { setT(st.T - S.step); }
    });
  }

  // ---------------------------------------------------------------- 期間
  function dataRange() {
    var ms = Object.keys(st.manifest.months).sort();
    var first = ms.length ? QC.parseJst(st.manifest.months[ms[0]].first) : Date.now();
    var last = ms.length ? QC.parseJst(st.manifest.months[ms[ms.length - 1]].last) : Date.now();
    return { first: first, last: last };
  }
  function onPeriodChange() {
    var a = QC.dateToMs($('t0').value), b = QC.dateToMs($('t1').value);
    if (isNaN(a) || isNaN(b) || b < a) { $('periodNote').innerHTML = '<span class="warn">期間が正しくありません</span>'; return; }
    S.t0 = $('t0').value; S.t1 = $('t1').value;
    applyPeriod();
  }
  function applyPeriod() {
    var R = dataRange();
    var t1 = S.t1 ? QC.dateToMs(S.t1) + DAY : QC.floorDayJst(R.last) + DAY;
    var t0 = S.t0 ? QC.dateToMs(S.t0) : t1 - 365 * DAY;
    st.t0 = t0; st.t1 = t1;
    $('t0').value = QC.formatDate(t0); $('t1').value = QC.formatDate(t1 - 1);
    $('t0').min = $('t1').min = QC.formatDate(R.first); $('t0').max = $('t1').max = QC.formatDate(R.last);
    var notes = [];
    if (t0 < QC.floorDayJst(R.first)) notes.push('期間の始めはデータより前です（データは ' + QC.formatDate(R.first) + ' から）');
    CATALOG_CHANGES.forEach(function (c) { var t = QC.dateToMs(c.t); if (t > t0 && t < t1) notes.push(c.note); });
    if (t1 > R.last + DAY) notes.push('期間の終わりはデータより後です（データは ' + QC.formatDateTime(R.last) + ' まで）');
    $('periodNote').innerHTML = notes.map(function (n) { return '<span class="warn">' + n + '</span>'; }).join('<br>');
    // 開いたときは期間の最後（最新の状態）。再生を押すと最初から始まる
    var T = st.hashT && st.hashT >= t0 && st.hashT <= t1 ? st.hashT : Math.min(t1, st.dataEnd);
    st.hashT = null;
    st.T = T; syncSlider();
    writeHash();
    return loadPeriod();
  }

  function renderDataNote() {
    var m = st.manifest, R = dataRange(), recent = (m.revisions || []).filter(function (r) {
      return Date.now() - QC.parseJst(r.at.slice(0, 16)) < 30 * DAY; });
    var failedInt = Object.keys(m.days).filter(function (d) { return m.days[d].intensity === 'failed'; });
    var h = 'データ：' + QC.formatDate(R.first) + ' 〜 ' + QC.formatDateTime(R.last) + '（日本時間）<br>' +
      '最終取得：' + (m.updated || '不明').replace('T', ' ').slice(0, 16);
    if (recent.length) h += '<br>直近30日に速報が書き換わった日：' + recent.length;
    if (failedInt.length) h += '<br><span class="warn">震度を取得できなかった日：' + failedInt.length + '（' + failedInt.slice(-3).join('、') + ' など）</span>';
    if ((m.errors || []).length) h += '<br><span class="warn">最近の取得の失敗：' + m.errors[m.errors.length - 1].what + '（' + m.errors[m.errors.length - 1].at.slice(0, 16).replace('T', ' ') + '）</span>';
    $('dataNote').innerHTML = h;
  }

  // ---------------------------------------------------------------- 動画
  function pickMime() {
    var c = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < c.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i];
    return null;
  }
  /** 地図のタイル（読み込み済みの img）を 1 枚の canvas に写す */
  function snapshotTiles(W, H, scale) {
    var c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale;
    var ctx = c.getContext('2d'), rc = map.getContainer().getBoundingClientRect(), miss = 0;
    ctx.fillStyle = '#cfe3f2'; ctx.fillRect(0, 0, c.width, c.height);
    map.getContainer().querySelectorAll('.leaflet-tile-pane img').forEach(function (img) {
      var r = img.getBoundingClientRect();
      if (r.right < rc.left || r.bottom < rc.top || r.left > rc.right || r.top > rc.bottom) return;
      if (!img.complete || !img.naturalWidth) { miss++; return; }
      var op = +getComputedStyle(img.closest('.leaflet-layer') || img).opacity || 1;
      ctx.globalAlpha = op;
      ctx.drawImage(img, (r.left - rc.left) * scale, (r.top - rc.top) * scale, r.width * scale, r.height * scale);
    });
    ctx.globalAlpha = 1;
    return { canvas: c, missing: miss };
  }
  function drawFrame(ctx, bg, W, H, scale, chartH, mtBase) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    var tr = viewTransform();
    drawQuakes(ctx, st.T, function (i) { return [(st.px[i] * tr.k - tr.ox) * scale, (st.py[i] * tr.k - tr.oy) * scale]; }, scale, W * scale, H * scale);
    // 左上の日付（白い縁取り）
    ctx.font = 'bold ' + 26 * scale + 'px sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.lineWidth = 5 * scale; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round';
    var clock = QC.formatClock(st.T, S.step);
    ctx.strokeText(clock, 12 * scale, 10 * scale); ctx.fillStyle = '#1d2433'; ctx.fillText(clock, 12 * scale, 10 * scale);
    var di = dayInfo(st.T);
    if (di.text) { ctx.font = 12 * scale + 'px sans-serif'; ctx.lineWidth = 3 * scale; ctx.strokeText(di.text, 14 * scale, 42 * scale); ctx.fillText(di.text, 14 * scale, 42 * scale); }
    drawLegendCanvas(ctx, 10 * scale, 64 * scale, scale);
    // 出典（右下）
    ctx.font = 11 * scale + 'px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    var cw = ctx.measureText(CREDIT).width;
    ctx.globalAlpha = 0.8; ctx.fillStyle = '#fff'; ctx.fillRect(W * scale - cw - 12 * scale, H * scale - 18 * scale, cw + 12 * scale, 18 * scale);
    ctx.globalAlpha = 1; ctx.fillStyle = '#1d2433'; ctx.fillText(CREDIT, W * scale - 6 * scale, H * scale - 4 * scale);
    if (chartH) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, H * scale, W * scale, chartH * scale);
      ctx.drawImage(mtBase, 0, H * scale);
      var x = chartX(st.T, W) * scale;
      ctx.globalAlpha = 0.12; ctx.fillStyle = '#5b6475'; ctx.fillRect(x, H * scale, W * scale - x, (chartH - CH.bottom) * scale);
      ctx.globalAlpha = 1; ctx.fillStyle = '#d81b60'; ctx.fillRect(x - scale, H * scale, 2 * scale, (chartH - CH.bottom) * scale);
    }
  }
  function startRecording() {
    var mime = pickMime(), note = $('recNote');
    if (!mime) { note.innerHTML = '<span class="warn">このブラウザは動画の書き出しに対応していません（Chrome・Edge・Safari・Firefox の新しい版で使えます）</span>'; return; }
    play(false);
    var W = map.getSize().x, H = map.getSize().y, scale = +$('vidScale').value, chartH = $('vidChart').checked ? 110 : 0;
    var snap = snapshotTiles(W, H, scale);
    if (snap.missing) { note.innerHTML = '<span class="warn">地図のタイルがまだ読み込み中です（' + snap.missing + ' 枚）。少し待ってからもう一度押してください。</span>'; return; }
    var cv = document.createElement('canvas'); cv.width = W * scale; cv.height = (H + chartH) * scale;
    // 幅と高さは偶数にする（動画の符号化の都合）
    cv.width -= cv.width % 2; cv.height -= cv.height % 2;
    var ctx = cv.getContext('2d');
    try { ctx.drawImage(snap.canvas, 0, 0); cv.toDataURL('image/png').length; }
    catch (e) { note.innerHTML = '<span class="warn">地図の画像を動画に入れられませんでした（' + e.message + '）</span>'; return; }
    var mtBase = chartH ? buildMtBase(W, chartH, scale, '#1d2433', '#5b6475') : null;
    var stream = cv.captureStream(0), track = stream.getVideoTracks()[0];
    var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 * scale }), chunks = [];
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    var total = Math.ceil((st.t1 - st.t0) / S.step) + 1, frame = 0, aborted = false, fps = S.fps;
    st.rec = { stop: function () { aborted = true; } };
    map.dragging.disable(); map.scrollWheelZoom.disable(); map.doubleClickZoom.disable(); map.touchZoom.disable(); map.keyboard.disable();
    $('recBtn').disabled = true; $('recStop').disabled = false; $('playBtn').disabled = true;
    rec.onstop = function () {
      map.dragging.enable(); map.scrollWheelZoom.enable(); map.doubleClickZoom.enable(); map.touchZoom.enable(); map.keyboard.enable();
      $('recBtn').disabled = false; $('recStop').disabled = true; $('playBtn').disabled = false; st.rec = null;
      if (!chunks.length) { note.innerHTML = '<span class="warn">動画が空でした</span>'; return; }
      var ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm', blob = new Blob(chunks, { type: mime.split(';')[0] });
      var a = document.createElement('a'), name = '地震_' + QC.formatDate(st.t0) + '_' + QC.formatDate(st.t1 - 1) + '.' + ext;
      a.href = URL.createObjectURL(blob); a.download = name; a.textContent = name + ' を保存（' + (blob.size / 1048576).toFixed(1) + 'MB）';
      note.innerHTML = (aborted ? '途中で止めました（' + frame + ' / ' + total + ' コマ）。' : '書き出しました（' + frame + ' コマ）。') + '<br>';
      note.appendChild(a);
      a.click();
    };
    rec.start(1000);
    setT(st.t0);
    var startWall = performance.now();
    (function next() {
      if (aborted || frame >= total) { rec.stop(); setT(st.t0 + Math.min(frame, total - 1) * S.step); return; }
      setT(st.t0 + frame * S.step);
      drawFrame(ctx, snap.canvas, W, H, scale, chartH, mtBase);
      track.requestFrame();
      frame++;
      if (frame % 10 === 0) note.textContent = '書き出し中… ' + frame + ' / ' + total + ' コマ（このタブを前面に出したままにしてください）';
      // 1 コマを 1/fps 秒の間隔で渡す（MediaRecorder は実時間で刻むため）
      var wait = startWall + frame * 1000 / fps - performance.now();
      setTimeout(next, Math.max(0, wait));
    })();
  }

  // ---------------------------------------------------------------- 起動
  function boot() {
    readHash();
    bindControls();
    applyShapeClass();
    initMap();
    bindTime();
    bindCharts();
    renderLegend();
    $('recBtn').onclick = startRecording;
    $('recStop').onclick = function () { if (st.rec) st.rec.stop(); };
    window.addEventListener('resize', function () { renderChartBases(); drawAll(); });
    // 利用者が # を書き換えたら読み直す（自分で書き換えるときは replaceState なので発火しない）
    window.addEventListener('hashchange', function () { location.reload(); });
    return fetchJson('data/manifest.json').then(function (m) {
      st.manifest = m;
      st.dataEnd = dataRange().last;
      renderDataNote();
      return applyPeriod();
    }).catch(function (e) {
      setStatus('データを読み込めませんでした：' + e.message, true);
    });
  }
  window.__app = { S: S, st: st, setT: setT, boot: boot, drawFrame: drawFrame, QC: QC, getMap: function () { return map; } };
  boot();
})();
