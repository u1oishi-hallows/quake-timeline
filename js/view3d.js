/* 立体表示（試作）。地図で範囲を選び、その範囲の地震だけを、半透明の地面の下に実際の深さで立体に描く。
 *
 * 流れ：「立体で見る」→ 地図の上をドラッグして範囲を選ぶ（または今見えている範囲全部）→ 立体表示。
 * 表示モードは平面の地図と同じ：
 *   時間に沿って（1 つずつ）… その時刻に残っている地震を、震源の立体位置に
 *   期間の合計（集合マーカー）… k-means（xyz）でまとめた塊を、立体の模型のように
 *   時間に沿って（集合マーカー）… k-means（xyzt）でまとめた塊を、その時刻の姿で
 * 回転・傾き・拡大は描き方（画面への写し方）だけを変え、計算はし直さない：
 *   ・地震の位置と大きさは地面の上の長さ（m）で持つ（大きさは立体にしたときの地図の倍率での見かけに合わせる）
 *   ・k-means は「選んだ範囲」でまとめる（画面に見えている範囲ではない）ので、回しても拡大しても同じ塊
 * 地面は平ら（地形・海の深さは描かない）。平面の地図の断面図・奥行きの効きは使わない（立体そのもので深さが見えるため）。
 * 深さ不明の地震は立体の位置が決まらないので描かず、数を出す。
 * 描画は deck.gl（MIT、vendor/ に同梱）。初めて立体表示を開いたときに読み込む。 */
(function () {
  'use strict';
  var DECK_SRC = 'vendor/deckgl-9.3.11.min.js';
  var GSI = 'https://cyberjapandata.gsi.go.jp/xyz/';
  var TERRAIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  var TILES = { pale: GSI + 'pale/{z}/{x}/{y}.png', blank: GSI + 'blank/{z}/{x}/{y}.png', photo: GSI + 'seamlessphoto/{z}/{x}/{y}.jpg' };
  var DAY = 86400000;
  var A, S, st, QC, map;
  var V = { open: false, roi: null, d: null, km: {}, deck: null, ground: null, mpp: 1, exag: 1, exagSel: 'auto', terrain: true, shadow: true, drop: true, pickRect: null };
  function $(id) { return document.getElementById(id); }
  function app() { A = window.__app; S = A.S; st = A.st; QC = A.QC; map = A.getMap(); }

  // ---------------------------------------------------------------- 範囲を選ぶ
  function startPick() {
    app();
    if (!st.f || st.rec) return;
    if (V.open) closeView(true);
    var p = $('roiPick');
    p.style.display = 'block';
    $('roiBox').style.display = 'none';
    setPickBar('pick');
  }
  function setPickBar(stage) {
    $('roiMsg').textContent = stage === 'pick' ? '立体で見る範囲を、地図の上でドラッグして囲んでください' : 'この範囲を立体で見ますか？（地震 ' + V.pickCount.toLocaleString() + ' 回）';
    $('roiAll').style.display = stage === 'pick' ? '' : 'none';
    $('roiGo').style.display = stage === 'pick' ? 'none' : '';
    $('roiRedo').style.display = stage === 'pick' ? 'none' : '';
  }
  function cancelPick() {
    $('roiPick').style.display = 'none';
    if (V.pickRect) { map.removeLayer(V.pickRect); V.pickRect = null; }
  }
  /** 画面（地図の枠）の点 → 緯度経度。地図を回しているときは逆に回してから Leaflet に聞く */
  function screenToLatLng(x, y) {
    var w = $('mapwrap'), ms = map.getSize(), d = QC.rotDelta(x - w.clientWidth / 2, y - w.clientHeight / 2, S.bearing);
    return map.containerPointToLatLng([ms.x / 2 + d[0], ms.y / 2 + d[1]]);
  }
  /** 画面の四角（4 隅）を囲む緯度経度の範囲。地図を回していると画面の四角は地図の上で斜めになるので、それを囲む南北・東西の範囲にする */
  function roiOfScreen(x0, y0, x1, y1) {
    var c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(function (p) { return screenToLatLng(p[0], p[1]); });
    var lat = c.map(function (q) { return q.lat; }), lon = c.map(function (q) { return q.lng; });
    return { s: Math.max(-85, Math.min.apply(null, lat)), n: Math.min(85, Math.max.apply(null, lat)),
             w: Math.min.apply(null, lon), e: Math.max.apply(null, lon) };
  }
  function bindPick() {
    var p = $('roiPick'), box = $('roiBox'), start = null;
    p.addEventListener('pointerdown', function (e) {
      if (e.target.closest('#roiBar')) return;
      var rc = p.getBoundingClientRect();
      start = [e.clientX - rc.left, e.clientY - rc.top];
      p.setPointerCapture(e.pointerId);
      box.style.display = 'block'; sizeBox(start, start);
      if (V.pickRect) { map.removeLayer(V.pickRect); V.pickRect = null; }
      setPickBar('pick');
    });
    p.addEventListener('pointermove', function (e) {
      if (!start) return;
      var rc = p.getBoundingClientRect();
      sizeBox(start, [e.clientX - rc.left, e.clientY - rc.top]);
    });
    p.addEventListener('pointerup', function (e) {
      if (!start) return;
      var rc = p.getBoundingClientRect(), end = [e.clientX - rc.left, e.clientY - rc.top], s0 = start;
      start = null; box.style.display = 'none';
      if (Math.abs(end[0] - s0[0]) < 20 || Math.abs(end[1] - s0[1]) < 20) return;   // 小さすぎる（クリック）は選び直し
      proposeRoi(roiOfScreen(Math.min(s0[0], end[0]), Math.min(s0[1], end[1]), Math.max(s0[0], end[0]), Math.max(s0[1], end[1])));
    });
    function sizeBox(a, b) {
      box.style.left = Math.min(a[0], b[0]) + 'px'; box.style.top = Math.min(a[1], b[1]) + 'px';
      box.style.width = Math.abs(b[0] - a[0]) + 'px'; box.style.height = Math.abs(b[1] - a[1]) + 'px';
    }
    $('roiAll').onclick = function () { var w = $('mapwrap'); proposeRoi(roiOfScreen(0, 0, w.clientWidth, w.clientHeight)); };
    $('roiCancel').onclick = cancelPick;
    $('roiRedo').onclick = function () { if (V.pickRect) { map.removeLayer(V.pickRect); V.pickRect = null; } setPickBar('pick'); };
    $('roiGo').onclick = function () { var r = V.pickRoi; cancelPick(); openView(r); };
  }
  /** 選んだ範囲を地図に重ねて見せ、確かめてもらう（地図を回していると、選んだ四角より広い南北・東西の四角になる） */
  function proposeRoi(r) {
    V.pickRoi = r;
    V.pickCount = roiList(r).all.length;
    V.pickRect = L.rectangle([[r.s, r.w], [r.n, r.e]], { color: '#d81b60', weight: 2, dashArray: '6 4', fill: false, interactive: false }).addTo(map);
    setPickBar('ok');
  }
  /** 範囲に入る地震（描く対象のうち）。all は深さ不明も含む（下のグラフ用）、list は深さが分かるもの（立体用） */
  function roiList(r) {
    var ev = st.ev, idx = st.f.idx, all = [], list = [], noDep = 0;
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], la = ev.lat[i], lo = ev.lon[i];
      if (la < r.s || la > r.n || lo < r.w || lo > r.e) continue;
      all.push(i);
      if (isNaN(ev.dep[i])) noDep++; else list.push(i);
    }
    return { all: all, list: list, noDep: noDep };
  }

  // ---------------------------------------------------------------- 立体表示を開く・閉じる
  function loadDeck() {
    if (window.deck) return Promise.resolve();
    if (V.loading) return V.loading;
    return (V.loading = new Promise(function (ok, ng) {
      var s = document.createElement('script');
      s.src = DECK_SRC; s.onload = ok; s.onerror = function () { V.loading = null; ng(new Error('deck.gl を読み込めませんでした')); };
      document.head.appendChild(s);
    }));
  }
  function openView(r) {
    app();
    V.roi = r; V.d = null; V.km = {};
    $('v3dMsg').textContent = '立体表示を準備しています…';
    document.body.classList.add('v3d'); st.v3d = true;
    $('v3d').style.display = 'block';
    $('recBtn').disabled = true;
    loadDeck().then(function () {
      if (!V.open) createDeck();
      V.open = true;
      flyToRoi();
      A.refreshCharts();
      update();
    }).catch(function (e) { $('v3dMsg').textContent = e.message; });
  }
  function closeView(keepUi) {
    if (!V.open && !st.v3d) return;
    if (V.spin) spin(false);
    V.open = false; st.v3d = false;
    document.body.classList.remove('v3d');
    $('v3d').style.display = 'none';
    if (!st.rec) $('recBtn').disabled = false;
    if (V.worker) { V.worker.terminate(); V.worker = null; }
    V.km = {}; V.kmPending = null;
    if (V.deck) { V.deck.finalize(); V.deck = null; V.ground = null; }
    $('v3dCanvasBox').innerHTML = '';
    A.refreshCharts();
    if (!keepUi) A.redraw();
  }
  function createDeck() {
    V.deck = new deck.Deck({
      parent: $('v3dCanvasBox'),
      views: new deck.MapView({ repeat: false }),
      // 見え方は自分で持つ（viewState）。回転の中心を地面より下（箱の深さの真ん中）に置くため、position（中心の高さ）を毎回付け直す
      viewState: (V.vs = { longitude: 137, latitude: 37, zoom: 4, pitch: 0, bearing: 0, maxPitch: 85, position: [0, 0, 0] }),
      onViewStateChange: function (e) { setView(e.viewState); },
      // 左ドラッグ（マウス）は自前で回す（bindRotate）。Shift＋ドラッグ・右ドラッグは移動、2 本指は deck.gl の回転と傾き
      controller: { dragMode: 'rotate', dragRotate: true, touchRotate: true, keyboard: true, inertia: 200 },
      getTooltip: tooltip,
      layers: []
    });
  }
  /** 選んだ範囲が画面に収まるように、少し斜めから見る。地図の向きは平面の地図に合わせる */
  function flyToRoi() {
    var r = V.roi, box = $('v3dCanvasBox'), W = box.clientWidth || 800, H = box.clientHeight || 600;
    var vp = new deck.WebMercatorViewport({ width: W, height: H }).fitBounds([[r.w, r.s], [r.e, r.n]], { padding: Math.min(80, W / 6, H / 6) });
    V.zoom0 = vp.zoom;
    // 大きさの基準：立体にしたときの倍率で、平面の地図の 1px が地面の上で何 m か
    V.mpp = 40075016.686 * Math.cos((r.s + r.n) / 2 * Math.PI / 180) / (512 * Math.pow(2, vp.zoom));
    setView({ longitude: vp.longitude, latitude: vp.latitude, zoom: vp.zoom - 0.3, pitch: 50, bearing: -S.bearing });
  }
  function setCamera(pitch) {
    var r = V.roi, box = $('v3dCanvasBox');
    var vp = new deck.WebMercatorViewport({ width: box.clientWidth, height: box.clientHeight }).fitBounds([[r.w, r.s], [r.e, r.n]], { padding: 60 });
    setView({ longitude: vp.longitude, latitude: vp.latitude, zoom: vp.zoom - (pitch ? 0.3 : 0), pitch: pitch, bearing: V.vs.bearing });
  }
  /** 見え方を決める。画面の中心は「地図の中心の真下、箱の深さの真ん中」（position＝その高さ）。回すとこの点のまわりに回る */
  function setView(v) {
    V.vs = { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: Math.max(0, Math.min(85, v.pitch)), bearing: v.bearing,
             maxPitch: 85, position: [0, 0, V.d ? zOf(V.d.maxKm / 2) : 0] };
    V.deck.setProps({ viewState: V.vs });
  }

  // ---------------------------------------------------------------- 範囲の地震（絞り込み・期間・残る時間が変わったら作り直す）
  function roiData() {
    var key = [st.fVer, st.t0, st.t1, S.life1, S.lifeGrowth, S.lifeMin, S.lifeMax, V.roi.s, V.roi.n, V.roi.w, V.roi.e].join('|');
    if (V.d && V.d.key === key && V.d.ev === st.ev) return V.d;
    var rl = roiList(V.roi), ev = st.ev, n = rl.list.length, life = new Float64Array(n), maxDep = 0;
    for (var q = 0; q < n; q++) { var i = rl.list[q]; life[q] = QC.lifeMs(ev.mag[i], S); maxDep = Math.max(maxDep, ev.dep[i]); }
    var step = maxDep <= 60 ? 10 : maxDep <= 200 ? 50 : 100;
    V.d = { key: key, ev: st.ev, idx: Int32Array.from(rl.list), life: life, noDep: rl.noDep, all: rl.all.length,
            maxLife: QC.lifeMs(99, S), maxKm: Math.max(step, Math.ceil(maxDep / step) * step) };
    $('v3dExag').options[0].textContent = '自動（×' + autoExag(V.roi, V.d.maxKm) + '）';
    V.km = {};
    if (V.dOnce) setTimeout(A.refreshCharts, 0);
    V.dOnce = true;
    return V.d;
  }
  /** 深さの強調の自動：箱の深さが、範囲の短いほうの辺の 3 分の 1 くらいに見える倍率（1・2・3・5・10 から） */
  function autoExag(r, maxKm) {
    var side = Math.min((r.e - r.w) * 111.32 * Math.cos((r.s + r.n) / 2 * Math.PI / 180), (r.n - r.s) * 110.574), want = side / 3 / maxKm, pick = 1;
    [1, 2, 3, 5, 10].forEach(function (x) { if (x <= want * 1.25) pick = x; });
    return pick;
  }
  function zOf(dep) { return -Math.max(dep, 0) * 1000 * V.exag; }

  // ---------------------------------------------------------------- k-means（選んだ範囲で。回転・拡大では計算し直さない）
  function kmFor(dim) {
    var d = roiData(), r = V.roi;
    var key = [dim, d.key, S.kmDepthW, S.kmKmPerDay, S.aggLevel].join('|');
    if (V.km[key]) return V.km[key];
    if (V.kmPending === key) return null;
    var area = (r.e - r.w) * 111.32 * Math.cos((r.s + r.n) / 2 * Math.PI / 180) * (r.n - r.s) * 110.574;
    var job = A.kmJobOf(Array.from(d.idx), dim, area, d.noDep);
    if (!window.Worker) { V.km[key] = QC.kmSolve(job); return V.km[key]; }
    if (V.worker) V.worker.terminate();
    V.worker = new Worker('js/kmworker.js');
    V.kmPending = key; V.kmSeq = (V.kmSeq || 0) + 1; job.seq = V.kmSeq;
    V.worker.onmessage = function (e) {
      if (e.data.seq !== V.kmSeq) return;
      V.kmPending = null;
      if (e.data.error) { $('v3dMsg').textContent = '集合マーカーをまとめられませんでした：' + e.data.error; return; }
      V.km[key] = e.data;
      update();
    };
    V.worker.postMessage(job, [job.P.buffer, job.ms.buffer, job.ids.buffer, job.ts.buffer]);
    return null;
  }

  // ---------------------------------------------------------------- 描く
  var colorCache = {};
  function rgb(c) {
    if (colorCache[c]) return colorCache[c];
    var v;
    if (c.charAt(0) === '#') { var n = parseInt(c.slice(1), 16); v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    else v = (c.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    return (colorCache[c] = v);
  }
  var NO_DEPTH = { depthWriteEnabled: false, depthCompare: 'always' };   // 半透明の地面の下も透けて見えるよう、描いた順に重ねる

  /** 時刻・設定が変わるたびに呼ぶ（app.js の drawAll から）。描く物を作り直すのは時刻に関わるものだけ */
  function update() {
    if (!V.open || !V.deck || !st.f) return;
    var d = roiData(), sum = A.sumView(), T = st.T;
    V.exag = V.exagSel === 'auto' ? autoExag(V.roi, d.maxKm) : +V.exagSel;    // 深さの強調は位置を写すときだけに効く（k-means は計算し直さない）
    if (V.vs && V.vs.position[2] !== zOf(d.maxKm / 2)) setView(V.vs);          // 回転の中心の深さも合わせる
    var layers = [groundLayer(), frameLayer(d)].concat(frameLabels(d), srcLayers3d());
    var msg = d.idx.length.toLocaleString() + ' 回' + (d.noDep ? '（深さ不明 ' + d.noDep.toLocaleString() + ' 回は立体の位置が決まらないので描かない）' : '');
    if (sum || S.mode === 'timeAgg') {
      var km = kmFor(sum ? 3 : 4);
      if (!km) msg = '集合マーカーをまとめています…　' + msg;
      else layers = layers.concat(clusterLayers(km, sum ? null : T));
      if (km) msg = (sum ? 'k-means（xyz）' + km.clusters.length + '塊' : 'k-means（xyzt）全体' + km.clusters.length + '塊・同時に約' + km.active) + '　' + msg;
    } else layers = layers.concat(quakeLayers(d, T));
    $('v3dMsg').textContent = msg;
    V.deck.setProps({ layers: layers });
  }
  /** 地面：地理院タイルを半透明に、選んだ範囲で切り取る（タイルの層は同じものを使い回し、回しても読み直さない） */
  function groundLayer() {
    if (V.terrain) return terrainLayer();
    var r = V.roi, key = [S.base, r.s, r.n, r.w, r.e].join('|');
    if (V.ground && V.groundKey === key) return V.ground;
    V.groundKey = key;
    return (V.ground = new deck.TileLayer({
      id: 'ground', data: TILES[S.base] || TILES.pale, minZoom: 2, maxZoom: S.base === 'blank' ? 14 : 18, tileSize: 256,
      extent: [r.w, r.s, r.e, r.n], parameters: NO_DEPTH,
      renderSubLayers: function (p) {
        var b = p.tile.boundingBox;
        return new deck.BitmapLayer(p, { data: null, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]], opacity: 0.55,
          parameters: NO_DEPTH, extensions: [new deck.ClipExtension()], clipBounds: [r.w, r.s, r.e, r.n] });
      }
    }));
  }
  /** 地形（海底を含む）：AWS Terrain Tiles（Terrarium 形式の標高 PNG。日本の周りの海底は ETOPO1、陸は SRTM・GMTED）に地理院タイルを貼る。
   *  高さは震源と同じ倍率で強調する（地形だけ強めると、海底の下で起きた地震が海底より上に見えてしまう）。
   *  地形どうしは前後を正しく重ね（奥の斜面が手前に透けない）、震源・箱は地形より後に、前後を見ずに重ねる（地面の下も見える） */
  function terrainLayer() {
    var r = V.roi, x = V.exag, key = ['T', S.base, r.s, r.n, r.w, r.e, x].join('|');
    if (V.ground && V.groundKey === key) return V.ground;
    V.groundKey = key;
    return (V.ground = new deck.TerrainLayer({
      id: 'terrain-' + x, elevationData: TERRAIN, texture: TILES[S.base] || TILES.pale, minZoom: 2, maxZoom: 12, tileSize: 256,
      elevationDecoder: { rScaler: 256 * x, gScaler: 1 * x, bScaler: x / 256, offset: -32768 * x },
      extent: [r.w, r.s, r.e, r.n], meshMaxError: 20 * x, opacity: 0.6, loadOptions: { worker: false },
      extensions: [new deck.ClipExtension()], clipBounds: [r.w, r.s, r.e, r.n],
      onTileError: function () { $('v3dMsg').textContent = '地形のタイルの一部を読めませんでした'; }
    }));
  }
  /** 想定震源域（重ねる図で選んだ海域）：外形と等深線を実際の深さに。選んだ範囲で切り取る。海域・倍率・範囲が同じなら作り直さない */
  function srcLayers3d() {
    var ids = A.srcIds(), r = V.roi, data = st.srcData;
    if (!ids.length || !data) return [];
    var key = [ids.join(','), V.exag, r.s, r.n, r.w, r.e].join('|');
    if (V.srcKey === key) return V.srcLay;
    var paths = [];
    data.groups.forEach(function (g) {
      if (ids.indexOf(g.id) < 0) return;
      g.codes.forEach(function (c) {
        c.outline.forEach(function (ring) {
          paths.push({ p: ring.map(function (q) { return [q[0], q[1], zOf(q[2])]; }), c: [180, 65, 13, c.main ? 230 : 170], w: c.main ? 2 : 1.3 });
        });
      });
      g.depth.forEach(function (x) {
        x.lines.forEach(function (ln) { paths.push({ p: ln.map(function (q) { return [q[0], q[1], zOf(x.km)]; }), c: [91, 58, 41, 150], w: 1 }); });
      });
    });
    V.srcKey = key;
    return (V.srcLay = [new deck.PathLayer({ id: 'src3d-' + key, data: paths, getPath: function (x) { return x.p; }, getColor: function (x) { return x.c; },
      getWidth: function (x) { return x.w; }, widthUnits: 'pixels', parameters: NO_DEPTH,
      extensions: [new deck.ClipExtension()], clipBounds: [r.w, r.s, r.e, r.n] })]);
  }
  /** 範囲の箱：地表と底の四角、4 本の縦の辺、深さの目盛りの四角 */
  function frameLayer(d) {
    var r = V.roi, rect = function (z) { return [[r.w, r.s, z], [r.e, r.s, z], [r.e, r.n, z], [r.w, r.n, z], [r.w, r.s, z]]; };
    var paths = [], zb = zOf(d.maxKm);
    QC.depthTicks(d.maxKm).forEach(function (km) { paths.push({ p: rect(zOf(km)), c: km === 0 ? [40, 50, 70, 200] : [90, 100, 120, 70], w: km === 0 ? 1.6 : 1 }); });
    if (QC.depthTicks(d.maxKm).slice(-1)[0] !== d.maxKm) paths.push({ p: rect(zb), c: [90, 100, 120, 120], w: 1 });
    [[r.w, r.s], [r.e, r.s], [r.e, r.n], [r.w, r.n]].forEach(function (c) { paths.push({ p: [[c[0], c[1], 0], [c[0], c[1], zb]], c: [90, 100, 120, 150], w: 1 }); });
    return new deck.PathLayer({ id: 'frame', data: paths, getPath: function (x) { return x.p; }, getColor: function (x) { return x.c; },
      getWidth: function (x) { return x.w; }, widthUnits: 'pixels', parameters: NO_DEPTH, updateTriggers: { getPath: [V.exag, d.maxKm] } });
  }
  function frameLabels(d) {
    var r = V.roi, items = QC.depthTicks(d.maxKm).filter(function (km) { return km > 0; }).map(function (km) { return { p: [r.w, r.s, zOf(km)], t: km + 'km' }; });
    return [new deck.TextLayer({ id: 'frameLbl', data: items, getPosition: function (x) { return x.p; }, getText: function (x) { return x.t; },
      getSize: 12, getColor: [40, 50, 70, 230], getTextAnchor: 'end', getAlignmentBaseline: 'center', getPixelOffset: [-6, 0],
      fontFamily: 'sans-serif', background: true, getBackgroundColor: [255, 255, 255, 170], backgroundPadding: [2, 1],
      parameters: NO_DEPTH, updateTriggers: { getPosition: [V.exag] } })];
  }
  /** 1 つずつ：その時刻に残っている地震（大きいものを先に＝下に）。位置・大きさ・色は数の並びで渡す */
  function quakeLayers(d, T) {
    var ev = st.ev, vis = QC.visibleAt(ev, d.idx, d.life, T, d.maxLife), n = vis.length, rippleDur = S.rippleFrames * S.step;
    var pos = new Float32Array(n * 3), rad = new Float32Array(n), fill = new Uint8Array(n * 4), line = new Uint8Array(n * 4), lw = new Float32Array(n);
    var ids = new Int32Array(n), rip = [], drops = [];
    for (var q = 0; q < n; q++) {
      var k = vis[q], i = d.idx[k], m = ev.mag[i], age = T - ev.t[i], f = age / d.life[k];
      var sty = QC.styleOf(S.colorMode, m, ev.dep[i], f, ev.maxi[i], A.srcd(i)), a = QC.alphas(m, f, S), cf = rgb(sty.fill), cs = rgb(sty.stroke);
      var r = QC.radius(m, S) * V.mpp;
      pos[q * 3] = ev.lon[i]; pos[q * 3 + 1] = ev.lat[i]; pos[q * 3 + 2] = zOf(ev.dep[i]);
      rad[q] = r; lw[q] = m >= 5 ? 1.6 : 1; ids[q] = i;
      fill.set([cf[0], cf[1], cf[2], Math.round(255 * a.fill)], q * 4);
      line.set([cs[0], cs[1], cs[2], Math.round(255 * a.stroke)], q * 4);
      if (V.drop && m >= 4) drops.push({ i: i, c: cs, a: a.stroke });
      if (S.ripple && m >= S.rippleMinM && age < rippleDur) rip.push({ i: i, r: r, g: age / rippleDur, c: cs });
    }
    V.ids = ids;
    var data = { length: n, attributes: { getPosition: { value: pos, size: 3 }, getRadius: { value: rad, size: 1 },
      getFillColor: { value: fill, size: 4, normalized: true }, getLineColor: { value: line, size: 4, normalized: true }, getLineWidth: { value: lw, size: 1 } } };
    var out = [];
    if (V.shadow) out.push(shadowLayer('shadow', vis.map(function (k) { return d.idx[k]; })));
    if (drops.length) out.push(dropLayer('drop', drops));
    out.push(new deck.ScatterplotLayer({ id: 'quakes', data: data, billboard: true, stroked: true, filled: true, radiusUnits: 'meters',
      radiusMinPixels: 1.5, lineWidthUnits: 'pixels', pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 120], parameters: NO_DEPTH }));
    if (rip.length) out.push(new deck.ScatterplotLayer({ id: 'ripple', data: rip, billboard: true, stroked: true, filled: false, radiusUnits: 'meters',
      getPosition: function (x) { return [ev.lon[x.i], ev.lat[x.i], zOf(ev.dep[x.i])]; },
      getRadius: function (x) { return x.r + x.g * (12 * V.mpp + 2.5 * x.r); },
      getLineColor: function (x) { return [x.c[0], x.c[1], x.c[2], Math.round(230 * (1 - x.g))]; }, lineWidthUnits: 'pixels', getLineWidth: 2, parameters: NO_DEPTH }));
    return out;
  }
  /** 地表の影（震央）：立体の位置を読み取りやすくする */
  function shadowLayer(id, list) {
    var ev = st.ev;
    return new deck.ScatterplotLayer({ id: id, data: list, getPosition: function (i) { return [ev.lon[i], ev.lat[i], 0]; },
      getRadius: 1.6, radiusUnits: 'pixels', getFillColor: [40, 50, 70, 90], parameters: NO_DEPTH });
  }
  /** 震央から震源への線（大きい地震・塊だけ） */
  function dropLayer(id, items) {
    var ev = st.ev;
    return new deck.LineLayer({ id: id, data: items, getSourcePosition: function (x) { return [ev.lon[x.i], ev.lat[x.i], 0]; },
      getTargetPosition: function (x) { return [ev.lon[x.i], ev.lat[x.i], zOf(ev.dep[x.i])]; },
      getColor: function (x) { return [x.c[0], x.c[1], x.c[2], Math.round(150 * x.a)]; }, getWidth: 1, widthUnits: 'pixels', parameters: NO_DEPTH });
  }
  /** 集合マーカー：塊ごとに、時刻 T の姿（T が null なら期間の合計）。大きい塊を先に（下に） */
  function clusterLayers(km, T) {
    var ev = st.ev, items = [];
    for (var q = km.clusters.length - 1; q >= 0; q--) {
      var a = QC.kmAt(km.clusters[q], T, S);
      if (a) items.push(a);
    }
    var col = function (a) { return rgb(QC.colorOf('mag', a.meq, 0, 0)); };
    var out = [];
    if (V.shadow) out.push(shadowLayer('kmShadow', items.map(function (a) { return a.ev; })));
    if (V.drop) out.push(dropLayer('kmDrop', items.map(function (a) { return { i: a.ev, c: col(a), a: a.alpha }; })));
    out.push(new deck.ScatterplotLayer({ id: 'km', data: items, billboard: true, stroked: true, filled: true, radiusUnits: 'meters', radiusMinPixels: 3,
      getPosition: function (a) { return [ev.lon[a.ev], ev.lat[a.ev], zOf(ev.dep[a.ev])]; },
      getRadius: function (a) { return QC.aggRadius(a.meq, S) * V.mpp; },
      getFillColor: function (a) { var c = col(a); return [c[0], c[1], c[2], Math.round(158 * a.alpha)]; },
      getLineColor: function (a) { return [255, 255, 255, Math.round(242 * a.alpha)]; }, lineWidthUnits: 'pixels', getLineWidth: 1.6,
      pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 110], parameters: NO_DEPTH }));
    out.push(new deck.TextLayer({ id: 'kmLbl', data: items.filter(function (a) { return QC.aggRadius(a.meq, S) >= 10; }),
      getPosition: function (a) { return [ev.lon[a.ev], ev.lat[a.ev], zOf(ev.dep[a.ev])]; }, getText: function (a) { return label(a); },
      getSize: function (a) { return Math.max(10, Math.min(16, QC.aggRadius(a.meq, S) * 0.55)); }, getColor: function (a) { return [255, 255, 255, Math.round(255 * a.alpha)]; },
      fontFamily: 'sans-serif', fontWeight: 'bold', outlineWidth: 3, outlineColor: [0, 0, 0, 170], fontSettings: { sdf: true }, characterSet: 'auto',
      parameters: NO_DEPTH }));
    return out;
  }
  function label(a) {
    if (S.aggLabel === 'count') return a.n >= 10000 ? (a.n / 10000).toFixed(a.n >= 100000 ? 0 : 1) + '万' : String(a.n);
    if (S.aggLabel === 'energy') return QC.formatEnergy(a.E);
    return a.meq.toFixed(1);
  }
  function tooltip(info) {
    if (!info || info.index < 0 || !info.layer) return null;
    var ev = st.ev, txt;
    if (info.layer.id === 'quakes') {
      var i = V.ids[info.index];
      if (i == null) return null;
      txt = QC.formatDateTime(ev.t[i]) + '　M' + ev.mag[i].toFixed(1) + '　深さ' + (Math.round(ev.dep[i] * 10) / 10) + 'km　観測' + QC.MAXI_LABEL[ev.maxi[i]] + A.srcTip(i);
    } else if (info.layer.id === 'km' && info.object) {
      var g = info.object, mi = g.maxI;
      txt = '集合：' + g.n.toLocaleString() + '回　エネルギーの合計 M' + g.meq.toFixed(1) + '相当（' + QC.formatEnergy(g.E) + '）　最大 M' + ev.mag[mi].toFixed(1) +
        '（' + QC.formatDateTime(ev.t[mi]).slice(0, 16) + '、深さ' + Math.round(ev.dep[mi]) + 'km）';
    } else return null;
    return { text: txt, style: { fontSize: '12px', background: 'rgba(29,36,51,.9)', color: '#fff', padding: '4px 8px', borderRadius: '4px', maxWidth: '360px' } };
  }

  /** 回す：dBearing は縦の軸（z）まわり、dPitch は横の軸（x）まわり（傾き、0＝真上から〜85＝ほぼ真横から）。
   *  中心は画面の中心（地図の中心の真下・箱の深さの真ん中）なので、向きと傾きを変えるだけでその点のまわりに回る */
  function rotateBy(dBearing, dPitch) {
    var v = V.vs;
    setView({ longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, bearing: v.bearing + dBearing, pitch: v.pitch + dPitch });
  }
  /** マウスの左ドラッグで回す（左右＝縦の軸まわり、上下＝傾き）。deck.gl に渡さない（渡すと移動になる） */
  function bindRotate() {
    var box = $('v3dCanvasBox'), drag = null;
    var mine = function (e) { return e.pointerType === 'mouse' && e.button === 0 && !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey); };
    box.addEventListener('pointerdown', function (e) {
      if (V.spin) spin(false);
      if (!V.deck || !mine(e)) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* 押した指が無い（合成の操作など）：取り込まずに続ける */ }
      e.stopPropagation(); e.preventDefault();
    }, true);
    box.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      rotateBy(dx * 0.35, -dy * 0.3);
    }, true);
    var end = function (e) { if (drag && e.pointerId === drag.id) { drag = null; e.stopPropagation(); } };
    box.addEventListener('pointerup', end, true); box.addEventListener('pointercancel', end, true);
    // deck.gl はマウスの押し下げでも動き出すので、自前で回すときはそれも止める
    ['mousedown', 'mousemove', 'mouseup'].forEach(function (t) {
      box.addEventListener(t, function (e) { if (drag || (t === 'mousedown' && mine({ pointerType: 'mouse', button: e.button, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }))) e.stopPropagation(); }, true);
    });
  }
  /** 回し続ける（ろくろのように）。もう一度押すか、図に触れると止まる */
  function spin(on) {
    V.spin = on; $('v3dSpin').textContent = on ? '■ 止める' : '⟳ 回し続ける';
    if (!on) return;
    var last = performance.now();
    (function step(now) {
      if (!V.spin || !V.open) return;
      rotateBy((now - last) * 0.012, 0); last = now;       // 1 秒に 12 度（30 秒で 1 周）
      requestAnimationFrame(step);
    })(last);
  }

  // ---------------------------------------------------------------- 操作
  function bind() {
    bindPick();
    $('v3dBtn').onclick = startPick;
    $('v3dSide').onclick = startPick;
    $('v3dClose').onclick = function () { closeView(); };
    $('v3dRedo').onclick = function () { closeView(); startPick(); };
    $('v3dTop').onclick = function () { setCamera(0); };
    $('v3dTilt').onclick = function () { setCamera(55); };
    $('v3dSpin').onclick = function () { spin(!V.spin); };
    $('v3dTerrain').onchange = function () { V.terrain = this.checked; update(); };
    bindRotate();
    // 凡例と操作盤を隠す・出す（平面の地図でも使える。時刻は隠さない）
    var tog = function () { var h = !document.body.classList.contains('uiHidden'); document.body.classList.toggle('uiHidden', h);
      $('uiTog').textContent = h ? '凡例などを出す' : '凡例などを隠す'; };
    $('uiTog').onclick = tog;
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) tog();
    });
    $('v3dExag').onchange = function () { V.exagSel = this.value; update(); };
    $('v3dShadow').onchange = function () { V.shadow = this.checked; update(); };
    $('v3dDrop').onchange = function () { V.drop = this.checked; update(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('roiPick').style.display === 'block') cancelPick(); });
  }
  window.V3 = { update: update, roiAll: function () { return Int32Array.from(roiList(V.roi).all); }, isOpen: function () { return V.open; }, close: closeView, startPick: startPick, _V: V, _roiOfScreen: function (a, b, c, d) { app(); return roiOfScreen(a, b, c, d); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
