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
                          poorQuality: 0, artificial: 0, lowFreq: 0, depth: 0 };
    for (var i = i0; i < i1; i++) {
      var la = ev.lat[i], lo = ev.lon[i];
      if (la < s.bbox[0] || la > s.bbox[2] || lo < s.bbox[1] || lo > s.bbox[3]) { why.outside++; continue; }
      if (ev.aux[i] === 3) { why.artificial++; continue; }
      if (ev.aux[i] === 5 && !s.lowFreq) { why.lowFreq++; continue; }
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
  function colorOf(mode, m, dep, ageFrac, maxi) {
    if (mode === 'depth') return isNaN(dep) ? DEP_UNKNOWN : band(DEP_COLORS, dep);
    if (mode === 'age') return ageColor(ageFrac);
    if (mode === 'maxi') return intensityStyle(maxi).fill;
    return band(MAG_COLORS, m);
  }
  /** 塗り・輪郭・点線。最大震度のときだけ輪郭の色が塗りと違うことがある */
  function styleOf(mode, m, dep, ageFrac, maxi) {
    if (mode === 'maxi') { var s = intensityStyle(maxi); return { fill: s.fill, stroke: s.stroke, dash: !!s.dash }; }
    var c = colorOf(mode, m, dep, ageFrac, maxi);
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
    visibleAt: visibleAt, depthLook: depthLook, project0: project0, estIntensity: estIntensity, INT_THRESHOLDS: INT_THRESHOLDS,
    RING_LEVELS: RING_LEVELS, ringRadiiKm: ringRadiiKm, sphereRadiusKm: sphereRadiusKm, geomSphereRadiusKm: geomSphereRadiusKm, surfaceRadiusKm: surfaceRadiusKm, pxPerKm: pxPerKm, dailyCounts: dailyCounts, timeTicks: timeTicks
  };
  if (typeof module === 'object' && module.exports) module.exports = QC;
  else root.QC = QC;
})(this);
