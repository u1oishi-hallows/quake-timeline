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
  var V = { open: false, roi: null, d: null, km: {}, deck: null, ground: null, mpp: 1, exag: 1, exagSel: 'auto', terrain: true, membrane: true, shadow: true, drop: true, pickRect: null };
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
    V.roi = r; V.d = null; V.km = {}; V.zc = null;
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
  /** 立体の模型として見る（OrbitView）。座標は選んだ範囲の中心からの m（東西は緯度ごとの縮み cos(緯度) を掛ける正弦図法、南北、上下）。
   *  地図の見え方（MapView）は地面の上からしか見られないので使わない。これで真上から真横、地面の下から見上げるまで回せる */
  function createDeck() {
    V.deck = new deck.Deck({
      parent: $('v3dCanvasBox'),
      views: new deck.OrbitView({ orbitAxis: 'Z', fovy: 40, near: 0.01, far: 1000 }),
      viewState: (V.vs = { target: [0, 0, 0], rotationX: 35, rotationOrbit: 0, zoom: -10, minRotationX: -90, maxRotationX: 90, minZoom: -20, maxZoom: 5 }),
      onViewStateChange: function (e) { setView(e.viewState); },
      // 左ドラッグ：回す（中心＝箱の中心）、Shift＋ドラッグ・右ドラッグ：移動、ホイール・ピンチ：拡大
      controller: { inertia: 200, keyboard: true },
      getTooltip: tooltip,
      layers: []
    });
  }
  /** 経度・緯度・高さ（m、下が負）→ 模型の座標（m） */
  function P(lon, lat, z) {
    var c = V.c;
    return [(lon - c.lon) * 111320 * Math.cos(lat * Math.PI / 180), (lat - c.lat) * 110574, z];
  }
  /** 選んだ範囲が画面に収まるように、少し斜めから見る。地図の向きは平面の地図に合わせる */
  function flyToRoi() {
    var r = V.roi;
    V.c = { lon: (r.w + r.e) / 2, lat: (r.s + r.n) / 2 };
    var box = $('v3dCanvasBox'), W = box.clientWidth || 800, H = box.clientHeight || 600;
    var w = (r.e - r.w) * 111320 * Math.cos(V.c.lat * Math.PI / 180), h = (r.n - r.s) * 110574;
    var zoom = Math.log2(Math.min(W / w, H / h) * 0.8);
    // 大きさの基準：立体にした直後の倍率で、平面の地図の 1px が地面の上で何 m か（印の大きさを平面の見かけに合わせる）
    V.mpp = 1 / Math.pow(2, zoom);
    setView({ target: [0, 0, 0], rotationX: 40, rotationOrbit: S.bearing, zoom: zoom });
  }
  /** 決まった向きから見る（rotationX：90＝真上、0＝真横、負＝地面の下から見上げる） */
  function setCamera(rx) {
    setView(Object.assign({}, V.vs, { rotationX: rx, zoom: Math.min(V.vs.zoom, fitZoom()) }));
  }
  /** 箱（選んだ範囲 × 深さ × 強調）が画面に入りきる倍率 */
  function fitZoom() {
    var r = V.roi, box = $('v3dCanvasBox'), W = box.clientWidth || 800, H = box.clientHeight || 600;
    var w = (r.e - r.w) * 111320 * Math.cos(V.c.lat * Math.PI / 180), h = (r.n - r.s) * 110574, dz = V.d ? V.d.maxKm * 1000 * V.exag : 0;
    return Math.log2(Math.min(W, H) * 0.85 / Math.sqrt(w * w + h * h + dz * dz));
  }
  /** 見え方を決める。回転の中心は target（初めは箱の中心＝範囲の中心の真下・箱の深さの真ん中。Shift＋ドラッグで移動すると一緒に動く） */
  function setView(v) {
    V.vs = { target: v.target || [0, 0, 0], rotationX: Math.max(-90, Math.min(90, v.rotationX)), rotationOrbit: v.rotationOrbit,
             zoom: v.zoom, minRotationX: -90, maxRotationX: 90, minZoom: -20, maxZoom: 5 };
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
    var key = [dim, d.key, S.kmDepthW, S.kmKmPerDay, S.kmWeight, S.aggLevel].join('|');
    if (V.km[key]) return V.km[key];
    if (V.kmPending === key) return null;
    var area = (r.e - r.w) * 111.32 * Math.cos((r.s + r.n) / 2 * Math.PI / 180) * (r.n - r.s) * 110.574;
    var job = A.kmJobOf(Array.from(d.idx), dim === 'cum' ? 3 : dim, area, d.noDep);
    if (dim === 'cum') { job.type = 'cum'; job.nk = A.kmCumFrames(job.ids.length, job.k); }     // 累積（その時刻までを全部）
    if (!window.Worker) { V.km[key] = dim === 'cum' ? QC.kmCumSolve(job) : QC.kmSolve(job); return V.km[key]; }
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
  var NO_DEPTH = { depthWriteEnabled: false, depthCompare: 'always' };
  // 震源・集合マーカーは前後を見ずに描く（地面の下も見える）が、奥行きは書き残す。あとから描く震源域の膜は、それより奥の震源にだけ重なる
  // （膜の向こうの震源は膜の色がかかり、手前の震源はそのまま＝膜が立体に見える）
  var QUAKE_DEPTH = { depthWriteEnabled: true, depthCompare: 'always' };
  var BEHIND = { depthWriteEnabled: false, depthCompare: 'less-equal' };   // 半透明の地面の下も透けて見えるよう、描いた順に重ねる

  /** 時刻・設定が変わるたびに呼ぶ（app.js の drawAll から）。描く物を作り直すのは時刻に関わるものだけ */
  function update() {
    if (!V.open || !V.deck || !st.f) return;
    var d = roiData(), sum = A.sumView(), T = st.T;
    V.exag = V.exagSel === 'auto' ? autoExag(V.roi, d.maxKm) : +V.exagSel;    // 深さの強調は位置を写すときだけに効く（k-means は計算し直さない）
    if (V.zc !== zOf(d.maxKm / 2)) {                                            // 開いたとき・強調を変えたとき：回転の中心を箱の深さの真ん中に、箱が入りきるまで引く
      V.zc = zOf(d.maxKm / 2);
      setView(Object.assign({}, V.vs, { target: [V.vs.target[0], V.vs.target[1], V.zc], zoom: Math.min(V.vs.zoom, fitZoom()) }));
    }
    var layers = [groundLayer(), frameLayer(d)].concat(frameLabels(d), srcLayers3d()).filter(Boolean);
    var msg = d.idx.length.toLocaleString() + ' 回' + (d.noDep ? '（深さ不明 ' + d.noDep.toLocaleString() + ' 回は立体の位置が決まらないので描かない）' : '');
    if (sum || S.mode === 'timeAgg') {
      var cum = !sum && S.aggMethod === 'kmcum', km = kmFor(sum ? 3 : cum ? 'cum' : 4);
      if (!km) msg = '集合マーカーをまとめています…　' + msg;
      else layers = layers.concat(clusterLayers(km, sum ? null : T));
      if (km) msg = (sum ? 'k-means（xyz）' + km.clusters.length + '塊' : cum ? 'k-means（累積）' + QC.kmCumAt(km, T).length + '塊' :
        'k-means（xyzt）全体' + km.clusters.length + '塊・同時に約' + km.active) + '　' + msg;
    } else layers = layers.concat(quakeLayers(d, T));
    layers = layers.concat(membrane3d());
    $('v3dMsg').textContent = msg + (V.groundNote ? '　' + V.groundNote : '');
    V.deck.setProps({ layers: layers });
  }
  /** 地面：選んだ範囲 1 枚の模型。地形・海底地形（AWS Terrain Tiles の標高 PNG、Terrarium：(R×256＋G＋B/256)−32768 m）に地理院タイルを貼る。
   *  タイルは範囲に合う倍率で 1 回だけ読み、つなげて 1 枚の画像と標高の格子にする（回しても拡大しても読み直さない）。
   *  高さは震源と同じ倍率で強調する（地形だけ強めると、海底の下の地震が海底より上に見えてしまう）。「地形」を外すと平らな地面。
   *  地形どうしは前後を正しく重ね、震源・箱は地形の後に前後を見ずに重ねる（地面の下が透けて見える） */
  var MESH_N = 160;
  function groundLayer() {
    var g = groundData();
    if (!g) return null;
    var key = [g.key, V.terrain, V.exag].join('|');
    if (V.ground && V.groundKey === key) return V.ground;
    V.groundKey = key;
    var r = V.roi, N = MESH_N, pos = new Float32Array(N * N * 3), q = 0;
    for (var i = 0; i < N; i++) {
      var lat = r.n - (r.n - r.s) * i / (N - 1);
      for (var j = 0; j < N; j++) {
        var lon = r.w + (r.e - r.w) * j / (N - 1), p = P(lon, lat, V.terrain && g.elev ? g.elev[q] * V.exag : 0);
        pos[q * 3] = p[0]; pos[q * 3 + 1] = p[1]; pos[q * 3 + 2] = p[2]; q++;
      }
    }
    return (V.ground = new deck.SimpleMeshLayer({ id: 'ground-' + key, data: [0], _instanced: false, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
      mesh: { attributes: { POSITION: { value: pos, size: 3 }, TEXCOORD_0: { value: g.uv, size: 2 } }, indices: { value: g.idx, size: 1 } },
      texture: g.tex, getPosition: [0, 0, 0], getColor: [235, 238, 242], opacity: 0.72, parameters: { depthWriteEnabled: false, depthCompare: 'always' },
      material: { ambient: 0.6, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] } }));
  }
  /** 地面の画像と標高を読む（範囲・地図の種類ごとに 1 回）。読み終えたら描き直す */
  function groundData() {
    var r = V.roi, base = S.base === 'blank' ? 'blank' : S.base === 'photo' ? 'photo' : 'pale', key = [base, r.s, r.n, r.w, r.e].join('|');
    if (V.g && V.g.key === key) return V.g.ready ? V.g : null;
    var mx = function (lon, z) { return (lon + 180) / 360 * Math.pow(2, z) * 256; };
    var my = function (lat, z) { return (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z) * 256; };
    // 範囲の横・縦が 1600px くらいになる倍率（タイルは多くても 8×8 枚ほど）
    var z = Math.floor(Math.log2(1600 / Math.max(mx(r.e, 0) - mx(r.w, 0), my(r.s, 0) - my(r.n, 0))));
    z = Math.max(base === 'blank' ? 5 : 2, Math.min(12, z));
    var x0 = Math.floor(mx(r.w, z) / 256), x1 = Math.floor(mx(r.e, z) / 256), y0 = Math.floor(my(r.n, z) / 256), y1 = Math.floor(my(r.s, z) / 256);
    var nx = x1 - x0 + 1, ny = y1 - y0 + 1, G = V.g = { key: key, ready: false };
    var tex = document.createElement('canvas'); tex.width = nx * 256; tex.height = ny * 256;
    var hc = document.createElement('canvas'); hc.width = nx * 256; hc.height = ny * 256;
    var tc = tex.getContext('2d'), hx = hc.getContext('2d', { willReadFrequently: true }), jobs = [], done = 0, fail = 0, total = nx * ny * 2;
    var img = function (u) { return fetch(u, { mode: 'cors' }).then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); }).then(createImageBitmap); };
    var url = function (u, x, y) { return u.replace('{z}', z).replace('{x}', x).replace('{y}', y); };
    for (var tx = x0; tx <= x1; tx++) for (var ty = y0; ty <= y1; ty++) (function (tx, ty) {
      jobs.push(img(url(TILES[base], tx, ty)).then(function (b) { tc.drawImage(b, (tx - x0) * 256, (ty - y0) * 256); }).catch(function () { fail++; })
        .then(function () { done++; progress(); }));
      jobs.push(img(url(TERRAIN, tx, ty)).then(function (b) { hx.drawImage(b, (tx - x0) * 256, (ty - y0) * 256); }).catch(function () { fail++; G.elevFail = true; })
        .then(function () { done++; progress(); }));
    })(tx, ty);
    function progress() { if (V.open && !G.ready) $('v3dMsg').textContent = '地面の画像と地形を読み込んでいます… ' + done + ' / ' + total; }
    Promise.all(jobs).then(function () {
      if (V.g !== G) return;
      var px = hx.getImageData(0, 0, hc.width, hc.height).data, N = MESH_N, uv = new Float32Array(N * N * 2), elev = new Float32Array(N * N), q = 0;
      var hAt = function (X, Y) {     // 標高の画像を双線形で読む（m）
        X = Math.max(0, Math.min(hc.width - 1.001, X)); Y = Math.max(0, Math.min(hc.height - 1.001, Y));
        var i0 = Math.floor(X), j0 = Math.floor(Y), fx = X - i0, fy = Y - j0, v = function (i, j) { var o = (j * hc.width + i) * 4; return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768; };
        return (v(i0, j0) * (1 - fx) + v(i0 + 1, j0) * fx) * (1 - fy) + (v(i0, j0 + 1) * (1 - fx) + v(i0 + 1, j0 + 1) * fx) * fy;
      };
      for (var i = 0; i < N; i++) {
        var lat = r.n - (r.n - r.s) * i / (N - 1), Y = my(lat, z) - y0 * 256;
        for (var j = 0; j < N; j++) {
          var lon = r.w + (r.e - r.w) * j / (N - 1), X = mx(lon, z) - x0 * 256;
          uv[q * 2] = X / tex.width; uv[q * 2 + 1] = Y / tex.height; elev[q] = G.elevFail ? 0 : hAt(X, Y); q++;
        }
      }
      var idx = new Uint32Array((N - 1) * (N - 1) * 6), k = 0;
      for (i = 0; i < N - 1; i++) for (var j2 = 0; j2 < N - 1; j2++) {
        var v0 = i * N + j2, v1 = v0 + 1, v2 = v0 + N, v3 = v2 + 1;
        idx[k++] = v0; idx[k++] = v2; idx[k++] = v1; idx[k++] = v1; idx[k++] = v2; idx[k++] = v3;
      }
      G.uv = uv; G.elev = G.elevFail ? null : elev; G.idx = idx; G.tex = tex; G.z = z; G.fail = fail; G.ready = true;
      if (fail) V.groundNote = '地面のタイルのうち ' + fail + ' 枚を読めませんでした' + (G.elevFail ? '（地形は平らにしています）' : '');
      else V.groundNote = '';
      update();
    });
    return null;
  }
  /** 想定震源域（重ねる図で選んだ海域）：外形と等深線を実際の深さに。範囲の外は切る。海域・倍率・範囲が同じなら作り直さない */
  function srcLayers3d() {
    var ids = A.srcIds(), r = V.roi, data = st.srcData;
    if (!ids.length || !data) return [];
    var key = [ids.join(','), V.exag, r.s, r.n, r.w, r.e].join('|');
    if (V.srcKey === key) return V.srcLay;
    var paths = [], inR = function (q) { return q[0] >= r.w && q[0] <= r.e && q[1] >= r.s && q[1] <= r.n; };
    var add = function (pts, zf, c, w) {          // 範囲の外に出た所で線を切る
      var cur = [];
      pts.forEach(function (q) {
        if (inR(q)) cur.push(P(q[0], q[1], zf(q)));
        else { if (cur.length > 1) paths.push({ p: cur, c: c, w: w }); cur = []; }
      });
      if (cur.length > 1) paths.push({ p: cur, c: c, w: w });
    };
    data.groups.forEach(function (g) {
      if (ids.indexOf(g.id) < 0) return;
      g.codes.forEach(function (c) {
        var gc = rgb(QC.SRC_GROUP_COLORS[g.id] || '#b4410d');
        c.outline.forEach(function (ring) { add(ring, function (q) { return zOf(q[2]); }, [gc[0], gc[1], gc[2], c.main ? 230 : 170], c.main ? 2 : 1.3); });
      });
      g.depth.forEach(function (x) {
        x.lines.forEach(function (ln) { add(ln, function () { return zOf(x.km); }, [91, 58, 41, 150], 1); });
      });
    });
    V.srcKey = key;
    return (V.srcLay = [new deck.PathLayer({ id: 'src3d-' + key, data: paths, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
      getPath: function (x) { return x.p; }, getColor: function (x) { return x.c; }, getWidth: function (x) { return x.w; }, widthUnits: 'pixels', parameters: NO_DEPTH })]);
  }
  /** 想定震源域の面（重ねる図で選んだ海域）：半透明の膜（光の当たり方で陰が付く）と、0.2 度ごとの薄い網目。
   *  面は深さの格子（0.05 度）の升の真ん中の深さを結んだもの。長方形が何通りも重なって深さが 1 つに決まらない所（幅 5km 超）と、
   *  隣どうしで深さが 15km 以上違う所（別の断層面）は結ばない。海域・強調・範囲が同じなら作り直さない */

  function membrane3d() {
    var ids = A.srcIds(), r = V.roi, data = st.srcData;
    if (!V.membrane || !ids.length || !data) return [];
    var key = [ids.join(','), V.exag, r.s, r.n, r.w, r.e].join('|');
    if (V.memKey === key) return V.memLay;
    var out = [];
    data.groups.forEach(function (g) {
      if (ids.indexOf(g.id) < 0) return;
      var gr = g.grid, nx = gr.nx, ny = gr.ny, Z = new Float32Array(nx * ny).fill(NaN), n = 0, w = 0, q;
      for (q = 0; q < gr.z.length; q++) {
        var v = gr.z[q];
        if (v < 0) { n -= v; continue; }
        var wd = gr.w[w++];
        var lon = gr.lon0 + (n % nx) * gr.step, lat = gr.lat0 + Math.floor(n / nx) * gr.step;
        var inR = lon >= r.w - gr.step && lon <= r.e + gr.step && lat >= r.s - gr.step && lat <= r.n + gr.step;
        if (wd <= 50 && inR) Z[n] = (v + wd / 2) / 10;          // 升の真ん中の深さ（km）
        n++;
      }
      var vid = new Int32Array(nx * ny).fill(-1), pos = [], tri = [], ok = function (a) { return !isNaN(Z[a]); };
      var vert = function (a) {
        if (vid[a] < 0) { vid[a] = pos.length / 3; var p = P(gr.lon0 + (a % nx) * gr.step, gr.lat0 + Math.floor(a / nx) * gr.step, zOf(Z[a])); pos.push(p[0], p[1], p[2]); }
        return vid[a];
      };
      var near = function (a, b) { return Math.abs(Z[a] - Z[b]) < 15; };
      for (var i = 0; i < ny - 1; i++) for (var j = 0; j < nx - 1; j++) {
        var a0 = i * nx + j, a1 = a0 + 1, a2 = a0 + nx, a3 = a2 + 1, c = [a0, a1, a3, a2].filter(ok);
        if (c.length === 4 && near(a0, a1) && near(a0, a2) && near(a3, a1) && near(a3, a2)) tri.push(vert(a0), vert(a2), vert(a1), vert(a1), vert(a2), vert(a3));
        else if (c.length === 3 && near(c[0], c[1]) && near(c[1], c[2]) && near(c[0], c[2])) tri.push(vert(c[0]), vert(c[1]), vert(c[2]));
      }
      if (!tri.length) return;
      var col = rgb(QC.SRC_GROUP_COLORS[g.id] || '#e66101');      // 海域の色（地図の外形・距離の色と同じ）
      out.push(new deck.SimpleMeshLayer({ id: 'mem-' + g.id + '-' + key, data: [0], _instanced: false, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
        mesh: { attributes: { POSITION: { value: new Float32Array(pos), size: 3 } }, indices: { value: new Uint32Array(tri), size: 1 } },
        getPosition: [0, 0, 0], getColor: col, opacity: 0.25, material: { ambient: 0.45, diffuse: 0.7, shininess: 8, specularColor: [60, 60, 60] }, parameters: BEHIND }));
      // 網目：0.2 度（4 升）ごとの緯線・経線に沿って、面のある所だけ
      var paths = [], line = function (cells) {
        var cur = [];
        cells.forEach(function (a, k) {
          if (ok(a) && (!cur.length || near(a, cells[k - 1]))) cur.push(vid[a] >= 0 || true ? P(gr.lon0 + (a % nx) * gr.step, gr.lat0 + Math.floor(a / nx) * gr.step, zOf(Z[a])) : null);
          else { if (cur.length > 1) paths.push(cur); cur = ok(a) ? [P(gr.lon0 + (a % nx) * gr.step, gr.lat0 + Math.floor(a / nx) * gr.step, zOf(Z[a]))] : []; }
        });
        if (cur.length > 1) paths.push(cur);
      };
      for (i = 0; i < ny; i += 4) { var row = []; for (j = 0; j < nx; j++) row.push(i * nx + j); line(row); }
      for (j = 0; j < nx; j += 4) { var colA = []; for (i = 0; i < ny; i++) colA.push(i * nx + j); line(colA); }
      out.push(new deck.PathLayer({ id: 'memNet-' + g.id + '-' + key, data: paths, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
        getPath: function (x) { return x; }, getColor: [Math.round(col[0] * 0.6), Math.round(col[1] * 0.6), Math.round(col[2] * 0.6), 120], getWidth: 0.8, widthUnits: 'pixels', parameters: BEHIND }));
    });
    V.memKey = key;
    return (V.memLay = out);
  }
  /** 範囲の箱：地表と底の四角（辺は緯線・経線に沿う）、4 本の縦の辺、深さの目盛りの四角 */
  function frameLayer(d) {
    var r = V.roi, M = 24, rect = function (z) {
      var out = [], k;
      for (k = 0; k <= M; k++) out.push(P(r.w + (r.e - r.w) * k / M, r.s, z));
      for (k = 0; k <= M; k++) out.push(P(r.e, r.s + (r.n - r.s) * k / M, z));
      for (k = 0; k <= M; k++) out.push(P(r.e - (r.e - r.w) * k / M, r.n, z));
      for (k = 0; k <= M; k++) out.push(P(r.w, r.n - (r.n - r.s) * k / M, z));
      return out;
    };
    var paths = [], zb = zOf(d.maxKm);
    QC.depthTicks(d.maxKm).forEach(function (km) { paths.push({ p: rect(zOf(km)), c: km === 0 ? [40, 50, 70, 200] : [90, 100, 120, 70], w: km === 0 ? 1.6 : 1 }); });
    if (QC.depthTicks(d.maxKm).slice(-1)[0] !== d.maxKm) paths.push({ p: rect(zb), c: [90, 100, 120, 120], w: 1 });
    [[r.w, r.s], [r.e, r.s], [r.e, r.n], [r.w, r.n]].forEach(function (c) { paths.push({ p: [P(c[0], c[1], 0), P(c[0], c[1], zb)], c: [90, 100, 120, 150], w: 1 }); });
    return new deck.PathLayer({ id: 'frame', data: paths, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, getPath: function (x) { return x.p; }, getColor: function (x) { return x.c; },
      getWidth: function (x) { return x.w; }, widthUnits: 'pixels', parameters: NO_DEPTH });
  }
  function frameLabels(d) {
    var r = V.roi, items = QC.depthTicks(d.maxKm).filter(function (km) { return km > 0; }).map(function (km) { return { p: P(r.w, r.s, zOf(km)), t: km + 'km' }; });
    // 方角（地面の 4 辺の外側に）：回したり下から見たりしても向きが分かるように
    var mid = function (lon, lat) { return P(lon, lat, 0); }, dl = (r.n - r.s) * 0.04, dw = (r.e - r.w) * 0.04;
    items.push({ p: mid((r.w + r.e) / 2, r.n + dl), t: '北' }, { p: mid((r.w + r.e) / 2, r.s - dl), t: '南' }, { p: mid(r.e + dw, (r.s + r.n) / 2), t: '東' }, { p: mid(r.w - dw, (r.s + r.n) / 2), t: '西' });
    return [new deck.TextLayer({ id: 'frameLbl', data: items, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, getPosition: function (x) { return x.p; }, getText: function (x) { return x.t; },
      getSize: 12, getColor: [40, 50, 70, 230], getTextAnchor: 'middle', getAlignmentBaseline: 'center',
      fontFamily: 'sans-serif', background: true, getBackgroundColor: [255, 255, 255, 170], backgroundPadding: [2, 1], characterSet: 'auto',
      parameters: NO_DEPTH })];
  }
  /** 1 つずつ：その時刻に残っている地震（大きいものを先に＝下に）。位置・大きさ・色は数の並びで渡す */
  function quakeLayers(d, T) {
    var ev = st.ev, vis = QC.visibleAt(ev, d.idx, d.life, T, d.maxLife), n = vis.length, rippleDur = S.rippleFrames * S.step;
    var pos = new Float32Array(n * 3), rad = new Float32Array(n), fill = new Uint8Array(n * 4), line = new Uint8Array(n * 4), lw = new Float32Array(n);
    var ids = new Int32Array(n), rip = [], drops = [];
    for (var q = 0; q < n; q++) {
      var k = vis[q], i = d.idx[k], m = ev.mag[i], age = T - ev.t[i], f = age / d.life[k];
      var sty = QC.styleOf(S.colorMode, m, ev.dep[i], f, ev.maxi[i], A.srcd(i), A.srcHue(i)), a = QC.alphas(m, f, S), cf = rgb(sty.fill), cs = rgb(sty.stroke);
      var r = QC.radius(m, S) * V.mpp;
      var pp = P(ev.lon[i], ev.lat[i], zOf(ev.dep[i]));
      pos[q * 3] = pp[0]; pos[q * 3 + 1] = pp[1]; pos[q * 3 + 2] = pp[2];
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
    out.push(new deck.ScatterplotLayer({ id: 'quakes', data: data, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, billboard: true, stroked: true, filled: true, radiusUnits: 'common',
      radiusMinPixels: 1.5, lineWidthUnits: 'pixels', pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 120], parameters: QUAKE_DEPTH }));
    if (rip.length) out.push(new deck.ScatterplotLayer({ id: 'ripple', data: rip, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, billboard: true, stroked: true, filled: false, radiusUnits: 'common',
      getPosition: function (x) { return P(ev.lon[x.i], ev.lat[x.i], zOf(ev.dep[x.i])); },
      getRadius: function (x) { return x.r + x.g * (12 * V.mpp + 2.5 * x.r); },
      getLineColor: function (x) { return [x.c[0], x.c[1], x.c[2], Math.round(230 * (1 - x.g))]; }, lineWidthUnits: 'pixels', getLineWidth: 2, parameters: NO_DEPTH }));
    return out;
  }
  /** 地表の影（震央）：立体の位置を読み取りやすくする */
  function shadowLayer(id, list) {
    var ev = st.ev;
    return new deck.ScatterplotLayer({ id: id, data: list, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, getPosition: function (i) { return P(ev.lon[i], ev.lat[i], 0); },
      getRadius: 1.6, radiusUnits: 'pixels', getFillColor: [40, 50, 70, 90], parameters: NO_DEPTH });
  }
  /** 震央から震源への線（大きい地震・塊だけ） */
  function dropLayer(id, items) {
    var ev = st.ev;
    return new deck.LineLayer({ id: id, data: items, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, getSourcePosition: function (x) { return P(ev.lon[x.i], ev.lat[x.i], 0); },
      getTargetPosition: function (x) { return P(ev.lon[x.i], ev.lat[x.i], zOf(ev.dep[x.i])); },
      getColor: function (x) { return [x.c[0], x.c[1], x.c[2], Math.round(150 * x.a)]; }, getWidth: 1, widthUnits: 'pixels', parameters: NO_DEPTH });
  }
  /** 集合マーカー：塊ごとに、時刻 T の姿（T が null なら期間の合計）。大きい塊を先に（下に） */
  function clusterLayers(km, T) {
    var ev = st.ev, items = [];
    if (km.frames) items = QC.kmCumAt(km, T).reverse();       // 累積：その時刻までの全部をまとめた姿（大きい塊を先に）
    else for (var q = km.clusters.length - 1; q >= 0; q--) {
      var a = QC.kmAt(km.clusters[q], T, S);
      if (a) items.push(a);
    }
    var col = function (a) { return rgb(QC.colorOf('mag', a.meq, 0, 0)); };
    var out = [];
    if (V.shadow) out.push(shadowLayer('kmShadow', items.map(function (a) { return a.ev; })));
    if (V.drop) out.push(dropLayer('kmDrop', items.map(function (a) { return { i: a.ev, c: col(a), a: a.alpha }; })));
    out.push(new deck.ScatterplotLayer({ id: 'km', data: items, coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN, billboard: true, stroked: true, filled: true, radiusUnits: 'common', radiusMinPixels: 3,
      getPosition: function (a) { return P(ev.lon[a.ev], ev.lat[a.ev], zOf(ev.dep[a.ev])); },
      getRadius: function (a) { return QC.aggRadius(a.meq, S) * V.mpp; },
      getFillColor: function (a) { var c = col(a); return [c[0], c[1], c[2], Math.round(158 * a.alpha)]; },
      getLineColor: function (a) { return [255, 255, 255, Math.round(242 * a.alpha)]; }, lineWidthUnits: 'pixels', getLineWidth: 1.6,
      pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 110], parameters: QUAKE_DEPTH }));
    out.push(new deck.TextLayer({ id: 'kmLbl', data: items.filter(function (a) { return QC.aggRadius(a.meq, S) >= 10; }), coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
      getPosition: function (a) { return P(ev.lon[a.ev], ev.lat[a.ev], zOf(ev.dep[a.ev])); }, getText: function (a) { return label(a); },
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

  /** 回し続ける（ろくろのように、縦の軸まわり）。もう一度押すか、図に触れると止まる */
  function spin(on) {
    V.spin = on; $('v3dSpin').textContent = on ? '■ 止める' : '⟳ 回し続ける';
    if (!on) return;
    var last = performance.now();
    (function step(now) {
      if (!V.spin || !V.open) return;
      setView(Object.assign({}, V.vs, { rotationOrbit: V.vs.rotationOrbit + (now - last) * 0.012 })); last = now;   // 1 秒に 12 度（30 秒で 1 周）
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
    $('v3dTop').onclick = function () { setCamera(90); };
    $('v3dTilt').onclick = function () { setCamera(35); };
    $('v3dSide2').onclick = function () { setCamera(0); };
    $('v3dBelow').onclick = function () { setCamera(-35); };
    $('v3dCanvasBox').addEventListener('pointerdown', function () { if (V.spin) spin(false); }, true);
    $('v3dSpin').onclick = function () { spin(!V.spin); };
    $('v3dTerrain').onchange = function () { V.terrain = this.checked; update(); };
    $('v3dMembrane').onchange = function () { V.membrane = this.checked; update(); };
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
