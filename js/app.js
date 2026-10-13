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
  // 1919〜2023 年の確定版を数えて確かめた（2026-10-13）：M5以上は 1924 年以降 年およそ 70〜190 回で大きな段差が無い。
  // M4以上・M3以上は 1983 年と 1997 年 10 月に段差がある（観測と処理が変わったため。地震が増えたのではない）
  var CATALOG_CHANGES = [
    { t: '1983-01-01', label: '震源の数が増える（観測の変化）', note: '1983年から震源の数が増え、深さは1km刻みで求めるようになります（それまでは10km刻みなど）。1983年をまたいで回数を比べるならM5以上が目安です。' },
    { t: '1997-10-01', label: '一元化（大学・防災科研の観測も合わせる）', note: '1997年10月から気象庁・大学・防災科研などの観測を合わせて震源を決める（一元化）ようになり、小さな地震の数が大きく増えます。1997年をまたいで回数を比べるならM5以上（2000年以降どうしならM4以上）が目安です。' },
    { t: '2016-04-01', label: '自動処理の震源が加わる', note: '2016年4月から自動処理で決めた震源が加わり、主に M1 未満の回数が増えています。年をまたいで回数を比べるなら M2 以上が目安です。' }];

  var DEFAULTS = {
    srcShow: '', srcNearKm: 10, fixedDep: false,
    magMin: 1, intMin: 0, depMin: 0, depMax: 1000, lowFreq: true, reference: true, lfeOnly: false,
    colorMode: 'mag', sizeScale: 'exp', r1: 1.5, sizeGrowth: 1.7,
    life1: 3, lifeGrowth: 1.8, lifeMin: 1 / 24, lifeMax: 120,
    ripple: true, rippleMinM: 3, rippleFrames: 12,
    shape: 'circle', sphereKind: 'est', sphereInt: '4', sphereAmp: 1.31, sphereFade: 300, sphereR5: 30, sphereGrowth: 2,
    ringFrom: '3', ringMinM: 3.5,
    mode: 'time', aggWindow: '7', aggMethod: 'kmeans', kmWeight: 'none', aggLevel: 6, kmDepthW: 1, kmKmPerDay: 3, xsSize: 'M', aggLabel: 'meq', aggCell: 56, aggRatio: 1.35, aggMin: 7, aggMax: 64, aggBase: 2,
    endSeq: true, endSumSec: 3, endStatsSec: 7,
    bearing: 0, xsDepth: 'equal', showXsec: true, showMt: true, chartView: true,
    vol: 0.5, viewH: 100, dShrink: true, dBlur: 1, dHaze: 1, hazeMin: 0.25, keepBig: true, keepBigM: 7,
    fillAlpha: 0.55, strokeAlpha: 0.9, fadePow: 0.7,
    step: 6 * HOUR, fps: 30, base: 'pale', t0: '', t1: '',
    bbox: [20, 120, 50, 156]
  };
  var NUM = ['magMin', 'intMin', 'depMin', 'depMax', 'r1', 'sizeGrowth', 'life1', 'lifeGrowth', 'lifeMax',
             'rippleMinM', 'step', 'fps', 'sphereAmp', 'sphereFade', 'sphereR5', 'sphereGrowth', 'ringMinM',
             'vol', 'viewH', 'dBlur', 'dHaze', 'hazeMin', 'keepBigM', 'bearing', 'aggLevel', 'kmDepthW', 'kmKmPerDay', 'aggCell', 'aggRatio', 'endSumSec', 'endStatsSec', 'srcNearKm'];
  var BOOL = ['fixedDep', 'lowFreq', 'lfeOnly', 'reference', 'ripple', 'dShrink', 'keepBig', 'showXsec', 'showMt', 'chartView', 'endSeq'];
  var STR = ['colorMode', 'sizeScale', 'base', 't0', 't1', 'shape', 'sphereInt', 'sphereKind', 'ringFrom', 'xsDepth', 'mode', 'aggLabel', 'aggWindow', 'xsSize', 'aggMethod', 'srcShow', 'kmWeight'];

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
    if (p.get('showNankai') === '1' && !p.has('srcShow')) S.srcShow = 'nankai';   // 前の版の URL（南海トラフだけだったころ）
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
      // つまみ：動かしている間も反映する。ただし重い計算につながるもの（DEFER）は、離して位置が決まってから計算する
      if (el.type === 'range') el.addEventListener('input', function () {
        if (DEFER.indexOf(k) >= 0) return previewRange(k, el);
        el.dispatchEvent(new Event('change'));
      });
      el.addEventListener('change', function () {
        if (k === 't0' || k === 't1') return onPeriodChange(k);
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
    // 重ねる想定震源域：海域ごとのチェック → srcShow（海域の名前をカンマでつなぐ）
    var boxes = document.querySelectorAll('#srcBoxes input[data-src]');
    boxes.forEach(function (el) {
      el.checked = srcIds().indexOf(el.dataset.src) >= 0;
      el.addEventListener('change', function () {
        S.srcShow = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.dataset.src; }).join(',');
        settingsChanged('srcShow');
      });
    });
  }
  function srcIds() { return S.srcShow ? S.srcShow.split(',') : []; }
  var DEFER = ['aggLevel', 'bearing'];
  /** 重いつまみを動かしている間：表示だけ変える（マーカーの数は数字だけ、地図の向きは今の塊のまま回す） */
  function previewRange(k, el) {
    if (k === 'aggLevel') { $('aggKV').textContent = '段階' + el.value + '（' + QC.kOfLevel(+el.value) + '個）…離すと計算'; return; }
    if (k === 'bearing') { S.bearing = +el.value; st.live = true; layoutRot(); drawAll(); }
  }
  var REFILTER = ['magMin', 'intMin', 'depMin', 'depMax', 'lowFreq', 'lfeOnly', 'reference'];
  var RELIFE = ['life1', 'lifeGrowth', 'lifeMax'];
  var RESPHERE = ['sphereInt', 'sphereAmp', 'sphereKind', 'sphereR5', 'sphereGrowth', 'ringFrom', 'ringMinM'];
  function settingsChanged(k) {
    if (k === 'srcShow') { applySrc(); renderLegend(); if (S.colorMode === 'src') st.srcKey = null; }
    // 低周波地震だけにしたら、M の下限を下げる（ほとんど M1 未満のため）。そのことを画面に書く
    if (k === 'lfeOnly') {
      if (S.lfeOnly && S.magMin > -1) { S.lfeMagPrev = S.magMin; S.magMin = -2; $('magMin').value = -2; }
      else if (!S.lfeOnly && S.lfeMagPrev != null) { S.magMin = S.lfeMagPrev; $('magMin').value = S.magMin; S.lfeMagPrev = null; }
      $('lfeNote').style.display = S.lfeOnly ? 'block' : 'none';
    }
    if (k === 'fixedDep' && st.ev) { st.fixedN = QC.applyFixedDepth(st.ev, S.fixedDep); renderFixedNote(); rebuild(); renderChartBases(); }
    if (REFILTER.indexOf(k) >= 0) rebuild();
    else if (RELIFE.indexOf(k) >= 0) { computeLife(); }
    else if (RESPHERE.indexOf(k) >= 0) { computeSpheres(); }
    if (k === 'shape' || k === 'sphereKind' || k === 'vol') applyShapeClass();
    if (k === 'bearing') { st.live = false; layoutRot(); scheduleViewIdx(); }
    if (k === 'mode' || k === 'aggCell' || k === 'aggMethod' || k === 'aggLevel' || k === 'kmWeight') { st.agg = null; cancelEnding(true); applyShapeClass(); }
    if (k === 'mode' && S.mode === 'sum' && st.playing) play(false);
    if (k === 'xsSize') applyXsecSize();
    if (k === 'showXsec' || k === 'showMt') applyChartVisibility();
    if (k === 'chartView') { computeViewIdx(); renderChartBases(); }
    if (k === 'colorMode' || REFILTER.indexOf(k) >= 0) renderChartBases();
    if (k === 'step') syncSlider();
    renderLegend();
    drawAll();
    writeHash();
  }

  // ---------------------------------------------------------------- 地図
  var map, baseLayer;
  function initMap() {
    layoutRot(true);
    // ＋−と出典は回転しない層に自前で置く（Leaflet の部品は回転する枠の中に入ってしまうため）
    map = L.map('map', { center: [37.5, 137.5], zoom: 5, minZoom: 2, maxZoom: 18, zoomSnap: 0.5,
                         preferCanvas: true, attributionControl: false, zoomControl: false });
    setBase();
    var c = $('quakeCanvas'), wrap = $('mapwrap');
    map.on('move zoomend resize viewreset', function () { sizeCanvas(); drawMap(); });
    map.on('moveend zoomend resize', scheduleViewIdx);
    map.on('moveend zoomend resize', function () {
      if (st.live) return;                                 // 地図の向きのつまみを動かしている間はまとめ直さない（離したときに 1 回）
      // 続けて動かしている間はまとめ直さない。手が止まって KM_WAIT ms たってから（それまでは前の塊を描く）
      clearTimeout(st.viewTimer);
      st.viewTimer = setTimeout(function () {
        st.viewVer = (st.viewVer || 0) + 1; if (S.mode !== 'time' && isKm()) drawMap();
      }, st.rec ? 0 : KM_WAIT);
    });
    map.on('zoomstart', function () { c.style.visibility = 'hidden'; });
    map.on('zoomend', function () { c.style.visibility = ''; });
    wrap.addEventListener('mousemove', onHover);
    wrap.addEventListener('mouseleave', function () { $('tip').style.display = 'none'; });
    $('zIn').onclick = function () { if (!st.rec) map.zoomIn(); };
    $('zOut').onclick = function () { if (!st.rec) map.zoomOut(); };
    $('north').onclick = function () { if (st.rec) return; S.bearing = 0; $('bearing').value = 0; settingsChanged('bearing'); };
    bindRotatedDrag(wrap);
    applySrc();
    $('lfeNote').style.display = S.lfeOnly ? 'block' : 'none';
    wrap.addEventListener('pointerdown', function () { if (st.ending) cancelEnding(); });
    $('statsCanvas').addEventListener('click', function () { cancelEnding(); });
    document.addEventListener('keydown', function (e) { if (st.ending && e.key === 'Escape') cancelEnding(); });
    layoutRot();
    sizeCanvas();
    // 地図の枠の大きさが変わったら、回転用の枠を作り直して Leaflet に知らせる（知らせないとタイルが欠ける）
    if (window.ResizeObserver) new ResizeObserver(function () { layoutRot(); }).observe(wrap);
  }
  // ---------------------------------------------------------------- 想定震源域（J-SHIS を加工した図形。research/build_source_areas.py）
  var SRC_BANDS = [['#fdd0a2', 0.22], ['#fdae6b', 0.28], ['#fd8d3c', 0.32], ['#e6550d', 0.36]];
  var srcLayers = {};
  /** 想定震源域の図形を読む（1 回だけ）。重ねる図と、距離で色を変えるときの両方で使う */
  function loadSrc() {
    if (st.srcData) return Promise.resolve(st.srcData);
    if (st.srcLoading) return st.srcLoading;
    return (st.srcLoading = fetchJson('data/overlays/source_areas.json').then(function (d) { st.srcData = d; return d; })
      .catch(function (e) { st.srcLoading = null; setStatus('想定震源域の図を読めませんでした：' + e.message, true); throw e; }));
  }
  function applySrc() {
    if (!map) return;
    var ids = srcIds();
    Object.keys(srcLayers).forEach(function (id) { if (ids.indexOf(id) < 0) map.removeLayer(srcLayers[id]); });
    if (!ids.length) return;
    loadSrc().then(function (d) {
      d.groups.forEach(function (g) {
        if (srcIds().indexOf(g.id) < 0) return;
        if (!srcLayers[g.id]) srcLayers[g.id] = srcGroupLayer(g);
        srcLayers[g.id].addTo(map);
      });
      renderLegend();
      if (window.V3) V3.update();
    }).catch(function () {});
  }
  /** 海域 1 つ分の図：主な想定の割合の帯、どの想定も外形の線（長方形は点線）と名前、プレート境界（断層面）の等深線 */
  function srcGroupLayer(g) {
    var lay = L.layerGroup(), ll = function (r) { return r.map(function (p) { return [p[1], p[0]]; }); };
    g.codes.forEach(function (c) {
      (c.bands || []).forEach(function (b, i) {
        var col = SRC_BANDS[i] || SRC_BANDS[SRC_BANDS.length - 1];
        L.polygon(b.rings.map(ll), { stroke: false, fillColor: col[0], fillOpacity: col[1], fillRule: 'evenodd', interactive: false }).addTo(lay);
      });
      c.outline.forEach(function (r) {
        L.polygon(ll(r), { color: QC.SRC_GROUP_COLORS[g.id] || '#b4410d', weight: c.main ? 1.8 : 1.2, opacity: 0.9, dashArray: c.kind === 'rect' ? '6 4' : (c.main ? null : '2 3'),
          fill: !c.bands, fillColor: '#fdae6b', fillOpacity: 0.12, interactive: false }).addTo(lay);
      });
      if (c.label) L.marker([c.label[1], c.label[0]], { interactive: false, icon: L.divIcon({ className: 'srcLbl', html: '<span>' + c.name + '</span>', iconSize: null }) }).addTo(lay);
    });
    g.depth.forEach(function (x) {
      x.lines.forEach(function (L1) {
        L.polyline(ll(L1), { color: '#5b3a29', weight: 1, opacity: 0.7, dashArray: '2 3', interactive: false }).addTo(lay);
        if (L1.length < 8) return;                     // 短い線には深さを書かない（重なって読めないため）
        var mid = L1[Math.floor(L1.length / 2)];
        L.marker([mid[1], mid[0]], { interactive: false, icon: L.divIcon({ className: 'nkLbl', html: x.km + 'km', iconSize: null }) }).addTo(lay);
      });
    });
    return lay;
  }
  function srcLegendHtml() {
    if (!srcIds().length) return '';
    var h = '<div class="ttl" style="margin-top:6px">想定震源域（長期評価）</div><div style="max-width:150px">震源域に入る割合<br>';
    ['1%', '25%', '50%', '75%'].forEach(function (t, i) {
      h += '<span style="display:inline-flex;align-items:center;gap:2px;margin-right:4px"><span class="sw" style="width:12px;height:10px;border-radius:2px;background:' + SRC_BANDS[i][0] + ';border-color:#a0522d"></span>' + t + '</span>';
    });
    h += '<span style="font-size:11px">以上</span>';
    return h + '<div class="note" style="color:#333">線＝想定の外形（点線＝長方形の断層面）。茶の点線＝プレート境界（断層面）の深さ。固着の観測値ではない。J-SHIS（防災科研）を加工</div></div>';
  }
  function srcNames() {
    var d = st.srcData, ids = srcIds();
    if (!d) return '';
    return d.groups.filter(function (g) { return !ids.length || ids.indexOf(g.id) >= 0; }).map(function (g) { return g.name; }).join('・');
  }
  /** 想定震源域からの距離（色を「想定震源域からの距離」にしたとき）。地震ごとに 1 回だけ求め、絞り込み・海域が変わったら作り直す。
   *  海域は「重ねる図」で選んだもの（選んでいなければ全部） */
  function ensureSrcD(force) {
    if ((S.colorMode !== 'src' && !force) || !st.f) return true;
    var key = [st.fVer, srcIds().join(',')].join('|');
    if (st.srcKey === key && st.srcD && st.srcEv === st.ev) return true;
    if (!st.srcData) { loadSrc().then(function () { drawAll(); renderChartBases(); drawCharts(); renderLegend(); }).catch(function () {}); return false; }
    var t = performance.now(), prep = QC.srcPrepare(st.srcData, srcIds()), ev = st.ev, idx = st.f.idx;
    var D = new Float32Array(ev.t.length).fill(NaN), G = new Int8Array(ev.t.length).fill(-1), Sd = new Int8Array(ev.t.length);
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k];
      D[i] = QC.srcDistance(prep, ev.lon[i], ev.lat[i], ev.dep[i]);
      var w = QC.srcLast(); G[i] = w.group; Sd[i] = w.side;
    }
    st.srcD = D; st.srcG = G; st.srcSide = Sd; st.srcKey = key; st.srcEv = ev; st.srcMs = Math.round(performance.now() - t);
    renderChartBases();
    return true;
  }
  function srcd(i) { return st.srcD && S.colorMode === 'src' ? st.srcD[i] : NaN; }
  /** その地震にいちばん近い海域の色（「想定震源域からの距離」の色の元） */
  function srcHue(i) { var g = st.srcG && st.srcData && st.srcData.groups[st.srcG[i]]; return g ? QC.SRC_GROUP_COLORS[g.id] : null; }
  /** 吹き出し用：想定震源域からの距離の説明 */
  function srcTip(i) {
    if (S.colorMode !== 'src' || !st.srcD || !st.srcData) return '';
    var d = st.srcD[i];
    if (isNaN(d)) return '　想定震源域からの距離：深さ不明';
    if (d === Infinity) return '　想定震源域から ' + QC.SRC_MAX_KM + 'km 以上';
    var g = st.srcData.groups[st.srcG[i]];
    return '　想定震源域（' + (g ? g.name : '') + '）から ' + d.toFixed(1) + 'km' + (st.srcSide[i] < 0 ? '（面より浅い）' : st.srcSide[i] > 0 ? '（面より深い）' : '（面の深さ）');
  }

  /** 画面（地図の見える範囲）の大きさ */
  function viewSize() { var w = $('mapwrap'); return { W: w.clientWidth, H: w.clientHeight }; }
  function rotated() { return ((S.bearing % 360) + 360) % 360 !== 0; }
  /** 回転用の枠の大きさと向きを決める。回すときは、どの向きでも画面を覆えるよう対角線の長さの正方形にする */
  function layoutRot(noMap) {
    var v = viewSize(), w = v.W, h = v.H, rot = $('rot');
    if (rotated()) { w = h = Math.ceil(Math.hypot(v.W, v.H)) + 2; }
    rot.style.width = w + 'px'; rot.style.height = h + 'px';
    rot.style.transform = 'translate(-50%, -50%) rotate(' + S.bearing + 'deg)';
    $('northSvg').style.transform = 'rotate(' + S.bearing + 'deg)';
    if ($('bearingV')) $('bearingV').textContent = S.bearing + '°';
    if (noMap || !map) return;
    if (!st.live) st.viewVer = (st.viewVer || 0) + 1;      // つまみを動かしている間は、見える範囲が変わったことにしない
    map.invalidateSize();                 // 中心は保ったまま大きさだけ変わる
    var r = rotated();                    // 回している間は、拡大の基準を地図の中心にする（マウスの位置は回転を考えないため）
    map.options.scrollWheelZoom = r ? 'center' : true;
    map.options.doubleClickZoom = r ? 'center' : true;
    map.options.touchZoom = r ? 'center' : true;
    if (!st.rec) { if (r) map.dragging.disable(); else map.dragging.enable(); }
    sizeCanvas(); drawMap();
  }
  /** 回しているときのドラッグ：画面での動きを逆に回して地図に渡す */
  function bindRotatedDrag(wrap) {
    var last = null, ids = {};
    wrap.addEventListener('pointerdown', function (e) {
      ids[e.pointerId] = true;
      if (!rotated() || st.rec || st.v3d || e.button !== 0 || e.target.closest('#mapCtl,#sideTab,#attrib')) return;
      if (Object.keys(ids).length > 1) { last = null; return; }     // 2 本指は Leaflet の拡大に任せる
      last = [e.clientX, e.clientY];
    });
    wrap.addEventListener('pointermove', function (e) {
      if (!last || !rotated()) return;
      var d = QC.rotDelta(e.clientX - last[0], e.clientY - last[1], S.bearing);
      last = [e.clientX, e.clientY];
      map.panBy([-d[0], -d[1]], { animate: false });
    });
    var up = function (e) { delete ids[e.pointerId]; last = null; };
    wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  }
  function setBase() {
    var b = BASES[S.base] || BASES.pale;
    var opt = { maxZoom: 18, maxNativeZoom: b.maxZoom, minZoom: b.minZoom, crossOrigin: 'anonymous' };
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(b.url, opt).addTo(map);
    baseLayer.bringToBack();
  }
  function sizeCanvas() {
    var c = $('quakeCanvas'), v = viewSize(), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(v.W * dpr) || c.height !== Math.round(v.H * dpr)) {
      c.width = Math.round(v.W * dpr); c.height = Math.round(v.H * dpr);
      c.style.width = v.W + 'px'; c.style.height = v.H + 'px';
    }
  }
  /** 今の地図の見え方で、地震 i の画面上の位置（回転を含む）。scale は動画の拡大率 */
  function makeProj(scale) {
    var k = Math.pow(2, map.getZoom()), o = map.getPixelBounds().min, ms = map.getSize(), v = viewSize(), b = S.bearing;
    return function (i) {
      var p = QC.rotScreen(st.px[i] * k - o.x, st.py[i] * k - o.y, ms.x, ms.y, v.W, v.H, b);
      return [p[0] * scale, p[1] * scale];
    };
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
      st.fixedN = QC.applyFixedDepth(st.ev, S.fixedDep);          // 深さ固定の地震：既定では深さ不明として扱う
      renderFixedNote();
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
    st.fVer = (st.fVer || 0) + 1; st.agg = null; st.stats = null;
    computeLife();
    computeViewIdx();
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
    document.body.classList.toggle('agg', S.mode !== 'time');
    document.body.classList.toggle('tagg', S.mode === 'timeAgg');
    document.body.classList.toggle('km', isKm());
    document.body.classList.toggle('grid', !isKm());
    document.body.classList.toggle('kmcum', S.aggMethod === 'kmcum');
    if ($('aggKV')) $('aggKV').textContent = '段階' + S.aggLevel + '（' + kNow() + '個）';
    document.body.classList.toggle('circle', S.shape === 'circle');
    if ($('volV')) $('volV').textContent = Math.round(S.vol * 100) + '%';
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
    var names = { notLfe: '低周波地震以外', lfeUnknown: '速報など（低周波地震か区別できない）',
                  outside: '日本の周辺の外', artificial: '人工地震（発破など）', lowFreq: '低周波地震',
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
    if (st.ending) { st.ending = null; $('statsCanvas').style.display = 'none'; renderLegend(); }
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
  /** 期間の合計（集合マーカー）で描くか：表示モードが「期間の合計」か、最後のまとめを出している間 */
  function sumView() { return S.mode === 'sum' || !!st.ending || !!st.vidEnd; }
  function periodText() { return QC.formatClock(st.t0, DAY) + '〜' + QC.formatClock(st.t1 - 1, DAY); }
  function drawAll() {
    if (!st.f) return;
    ensureSrcD();
    drawMap();
    drawCharts();
    if (st.v3d && window.V3) V3.update();      // 立体表示（js/view3d.js）
    if (sumView()) {
      $('clock').textContent = '期間の合計';
      $('clockNote').textContent = periodText() + '（' + chartIdx().length.toLocaleString() + ' 回）';
    } else {
      var di = dayInfo(st.T);
      $('clock').textContent = QC.formatClock(st.T, S.step);
      $('clockNote').textContent = (S.mode === 'timeAgg' ? '集合マーカー：' + kmLabel() + '　' : '') + di.text;
    }
  }
  function drawMap() {
    if (!st.f || !map) return;
    var c = $('quakeCanvas'), ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    var v = viewSize();
    if (st.v3d) { st.drawn = []; drawStatsScreen(); return; }      // 立体表示の間は平面の地図に描かない（隠れているので）
    st.drawn = sumView() ? drawAggregate(ctx, 1, v.W, v.H)
      : S.mode === 'timeAgg' ? drawTimeAgg(ctx, st.T, 1, v.W, v.H) : drawQuakes(ctx, st.T, makeProj(1), 1, v.W, v.H);
    drawStatsScreen();
    drawXsecScreen();
  }

  // ---------------------------------------------------------------- 期間の合計（集合マーカー）
  /** 地図の今の倍率の画素で格子にまとめる。対象は描く対象の地震の [k0, k1)（既定は期間全部）。
   *  倍率・絞り込み・格子の大きさ・範囲が変わったときだけ作り直す */
  function aggClusters(k0, k1) {
    if (k0 == null) { k0 = 0; k1 = st.f.idx.length; }
    var z = map.getZoom(), key = z + '|' + S.aggCell + '|' + st.fVer + '|' + k0 + '|' + k1;
    if (st.agg && st.agg.key === key) return st.agg.list;
    if (k0 === 0) {   // 期間の始めからの累積：前のコマから増えた地震だけを足す（戻ったときは作り直す）
      var base = z + '|' + S.aggCell + '|' + st.fVer, c = st.cum;
      if (!c || c.base !== base || c.k1 > k1) c = st.cum = { base: base, k1: 0, s: QC.aggState(S.aggCell) };
      var kk = Math.pow(2, z);
      for (var q = c.k1; q < k1; q++) { var ii = st.f.idx[q]; QC.aggAdd(c.s, st.px[ii] * kk, st.py[ii] * kk, st.ev.mag[ii], ii); }
      c.k1 = k1;
      st.agg = { key: key, list: QC.aggFinish(c.s) };
      return st.agg.list;
    }
    var idx = st.f.idx, ev = st.ev, k = Math.pow(2, z), n = k1 - k0;
    var xs = new Float64Array(n), ys = new Float64Array(n), ms = new Float64Array(n), ids = new Int32Array(n);
    for (var j = 0; j < n; j++) { var i = idx[k0 + j]; xs[j] = st.px[i] * k; ys[j] = st.py[i] * k; ms[j] = ev.mag[i]; ids[j] = i; }
    st.agg = { key: key, list: QC.aggregate(xs, ys, ms, ids, S.aggCell) };
    return st.agg.list;
  }
  /** 時間に沿った集合マーカーで、時刻 T にまとめる地震の位置 [k0, k1) */
  function windowRange(T) {
    var lo = S.aggWindow === 'cum' ? -Infinity : T - (+S.aggWindow) * DAY;
    return QC.idxRange(st.ev, st.f.idx, lo, T);
  }
  function windowText() { return S.aggWindow === 'cum' ? '期間の始めから' : '直近' + S.aggWindow + '日'; }
  /** 時間に沿った集合マーカー：時刻 T までの「まとめる時間の幅」の地震を格子でまとめ、発生の瞬間には波紋を出す */
  function drawTimeAgg(ctx, T, scale, W, H) {
    var r = windowRange(T), drawn = isKm() ? drawKm(ctx, scale, W, H, T) : drawAggregate(ctx, scale, W, H, r[0], r[1]);
    if (S.ripple) {
      var rippleDur = S.rippleFrames * S.step, rr = QC.idxRange(st.ev, st.f.idx, T - rippleDur, T), proj = makeProj(scale);
      for (var k = rr[0]; k < rr[1]; k++) {
        var i = st.f.idx[k], m = st.ev.mag[i];
        if (m < S.rippleMinM) continue;
        var p = proj(i), g = (T - st.ev.t[i]) / rippleDur, base = QC.aggRadius(m, S) * 0.5 * scale;
        ctx.beginPath(); ctx.arc(p[0], p[1], base + g * (14 + base) * scale, 0, 2 * Math.PI);
        ctx.strokeStyle = QC.colorOf('mag', m, 0, 0); ctx.globalAlpha = 0.9 * (1 - g); ctx.lineWidth = 2 * scale; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // 波紋が数字に重なっても読めるよう、数字をもう一度いちばん上に
      for (var q = drawn.length - 1; q >= 0; q--) drawAggLabel(ctx, drawn[q][0], drawn[q][1], drawn[q][2], drawn[q][5], scale);
    }
    return drawn;
  }
  function aggText(g) {
    if (S.aggLabel === 'count') return g.n >= 10000 ? (g.n / 10000).toFixed(g.n >= 100000 ? 0 : 1) + '万' : String(g.n);
    if (S.aggLabel === 'energy') return QC.formatEnergy(g.E);
    return g.meq.toFixed(1);
  }
  /** 集合マーカーの円を 1 つ描く（数字は drawAggLabel で、あとからまとめて） */
  function drawAggMarker(ctx, x, y, r, g, scale, alpha) {
    var col = QC.colorOf('mag', g.meq, 0, 0), a = alpha == null ? 1 : alpha;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.globalAlpha = 0.62 * a; ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = 0.95 * a; ctx.lineWidth = 1.6 * scale; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- k-means（震源の空間 xyz、再生は xyzt）
  /** マーカーの数（段階から求める。再生では同時に見える数） */
  function kNow() { return QC.kOfLevel(S.aggLevel); }
  var KM_MAX = QC.KM_MAX, KM_WAIT = 400;   // 地図を動かし終えてから、まとめ直しを始めるまでの待ち（ms）
  /** 地図に見えている範囲の地震を k-means でまとめる（dim 3＝xyz、4＝xyzt）。地図を動かし終えたときと設定を変えたときだけ。
   *  計算は別の計算場所（js/kmworker.js）で行い、その間は画面を止めない。答えが届くまでは、
   *  見える範囲かマーカーの数だけが違う前の答えをそのまま描く（地震の選び方・期間が違う答えは描かない）。
   *  書き出し中は、そのコマで答えが要るので画面の側で計算する */
  /** k-means でまとめるか（xyzt・累積のどちらも） */
  function isKm() { return S.aggMethod === 'kmeans' || S.aggMethod === 'kmcum'; }
  function kmLabel() { return S.aggMethod === 'kmcum' ? 'k-means（累積）' : S.aggMethod === 'kmeans' ? 'k-means（xyzt）' : windowText() + 'の合計'; }
  /** 累積の k-means の節目の数：地震が多く塊が多いほど減らす（計算の重さを数秒に抑える。24〜150） */
  function kmCumFrames(n, k) { return Math.max(24, Math.min(150, Math.round(4e8 / Math.max(1, n * k)))); }
  /** dim：3＝xyz（期間の合計）、4＝xyzt（再生）、'cum'＝累積（再生） */
  function kmClusters(dim) {
    // 段階ごとに計算結果を取っておく（同じ表示範囲・期間・重みなら、段階を行き来しても計算し直さない）
    var same = [dim, S.kmDepthW, S.kmKmPerDay, S.kmWeight, st.fVer, st.t0, st.t1].join('|'), base = same + '|' + st.viewVer, key = base + '|' + kNow();
    if (!st.kmCache || st.kmCache.base !== base) st.kmCache = { base: base, byK: {} };
    if (st.kmCache.byK[key]) return (st.km = st.kmShown = st.kmCache.byK[key]);
    var job = kmJob(dim === 'cum' ? 3 : dim);
    if (dim === 'cum') { job.type = 'cum'; job.nk = kmCumFrames(job.ids.length, job.k); }
    if (st.rec || !kmWorker()) {
      var r = dim === 'cum' ? QC.kmCumSolve(job) : QC.kmSolve(job);
      return (st.km = st.kmCache.byK[key] = kmResult(key, same, dim, job, r));
    }
    if (!st.kmPending || st.kmPending.key !== key) {
      st.kmSeq = (st.kmSeq || 0) + 1;
      if (st.kmPending) { st.kmW.terminate(); st.kmW = null; kmWorker(); }    // 前の計算は途中でやめる（答えはもう要らない）
      st.kmPending = { key: key, same: same, dim: dim, job: { dim: job.dim, k: job.k, K: job.K, t0: job.t0, t1: job.t1, s: job.s, n: job.ids.length, noDep: job.noDep }, seq: st.kmSeq, t: Date.now() };
      job.seq = st.kmSeq;
      st.kmW.postMessage(job, [job.P.buffer, job.ms.buffer, job.ids.buffer, job.ts.buffer]);
      kmBusy(true);
    }
    var old = st.kmShown;
    return old && old.same === same ? old : null;
  }
  /** 別の計算場所（使えないブラウザ・ファイルを直接開いたときは null → 画面の側で計算する） */
  function kmWorker() {
    if (st.kmW) return st.kmW;
    if (st.kmNoWorker || !window.Worker) return null;
    try { st.kmW = new Worker('js/kmworker.js'); }
    catch (e) { st.kmNoWorker = true; return null; }
    st.kmW.onmessage = function (e) {
      var d = e.data, p = st.kmPending;
      if (!p || d.seq !== p.seq) return;                  // 古い答え（もう別の範囲を頼んでいる）は捨てる
      st.kmPending = null; kmBusy(false);
      if (d.error) { setStatus('集合マーカーをまとめられませんでした：' + d.error, true); return; }
      if (!st.kmCache || p.key.indexOf(st.kmCache.base + '|') !== 0) return;   // 届く前に条件が変わった
      st.kmCache.byK[p.key] = kmResult(p.key, p.same, p.dim, p.job, d);
      st.kmLastMs = typeof d.ms === 'number' ? d.ms : d.ms_;
      drawMap();
    };
    st.kmW.onerror = function (e) {
      // 計算場所が動かない（古いブラウザなど）：以後は画面の側で計算する
      st.kmNoWorker = true; st.kmW = null; st.kmPending = null; kmBusy(false);
      if (e && e.preventDefault) e.preventDefault();
      drawMap();
    };
    return st.kmW;
  }
  function kmResult(key, same, dim, job, r) {
    return (st.kmShown = { key: key, same: same, dim: dim, clusters: r.clusters || [], cum: r.frames ? r : null, noDep: job.noDep,
                           n: job.n != null ? job.n : job.ids.length, K: r.K || job.k, active: r.active });
  }
  /** 時刻 T（null なら期間の合計）に描く塊：[{ a（その時刻の姿）, g（塊。累積では null）}]、エネルギーの小さい順 */
  function kmView(T) {
    var cum = T != null && S.aggMethod === 'kmcum', dim = T == null ? 3 : cum ? 'cum' : 4, km = kmClusters(dim) || kmEmpty(dim), items = [];
    if (cum) { if (km.cum) items = QC.kmCumAt(km.cum, T).map(function (a) { return { a: a, g: null }; }); }
    else km.clusters.forEach(function (g) { var a = kmAt(g, T); if (a) items.push({ a: a, g: g }); });
    return { km: km, items: items, cum: cum };
  }
  function kmBusy(on) { var b = $('kmBusy'); if (b) b.style.display = on ? 'block' : 'none'; }
  /** まとめる地震の座標を作る（見えている範囲だけ） */
  function kmJob(dim) {
    var ev = st.ev, proj = makeProj(1), v = viewSize(), list = [], noDep = 0, idx = st.f.idx;
    for (var q = 0; q < idx.length; q++) {
      var i = idx[q], p = proj(i);
      if (p[0] < 0 || p[0] > v.W || p[1] < 0 || p[1] > v.H) continue;
      if (isNaN(ev.dep[i])) { noDep++; continue; }
      list.push(i);
    }
    return kmJobOf(list, dim, (v.W * v.H) / Math.pow(QC.pxPerKm(map.getCenter().lat, map.getZoom()), 2), noDep);
  }
  /** まとめる頼み（list は地震の番号、時刻順。areaKm2 はまとめる範囲の広さ）。立体表示（js/view3d.js）でも使う */
  function kmJobOf(list, dim, areaKm2, noDep) {
    var pt = QC.kmPoints(st.ev, list, dim, S.kmDepthW, S.kmKmPerDay, st.t0), k = kNow();
    // 4 次元（再生）では k を「同時に見えるマーカーの数」にする。まとめたあと実際に数え、外れていれば 1 回だけまとめ直す（QC.kmSolve）
    var K = dim === 4 ? QC.kmInitialK(k, areaKm2, (st.t1 - st.t0) / DAY, S.kmKmPerDay) : k;
    return { P: pt.P, dim: dim, ms: pt.ms, ids: pt.ids, ts: pt.ts, k: k, K: K, t0: st.t0, t1: st.t1, noDep: noDep || 0, wmode: S.kmWeight,
             s: { life1: S.life1, lifeGrowth: S.lifeGrowth, lifeMin: S.lifeMin, lifeMax: S.lifeMax } };
  }
  /** 塊を時刻 T の姿に（T が null なら期間の合計） */
  function kmAt(g, T) { return QC.kmAt(g, T, S); }
  /** 計算中で、まだ描ける答えが無いとき */
  function kmEmpty(dim) { return { clusters: [], noDep: 0, n: 0, K: 0, active: 0, dim: dim, pending: true }; }
  function drawKm(ctx, scale, W, H, T) {
    var vw = kmView(T), proj = makeProj(scale), z = map.getZoom(), drawn = [];
    for (var q = vw.items.length - 1; q >= 0; q--) {           // 大きい塊を先に（下に）
      var g = vw.items[q].g, a = vw.items[q].a;
      var p = proj(a.ev), x = p[0], y = p[1], r = QC.aggRadius(a.meq, S) * scale;
      if (x < -r || y < -r || x > W + r || y > H + r) continue;
      var spread = g ? g.rmsXY * QC.pxPerKm(st.ev.lat[a.ev], z) * scale : 0;   // 塊の広がり（薄い点線。累積では出さない）
      if (spread > r * 1.15) {
        ctx.save(); ctx.setLineDash([3 * scale, 3 * scale]); ctx.globalAlpha = 0.45 * a.alpha; ctx.strokeStyle = QC.colorOf('mag', a.meq, 0, 0);
        ctx.lineWidth = 1 * scale; ctx.beginPath(); ctx.arc(x, y, spread, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
      }
      drawAggMarker(ctx, x, y, r, a, scale, a.alpha);
      drawn.push([x, y, r, a.maxI, -1, a]);
    }
    for (q = drawn.length - 1; q >= 0; q--) drawAggLabel(ctx, drawn[q][0], drawn[q][1], drawn[q][2], drawn[q][5], scale);
    return drawn;
  }
  function drawXsecKm(ctx, Wv, Hv, top, height, scale, bg, ink, sub, T) {
    var ev = st.ev, ih = height - (XS.top + XS.bottom) * scale, maxKm = xsecMaxKm(ih, scale), y0 = top + XS.top * scale;
    var vw = kmView(T), km = vw.km, proj = makeProj(scale), items = [], deep = 0, total = 0;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, Wv, height); ctx.clip();
    ctx.fillStyle = bg; ctx.fillRect(0, top, Wv, height);
    ctx.font = 10 * scale + 'px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    QC.depthTicks(maxKm).forEach(function (d) {
      var y = y0 + ih * d / maxKm;
      ctx.globalAlpha = d === 0 ? 0.8 : 0.3; ctx.fillStyle = sub; ctx.fillRect(0, y, Wv, d === 0 ? 1.2 * scale : 0.8 * scale);
      ctx.globalAlpha = 1; ctx.fillText(d + 'km', 4 * scale, y + 7 * scale);
    });
    var rmax = Math.max(6 * scale, ih * 0.35);
    for (var q = vw.items.length - 1; q >= 0; q--) {
      var a = vw.items[q].a;
      total += a.n;
      var d = ev.dep[a.ev];
      if (d > maxKm) { deep++; continue; }
      var x = proj(a.ev)[0], y = y0 + ih * Math.max(d, 0) / maxKm, r = Math.min(QC.aggRadius(a.meq, S) * 0.75 * scale, rmax);
      drawAggMarker(ctx, x, y, r, a, scale, a.alpha);
      items.push([x, y, r, a]);
    }
    for (q = items.length - 1; q >= 0; q--) drawAggLabel(ctx, items[q][0], items[q][1], items[q][2], items[q][3], scale);
    var az = QC.screenXAzimuth(S.bearing);
    ctx.font = 11 * scale + 'px sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = ink; ctx.textAlign = 'left';
    var tailTxt = total.toLocaleString() + '回・' + (T == null ? km.clusters.length + '塊' : vw.cum ? vw.items.length + '塊' : '全体' + km.clusters.length + '塊（同時に約' + km.active + '）') +
      (deep ? '・深すぎて範囲外 ' + deep + '塊' : '') + (km.noDep ? '・深さ不明 ' + km.noDep : '');
    var room = Wv - XS.right * scale - ctx.measureText(tailTxt).width - 60 * scale;
    var headTxt = '断面図（k-means ' + (T == null ? 'xyz・期間の合計' : vw.cum ? '累積・その時刻まで全部' : 'xyzt・その時刻まで') + '）　横＝地図の横方向（← ' + QC.dirName(az + 180) + '　' + QC.dirName(az) + ' →）　縦＝深さ 0〜' + Math.round(maxKm) + 'km';
    if (ctx.measureText(headTxt).width > room) headTxt = '断面図（k-means）← ' + QC.dirName(az + 180) + '　' + QC.dirName(az) + ' →　0〜' + Math.round(maxKm) + 'km';   // 幅が足りなければ短く
    ctx.fillText(headTxt, 48 * scale, top + 2 * scale);
    ctx.textAlign = 'right';
    ctx.fillText(tailTxt, Wv - XS.right * scale, top + 2 * scale);
    ctx.restore();
  }
  function drawAggLabel(ctx, x, y, r, g, scale) {
    if (r < 8 * scale) return;
    var t = aggText(g), fs = Math.max(9 * scale, Math.min(r * 0.62, 17 * scale, (2.1 * r) / Math.max(t.length, 2) * 1.5));
    ctx.font = 'bold ' + fs + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * scale; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineJoin = 'round';
    ctx.strokeText(t, x, y); ctx.fillStyle = '#fff'; ctx.fillText(t, x, y);
  }
  /** 地図に集合マーカーを描く（画面と動画で共通）。吹き出し用に [x, y, r, 最大の地震, -1, 塊] を返す */
  function drawAggregate(ctx, scale, W, H, k0, k1) {
    if (isKm()) return drawKm(ctx, scale, W, H, null);
    var list = aggClusters(k0, k1), o = map.getPixelBounds().min, ms = map.getSize(), v = viewSize(), drawn = [];
    for (var q = list.length - 1; q >= 0; q--) {           // 大きい塊を先に（下に）、小さい塊を上に
      var g = list[q], p = QC.rotScreen(g.x - o.x, g.y - o.y, ms.x, ms.y, v.W, v.H, S.bearing);
      var x = p[0] * scale, y = p[1] * scale, r = QC.aggRadius(g.meq, S) * scale;
      if (x < -r || y < -r || x > W + r || y > H + r) continue;
      drawAggMarker(ctx, x, y, r, g, scale);
      drawn.push([x, y, r, g.maxI, -1, g]);
    }
    // 数字は円を全部描いてから。大きい塊の数字をいちばん上に
    for (q = drawn.length - 1; q >= 0; q--) drawAggLabel(ctx, drawn[q][0], drawn[q][1], drawn[q][2], drawn[q][5], scale);
    return drawn;
  }
  /** 断面図を集合マーカーで（横＝画面の横方向、縦＝深さ）。地図に見えている範囲の地震だけ */
  function drawXsecAgg(ctx, Wv, Hv, top, height, scale, bg, ink, sub, T) {
    if (isKm()) return drawXsecKm(ctx, Wv, Hv, top, height, scale, bg, ink, sub, T);
    var ev = st.ev, ih = height - (XS.top + XS.bottom) * scale, maxKm = xsecMaxKm(ih, scale), y0 = top + XS.top * scale;
    var src = st.viewIdx && S.chartView ? st.viewIdx : st.f.idx;
    if (T != null) { var wr = windowRange(T); src = st.f.idx.subarray(wr[0], wr[1]); }   // 時間に沿った集合：時間の幅の地震だけ
    var proj = makeProj(scale), xs = [], ys = [], ms = [], ids = [], deep = 0;
    for (var k = 0; k < src.length; k++) {
      var i = src[k], p = proj(i), d = ev.dep[i];
      if (p[0] < 0 || p[0] > Wv || p[1] < 0 || p[1] > Hv || isNaN(d)) continue;
      if (d > maxKm) { deep++; continue; }
      xs.push(p[0]); ys.push(y0 + ih * Math.max(d, 0) / maxKm); ms.push(ev.mag[i]); ids.push(i);
    }
    var list = QC.aggregate(xs, ys, ms, ids, S.aggCell * 0.6 * scale);
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, Wv, height); ctx.clip();
    ctx.fillStyle = bg; ctx.fillRect(0, top, Wv, height);
    ctx.font = 10 * scale + 'px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    QC.depthTicks(maxKm).forEach(function (d) {
      var y = y0 + ih * d / maxKm;
      ctx.globalAlpha = d === 0 ? 0.8 : 0.3; ctx.fillStyle = sub; ctx.fillRect(0, y, Wv, d === 0 ? 1.2 * scale : 0.8 * scale);
      ctx.globalAlpha = 1; ctx.fillText(d + 'km', 4 * scale, y + 7 * scale);
    });
    var rmax = Math.max(6 * scale, ih * 0.35);
    var rs = list.map(function (g) { return Math.min(QC.aggRadius(g.meq, S) * 0.75 * scale, rmax); });
    for (var q = list.length - 1; q >= 0; q--) drawAggMarker(ctx, list[q].x, list[q].y, rs[q], list[q], scale);
    for (q = 0; q < list.length; q++) drawAggLabel(ctx, list[q].x, list[q].y, rs[q], list[q], scale);
    var az = QC.screenXAzimuth(S.bearing);
    ctx.font = 11 * scale + 'px sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = ink;
    ctx.textAlign = 'left'; ctx.fillText('断面図（' + (T != null ? windowText() + 'の合計' : '期間の合計') + '）　横＝地図の横方向（← ' + QC.dirName(az + 180) + '　' + QC.dirName(az) + ' →）　縦＝深さ 0〜' + Math.round(maxKm) + 'km', 48 * scale, top + 2 * scale);
    ctx.textAlign = 'right'; ctx.fillText(xs.length.toLocaleString() + '回' + (deep ? '・深すぎて範囲外 ' + deep : ''), Wv - XS.right * scale, top + 2 * scale);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 最後のまとめ（再生・動画）
  function getStats() {
    var key = st.fVer + '|' + (S.chartView && st.viewIdx ? st.viewIdx.length + ':' + st.viewIdx[0] + ':' + st.viewVer + ':' + !!st.v3d : 'all') + '|' + S.srcShow + '|' + S.srcNearKm;
    if (!st.stats || st.stats.key !== key || (!st.stats.v.srcAreas && st.srcData)) {
      var v = QC.computeStats(st.ev, chartIdx(), st.t0, st.t1);
      // 想定震源域ごとの解放エネルギー（面から srcNearKm 以内の地震）。図形を読んでいなければ読み始め、読めたら次に描くときに入る
      if (st.srcData && ensureSrcD(true) && st.srcD) v.srcAreas = srcAreaRows(QC.srcStats(st.ev, chartIdx(), st.srcD, st.srcG, S.srcNearKm));
      else loadSrc().catch(function () {});
      st.stats = { key: key, v: v };
    }
    return st.stats.v;
  }
  /** 想定震源域ごとの行：対象の海域を全部（地震が無い海域も 0 として）。広さ（km²）と 1 万 km² あたりの回数・エネルギーも。エネルギーの大きい順 */
  function srcAreaRows(found) {
    var ids = srcIds(), by = {};
    found.forEach(function (g) { by[g.group] = g; });
    return st.srcData.groups.map(function (grp, k) {
      if (ids.length && ids.indexOf(grp.id) < 0) return null;
      var g = by[k] || { group: k, n: 0, E: 0, max: -1, meq: NaN }, area = grp.areaKm2 || (grp.areaKm2 = QC.srcAreaKm2(grp));
      return { group: k, id: grp.id, name: grp.name, n: g.n, E: g.E, meq: g.meq, max: g.max, area: area, nPer: g.n / area * 1e4, meqPer: g.E ? QC.magOfEnergy(g.E / area * 1e4) : NaN,
               seen: srcSeen(grp) };
    }).filter(Boolean).sort(function (a, b) { return b.E - a.E; });
  }
  /** 集計の対象の範囲（下のグラフを「地図に見えている範囲」にしているとき）に、その海域の震源域がどれだけ入っているか（升の割合 0〜1）。
   *  全域を対象にしているときは 1。0 なら回数 0 は「地図の外」、1 未満なら「一部が地図の外」と書く（0 回を、地震が無かったと読ませない） */
  function srcSeen(grp) {
    if (!S.chartView) return 1;
    var b;
    if (st.v3d && window.V3 && V3._V.roi) { var r = V3._V.roi; b = { s: r.s, n: r.n, w: r.w, e: r.e }; }
    else if (map) { var lb = map.getBounds(); b = { s: lb.getSouth(), n: lb.getNorth(), w: lb.getWest(), e: lb.getEast() }; }
    else return 1;
    var gr = grp.grid, n = 0, tot = 0, inn = 0;
    for (var q = 0; q < gr.z.length; q++) {
      var v = gr.z[q];
      if (v < 0) { n -= v; continue; }
      var lon = gr.lon0 + (n % gr.nx) * gr.step, lat = gr.lat0 + Math.floor(n / gr.nx) * gr.step;
      tot++; if (lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e) inn++;
      n++;
    }
    return tot ? inn / tot : 1;
  }
  /** 画面のまとめの段階：{ statsAlpha }（集合マーカーだけの間は 0） */
  function endPhase() {
    if (st.vidEnd) return st.vidEnd;
    if (!st.ending) return null;
    var el = (performance.now() - st.ending.start) / 1000;
    return { statsAlpha: el < S.endSumSec ? 0 : Math.min(1, (el - S.endSumSec) / 0.6) };
  }
  /** 画面のまとめ：窓全体に重ねる（押すと閉じる） */
  function drawStatsScreen() {
    var c = $('statsCanvas'), ph = endPhase();
    if (!ph || st.vidEnd || !(ph.statsAlpha > 0)) { c.style.display = 'none'; return; }
    c.style.display = 'block';
    var dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    drawStatsPanel(ctx, W, H, 1, getStats(), ph.statsAlpha);
  }
  function startEnding() {
    if (!S.endSeq || st.rec) return;
    st.ending = { start: performance.now() };
    renderLegend();
    // 画面の描き直しが止まっている（タブが裏にある等）ときのため、時刻でも描き直す
    [S.endSumSec + 0.05, S.endSumSec + 0.35, S.endSumSec + 0.7].forEach(function (t) { setTimeout(function () { if (st.ending) drawAll(); }, t * 1000); });
    (function loop() {
      if (!st.ending) return;
      drawAll();
      if ((performance.now() - st.ending.start) / 1000 < S.endSumSec + 0.7) requestAnimationFrame(loop);
    })();
  }
  function cancelEnding(force) {
    if (!st.ending && !force) return;
    st.ending = null;
    $('statsCanvas').style.display = 'none';
    renderLegend(); drawAll();
  }
  function fmtInt(n) { return n.toLocaleString(); }
  /** まとめの表と棒グラフを描く（画面と動画で共通）。W×H は塗る範囲（ctx の単位） */
  /** 期間のまとめ（画面全体に重ねる）。字の大きさ u は窓の大きさから決め、全部が入りきらなければ入るまで小さくする
   *  （横長で低い窓などで、下の段が出典や画面の外にはみ出して重ならないように）。入るかは、描かずに位置だけ測って確かめる */
  function drawStatsPanel(ctx, W, H, scale, s, alpha) {
    ctx.save();
    ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(8,12,20,' + (0.86 * alpha) + ')'; ctx.fillRect(0, 0, W, H);
    var u = Math.max(9 * scale, Math.min(W / 52, H / 24)), pad = Math.max(14 * scale, W * 0.04);
    var foot = function (uu) { return H - pad * 0.6 - (s.srcAreas ? 2.0 : 1.0) * uu - 0.6 * uu; };
    var dry = new Proxy({}, {             // 測るだけの ctx（字の幅は本物で測り、描く命令は捨てる）
      get: function (_, k) { if (k === 'measureText') return function (t) { return ctx.measureText(t); }; var v = ctx[k]; return typeof v === 'function' ? function () {} : v; },
      set: function (_, k, v) { if (k === 'font') ctx.font = v; return true; }
    });
    for (var tries = 0; tries < 12 && statsBody(dry, W, H, scale, s, alpha, u, pad) > foot(u) && u > 6 * scale; tries++) u *= 0.9;
    statsBody(ctx, W, H, scale, s, alpha, u, pad);
    ctx.globalAlpha = 0.7 * alpha; ctx.font = 0.75 * u + 'px sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('出典：気象庁（震源データ・震源リスト・震度データベース）。エネルギーは log E = 1.5M + 4.8（J）による推定。', pad, H - pad * 0.6 - (s.srcAreas ? 1.9 : 0.9) * u, W - 2 * pad);
    if (s.srcAreas) ctx.fillText('想定震源域ごと＝震源から震源域の面まで' + S.srcNearKm + 'km以内の地震を、いちばん近い海域に。広さは震源域の地図の上の面積。1万km²あたり＝期間の合計を広さで割った値。震源域は長期評価のモデル（J-SHIS を加工）', pad, H - pad * 0.6 - 0.9 * u, W - 2 * pad);
    ctx.restore();
  }
  /** まとめの中身を字の大きさ u で描き、いちばん下の位置を返す */
  function statsBody(ctx, W, H, scale, s, alpha, u, pad) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = 'bold ' + 1.7 * u + 'px sans-serif'; ctx.fillText('期間のまとめ', pad, pad);
    ctx.font = 1.05 * u + 'px sans-serif';
    ctx.fillText(periodText() + '（' + s.days + '日間）', pad, pad + 2.3 * u);
    ctx.globalAlpha = 0.8 * alpha; ctx.font = 0.85 * u + 'px sans-serif';
    ctx.fillText('対象：' + chartScopeLabel() + '・M' + S.magMin + '以上' + (S.intMin > 0 ? '・震度' + QC.MAXI_LABEL[S.intMin].replace('震度', '') + '以上' : ''), pad, pad + 3.7 * u);
    ctx.globalAlpha = alpha;
    var ev = st.ev, mi = s.max, rows = [];
    rows.push(['地震の回数', fmtInt(s.n) + ' 回']);
    if (mi >= 0) rows.push(['最大の地震', 'M' + ev.mag[mi].toFixed(1) + '　' + QC.formatDateTime(ev.t[mi]).slice(0, 16) + '　深さ' +
      (isNaN(ev.dep[mi]) ? '不明' : Math.round(ev.dep[mi]) + 'km') + '　' + QC.MAXI_LABEL[ev.maxi[mi]]]);
    rows.push(['揺れを観測', '震度1以上 ' + fmtInt(s.byInt[1]) + '回　震度4以上 ' + fmtInt(s.byInt[4]) + '回　震度5弱以上 ' + fmtInt(s.byInt[5]) + '回' + (s.byInt[7] ? '　震度6弱以上 ' + fmtInt(s.byInt[7]) + '回' : '')]);
    if (s.busiest) rows.push(['最も多かった日', s.busiest.day + '（' + fmtInt(s.busiest.n) + '回）']);
    if (s.n) rows.push(['エネルギーの合計', 'M' + s.meq.toFixed(1) + '相当（' + QC.formatEnergy(s.E) + '）']);
    var dn = s.depth.shallow + s.depth.mid + s.depth.deep;
    if (dn) rows.push(['深さ', '30km未満 ' + Math.round(100 * s.depth.shallow / dn) + '%　30〜100km ' + Math.round(100 * s.depth.mid / dn) + '%　100km以上 ' + Math.round(100 * s.depth.deep / dn) + '%']);
    if (s.src[1] + s.src[2] + s.src[3]) rows.push(['値の種類', '確定 ' + fmtInt(s.src[0]) + '・速報など ' + fmtInt(s.src[1] + s.src[2] + s.src[3]) + '（速報は後で変わることがあります）']);
    var wide = W / H > 1.25, tableW = wide ? W * 0.58 - pad : W - 2 * pad, y = pad + 5.4 * u, lh = 1.75 * u;
    var labW = 8.6 * u;
    rows.forEach(function (r) {
      ctx.globalAlpha = 0.75 * alpha; ctx.font = 0.95 * u + 'px sans-serif'; ctx.fillText(r[0], pad, y);
      ctx.globalAlpha = alpha; ctx.font = 'bold ' + 1.0 * u + 'px sans-serif';
      // 値は全角スペースの区切りで折り返す（切り捨てない）
      var parts = r[1].split('　'), line = '', maxw = tableW - labW, lines = [];
      parts.forEach(function (p) {
        var t = line ? line + '　' + p : p;
        if (line && ctx.measureText(t).width > maxw) { lines.push(line); line = p; } else line = t;
      });
      lines.push(line);
      lines.forEach(function (L, n) { ctx.fillText(L, pad + labW, y + n * 1.3 * u); });
      y += lh + (lines.length - 1) * 1.3 * u;
    });
    // 棒グラフ：M ごとの回数（以上）。数の差が大きいので長さは対数
    var bx = wide ? W * 0.62 : pad, by = wide ? pad + 5.4 * u : y + 0.8 * u, bw = wide ? W - bx - pad : W - 2 * pad;
    var bars = [3, 4, 5, 6, 7], mx = Math.max.apply(null, bars.map(function (m) { return s.byM[m]; }).concat([1])), bh = 1.35 * u;
    ctx.font = 'bold ' + 1.0 * u + 'px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('M ごとの回数（以上、対数の長さ）', bx, by);
    bars.forEach(function (m, n) {
      var yy = by + 1.8 * u + n * (bh + 0.45 * u), c = s.byM[m], len = c ? (bw - 9 * u) * Math.log(c + 1) / Math.log(mx + 1) : 0;
      ctx.globalAlpha = alpha; ctx.fillStyle = '#fff'; ctx.font = 0.95 * u + 'px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText('M' + m + '以上', bx, yy + bh / 2);
      ctx.fillStyle = QC.colorOf('mag', m, 0, 0); ctx.fillRect(bx + 4.6 * u, yy, Math.max(len, c ? 2 : 0), bh);
      ctx.fillStyle = '#fff'; ctx.fillText(fmtInt(c), bx + 4.6 * u + len + 0.5 * u, yy + bh / 2);
      ctx.textBaseline = 'top';
    });
    // 想定震源域ごと：面から srcNearKm km 以内の地震の合計と、1 万 km² あたり。対象の海域は全部出す（入りきらなければ全体の字を小さくする）。
    // 置き場所は表と棒グラフの下、横幅いっぱい。棒の長さは合計の M 相当
    var bottom = Math.max(y, by + 1.8 * u + bars.length * (bh + 0.45 * u));
    if (s.srcAreas) {
      var list = s.srcAreas, sx = pad, sw = W - 2 * pad;
      var sy = bottom + 0.7 * u, rh = bh + 0.3 * u, fs = 0.95 * u;
      bottom = sy + 1.5 * u + 1.1 * u + list.length * rh;
      ctx.globalAlpha = alpha; ctx.font = 'bold ' + 1.0 * u + 'px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
      ctx.fillText('想定震源域ごと（面から' + S.srcNearKm + 'km以内の地震）', sx, sy);
      ctx.font = fs + 'px sans-serif';
      var nameW = ctx.measureText('日本海東縁部　').width, tw1 = ctx.measureText('M8.8相当・888,888回・最大M8.8　').width;
      var tw2 = ctx.measureText('—（一部が地図の外）　').width, tw3 = ctx.measureText('（広さ 88.8万km²・一部が地図の外）').width;
      var barMax = Math.max(2 * u, Math.min(sw * 0.3, sw - nameW - tw1 - tw2 - tw3)), m0 = 3, m1 = Math.max(8, Math.ceil(isNaN(list[0] && list[0].meq) ? 8 : list[0].meq));
      var hy = sy + 1.5 * u;
      ctx.globalAlpha = 0.7 * alpha; ctx.font = 0.75 * u + 'px sans-serif';
      ctx.fillText('合計', sx + nameW + barMax + 0.5 * u, hy); ctx.fillText('1万km²あたり', sx + nameW + barMax + 0.5 * u + tw1, hy);
      ctx.globalAlpha = alpha;
      list.forEach(function (g, n) {
        var yy = hy + 1.1 * u + n * rh, bhh = Math.max(4, rh - 0.4 * u), len = g.n ? Math.max(2, barMax * Math.max(0, g.meq - m0) / (m1 - m0)) : 0;
        ctx.textBaseline = 'middle'; ctx.font = fs + 'px sans-serif'; ctx.fillStyle = '#fff';
        ctx.fillText(g.name, sx, yy + bhh / 2);
        if (len) { ctx.fillStyle = QC.SRC_GROUP_COLORS[g.id] || '#888'; ctx.fillRect(sx + nameW, yy, len, bhh); }   // 棒の色＝海域の色（地図・立体と同じ）
        ctx.fillStyle = '#fff';
        var tx = sx + nameW + barMax + 0.5 * u;
        var none = g.seen <= 0 ? '地図の外（数えていない）' : '0回';
        ctx.fillText(g.n ? 'M' + g.meq.toFixed(1) + '相当・' + fmtInt(g.n) + '回・最大M' + ev.mag[g.max].toFixed(1) : none, tx, yy + bhh / 2);
        // 一部が地図の外の海域は、広さで割ると小さく出るので割らない
        ctx.fillText(!g.n ? (g.seen <= 0 ? '—' : '0回') : g.seen < 0.999 ? '—（一部が地図の外）' : (g.nPer >= 10 ? fmtInt(Math.round(g.nPer)) : g.nPer.toFixed(1)) + '回・M' + g.meqPer.toFixed(1) + '相当', tx + tw1, yy + bhh / 2);
        ctx.globalAlpha = 0.65 * alpha;
        ctx.fillText('（広さ ' + (g.area / 1e4).toFixed(1) + '万km²' + (g.seen <= 0 ? '・地図の外' : g.seen < 0.999 ? '・一部が地図の外' : '') + '）', tx + tw1 + tw2, yy + bhh / 2);
        ctx.globalAlpha = alpha; ctx.textBaseline = 'top';
      });
    }
    return bottom;
  }
  /** 地震を描く（画面と動画で共通）。描いたものの位置を返す（吹き出し用）。 */
  function drawQuakes(ctx, T, proj, scale, W, H) {
    var ev = st.ev, idx = st.f.idx, vis = QC.visibleAt(ev, idx, st.life, T, st.maxLife);
    var rippleDur = S.rippleFrames * S.step, drawn = [];
    if (S.shape === 'rings') drawRingLayers(ctx, vis, T, proj, scale, W, H);
    var depth3d = S.shape === 'circle' && S.vol > 0;
    if (depth3d) {   // 奥行き：深いものから先に描き、浅い（近い）地震を手前にする。深さ不明は最後（効かせない）
      vis.sort(function (a, b) {
        var da = ev.dep[idx[a]], db = ev.dep[idx[b]];
        return (isNaN(db) ? -1 : db) - (isNaN(da) ? -1 : da) || ev.mag[idx[b]] - ev.mag[idx[a]];
      });
    }
    for (var n = 0; n < vis.length; n++) {
      var k = vis[n], i = idx[k], m = ev.mag[i], age = T - ev.t[i], f = age / st.life[k];
      var p = proj(i), r = QC.radius(m, S) * scale;
      var sty = QC.styleOf(S.colorMode, m, ev.dep[i], f, ev.maxi[i], srcd(i), srcHue(i)), a = QC.alphas(m, f, S);
      if (S.shape === 'sphere' || S.shape === 'rings') {
        r = S.shape === 'rings' ? drawRings(ctx, k, i, p, f, sty, scale, W, H) : drawSphere(ctx, k, i, p, f, sty, scale, W, H);
        if (r < 0) continue;
      } else {
      var look = depth3d ? QC.depthLook(ev.dep[i], m, S) : null;
      if (look) { r *= look.scale; a = { fill: a.fill * look.alpha, stroke: a.stroke * look.alpha }; }
      if (p[0] < -r - 60 || p[1] < -r - 60 || p[0] > W + r + 60 || p[1] > H + r + 60) continue;
      ctx.fillStyle = sty.fill; ctx.strokeStyle = sty.stroke;
      if (look && look.blur > 0.03 && r >= 2 && !sty.dash) {
        // ぼかし：放射状のグラデーションで輪郭をにじませる（どのブラウザでも同じに見える）
        var gi = r * (1 - look.blur), go = r * (1 + look.blur), gr = ctx.createRadialGradient(p[0], p[1], gi, p[0], p[1], go);
        gr.addColorStop(0, withAlpha(sty.fill, 1)); gr.addColorStop(1, withAlpha(sty.fill, 0));
        ctx.fillStyle = gr; ctx.globalAlpha = Math.min(1, a.fill * 1.2);
        ctx.beginPath(); ctx.arc(p[0], p[1], go, 0, 2 * Math.PI); ctx.fill();
        if (look.blur < 0.25) { ctx.globalAlpha = a.stroke; ctx.lineWidth = 1 * scale; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 2 * Math.PI); ctx.stroke(); }
      } else if (r < 1.2 && !sty.dash) { ctx.globalAlpha = Math.max(a.fill, a.stroke); ctx.fillRect(p[0] - r, p[1] - r, 2 * r, 2 * r); }
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
      drawn.push([p[0], p[1], r, i, k]);
    }
    ctx.globalAlpha = 1;
    return drawn;
  }

  /** '#rrggbb' または 'rgb(r,g,b)' に透明度を付ける */
  function withAlpha(c, al) {
    var v;
    if (c.charAt(0) === '#') { var n = parseInt(c.slice(1), 16); v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    else v = (c.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    return 'rgba(' + v[0] + ',' + v[1] + ',' + v[2] + ',' + al + ')';
  }
  function depthNote() {
    var parts = [];
    if (S.dShrink) parts.push('小さく');
    if (S.dBlur > 0) parts.push('ぼかし');
    if (S.dHaze > 0) parts.push('薄く');
    return '奥行き：深いほど' + parts.join('・') + '（3Dの効き' + Math.round(S.vol * 100) + '%、視点の高さ' + S.viewH + 'km' +
      (S.keepBig ? '、M' + S.keepBigM + '以上は薄めない' : '') + '）';
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
    if (!st.drawn || st.rec || st.v3d) return;
    var rc = $('mapwrap').getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    var best = null, bd = Infinity;
    for (var n = st.drawn.length - 1; n >= 0; n--) {   // 上に描いた（小さい）ものを先に
      var d = st.drawn[n], dist = Math.hypot(d[0] - x, d[1] - y);
      if (dist <= Math.max(d[2], 4) && dist < bd) { bd = dist; best = d; }
    }
    var tip = $('tip');
    if (!best) { tip.style.display = 'none'; return; }
    if (best[5]) {
      var g = best[5], mi = g.maxI;
      tip.textContent = '集合：' + g.n.toLocaleString() + '回　エネルギーの合計 M' + g.meq.toFixed(1) + '相当（' + QC.formatEnergy(g.E) + '）　最大 M' +
        st.ev.mag[mi].toFixed(1) + '（' + QC.formatDateTime(st.ev.t[mi]).slice(0, 16) + '、深さ' + (isNaN(st.ev.dep[mi]) ? '不明' : Math.round(st.ev.dep[mi]) + 'km') + '）';
      tip.style.display = 'block';
      tip.style.left = Math.min(x + 12, rc.width - tip.offsetWidth - 4) + 'px'; tip.style.top = (y + 14) + 'px';
      return;
    }
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
      (QC.depthFixed(ev.df[i]) ? (S.fixedDep ? Math.round(dep) + 'km（仮定の深さ）' : '不明（' + Math.round(ev.depRaw[i]) + 'km と仮定して震源を決めた）')
        : isNaN(dep) ? '不明' : (Math.round(dep * 10) / 10) + 'km' + (ev.df[i] === 2 ? stepNote(ev.t[i]) : '')) + '　観測' + QC.MAXI_LABEL[mx] +
      '　（' + QC.SRC_LABEL[ev.src[i]] + '）' + sph + srcTip(i);
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 12, rc.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = (y + 14) + 'px';
  }

  // ---------------------------------------------------------------- 凡例
  function legendItems() {
    if (sumView() || S.mode === 'timeAgg') return { title: 'エネルギーの合計（M相当）', items: QC.MAG_COLORS.filter(function (b) { return b.lo >= 2; })
      .map(function (b) { return { c: b.c, label: b.label.replace('以上', '') + '相当' + (b.label.indexOf('以上') >= 0 ? '以上' : ''), m: b.lo }; }) };
    if (S.colorMode === 'src') {
      // 色＝いちばん近い想定震源域（対象の海域だけ）、鮮やかさ＝近さ
      var gs = st.srcData ? st.srcData.groups.filter(function (g) { return !srcIds().length || srcIds().indexOf(g.id) >= 0; }) : [];
      return { title: '色＝いちばん近い想定震源域', items: gs.map(function (g) { return { c: QC.SRC_GROUP_COLORS[g.id], label: g.name }; })
        .concat([{ c: QC.SRC_FAR, label: QC.SRC_MAX_KM + 'km以内に無い' }, { c: QC.SRCD_UNKNOWN.fill, stroke: QC.SRCD_UNKNOWN.stroke, dash: true, label: '深さ不明' }]) };
    }
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
    // 見本の円の大きさ（集合マーカーは M 相当ごとの大きさ）。行の高さは円に合わせ、円は決まった幅の枠の真ん中に置く（字の位置をそろえ、円どうしを重ねない）
    var agg = sumView() || S.mode === 'timeAgg', rOf = function (it) {
      if (it.m == null) return 5;
      return agg ? Math.max(3, Math.min(QC.aggRadius(it.m, S) * 0.45, 11)) : S.shape === 'circle' ? Math.max(3, Math.min(QC.radius(it.m, S), 11)) : 5;
    };
    var rMax = Math.max.apply(null, L.items.map(rOf).concat([5]));
    L.items.forEach(function (it) {
      var r = rOf(it);
      h += '<div class="row" style="height:' + Math.max(18, 2 * r + 3) + 'px"><span class="swBox" style="width:' + (2 * rMax + 3) + 'px"><span class="sw" style="width:' + 2 * r + 'px;height:' + 2 * r + 'px;background:' +
        it.c + '99;border-color:' + (it.stroke || it.c) + (it.dash ? ';border-style:dashed' : '') + '"></span></span>' + it.label + '</div>';
    });
    if (sumView() || S.mode === 'timeAgg') {
      h += '<div class="note" style="color:#333;max-width:150px">' + aggNote() + '</div>';
      $('legend').innerHTML = h + srcLegendHtml(); return;
    }
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
    if (S.colorMode === 'src') {
      // 鮮やかさの見本（日本海溝の色で）：面から 5km 以内は元の色、遠いほど灰色に
      h += '<div class="ttl" style="margin-top:4px">鮮やかさ＝面からの近さ</div><div style="display:flex;flex-wrap:wrap;gap:2px 6px;max-width:150px">';
      [[3, '5km以内'], [10, '10km'], [20, '20km'], [40, '40km'], [80, '80km以上']].forEach(function (x) {
        h += '<span style="display:inline-flex;align-items:center;gap:2px"><span class="sw" style="width:10px;height:10px;background:' +
          QC.desaturate(QC.SRC_GROUP_COLORS.japan, QC.srcFade(x[0])) + ';border-color:#888"></span>' + x[1] + '</span>';
      });
      h += '</div><div class="note" style="color:#333;max-width:150px">震源から想定震源域の面（プレート境界・断層面）までの立体の距離。対象：' +
        (srcNames() || '読み込み中') + (srcIds().length ? '（重ねる図で選んだ海域）' : '（全部の海域）') + '</div>';
    }
    if (S.shape === 'circle' && S.vol > 0 && !st.v3d) h += '<div class="note" style="color:#333;max-width:150px">' + depthNote() + '</div>';   // 立体表示では奥行きの効きは使わない
    $('legend').innerHTML = h + srcLegendHtml();
  }
  /** まとめ方の重みの説明（凡例・動画用） */
  function kmWeightNote() {
    return { gr: '。重み＝10^M（M が 1 増えるごとに 10 倍。どの M の帯も同じくらい効き、大きな地震の周りが独立しやすい）',
             energy: '。重み＝エネルギー（大きな地震に中心が寄る。少数の大地震でまとめ方が大きく変わる）' }[S.kmWeight] || '';
  }
  function aggNote() {
    if (isKm() || st.v3d) return aggNoteBase() + kmWeightNote();
    return aggNoteBase();
  }
  function aggNoteBase() {
    if (st.v3d) return '集合マーカー：k-means（震源の' + (sumView() ? '東西・南北・深さの3次元' : '東西・南北・深さ・時間の4次元') + '）で、立体表示に選んだ範囲の地震を' +
      (sumView() ? kNow() + '個に' : '同時に約' + kNow() + '個見えるように') + 'まとめ、位置＝中心に近い実際の震源、大きさと色＝推定エネルギーの合計（M相当）、数字＝' +
      { meq: 'M相当', count: '回数', energy: 'エネルギー' }[S.aggLabel] + (isKm() ? '' : '（立体表示ではいつも k-means）');
    if (S.aggMethod === 'kmcum' && !sumView()) return '集合マーカー：k-means（累積）。期間の始めからその時刻までの地震を全部、震源の東西・南北・深さで' + kNow() +
      '個にまとめる（過去の地震もその時刻の地震として扱い、消えない）。中心は前の節目の中心から続けて求める。位置＝中心に近い実際の震央、大きさと色＝推定エネルギーの合計（M相当）、数字＝' +
      { meq: 'M相当', count: '回数', energy: 'エネルギー' }[S.aggLabel];
    if (isKm()) return '集合マーカー：k-means（震源の' + (sumView() ? '東西・南北・深さの3次元' : '東西・南北・深さ・時間の4次元') +
      '）で地図に見えている範囲の地震を' + (sumView() ? kNow() + '個に' : '同時に約' + kNow() + '個見えるように') + 'まとめ、位置＝中心に近い実際の震央、大きさと色＝推定エネルギーの合計（M相当）、数字＝' +
      { meq: 'M相当', count: '回数', energy: 'エネルギー' }[S.aggLabel] + '、点線＝塊の広がり';
    return '集合マーカー：' + (sumView() ? '期間内' : windowText()) + 'の地震を格子でまとめ、大きさと色＝推定エネルギーの合計（M相当）、数字＝' +
      { meq: 'M相当', count: '回数', energy: 'エネルギー' }[S.aggLabel] + '。合計はほぼ最大の地震で決まる';
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
    if (S.colorMode !== 'mag' && S.shape === 'circle' && !sumView()) ctx.fillText('円の大きさ＝M', x + 8 * scale, y + h - 10 * scale);
    if (srcIds().length || sumView() || S.mode === 'timeAgg' || S.shape === 'sphere' || S.shape === 'rings' || (S.shape === 'circle' && S.vol > 0)) {
      var words = (srcIds().length ? '［重ねた図］想定震源域（' + srcNames() + '。長期評価モデル、震源域に入る割合の濃淡、線＝想定の外形、茶の点線＝プレート境界の深さ、J-SHIS（防災科研）を加工）。' : '') + ((sumView() || S.mode === 'timeAgg') ? aggNote() : S.shape === 'circle' ? (S.vol > 0 ? depthNote() : '') : S.shape === 'rings' ? '輪の色＝推定震度（' + QC.RING_LEVELS.slice(QC.RING_LEVELS.indexOf(S.ringFrom)).map(function (lv) { return lv.replace('-', '弱').replace('+', '強'); }).join('・') + '）。' + ringNote() : sphereNote()), lines = [], cur = '', maxW = 230 * scale;
      ctx.font = 11 * scale + 'px sans-serif';
      for (var c = 0; c < words.length; c++) { if (ctx.measureText(cur + words[c]).width > maxW) { lines.push(cur); cur = ''; } cur += words[c]; }
      lines.push(cur);
      var by = y + h + 4 * scale;
      ctx.globalAlpha = 0.88; ctx.fillStyle = '#fff'; ctx.fillRect(x, by, maxW + 12 * scale, (lines.length * 15 + 6) * scale); ctx.globalAlpha = 1;
      ctx.fillStyle = '#1d2433'; ctx.textBaseline = 'top';
      lines.forEach(function (L, n) { ctx.fillText(L, x + 6 * scale, by + (3 + n * 15) * scale); });
    }
  }

  // ---------------------------------------------------------------- 断面図（横＝画面の横方向、縦＝深さ）
  var XS = { top: 16, bottom: 6, right: 150 };   // right：右上のボタンを避ける
  var XS_H = { S: 90, M: 170, L: 260 };
  function applyXsecSize() {
    var c = $('xsec'), h = XS_H[S.xsSize] || 170;
    c.dataset.h = h; c.style.height = h + 'px'; c.width = 0;        // 幅を 0 にして、次に描くときに大きさを合わせ直させる
    document.querySelectorAll('#xsecBtns button[data-s]').forEach(function (b) { b.classList.toggle('on', b.dataset.s === S.xsSize); });
    drawAll();
  }
  /** 断面図の縦の範囲（km）。「縦横同じ縮尺」は地図の 1 画素と同じ km を縦にも使う */
  function xsecMaxKm(innerH, scale) {
    if (S.xsDepth !== 'equal') return +S.xsDepth;
    return innerH / (QC.pxPerKm(map.getCenter().lat, map.getZoom()) * scale);
  }
  /** 断面図を描く。drawn は drawQuakes が返した [x, y, 半径, i, k]（ctx の単位）。
   *  画面に見えている（0≦x≦Wv、0≦y≦Hv）地震だけを、同じ x に、深さを縦にして描く。 */
  function drawXsec(ctx, drawn, Wv, Hv, top, height, scale, T, bg, ink, sub) {
    var ev = st.ev, ih = height - (XS.top + XS.bottom) * scale, maxKm = xsecMaxKm(ih, scale), y0 = top + XS.top * scale;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, Wv, height); ctx.clip();
    ctx.fillStyle = bg; ctx.fillRect(0, top, Wv, height);
    // 深さの目盛り
    ctx.font = 10 * scale + 'px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    QC.depthTicks(maxKm).forEach(function (d) {
      var y = y0 + ih * d / maxKm;
      ctx.globalAlpha = d === 0 ? 0.8 : 0.3; ctx.fillStyle = sub; ctx.fillRect(0, y, Wv, d === 0 ? 1.2 * scale : 0.8 * scale);
      ctx.globalAlpha = 1; ctx.fillText(d + 'km', 4 * scale, y + 7 * scale);
    });
    var deep = 0, noDep = 0, n = 0;
    if (drawn && ev) {
      for (var q = 0; q < drawn.length; q++) {
        var x = drawn[q][0], ys = drawn[q][1], i = drawn[q][3], k = drawn[q][4];
        if (x < 0 || x > Wv || ys < 0 || ys > Hv) continue;
        var d = ev.dep[i];
        if (isNaN(d)) { noDep++; continue; }
        if (d > maxKm) { deep++; continue; }
        var m = ev.mag[i], f = (T - ev.t[i]) / st.life[k];
        var sty = QC.styleOf(S.colorMode, m, d, f, ev.maxi[i], srcd(i), srcHue(i)), a = QC.alphas(m, f, S);
        var r = Math.min(QC.radius(m, S), 14) * scale, y = y0 + ih * Math.max(d, 0) / maxKm;
        ctx.beginPath(); ctx.arc(x, y, Math.max(r, 1.2 * scale), 0, 2 * Math.PI);
        ctx.fillStyle = sty.fill; ctx.globalAlpha = Math.max(a.fill, 0.25); ctx.fill();
        ctx.strokeStyle = sty.stroke; ctx.globalAlpha = a.stroke; ctx.lineWidth = 0.8 * scale; ctx.stroke();
        n++;
      }
    }
    ctx.globalAlpha = 1;
    // 見出し：横の向き（両端の方位）と縦の縮尺
    var az = QC.screenXAzimuth(S.bearing), kmPx = 1 / (QC.pxPerKm(map.getCenter().lat, map.getZoom()) * scale);
    var exag = (maxKm / ih) > 0 ? kmPx / (maxKm / ih) : 1;
    var head = '断面図　横＝地図の横方向（← ' + QC.dirName(az + 180) + '　' + QC.dirName(az) + ' →）　縦＝深さ 0〜' + Math.round(maxKm) + 'km' +
      (S.xsDepth === 'equal' ? '（縦横同じ縮尺）' : '（縦は横の約' + (exag >= 10 ? Math.round(exag) : exag.toFixed(1)) + '倍）');
    var tail = n + '件' + (deep ? '・深すぎて範囲外 ' + deep : '') + (noDep ? '・深さ不明 ' + noDep : '');
    ctx.font = 11 * scale + 'px sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = ink;
    ctx.textAlign = 'left'; ctx.fillText(head, 48 * scale, top + 2 * scale);
    ctx.textAlign = 'right'; ctx.fillText(tail, Wv - XS.right * scale, top + 2 * scale);
    ctx.restore();
  }
  function drawXsecScreen() {
    var c = $('xsec');
    if (!S.showXsec || !c.clientWidth) return;
    var g = fitCanvas(c), ctx = c.getContext('2d'), v = viewSize();
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    if (sumView()) return drawXsecAgg(ctx, Math.min(g.W, v.W), v.H, 0, g.H, 1, cssVar('--chart-bg'), cssVar('--ink'), cssVar('--sub'));
    if (S.mode === 'timeAgg') return drawXsecAgg(ctx, Math.min(g.W, v.W), v.H, 0, g.H, 1, cssVar('--chart-bg'), cssVar('--ink'), cssVar('--sub'), st.T);
    drawXsec(ctx, st.drawn, Math.min(g.W, v.W), v.H, 0, g.H, 1, st.T, cssVar('--chart-bg'), cssVar('--ink'), cssVar('--sub'));
  }
  function applyChartVisibility() {
    $('xsecBox').style.display = S.showXsec ? '' : 'none';
    $('xsecShow').style.display = S.showXsec ? 'none' : 'block';
    $('showXsec').checked = S.showXsec;
    $('mtChart').style.display = $('cntChart').style.display = S.showMt ? '' : 'none';
    renderChartBases(); drawAll();
  }

  // ---------------------------------------------------------------- グラフを地図の表示範囲に絞る
  /** 地図に見えている範囲（回転を含む）にある、描く対象の地震 */
  function computeViewIdx() {
    if (!st.f || !map) return;
    if (st.v3d && window.V3) { st.viewIdx = V3.roiAll(); return; }   // 立体表示の間は、選んだ範囲の地震
    var proj = makeProj(1), v = viewSize(), idx = st.f.idx, out = [];
    for (var k = 0; k < idx.length; k++) {
      var p = proj(idx[k]);
      if (p[0] >= 0 && p[0] <= v.W && p[1] >= 0 && p[1] <= v.H) out.push(idx[k]);
    }
    st.viewIdx = Int32Array.from(out);
  }
  var viewTimer = 0;
  function scheduleViewIdx() {
    if (!S.chartView) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(function () { computeViewIdx(); renderChartBases(); drawCharts(); }, 250);
  }
  function chartIdx() { return S.chartView && st.viewIdx ? st.viewIdx : st.f.idx; }
  function chartScopeLabel() { return S.chartView ? (st.v3d ? '立体表示の範囲の地震' : '地図に見えている範囲の地震') : '期間内の全域の地震'; }

  // ---------------------------------------------------------------- 操作盤の出し入れ
  function setSideHidden(h) {
    document.body.classList.toggle('sideHidden', h);
    $('sideTab').textContent = h ? '◀ 操作盤' : '操作盤 ▶';
    try { localStorage.setItem('quake.sideHidden', h ? '1' : '0'); } catch (e) { /* 保存できなくても動く */ }
  }

  // ---------------------------------------------------------------- グラフ（M-T 図と 1 日の回数）
  var CH = { left: 34, right: 8, top: 8, bottom: 16 };
  function chartX(t, W) { return CH.left + (W - CH.left - CH.right) * (t - st.t0) / (st.t1 - st.t0); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }
  function fitCanvas(c) {
    // 元の高さ（CSS の画素）は最初に控える。height 属性は高精細画面用に書き換わるので、毎回は読まない
    if (!c.dataset.h) c.dataset.h = c.getAttribute('height');
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = +c.dataset.h;
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
    ctx.save(); ctx.fillStyle = sub; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('M-T図（' + chartScopeLabel() + '）', CH.left + 4, 5); ctx.restore();
    var ev = st.ev, idx = chartIdx();
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], mg = ev.mag[i];
      ctx.fillStyle = S.colorMode === 'age' ? sub : S.colorMode === 'maxi' ? QC.styleOf('maxi', mg, 0, 0, ev.maxi[i]).stroke
        : QC.colorOf(S.colorMode, mg, ev.dep[i], 0, 0, srcd(i), srcHue(i));
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
    var dc = QC.dailyCounts(st.ev, chartIdx(), st.t0, st.t1), mx = 1;
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
    ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('1日あたりの回数（' + chartScopeLabel() + '）', CH.left + 4, CH.top - 2); ctx.restore();
    drawCatalogChanges(ctx, W, H, sub, true);
    drawTimeAxis(ctx, W, H, sub);
    return c;
  }
  function renderChartBases() {
    if (!st.f || !S.showMt || !$('mtChart').clientWidth) return;
    var ink = cssVar('--ink'), sub = cssVar('--sub');
    var a = fitCanvas($('mtChart')), b = fitCanvas($('cntChart'));
    st.mtBase = buildMtBase(a.W, a.H, a.dpr, ink, sub);
    st.cntBase = buildCntBase(b.W, b.H, b.dpr, sub);
  }
  function drawCharts() {
    if (!st.mtBase || !S.showMt) return;
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
      if (S.mode === 'sum') { S.mode = 'time'; $('mode').value = 'time'; st.agg = null; applyShapeClass(); renderLegend(); }
      cancelEnding();
      // 終わり（期間の終わり、またはデータの最後）にいるときは、いちばん過去から。途中で止めたときは、その時刻から続ける
      if (st.T >= playEnd() - S.step) setT(st.t0);
      st.lastTs = 0; requestAnimationFrame(tick);
    } else writeHash();
  }
  /** 再生の終わり：期間の終わりか、データの最後（その先は地震が無いので再生しない）の早いほう */
  function playEnd() { return Math.min(st.t1, st.dataEnd || st.t1); }
  function tick(ts) {
    if (!st.playing) return;
    if (st.lastTs) {
      var dt = Math.min((ts - st.lastTs) / 1000, 0.25);
      setT(st.T + S.step * S.fps * dt);
      if (st.T >= playEnd()) { setT(playEnd()); play(false); startEnding(); return; }
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
  var PERIOD_FOLLOW = 365;   // 開始日を動かしたとき、終了日がこの日数より先なら開始日＋この日数まで連れて動かす
  function onPeriodChange(which) {
    var a = QC.dateToMs($('t0').value), b = QC.dateToMs($('t1').value);
    // 開始日を大きく過去へ（または終了日より後へ）動かしたら、終了日も連れて動かす（最大 1 年、データの最後まで）。
    // 長い期間を見たいときは、そのあと終了日を動かす（終了日を動かしたときは開始日を動かさない）
    var moved = a < st.t0;       // 開始日を過去へ動かした（後ろへ動かしたときは、終了日が開始日より前になったときだけ連れて動かす）
    if (which === 't0' && !isNaN(a) && !isNaN(b) && ((moved && b - a > PERIOD_FOLLOW * DAY) || b < a)) {
      b = Math.min(a + (PERIOD_FOLLOW - 1) * DAY, QC.floorDayJst(dataRange().last));
      if (b < a) b = a;
      $('t1').value = QC.formatDate(b);
    }
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

  /** 深さ刻み（震源評価 2）で求めた深さの刻み（気象庁のフォーマットの説明による） */
  function stepNote(t) {
    var y = +QC.formatDate(t).slice(0, 4);
    return '（' + (y >= 1983 ? 1 : y >= 1961 && y <= 1966 ? 20 : 10) + 'km刻みで求めた深さ）';
  }
  /** 深さ固定の地震の数（読み込んだ期間）と扱い */
  function renderFixedNote() {
    var n = st.fixedN || 0, el = $('fixedNote');
    if (!el) return;
    el.textContent = '読み込んだ期間に ' + n.toLocaleString() + ' 回' + (n ? (S.fixedDep ? '（仮定の深さで描いている）' : '（深さ不明として、立体・断面図・深さの色・想定震源域からの距離では描かない）') : '');
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
  /** 地図のタイル（読み込み済みの img）を、回転する前の枠のまま 1 枚の canvas に写す。
   *  位置を測る間だけ枠の回転を外す（同じ処理の中で戻すので、画面には出ない）。 */
  function snapshotTiles(scale) {
    var rot = $('rot'), prev = rot.style.transform;
    rot.style.transform = 'translate(-50%, -50%)';
    var ms = map.getSize(), c = document.createElement('canvas'); c.width = ms.x * scale; c.height = ms.y * scale;
    var ctx = c.getContext('2d'), rc = map.getContainer().getBoundingClientRect(), miss = 0, items = [];
    map.getContainer().querySelectorAll('.leaflet-tile-pane img, .leaflet-overlay-pane canvas').forEach(function (img) {
      var r = img.getBoundingClientRect();
      if (r.right < rc.left || r.bottom < rc.top || r.left > rc.right || r.top > rc.bottom) return;
      if (img.tagName === 'IMG' && (!img.complete || !img.naturalWidth)) { miss++; return; }
      items.push([img, r.left - rc.left, r.top - rc.top, r.width, r.height, +getComputedStyle(img.closest('.leaflet-layer') || img).opacity || 1]);
    });
    rot.style.transform = prev;
    ctx.fillStyle = '#cfe3f2'; ctx.fillRect(0, 0, c.width, c.height);
    items.forEach(function (t) { ctx.globalAlpha = t[5]; ctx.drawImage(t[0], t[1] * scale, t[2] * scale, t[3] * scale, t[4] * scale); });
    ctx.globalAlpha = 1;
    return { canvas: c, missing: miss };
  }
  function drawFrame(ctx, bg, W, H, scale, chartH, mtBase, xsH, endState) {
    st.vidEnd = endState || null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W * scale, H * scale); ctx.clip();      // 地図の範囲の外（下のグラフ）にはみ出さない
    ctx.translate(W * scale / 2, H * scale / 2); ctx.rotate(S.bearing * Math.PI / 180);
    ctx.drawImage(bg, -bg.width / 2, -bg.height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var drawn = endState ? drawAggregate(ctx, scale, W * scale, H * scale)
      : S.mode === 'timeAgg' ? drawTimeAgg(ctx, st.T, scale, W * scale, H * scale) : drawQuakes(ctx, st.T, makeProj(scale), scale, W * scale, H * scale);
    if (rotated()) {   // 北の向き
      ctx.save(); ctx.translate(W * scale - 24 * scale, 66 * scale); ctx.rotate(S.bearing * Math.PI / 180);
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(0, 0, 15 * scale, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = '#c62828'; ctx.beginPath(); ctx.moveTo(0, -11 * scale); ctx.lineTo(6 * scale, 7 * scale); ctx.lineTo(0, 3 * scale); ctx.lineTo(-6 * scale, 7 * scale); ctx.fill();
      ctx.fillStyle = '#1d2433'; ctx.font = 8 * scale + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('北', 0, 7 * scale);
      ctx.restore();
    }
    ctx.restore();
    // 左上の日付（白い縁取り）
    ctx.font = 'bold ' + 26 * scale + 'px sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.lineWidth = 5 * scale; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round';
    var clock = endState ? '期間の合計' : QC.formatClock(st.T, S.step);
    ctx.strokeText(clock, 12 * scale, 10 * scale); ctx.fillStyle = '#1d2433'; ctx.fillText(clock, 12 * scale, 10 * scale);
    var di = endState ? { text: periodText() + '（' + chartIdx().length.toLocaleString() + ' 回）' } : dayInfo(st.T);
    if (!endState && S.mode === 'timeAgg') di = { text: '集合マーカー：' + kmLabel() + '　' + (di.text || '') };
    if (di.text) { ctx.font = 12 * scale + 'px sans-serif'; ctx.lineWidth = 3 * scale; ctx.strokeText(di.text, 14 * scale, 42 * scale); ctx.fillText(di.text, 14 * scale, 42 * scale); }
    drawLegendCanvas(ctx, 10 * scale, 64 * scale, scale);
    // 出典（右下）
    ctx.font = 11 * scale + 'px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    var cw = ctx.measureText(CREDIT).width;
    ctx.globalAlpha = 0.8; ctx.fillStyle = '#fff'; ctx.fillRect(W * scale - cw - 12 * scale, H * scale - 18 * scale, cw + 12 * scale, 18 * scale);
    ctx.globalAlpha = 1; ctx.fillStyle = '#1d2433'; ctx.fillText(CREDIT, W * scale - 6 * scale, H * scale - 4 * scale);
    if (xsH && endState) drawXsecAgg(ctx, W * scale, H * scale, H * scale, xsH * scale, scale, '#ffffff', '#1d2433', '#5b6475');
    else if (xsH && S.mode === 'timeAgg') drawXsecAgg(ctx, W * scale, H * scale, H * scale, xsH * scale, scale, '#ffffff', '#1d2433', '#5b6475', st.T);
    else if (xsH) drawXsec(ctx, drawn, W * scale, H * scale, H * scale, xsH * scale, scale, st.T, '#ffffff', '#1d2433', '#5b6475');
    if (chartH) {
      var cy = (H + xsH) * scale;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, cy, W * scale, chartH * scale);
      ctx.drawImage(mtBase, 0, cy);
      var x = chartX(st.T, W) * scale;
      ctx.globalAlpha = 0.12; ctx.fillStyle = '#5b6475'; ctx.fillRect(x, cy, W * scale - x, (chartH - CH.bottom) * scale);
      ctx.globalAlpha = 1; ctx.fillStyle = '#d81b60'; ctx.fillRect(x - scale, cy, 2 * scale, (chartH - CH.bottom) * scale);
    }
    // 最後のまとめ：画面全体（地図と下のグラフ）を暗くして統計を重ねる
    if (endState && endState.statsAlpha > 0) drawStatsPanel(ctx, ctx.canvas.width, ctx.canvas.height, scale, getStats(), endState.statsAlpha);
    st.vidEnd = null;
  }
  /** 地図のタイルが読み込み中の枚数 */
  function tilesPending() {
    var n = 0;
    map.getContainer().querySelectorAll('.leaflet-tile-pane img').forEach(function (img) { if (!img.complete || !img.naturalWidth) n++; });
    return n;
  }
  /** 書き出しを始める：操作盤を引っ込め、広がった地図のタイルが読み込み終わるのを待ってから書き出す */
  function startRecording() {
    var mime = pickMime(), note = $('recNote');
    if (!mime) { note.innerHTML = '<span class="warn">このブラウザは動画の書き出しに対応していません（Chrome・Edge・Safari・Firefox の新しい版で使えます）</span>'; return; }
    play(false); cancelEnding();
    st.restoreSide = !document.body.classList.contains('sideHidden');
    if (st.restoreSide) setSideHidden(true);
    $('recBtn').disabled = true;
    var waited = 0, calm = 0;
    (function wait() {
      var p = tilesPending();
      calm = p === 0 ? calm + 1 : 0;
      if (calm >= 3 || waited > 15000) return beginRecording(mime, note);   // 3 回続けて読み込み済みなら始める（最大 15 秒待つ）
      waited += 200; setTimeout(wait, 200);
    })();
  }
  function endRecordingUi() {
    $('recBtn').disabled = false;
    if (st.restoreSide) { setSideHidden(false); st.restoreSide = false; }
  }
  function beginRecording(mime, note) {
    var v = viewSize(), W = v.W, H = v.H, scale = +$('vidScale').value, chartH = $('vidChart').checked ? 110 : 0;
    var xsH = $('vidXsec').checked && S.showXsec ? (XS_H[S.xsSize] || 170) : 0;
    var snap = snapshotTiles(scale);
    if (snap.missing) { endRecordingUi(); note.innerHTML = '<span class="warn">地図のタイルがまだ読み込み中です（' + snap.missing + ' 枚）。少し待ってからもう一度押してください。</span>'; return; }
    var cv = document.createElement('canvas'); cv.width = W * scale; cv.height = (H + xsH + chartH) * scale;
    // 幅と高さは偶数にする（動画の符号化の都合）
    cv.width -= cv.width % 2; cv.height -= cv.height % 2;
    var ctx = cv.getContext('2d');
    try { ctx.drawImage(snap.canvas, 0, 0); cv.toDataURL('image/png').length; ctx.clearRect(0, 0, cv.width, cv.height); }
    catch (e) { endRecordingUi(); note.innerHTML = '<span class="warn">地図の画像を動画に入れられませんでした（' + e.message + '）</span>'; return; }
    var mtBase = chartH ? buildMtBase(W, chartH, scale, '#1d2433', '#5b6475') : null;
    var stream = cv.captureStream(0), track = stream.getVideoTracks()[0];
    var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 * scale }), chunks = [];
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    var main = Math.ceil((st.t1 - st.t0) / S.step) + 1, frame = 0, aborted = false, fps = S.fps;
    // 最後のまとめ：集合マーカーを endSumSec 秒、そのあと暗くして統計を endStatsSec 秒（0.6 秒かけて暗くする）
    var sumF = S.endSeq ? Math.round(S.endSumSec * fps) : 0, statF = S.endSeq ? Math.round(S.endStatsSec * fps) : 0;
    var total = main + sumF + statF;
    st.rec = { stop: function () { aborted = true; } };
    map.dragging.disable(); map.scrollWheelZoom.disable(); map.doubleClickZoom.disable(); map.touchZoom.disable(); map.keyboard.disable();
    $('recBtn').disabled = true; $('recStop').disabled = false; $('playBtn').disabled = true; $('bearing').disabled = true;
    rec.onstop = function () {
      map.scrollWheelZoom.enable(); map.doubleClickZoom.enable(); map.touchZoom.enable(); map.keyboard.enable();
      $('recStop').disabled = true; $('playBtn').disabled = false; $('bearing').disabled = false; st.rec = null;
      endRecordingUi(); renderLegend(); drawAll();
      if (!rotated()) map.dragging.enable();
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
      if (aborted || frame >= total) { rec.stop(); setT(st.t0 + Math.min(frame, main - 1) * S.step); return; }
      if (frame < main) { setT(st.t0 + frame * S.step); drawFrame(ctx, snap.canvas, W, H, scale, chartH, mtBase, xsH); }
      else {
        var e = frame - main, sa = e < sumF ? 0 : Math.min(1, (e - sumF) / Math.max(1, 0.6 * fps));
        drawFrame(ctx, snap.canvas, W, H, scale, chartH, mtBase, xsH, { statsAlpha: sa });
      }
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
    $('xsecBox').style.display = S.showXsec ? '' : 'none';
    $('xsecShow').style.display = S.showXsec ? 'none' : 'block';
    document.querySelectorAll('#xsecBtns button[data-s]').forEach(function (b) {
      b.onclick = function () { S.xsSize = b.dataset.s; settingsChanged('xsSize'); };
    });
    $('xsecHide').onclick = function () { S.showXsec = false; settingsChanged('showXsec'); };
    $('xsecShow').onclick = function () { S.showXsec = true; settingsChanged('showXsec'); };
    var c0 = $('xsec'), h0 = XS_H[S.xsSize] || 170; c0.dataset.h = h0; c0.style.height = h0 + 'px';
    document.querySelectorAll('#xsecBtns button[data-s]').forEach(function (b) { b.classList.toggle('on', b.dataset.s === S.xsSize); });
    $('mtChart').style.display = $('cntChart').style.display = S.showMt ? '' : 'none';
    var hid = false;
    try { hid = localStorage.getItem('quake.sideHidden') === '1'; } catch (e) { /* 読めなくても動く */ }
    setSideHidden(hid);
    $('sideTab').onclick = function () { setSideHidden(!document.body.classList.contains('sideHidden')); };
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
  window.__app = { S: S, st: st, setT: setT, boot: boot, drawFrame: drawFrame, QC: QC, getMap: function () { return map; },
    snapshotTiles: snapshotTiles, buildMtBase: buildMtBase, startRecording: startRecording,
    // 立体表示（js/view3d.js）から使う
    getStats: getStats, startEnding: startEnding, kmCumFrames: kmCumFrames, srcHue: srcHue, kmJobOf: kmJobOf, sumView: sumView, srcd: srcd, srcTip: srcTip, srcIds: srcIds, loadSrc: loadSrc, redraw: function () { layoutRot(); drawAll(); },
    refreshCharts: function () { computeViewIdx(); renderChartBases(); drawCharts(); renderLegend(); } };
  boot();
})();
