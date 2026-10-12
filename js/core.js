/* 地震の時系列地図：計算の部品（画面に触らない純粋な関数）。
 * ブラウザでは window.QC、Node では require() で使う。
 *
 * 時刻はすべて「UTC のミリ秒」で持ち、表示のときだけ日本時間（+09:00）に直す。
 * 端末のタイムゾーンには頼らない（getHours 等は使わない）。
 */
(function (root) {
  'use strict';
  var JST = 9 * 3600e3, HOUR = 3600e3, DAY = 24 * HOUR;

  // ---------------------------------------------------------------- 時刻
  /** 'YYYY-MM-DDTHH:MM:SS.s' または 'YYYY-MM-DDTHH:MM'（日本時間）→ ms。読めなければ NaN。 */
  function parseJst(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(s);
    if (!m) return NaN;
    var mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], sec = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec >= 60) return NaN;
    return Date.UTC(+m[1], mo - 1, d, h, mi, 0) + Math.round(sec * 1000) - JST;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** ms → 日本時間の部品 */
  function jstParts(ms) {
    var d = new Date(ms + JST);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
             h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  /** 画面左上の表示。刻みが1日未満なら時刻も出す。 */
  function formatClock(ms, stepMs) {
    var p = jstParts(ms);
    var s = p.y + '年' + p.mo + '月' + p.d + '日';
    if (stepMs < DAY) s += ' ' + pad(p.h) + ':' + pad(p.mi);
    return s;
  }
  function formatDate(ms) { var p = jstParts(ms); return p.y + '-' + pad(p.mo) + '-' + pad(p.d); }
  function formatDateTime(ms) {
    var p = jstParts(ms);
    return formatDate(ms) + ' ' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s);
  }
  /** 'YYYY-MM-DD'（日本時間の 0 時）→ ms */
  function dateToMs(s) { return parseJst(s + 'T00:00'); }
  /** その日の日本時間 0 時 */
  function floorDayJst(ms) { return Math.floor((ms + JST) / DAY) * DAY - JST; }
  /** 期間 [t0, t1) に掛かる 'YYYY-MM' の一覧 */
  function monthsBetween(t0, t1) {
    var a = jstParts(t0), b = jstParts(t1 - 1), out = [];
    var y = a.y, m = a.mo;
    while (y < b.y || (y === b.y && m <= b.mo)) {
      out.push(y + '-' + pad(m));
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }

  // ---------------------------------------------------------------- 震度
  var MAXI = { '': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9,
               '5': 5, '6': 7, 'F': -2, '?': -1 };
  var MAXI_LABEL = { 0: '無感', 1: '震度1', 2: '震度2', 3: '震度3', 4: '震度4', 5: '震度5弱', 6: '震度5強',
                     7: '震度6弱', 8: '震度6強', 9: '震度7', '-1': '震度不明', '-2': '有感（階級不明）' };

  // ---------------------------------------------------------------- CSV
  var SRC = { C: 0, P: 1, I: 2, Q: 3 };
  var SRC_LABEL = ['確定', '速報', '震度DBのみ', '発表直後'];
  /** 月の CSV → 列ごとの配列。読めない行は捨てずに数えて返す。 */
  function parseMonthCsv(text) {
    var lines = text.split('\n');
    if (lines[0] !== 't,lat,lon,dep,mag,maxi,src,q,aux') throw new Error('CSVの見出しが想定外: ' + lines[0]);
    var n = 0, cap = lines.length;
    var t = new Float64Array(cap), lat = new Float32Array(cap), lon = new Float32Array(cap),
        dep = new Float32Array(cap), mag = new Float32Array(cap), maxi = new Int8Array(cap),
        src = new Int8Array(cap), q = new Array(cap), aux = new Int8Array(cap), bad = [];
    for (var i = 1; i < lines.length; i++) {
      var L = lines[i];
      if (!L) continue;
      var c = L.split(',');
      var tt = parseJst(c[0]), la = +c[1], lo = +c[2];
      if (c.length !== 9 || isNaN(tt) || !c[1] || !c[2] || !isFinite(la) || !isFinite(lo) ||
          !(c[5] in MAXI) || !(c[6] in SRC)) { bad.push(i + 1); continue; }
      t[n] = tt; lat[n] = la; lon[n] = lo;
      dep[n] = c[3] === '' ? NaN : +c[3];
      mag[n] = c[4] === '' ? NaN : +c[4];
      maxi[n] = MAXI[c[5]]; src[n] = SRC[c[6]]; q[n] = c[7]; aux[n] = c[8] === '' ? 0 : +c[8];
      n++;
    }
    return { n: n, t: t.subarray(0, n), lat: lat.subarray(0, n), lon: lon.subarray(0, n),
             dep: dep.subarray(0, n), mag: mag.subarray(0, n), maxi: maxi.subarray(0, n),
             src: src.subarray(0, n), q: q.slice(0, n), aux: aux.subarray(0, n), bad: bad };
  }
  /** 月ごとの列をつなぐ（時刻順であることを確かめる） */
  function concatColumns(parts) {
    var n = 0, k;
    parts.forEach(function (p) { n += p.n; });
    var o = { n: n, t: new Float64Array(n), lat: new Float32Array(n), lon: new Float32Array(n),
              dep: new Float32Array(n), mag: new Float32Array(n), maxi: new Int8Array(n),
              src: new Int8Array(n), q: new Array(n), aux: new Int8Array(n) };
    var at = 0;
    parts.forEach(function (p) {
      ['t', 'lat', 'lon', 'dep', 'mag', 'maxi', 'src', 'aux'].forEach(function (f) { o[f].set(p[f], at); });
      for (k = 0; k < p.n; k++) o.q[at + k] = p.q[k];
      at += p.n;
    });
    for (k = 1; k < n; k++) if (o.t[k] < o.t[k - 1]) throw new Error('時刻順に並んでいない: ' + k);
    return o;
  }
  /** t[i] >= x となる最初の i */
  function lowerBound(arr, x, lo, hi) {
    lo = lo || 0; hi = hi == null ? arr.length : hi;
    while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  // ---------------------------------------------------------------- 絞り込み
  /** 設定で絞る。描かない地震は理由ごとに数える（黙って落とさない）。 */
  function filterEvents(ev, s, t0, t1) {
    var i0 = lowerBound(ev.t, t0), i1 = lowerBound(ev.t, t1);
    var idx = [], why = { magUnknown: 0, magLow: 0, intUnknown: 0, intLow: 0, outside: 0,
                          poorQuality: 0, artificial: 0, lowFreq: 0, depth: 0, notLfe: 0, lfeUnknown: 0 };
    for (var i = i0; i < i1; i++) {
      var la = ev.lat[i], lo = ev.lon[i];
      if (la < s.bbox[0] || la > s.bbox[2] || lo < s.bbox[1] || lo > s.bbox[3]) { why.outside++; continue; }
      if (ev.aux[i] === 3) { why.artificial++; continue; }
      if (s.lfeOnly) {   // 低周波地震だけ：印があるのは確定版だけ。速報などは区別できないので描かない（数える）
        if (ev.src[i] !== 0) { why.lfeUnknown++; continue; }
        if (ev.aux[i] !== 5) { why.notLfe++; continue; }
      }
      if (ev.aux[i] === 5 && !s.lowFreq && !s.lfeOnly) { why.lowFreq++; continue; }
      if (ev.q[i] === 'N' || (!s.reference && /^[Ssa]$/.test(ev.q[i]))) { why.poorQuality++; continue; }
      var m = ev.mag[i];
      if (isNaN(m)) { why.magUnknown++; continue; }
      if (m < s.magMin) { why.magLow++; continue; }
      if (s.intMin > 0) {
        var mx = ev.maxi[i];
        if (mx < 0 && mx !== -2) { why.intUnknown++; continue; }
        if (mx !== -2 && mx < s.intMin) { why.intLow++; continue; }
      }
      var d = ev.dep[i];
      if (!isNaN(d) && (d < s.depMin || d > s.depMax)) { why.depth++; continue; }
      idx.push(i);
    }
    return { idx: Int32Array.from(idx), why: why, total: i1 - i0 };
  }

  // ---------------------------------------------------------------- 見た目
  /** 半径（px）。尺度 'exp'：r = r1 × g^(M−1)、'lin'：r = r1 × (1 + (M−1)×(g−1)×2) */
  function radius(m, s) {
    var x = m - 1, r;
    if (s.sizeScale === 'lin') r = s.r1 * (1 + Math.max(x, -0.9) * (s.sizeGrowth - 1) * 2);
    else r = s.r1 * Math.pow(s.sizeGrowth, x);
    return Math.max(0.6, Math.min(r, 400));
  }
  /** 残る時間（ms）：M1 で life1 日、M が 1 大きいごとに lifeGrowth 倍、上限 lifeMax 日 */
  function lifeMs(m, s) {
    var d = s.life1 * Math.pow(s.lifeGrowth, m - 1);
    return Math.max(s.lifeMin, Math.min(d, s.lifeMax)) * DAY;
  }

  // 参考動画の割り当て（M1 水色〜M7 紫）
  var MAG_COLORS = [
    { lo: -Infinity, c: '#9ad7ef', label: 'M1未満' },
    { lo: 1, c: '#4fc3f7', label: 'M1' }, { lo: 2, c: '#1e63d6', label: 'M2' },
    { lo: 3, c: '#f5d000', label: 'M3' }, { lo: 4, c: '#f08c00', label: 'M4' },
    { lo: 5, c: '#e8380d', label: 'M5' }, { lo: 6, c: '#9b1030', label: 'M6' },
    { lo: 7, c: '#7a2bb3', label: 'M7' }, { lo: 8, c: '#3b1f7a', label: 'M8' },
    { lo: 9, c: '#111111', label: 'M9以上' }];
  var DEP_COLORS = [
    { lo: -Infinity, c: '#e53935', label: '0〜10km' }, { lo: 10, c: '#fb8c00', label: '10〜30km' },
    { lo: 30, c: '#fdd835', label: '30〜60km' }, { lo: 60, c: '#43a047', label: '60〜100km' },
    { lo: 100, c: '#1e88e5', label: '100〜200km' }, { lo: 200, c: '#5e35b1', label: '200〜400km' },
    { lo: 400, c: '#37474f', label: '400km〜' }];
  var DEP_UNKNOWN = '#9e9e9e';
  // 最大震度：気象庁の震度の配色。白に近い色は輪郭を濃くする。不明は白抜き・点線
  var INT_STYLES = [
    { v: 0, fill: '#b0b0b0', stroke: '#8a8a8a', label: '無感' },
    { v: 1, fill: '#f2f2ff', stroke: '#8f8fb0', label: '震度1' },
    { v: 2, fill: '#00aaff', stroke: '#00aaff', label: '震度2' },
    { v: 3, fill: '#0041ff', stroke: '#0041ff', label: '震度3' },
    { v: 4, fill: '#fae696', stroke: '#c9a93a', label: '震度4' },
    { v: 5, fill: '#ffe600', stroke: '#c9b000', label: '震度5弱' },
    { v: 6, fill: '#ff9900', stroke: '#ff9900', label: '震度5強' },
    { v: 7, fill: '#ff2800', stroke: '#ff2800', label: '震度6弱' },
    { v: 8, fill: '#a50021', stroke: '#a50021', label: '震度6強' },
    { v: 9, fill: '#b40068', stroke: '#b40068', label: '震度7' }];
  var INT_UNKNOWN = { v: -1, fill: '#ffffff', stroke: '#555555', dash: true, label: '震度不明' };
  function intensityStyle(mx) { return mx >= 0 && mx <= 9 ? INT_STYLES[mx] : INT_UNKNOWN; }
  function band(list, v) {
    var c = list[0].c;
    for (var i = 0; i < list.length; i++) if (v >= list[i].lo) c = list[i].c;
    return c;
  }
  /** 経過時間：発生直後 赤 → 残る時間の終わり 灰（割合 f = 経過 / 残る時間） */
  function ageColor(f) {
    f = Math.max(0, Math.min(1, f));
    var a = [230, 40, 30], b = [150, 150, 160];
    return 'rgb(' + a.map(function (x, k) { return Math.round(x + (b[k] - x) * f); }).join(',') + ')';
  }
  // 想定震源域からの距離（km、震源から震源域の面までの立体の距離）。近いほど暖色
  var SRCD_COLORS = [
    { lo: -Infinity, c: '#d7191c', label: '5km以内' }, { lo: 5, c: '#f46d43', label: '5〜10km' }, { lo: 10, c: '#fdae61', label: '10〜20km' },
    { lo: 20, c: '#a6d96a', label: '20〜40km' }, { lo: 40, c: '#2c7bb6', label: '40〜80km' }, { lo: 80, c: '#7b6fae', label: '80〜' + 150 + 'km' },
    { lo: 150, c: '#b0b4bc', label: '150km以上' }];
  var SRCD_UNKNOWN = { fill: '#ffffff', stroke: '#555555', dash: true, label: '深さ不明' };
  function colorOf(mode, m, dep, ageFrac, maxi, srcd) {
    if (mode === 'depth') return isNaN(dep) ? DEP_UNKNOWN : band(DEP_COLORS, dep);
    if (mode === 'src') return isNaN(srcd) ? SRCD_UNKNOWN.fill : band(SRCD_COLORS, srcd);
    if (mode === 'age') return ageColor(ageFrac);
    if (mode === 'maxi') return intensityStyle(maxi).fill;
    return band(MAG_COLORS, m);
  }
  /** 塗り・輪郭・点線。最大震度のときだけ輪郭の色が塗りと違うことがある */
  function styleOf(mode, m, dep, ageFrac, maxi, srcd) {
    if (mode === 'maxi') { var s = intensityStyle(maxi); return { fill: s.fill, stroke: s.stroke, dash: !!s.dash }; }
    if (mode === 'src' && isNaN(srcd)) return { fill: SRCD_UNKNOWN.fill, stroke: SRCD_UNKNOWN.stroke, dash: true };
    var c = colorOf(mode, m, dep, ageFrac, maxi, srcd);
    return { fill: c, stroke: c, dash: false };
  }
  /** 塗りと輪郭の濃さ。大きい円ほど中を薄く、輪郭を残す。古くなるほど薄く。 */
  function alphas(m, ageFrac, s) {
    var fade = Math.pow(1 - Math.max(0, Math.min(1, ageFrac)), s.fadePow);
    var fill = s.fillAlpha * (m >= 8 ? 0.18 : m >= 6 ? 0.25 : m >= 5 ? 0.35 : m >= 4 ? 0.5 : m >= 3 ? 0.7 : 1);
    return { fill: fill * fade, stroke: Math.min(1, s.strokeAlpha * (m >= 4 ? 1 : 0.6)) * fade };
  }

  /** 奥行き：深さを「地面の上 viewH km から見下ろした距離」とみなした見え方。
   *  vol（3D の効き 0〜1）で深さを縮める。0 なら深さを表さない（元の円）。
   *  scale＝見かけの大きさ（遠いほど小さく）、blur＝輪郭のにじみ（半径に対する割合）、alpha＝かすみ（遠いほど薄く）。
   *  keepBig のとき、M が keepBigM 以上の地震は薄めず、ぼかさない（深い大地震が消えないように）。深さ不明は効かせない。 */
  function depthLook(dep, mag, s) {
    if (!(s.vol > 0) || isNaN(dep)) return { scale: 1, blur: 0, alpha: 1 };
    var near = s.viewH / (s.viewH + Math.max(dep, 0) * s.vol);
    var o = { scale: s.dShrink ? near : 1,
              blur: s.dBlur > 0 ? Math.min(0.95, s.dBlur * (1 - near)) : 0,
              alpha: s.dHaze > 0 ? Math.max(s.hazeMin, Math.pow(near, s.dHaze)) : 1 };
    if (s.keepBig && mag >= s.keepBigM) { o.blur = 0; o.alpha = 1; }
    return o;
  }

  /** 時刻 T に見えている地震（idx の中の位置）を、大きい順（下に描く順）に返す。
   *  T より後に起きた地震は決して含めない。 */
  function visibleAt(ev, idx, life, T, maxLife) {
    var tArr = ev.t, out = [];
    // idx は時刻順。T − maxLife より後、T 以下だけを見る
    var lo = 0, hi = idx.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (tArr[idx[m]] <= T - maxLife) lo = m + 1; else hi = m; }
    for (var k = lo; k < idx.length; k++) {
      var i = idx[k], age = T - tArr[i];
      if (age < 0) break;
      if (age <= life[k]) out.push(k);
    }
    out.sort(function (a, b) { return ev.mag[idx[b]] - ev.mag[idx[a]]; });
    return out;
  }

  // ---------------------------------------------------------------- 球（推定の揺れの範囲）
  // 司・翠川(1999)の最大速度の距離減衰式（S波速度600m/s相当の地盤、点震源として震源距離 X を使う）と、
  // 翠川ほか(1999)の計測震度への換算 I = 2.68 + 1.72 log10 PGV。amp は地盤の増幅（PGV地表 = amp × PGV600）。
  // 式は距離 100km までを対象に作られたもの。research/sphere_check.py と同じ式。
  var LOG10 = Math.LN10;
  function log10(x) { return Math.log(x) / LOG10; }
  function estIntensity(mw, depKm, xKm, amp, dtype) {
    var lp = 0.58 * mw + 0.0038 * depKm + (dtype || 0) - 1.29 - log10(xKm + 0.0028 * Math.pow(10, 0.5 * mw)) - 0.002 * xKm;
    return 2.68 + 1.72 * (lp + log10(amp));
  }
  /** 震度の境目（計測震度）：震度3 = 2.5、4 = 3.5、5弱 = 4.5、5強 = 5.0、6弱 = 5.5、6強 = 6.0、7 = 6.5 */
  var INT_THRESHOLDS = { '1': 0.5, '2': 1.5, '3': 2.5, '4': 3.5, '5-': 4.5, '5+': 5.0, '6-': 5.5, '6+': 6.0, '7': 6.5 };
  /** 推定震度が ithr になる震源距離 R（km）。震源の真上でも届かなければ 0。 */
  function sphereRadiusKm(mw, depKm, ithr, amp, dtype) {
    var lo = Math.max(depKm, 0.1);
    if (!(estIntensity(mw, depKm, lo, amp, dtype) >= ithr)) return 0;
    var hi = lo * 2;
    while (estIntensity(mw, depKm, hi, amp, dtype) >= ithr) { hi *= 2; if (hi > 5000) return hi; }
    for (var n = 0; n < 50; n++) {
      var mid = (lo + hi) / 2;
      if (estIntensity(mw, depKm, mid, amp, dtype) >= ithr) lo = mid; else hi = mid;
    }
    return lo;
  }
  /** 同心円：震度の境目ごとの地表の円の半径（km）。levels は ['3','4','5-',…]。外（弱い震度）から順。 */
  var RING_LEVELS = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
  function ringRadiiKm(mw, depKm, amp, levels) {
    return levels.map(function (lv) { return surfaceRadiusKm(sphereRadiusKm(mw, depKm, INT_THRESHOLDS[lv], amp), depKm); });
  }
  /** 図式の球：M だけで半径を決める（揺れの推定ではない）。M5 で r5 km、M が 1 増えるごとに growth 倍。 */
  function geomSphereRadiusKm(mw, r5, growth) { return r5 * Math.pow(growth, mw - 5); }
  /** 球が地表に顔を出す円の半径（km）。球が地表に届かなければ 0。 */
  function surfaceRadiusKm(R, depKm) { return R > depKm ? Math.sqrt(R * R - depKm * depKm) : 0; }
  /** 1 km が何画素か（Web メルカトル、zoom z、緯度 lat） */
  function pxPerKm(lat, z) { return 256 * Math.pow(2, z) / (40075.016686 * Math.cos(lat * Math.PI / 180)); }

  // ---------------------------------------------------------------- 地図の座標（Web メルカトル、zoom 0 の画素）
  function project0(lat, lon) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return [256 * (0.5 + lon / 360), 256 * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))];
  }

  // ---------------------------------------------------------------- 地図の回転と断面図
  // 地図（Leaflet）は回転しない枠の中で描き、その枠ごと画面の中心で deg 度（時計回り）回す。
  // 地震の印は回転しない画面に、回した後の位置で描く。
  /** Leaflet の枠の座標 (cx, cy)（枠の大きさ cw×ch）→ 画面（vw×vh）の座標 */
  function rotScreen(cx, cy, cw, ch, vw, vh, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), x = cx - cw / 2, y = cy - ch / 2;
    return [vw / 2 + x * c - y * s, vh / 2 + x * s + y * c];
  }
  /** 画面上で (dx, dy) 動かしたときの、Leaflet の枠の中での動き（逆回転） */
  function rotDelta(dx, dy, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  /** 画面の右（＋X）が指す方位（北 0°・東 90°、時計回り） */
  function screenXAzimuth(deg) { return (((90 - deg) % 360) + 360) % 360; }
  var DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
  function dirName(az) { return DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]; }
  /** 断面図の深さの目盛り（km） */
  function depthTicks(maxKm) {
    var steps = [5, 10, 20, 50, 100, 200, 500], st = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (maxKm / steps[i] <= 6) { st = steps[i]; break; }
    var out = [];
    for (var d = 0; d <= maxKm + 1e-9; d += st) out.push(d);
    return out;
  }

  // ---------------------------------------------------------------- エネルギーと集計（期間の合計）
  /** 地震波のエネルギー（J）：グーテンベルク・リヒター(1956) log10 E = 1.5 M + 4.8 */
  function energyJ(m) { return Math.pow(10, 1.5 * m + 4.8); }
  /** エネルギー（J）を、同じエネルギーの地震 1 つの M に置き換える（M 相当） */
  function magOfEnergy(E) { return E > 0 ? (Math.log(E) / Math.LN10 - 4.8) / 1.5 : NaN; }
  /** J を読みやすい単位で（kJ・MJ・GJ・TJ・PJ・EJ） */
  function formatEnergy(E) {
    var u = [['EJ', 1e18], ['PJ', 1e15], ['TJ', 1e12], ['GJ', 1e9], ['MJ', 1e6], ['kJ', 1e3]];
    for (var i = 0; i < u.length; i++) if (E >= u[i][1]) { var v = E / u[i][1]; return (v >= 100 ? Math.round(v) : v.toPrecision(2)) + u[i][0]; }
    return Math.round(E) + 'J';
  }
  /** 格子でまとめる。xs, ys は同じ座標系（画素）、cell は格子の大きさ。
   *  戻り値は塊ごとの { x, y（回数で重み付けした重心）, n, E, maxM, maxI（最大の地震の番号） }。エネルギーの小さい順。 */
  function aggregate(xs, ys, ms, ids, cell) {
    var s = aggState(cell);
    for (var j = 0; j < xs.length; j++) aggAdd(s, xs[j], ys[j], ms[j], ids[j]);
    return aggFinish(s);
  }
  /** 少しずつ足していける集計（累積の再生で、前のコマから増えた地震だけを足す） */
  function aggState(cell) { return { cell: cell, map: new Map(), groups: [] }; }
  function aggAdd(s, x, y, m, id) {
    // 格子の番号を 1 つの数にまとめる（文字列より速い。座標は数千万画素まで）
    var key = (Math.floor(x / s.cell) + 1e7) * 1e8 + (Math.floor(y / s.cell) + 1e7), g = s.map.get(key);
    if (!g) { g = { sx: 0, sy: 0, n: 0, E: 0, maxM: -Infinity, maxI: -1 }; s.map.set(key, g); s.groups.push(g); }
    g.sx += x; g.sy += y; g.n++; g.E += energyJ(m);
    if (m > g.maxM) { g.maxM = m; g.maxI = id; }
  }
  function aggFinish(s) {
    var out = s.groups.map(function (g) {
      return { x: g.sx / g.n, y: g.sy / g.n, n: g.n, E: g.E, maxM: g.maxM, maxI: g.maxI, meq: magOfEnergy(g.E) };
    });
    out.sort(function (a, b) { return a.E - b.E; });
    return out;
  }
  // ---- k-means（マーカーの数 k を決めてまとめる）
  /** 種を決めた乱数（同じ種なら毎回同じ結果） */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** D 次元の k-means の中心を求める。P は点を並べた配列（n×D、[x0,y0,z0,t0, x1,…]）。
   *  init（前の中心、k×D）があればそこから続ける。無ければ種を決めた k-means++ で始める。戻り値は中心（k×D） */
  function kmeans(P, D, k, opt) {
    opt = opt || {};
    var n = P.length / D, c, i, j;
    k = Math.min(k, n);
    var C = new Float64Array(k * D);
    if (!k) return C;
    if (opt.init && opt.init.length === k * D) C.set(opt.init);
    else {
      var r = rng(opt.seed || 1), d2 = new Float64Array(n).fill(Infinity), f = Math.floor(r() * n);
      for (j = 0; j < D; j++) C[j] = P[f * D + j];
      for (c = 1; c < k; c++) {
        var sum = 0;
        for (i = 0; i < n; i++) {
          var d = 0;
          for (j = 0; j < D; j++) { var e = P[i * D + j] - C[(c - 1) * D + j]; d += e * e; }
          if (d < d2[i]) d2[i] = d;
          sum += d2[i];
        }
        var pick = n - 1;
        if (sum > 0) { var u = r() * sum; for (i = 0; i < n; i++) { u -= d2[i]; if (u <= 0) { pick = i; break; } } }
        else pick = Math.floor(r() * n);
        for (j = 0; j < D; j++) C[c * D + j] = P[pick * D + j];
      }
    }
    var assign = new Int32Array(n).fill(-1), sum2 = new Float64Array(k * D), cnt = new Int32Array(k);
    for (var it = 0; it < (opt.iters || 25); it++) {
      var changed = 0;
      for (i = 0; i < n; i++) {
        var best = nearest(P, i, D, C, k);
        if (assign[i] !== best) { assign[i] = best; changed++; }
      }
      if (!changed) break;
      sum2.fill(0); cnt.fill(0);
      for (i = 0; i < n; i++) { cnt[assign[i]]++; for (j = 0; j < D; j++) sum2[assign[i] * D + j] += P[i * D + j]; }
      for (c = 0; c < k; c++) if (cnt[c]) for (j = 0; j < D; j++) C[c * D + j] = sum2[c * D + j] / cnt[c];   // 空の塊は中心をそのまま
    }
    return C;
  }
  var _nd = 0;
  function nearest(P, i, D, C, k) {
    var best = 0, bd = Infinity;
    for (var c = 0; c < k; c++) {
      var d = 0;
      for (var j = 0; j < D; j++) { var e = P[i * D + j] - C[c * D + j]; d += e * e; }
      if (d < bd) { bd = d; best = c; }
    }
    _nd = bd;
    return best;
  }
  /** 中心 C に全部の点を割り当てて塊ごとにまとめる。
   *  mi＝塊の中心にいちばん近い実際の点（マーカーをその地震の位置に置く。地震の無い場所に出さない）、
   *  members＝塊に入った点の番号、rms＝中心からの距離の二乗平均の平方根。空の塊は返さない。エネルギーの小さい順。 */
  function kmeansClusters(P, D, ms, ids, C) {
    var k = C.length / D, n = P.length / D, g = [], c, i;
    for (c = 0; c < k; c++) g.push({ n: 0, E: 0, maxM: -Infinity, maxI: -1, ss: 0, bd: Infinity, mi: -1, list: [] });
    for (i = 0; i < n; i++) {
      var q = g[nearest(P, i, D, C, k)], bd = _nd;
      q.n++; q.E += energyJ(ms[i]); q.ss += bd; q.list.push(i);
      if (ms[i] > q.maxM) { q.maxM = ms[i]; q.maxI = ids[i]; }
      if (bd < q.bd) { q.bd = bd; q.mi = i; }
    }
    var out = [];
    g.forEach(function (q, c2) {
      if (!q.n) return;
      out.push({ mi: q.mi, members: Int32Array.from(q.list), c: C.slice(c2 * D, c2 * D + D), n: q.n, E: q.E,
                 maxM: q.maxM, maxI: q.maxI, meq: magOfEnergy(q.E), rms: Math.sqrt(q.ss / q.n) });
    });
    out.sort(function (a, b) { return a.E - b.E; });
    return out;
  }

  // ---------------------------------------------------------------- 想定震源域からの距離
  /** 想定震源域の深さの格子（data/overlays/source_areas.json の groups[].grid）を、距離を求めやすい形にする。
   *  ids を渡すとその海域だけ。升ごとに [経度, 緯度, いちばん浅い, いちばん深い, 海域の番号] を持ち、0.2 度の箱に分けておく */
  var SRC_BIN = 0.2, SRC_MAX_KM = 150;
  function srcPrepare(data, ids) {
    var cells = [], gi = [];
    data.groups.forEach(function (g, k) {
      if (ids && ids.length && ids.indexOf(g.id) < 0) return;
      var gr = g.grid, n = 0, w = 0;
      for (var q = 0; q < gr.z.length; q++) {
        var v = gr.z[q];
        if (v < 0) { n -= v; continue; }
        var lon = gr.lon0 + (n % gr.nx) * gr.step, lat = gr.lat0 + Math.floor(n / gr.nx) * gr.step;
        cells.push(lon, lat, v / 10, (v + gr.w[w++]) / 10, k);
        n++;
      }
      gi.push(k);
    });
    var C = Float64Array.from(cells), bins = new Map();
    for (var i = 0; i < C.length / 5; i++) {
      var key = binKey(Math.floor(C[i * 5] / SRC_BIN), Math.floor(C[i * 5 + 1] / SRC_BIN)), b = bins.get(key);
      if (!b) bins.set(key, b = []);
      b.push(i);
    }
    return { C: C, bins: bins, groups: gi };
  }
  function binKey(bx, by) { return (bx + 2000) * 4000 + (by + 2000); }
  var _srcG = -1, _srcSide = 0;
  /** 震源（経度・緯度・深さ km）から、想定震源域の面（各升の深さの幅）までの立体の距離（km）。
   *  SRC_MAX_KM より遠い（近くに震源域が無い）ときは Infinity、深さ不明は NaN。
   *  直後に srcLast() で、いちばん近い海域の番号と、震源が面より浅い（-1）・幅の中（0）・深い（1）を返す */
  function srcDistance(prep, lon, lat, dep) {
    _srcG = -1; _srcSide = 0;
    if (isNaN(dep) || dep == null) return NaN;
    var C = prep.C, bx = Math.floor(lon / SRC_BIN), by = Math.floor(lat / SRC_BIN), best = Infinity, cosl = Math.cos(lat * Math.PI / 180);
    var binKm = SRC_BIN * 110.574 * Math.min(1, cosl), maxR = Math.ceil(SRC_MAX_KM / binKm) + 1;
    for (var r = 0; r <= maxR; r++) {
      if (r >= 2 && (r - 1) * binKm > best) break;                    // これより外の箱には、もっと近い升は無い
      for (var dx = -r; dx <= r; dx++) {
        for (var dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 輪の上の箱だけ
          var b = prep.bins.get(binKey(bx + dx, by + dy));
          if (!b) continue;
          for (var q = 0; q < b.length; q++) {
            var i = b[q] * 5, ex = (lon - C[i]) * 111.32 * cosl, ey = (lat - C[i + 1]) * 110.574;
            var ez = dep < C[i + 2] ? C[i + 2] - dep : dep > C[i + 3] ? dep - C[i + 3] : 0, d = ex * ex + ey * ey + ez * ez;
            if (d < best * best) { best = Math.sqrt(d); _srcG = C[i + 4]; _srcSide = dep < C[i + 2] ? -1 : dep > C[i + 3] ? 1 : 0; }
          }
        }
      }
    }
    return best <= SRC_MAX_KM ? best : Infinity;
  }
  function srcLast() { return { group: _srcG, side: _srcSide }; }

  // ---------------------------------------------------------------- k-means の一式（画面とは別の計算場所 js/kmworker.js でも同じものを使う）
  /** 中心を求め（多いときは等間隔に間引いた点で）、全部の点を割り当て、再生用の累積を作る。
   *  P は点の座標（dim 次元）、ms は M、ids は地震の番号、ts は発生時刻（時刻順に並んでいること） */
  function kmFit(P, dim, ms, ids, ts, K) {
    var n = ids.length, cap = K > 100 ? 8000 : 20000;
    var stride = Math.max(1, Math.ceil(n / cap)), SP = P, q;
    if (stride > 1) {
      var m = Math.floor(n / stride); SP = new Float64Array(m * dim);
      for (q = 0; q < m; q++) for (var j = 0; j < dim; j++) SP[q * dim + j] = P[q * stride * dim + j];
    }
    var C = kmeans(SP, dim, K, { seed: 7, iters: K > 100 ? 20 : 30 }), cl = kmeansClusters(P, dim, ms, ids, C);
    cl.forEach(function (g) {
      // 塊の広がり（東西・南北だけ、km）と、再生用の「その時刻までの」累積（members は時刻順）
      var ss = 0, L = g.members.length, best = Infinity, bi = -1, mx = -Infinity, mxi = -1, E = 0;
      g.times = new Float64Array(L); g.cumE = new Float64Array(L); g.bestAt = new Int32Array(L); g.maxAt = new Int32Array(L);
      for (var a = 0; a < L; a++) {
        var pt = g.members[a], dx = P[pt * dim] - g.c[0], dy = P[pt * dim + 1] - g.c[1], d = 0;
        ss += dx * dx + dy * dy;
        for (var b = 0; b < dim; b++) { var e = P[pt * dim + b] - g.c[b]; d += e * e; }
        if (d < best) { best = d; bi = ids[pt]; }
        if (ms[pt] > mx) { mx = ms[pt]; mxi = ids[pt]; }
        E += energyJ(ms[pt]);
        g.times[a] = ts[pt]; g.cumE[a] = E; g.bestAt[a] = bi; g.maxAt[a] = mxi;
      }
      g.rmsXY = Math.sqrt(ss / L); g.ev = ids[g.mi];
    });
    return cl;
  }
  /** k-means の塊を、時刻 T の姿に（T が null なら期間の合計）。まだ地震が起きていない塊・消えた塊は null。s は設定（残る時間） */
  function kmAt(g, T, s) {
    if (T == null) return { ev: g.ev, n: g.n, E: g.E, meq: g.meq, maxI: g.maxI, alpha: 1 };
    var lo = 0, hi = g.times.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (g.times[m] <= T) lo = m + 1; else hi = m; }
    if (!lo) return null;
    var E = g.cumE[lo - 1], meq = magOfEnergy(E), last = g.times[lo - 1], life = lifeMs(meq, s), alpha = 1;
    if (T > last) { alpha = 1 - (T - last) / life; if (alpha <= 0) return null; }   // 最後の地震から「残る時間」で消える
    return { ev: g.bestAt[lo - 1], n: lo, E: E, meq: meq, maxI: g.maxAt[lo - 1], alpha: alpha };
  }
  /** 期間内の 9 つの時刻で、見えている塊の数の中央値 */
  function kmActiveMedian(cl, t0, t1, s) {
    var c = [];
    for (var k = 1; k <= 9; k++) {
      var T = t0 + (t1 - t0) * k / 10, a = 0;
      for (var q = 0; q < cl.length; q++) if (kmAt(cl[q], T, s)) a++;
      c.push(a);
    }
    c.sort(function (x, y) { return x - y; });
    return c[4];
  }
  var KM_MAX = 600;
  /** まとめる地震（ev の番号の並び list、時刻順）の座標。東西・南北は km（東経137度を中心にした正弦図法。日本の範囲なら距離の歪みは小さい）、
   *  深さは km × depthW、時間（dim 4 のとき）は t0 からの日数 × kmPerDay */
  function kmPoints(ev, list, dim, depthW, kmPerDay, t0) {
    var n = list.length, P = new Float64Array(n * dim), ms = new Float64Array(n), ids = new Int32Array(n), ts = new Float64Array(n), RAD = Math.PI / 180;
    for (var q = 0; q < n; q++) {
      var i = list[q];
      P[q * dim] = (ev.lon[i] - 137) * 111.32 * Math.cos(ev.lat[i] * RAD);
      P[q * dim + 1] = ev.lat[i] * 110.574;
      P[q * dim + 2] = Math.max(ev.dep[i], 0) * depthW;
      if (dim === 4) P[q * dim + 3] = (ev.t[i] - t0) / DAY * kmPerDay;
      ms[q] = ev.mag[i]; ids[q] = i; ts[q] = ev.t[i];
    }
    return { P: P, ms: ms, ids: ids, ts: ts };
  }
  /** 再生（4 次元）で初めに頼む塊の数：塊は時期でも分かれるので、「期間を km にした長さ ÷ 塊 1 つ分の広さの一辺」倍にする。
   *  areaKm2 はまとめる範囲の広さ */
  function kmInitialK(k, areaKm2, spanDays, kmPerDay) {
    var cellKm = Math.sqrt(areaKm2 / k), spanKm = spanDays * kmPerDay;
    return Math.min(KM_MAX, Math.max(k, Math.round(k * spanKm / cellKm)));
  }
  /** まとめる一式。job = { P, dim, ms, ids, ts, k（目標の数）, K（初めの塊の数）, t0, t1, s }。
   *  4 次元（再生）では、同時に見える数が目標の ±15% を外れたら、外れた割合だけ塊の数を変えて 1 回だけまとめ直す */
  function kmSolve(job) {
    var k = job.k, K = job.K, fit = kmFit(job.P, job.dim, job.ms, job.ids, job.ts, K);
    var active = job.dim === 4 ? kmActiveMedian(fit, job.t0, job.t1, job.s) : fit.length;
    if (job.dim === 4 && (active < 0.85 * k || active > 1.15 * k) && !(active < k && K >= KM_MAX)) {
      K = Math.min(KM_MAX, Math.max(k, Math.round(K * k / Math.max(active, 1))));
      fit = kmFit(job.P, job.dim, job.ms, job.ids, job.ts, K); active = kmActiveMedian(fit, job.t0, job.t1, job.s);
    }
    return { clusters: fit, K: K, active: active };
  }

  /** idx（時刻順）のうち、tLo < 時刻 ≦ tHi の地震の位置 [k0, k1) */
  function idxRange(ev, idx, tLo, tHi) {
    var lo = 0, hi = idx.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (ev.t[idx[m]] <= tLo) lo = m + 1; else hi = m; }
    var k0 = lo; hi = idx.length;
    while (lo < hi) { m = (lo + hi) >> 1; if (ev.t[idx[m]] <= tHi) lo = m + 1; else hi = m; }
    return [k0, lo];
  }
  /** 集合マーカーの半径（px）：M 相当が 1 増えるごとに step px 大きく。小さすぎ・大きすぎは切る */
  function aggRadius(meq, s) { return Math.max(3, Math.min(s.aggMax, s.aggMin * Math.pow(s.aggRatio, meq - s.aggBase))); }
  /** マーカーの数の段階（1〜10）→ 同時に見える数：段階1で10個、1段ごとに 10^(1/9) 倍、段階10で100個 */
  function kOfLevel(L) { L = Math.max(1, Math.min(10, Math.round(L))); return Math.round(10 * Math.pow(10, (L - 1) / 9)); }

  /** 期間のまとめ（動画・再生の最後に出す）。idx は描く対象の地震（時刻順）。 */
  function computeStats(ev, idx, t0, t1) {
    var s = { n: idx.length, days: Math.round((t1 - t0) / DAY), byM: {}, byInt: { 1: 0, 4: 0, 5: 0, 7: 0 },
              E: 0, max: -1, busiest: null, depth: { shallow: 0, mid: 0, deep: 0, unknown: 0 }, src: [0, 0, 0, 0] };
    [1, 2, 3, 4, 5, 6, 7].forEach(function (m) { s.byM[m] = 0; });
    var day = {};
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], m = ev.mag[i], mx = ev.maxi[i], d = ev.dep[i];
      for (var b = 1; b <= 7; b++) if (m >= b) s.byM[b]++;
      if (mx >= 1) s.byInt[1]++;
      if (mx >= 4) s.byInt[4]++;
      if (mx >= 5) s.byInt[5]++;
      if (mx >= 7) s.byInt[7]++;
      s.E += energyJ(m);
      if (s.max < 0 || m > ev.mag[s.max]) s.max = i;
      if (isNaN(d)) s.depth.unknown++; else if (d < 30) s.depth.shallow++; else if (d < 100) s.depth.mid++; else s.depth.deep++;
      s.src[ev.src[i]]++;
      var dk = formatDate(ev.t[i]);
      day[dk] = (day[dk] || 0) + 1;
    }
    Object.keys(day).forEach(function (dk) { if (!s.busiest || day[dk] > s.busiest.n) s.busiest = { day: dk, n: day[dk] }; });
    s.meq = magOfEnergy(s.E);
    return s;
  }

  // ---------------------------------------------------------------- グラフ
  /** 期間を日本時間の日ごとに数える */
  function dailyCounts(ev, idx, t0, t1) {
    var d0 = floorDayJst(t0), nd = Math.ceil((t1 - d0) / DAY), c = new Uint32Array(Math.max(nd, 0));
    for (var k = 0; k < idx.length; k++) {
      var j = Math.floor((ev.t[idx[k]] - d0) / DAY);
      if (j >= 0 && j < nd) c[j]++;
    }
    return { day0: d0, counts: c };
  }
  /** 横軸（時刻）の目盛り：期間の長さに応じて 年／月／日 */
  function timeTicks(t0, t1, maxTicks) {
    var span = t1 - t0, out = [], p, ms;
    var stepDays = [1, 2, 7, 14];
    for (var a = 0; a < stepDays.length; a++) {
      if (span / (stepDays[a] * DAY) <= maxTicks) {
        for (ms = floorDayJst(t0); ms <= t1; ms += stepDays[a] * DAY) {
          if (ms >= t0) { p = jstParts(ms); out.push({ t: ms, label: p.mo + '/' + p.d }); }
        }
        return out;
      }
    }
    var monthsStep = [1, 2, 3, 6, 12];
    for (var b = 0; b < monthsStep.length; b++) {
      var st = monthsStep[b], months = monthsBetween(t0, t1);
      if (months.length / st <= maxTicks) {
        months.forEach(function (ym) {
          var y = +ym.slice(0, 4), m = +ym.slice(5);
          if ((m - 1) % st) return;
          ms = dateToMs(ym + '-01');
          if (ms >= t0 && ms <= t1) out.push({ t: ms, label: m === 1 ? y + '年' : m + '月' });
        });
        return out;
      }
    }
    var p0 = jstParts(t0), p1 = jstParts(t1);
    for (var y = p0.y + 1; y <= p1.y; y++) out.push({ t: dateToMs(y + '-01-01'), label: y + '年' });
    return out;
  }

  var QC = {
    JST: JST, HOUR: HOUR, DAY: DAY, parseJst: parseJst, jstParts: jstParts, formatClock: formatClock,
    formatDate: formatDate, formatDateTime: formatDateTime, dateToMs: dateToMs, floorDayJst: floorDayJst,
    monthsBetween: monthsBetween, MAXI: MAXI, MAXI_LABEL: MAXI_LABEL, SRC: SRC, SRC_LABEL: SRC_LABEL,
    parseMonthCsv: parseMonthCsv, concatColumns: concatColumns, lowerBound: lowerBound,
    filterEvents: filterEvents, radius: radius, lifeMs: lifeMs, MAG_COLORS: MAG_COLORS,
    DEP_COLORS: DEP_COLORS, DEP_UNKNOWN: DEP_UNKNOWN, INT_STYLES: INT_STYLES, INT_UNKNOWN: INT_UNKNOWN,
    intensityStyle: intensityStyle, colorOf: colorOf, styleOf: styleOf, ageColor: ageColor, alphas: alphas,
    visibleAt: visibleAt, depthLook: depthLook, energyJ: energyJ, magOfEnergy: magOfEnergy, formatEnergy: formatEnergy,
    SRCD_COLORS: SRCD_COLORS, SRCD_UNKNOWN: SRCD_UNKNOWN, SRC_MAX_KM: SRC_MAX_KM, srcPrepare: srcPrepare, srcDistance: srcDistance, srcLast: srcLast,
    rng: rng, kmeans: kmeans, kmeansClusters: kmeansClusters, kmFit: kmFit, kmAt: kmAt, kmActiveMedian: kmActiveMedian, kmSolve: kmSolve, kmPoints: kmPoints, kmInitialK: kmInitialK, KM_MAX: KM_MAX, aggregate: aggregate, aggState: aggState, aggAdd: aggAdd, aggFinish: aggFinish, aggRadius: aggRadius, kOfLevel: kOfLevel, idxRange: idxRange, computeStats: computeStats, rotScreen: rotScreen, rotDelta: rotDelta,
    screenXAzimuth: screenXAzimuth, dirName: dirName, depthTicks: depthTicks, project0: project0, estIntensity: estIntensity, INT_THRESHOLDS: INT_THRESHOLDS,
    RING_LEVELS: RING_LEVELS, ringRadiiKm: ringRadiiKm, sphereRadiusKm: sphereRadiusKm, geomSphereRadiusKm: geomSphereRadiusKm, surfaceRadiusKm: surfaceRadiusKm, pxPerKm: pxPerKm, dailyCounts: dailyCounts, timeTicks: timeTicks
  };
  if (typeof module === 'object' && module.exports) module.exports = QC;
  else root.QC = QC;
})(this);
