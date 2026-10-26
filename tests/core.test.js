/* 画面の計算部分（js/core.js）の検査。Node だけで動く。
 *   node tests/core.test.js            （端末のタイムゾーンを変えても同じ結果になること：
 *   TZ=America/New_York node tests/core.test.js  でも通す）
 *
 * 見ている点:
 *  1 時刻は日本時間として読み書きし、端末のタイムゾーンに左右されない
 *  2 日付の境目は日本時間の 0 時（UTC の 15 時ではない）
 *  3 時刻 T より後の地震は決して描かない。残る時間を過ぎたものも描かない。大きい順に返す
 *  4 描かない地震は理由ごとに数え、合計が合う（黙って落とさない）
 *  5 CSV の読めない行は数える。時刻順でないデータは止める
 *  6 色・大きさ・残る時間の境目
 */
'use strict';
var assert = require('assert');
var QC = require('../js/core.js');
var ng = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { ng++; console.error('✗ ' + name + '\n   ' + e.message); } }

var U = function (y, mo, d, h, mi, s, ms) { return Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0, ms || 0); };

t('日本時間の読み取り', function () {
  assert.strictEqual(QC.parseJst('2024-01-01T16:10:22.5'), U(2024, 1, 1, 7, 10, 22, 500));
  assert.strictEqual(QC.parseJst('2024-01-01T00:00'), U(2023, 12, 31, 15, 0));
  assert.ok(isNaN(QC.parseJst('2024-13-01T00:00')));
  assert.ok(isNaN(QC.parseJst('2024-01-01 00:00')));
  assert.ok(isNaN(QC.parseJst('')));
});
t('日本時間の表示（端末のタイムゾーンに左右されない）', function () {
  var ms = U(2023, 12, 31, 15, 30);        // 日本時間 2024-01-01 00:30
  assert.strictEqual(QC.formatClock(ms, QC.HOUR), '2024年1月1日 00:30');
  assert.strictEqual(QC.formatClock(ms, QC.DAY), '2024年1月1日');
  assert.strictEqual(QC.formatDate(ms), '2024-01-01');
  assert.strictEqual(QC.formatDateTime(U(2024, 1, 1, 7, 10, 22, 500)), '2024-01-01 16:10:22');
  assert.strictEqual(QC.dateToMs('2024-01-01'), U(2023, 12, 31, 15));
  assert.strictEqual(QC.floorDayJst(U(2023, 12, 31, 16)), U(2023, 12, 31, 15));
  assert.strictEqual(QC.floorDayJst(U(2023, 12, 31, 14, 59)), U(2023, 12, 30, 15));
});
t('期間に掛かる月', function () {
  assert.deepStrictEqual(QC.monthsBetween(QC.dateToMs('2023-12-25'), QC.dateToMs('2024-02-01')), ['2023-12', '2024-01']);
  assert.deepStrictEqual(QC.monthsBetween(QC.dateToMs('2024-01-31'), QC.dateToMs('2024-02-01') + 1), ['2024-01', '2024-02']);
});

var HEAD = 't,lat,lon,dep,mag,maxi,src,q,aux\n';
t('CSV：読めない行は数える', function () {
  var c = QC.parseMonthCsv(HEAD +
    '2024-01-01T16:10:22.5,37.495,137.27,16,7.6,7,P,,\n' +
    '2024-01-01T16:11,37.5,137.3,,,?,Q,,\n' +
    '2024-01-01T25:00:00.0,37.5,137.3,10,1,,P,,\n' +       // 時刻が壊れている
    '2024-01-01T16:12:00.0,,137.3,10,1,,P,,\n' +           // 緯度が空
    '2024-01-01T16:13:00.0,37.5,137.3,10,1,9,P,,\n' +      // 震度コードが想定外
    '2023-05-05T14:42:04.1,37.539,137.3045,12.14,6.5,6+,C,K,1\n');
  assert.strictEqual(c.n, 3);
  assert.deepStrictEqual(c.bad, [4, 5, 6]);
  assert.strictEqual(c.maxi[0], 9);
  assert.strictEqual(c.maxi[1], -1);
  assert.ok(isNaN(c.mag[1]) && isNaN(c.dep[1]));
  assert.strictEqual(c.maxi[2], 8);
  assert.strictEqual(c.q[2], 'K');
  assert.throws(function () { QC.parseMonthCsv('time,lat\n'); });
});
t('つなぐとき時刻順を確かめる', function () {
  var a = QC.parseMonthCsv(HEAD + '2024-02-01T00:00:00.0,35,135,10,1,,P,,\n');
  var b = QC.parseMonthCsv(HEAD + '2024-01-01T00:00:00.0,35,135,10,1,,P,,\n');
  assert.strictEqual(QC.concatColumns([b, a]).n, 2);
  assert.throws(function () { QC.concatColumns([a, b]); });
});

function evOf(rows) {
  return QC.concatColumns([QC.parseMonthCsv(HEAD + rows.join('\n') + '\n')]);
}
var S = { magMin: 1, intMin: 0, depMin: 0, depMax: 1000, lowFreq: false, reference: false,
          bbox: [20, 120, 50, 156], r1: 1.5, sizeGrowth: 1.7, sizeScale: 'exp',
          life1: 1, lifeGrowth: 2, lifeMin: 1 / 24, lifeMax: 30, fillAlpha: 0.5, strokeAlpha: 0.9, fadePow: 1 };

t('絞り込み：理由ごとに数え、合計が合う', function () {
  var ev = evOf([
    '2024-01-01T00:00:01.0,35,135,10,2.0,,P,,',      // 描く
    '2024-01-01T00:00:02.0,10,135,10,2.0,,P,,',      // 範囲外
    '2024-01-01T00:00:03.0,35,135,10,0.9,,P,,',      // M 下限未満
    '2024-01-01T00:00:04.0,35,135,10,,,P,,',         // M 不明
    '2024-01-01T00:00:05.0,35,135,10,2.0,,C,K,3',    // 人工
    '2024-01-01T00:00:06.0,35,135,10,2.0,,C,K,5',    // 低周波
    '2024-01-01T00:00:07.0,35,135,10,2.0,,C,S,1',    // 参考
    '2024-01-01T00:00:08.0,35,135,10,2.0,,C,N,1',    // 震源固定
    '2024-01-01T00:00:09.0,35,135,1200,2.0,,C,K,1',  // 深さ範囲外
    '2024-01-01T00:00:10.0,35,135,,2.0,,P,,'         // 深さ不明（描く）
  ]);
  var f = QC.filterEvents(ev, S, -Infinity, Infinity);
  assert.strictEqual(f.idx.length, 2);
  var w = f.why, sum = 0;
  Object.keys(w).forEach(function (k) { sum += w[k]; });
  assert.strictEqual(sum + f.idx.length, f.total);
  assert.deepStrictEqual(w, { magUnknown: 1, magLow: 1, intUnknown: 0, intLow: 0, outside: 1,
                              poorQuality: 2, artificial: 1, lowFreq: 1, depth: 1, notLfe: 0, lfeUnknown: 0 });
  var f2 = QC.filterEvents(ev, Object.assign({}, S, { lowFreq: true, reference: true }), -Infinity, Infinity);
  assert.strictEqual(f2.idx.length, 4);
  assert.strictEqual(f2.why.poorQuality, 1);    // N は常に除く
});
t('絞り込み：低周波地震だけ（確定版の印のあるものだけ。速報は区別できないと数える）', function () {
  var ev = evOf([
    '2023-01-01T00:00:01.0,34,134,30,0.5,,C,A,5',    // 低周波（確定）
    '2023-01-01T00:00:02.0,34,134,30,0.5,,C,A,1',    // ふつう（確定）
    '2023-01-01T00:00:04.0,34,134,30,-0.5,,C,A,5',   // 低周波だが M の下限未満
    '2024-01-01T00:00:03.0,34,134,30,0.5,,P,,'       // 速報（区別できない）
  ]);
  var f = QC.filterEvents(ev, Object.assign({}, S, { lfeOnly: true, magMin: 0 }), -Infinity, Infinity);
  assert.strictEqual(f.idx.length, 1);
  assert.strictEqual(ev.aux[f.idx[0]], 5);
  assert.strictEqual(f.why.notLfe, 1);
  assert.strictEqual(f.why.lfeUnknown, 1);
  assert.strictEqual(f.why.magLow, 1);
  var g = QC.filterEvents(ev, Object.assign({}, S, { lfeOnly: true, lowFreq: false, magMin: -1 }), -Infinity, Infinity);
  assert.strictEqual(g.idx.length, 2);                           // 「低周波を含めない」よりも「低周波だけ」が優先
});
t('絞り込み：震度の下限と不明', function () {
  var ev = evOf(['2024-01-01T00:00:01.0,35,135,10,3,3,P,,', '2024-01-01T00:00:02.0,35,135,10,3,1,P,,',
                 '2024-01-01T00:00:03.0,35,135,10,3,?,P,,', '2024-01-01T00:00:04.0,35,135,10,3,,P,,']);
  var f = QC.filterEvents(ev, Object.assign({}, S, { intMin: 3 }), -Infinity, Infinity);
  assert.strictEqual(f.idx.length, 1);
  assert.strictEqual(f.why.intUnknown, 1);
  assert.strictEqual(f.why.intLow, 2);
});
t('絞り込み：期間の端', function () {
  var ev = evOf(['2024-01-01T00:00:00.0,35,135,10,3,,P,,', '2024-01-02T00:00:00.0,35,135,10,3,,P,,']);
  var f = QC.filterEvents(ev, S, QC.dateToMs('2024-01-01'), QC.dateToMs('2024-01-02'));
  assert.strictEqual(f.total, 1);
});

t('時刻 T に見える地震：未来は出さない・残る時間を過ぎたら消す・大きい順', function () {
  var ev = evOf([
    '2024-01-01T00:00:00.0,35,135,10,1.0,,P,,',   // 残る 1 日
    '2024-01-01T12:00:00.0,35,135,10,5.0,,P,,',   // 残る 16 日
    '2024-01-02T00:00:00.0,35,135,10,3.0,,P,,',   // T ちょうど
    '2024-01-02T00:00:00.1,35,135,10,7.0,,P,,'    // T の 0.1 秒後
  ]);
  var f = QC.filterEvents(ev, S, -Infinity, Infinity), life = [], mx = 0;
  for (var k = 0; k < f.idx.length; k++) { life.push(QC.lifeMs(ev.mag[f.idx[k]], S)); mx = Math.max(mx, life[k]); }
  var T = QC.parseJst('2024-01-02T00:00:00.0');
  var vis = QC.visibleAt(ev, f.idx, life, T, mx).map(function (k) { return ev.mag[f.idx[k]]; });
  assert.deepStrictEqual(vis, [5, 3, 1]);           // M1 はちょうど 1 日で、まだ残る
  vis = QC.visibleAt(ev, f.idx, life, T + 1, mx).map(function (k) { return ev.mag[f.idx[k]]; });
  assert.deepStrictEqual(vis, [5, 3]);              // 1 日を過ぎた M1 は消える。M7 はまだ未来
  vis = QC.visibleAt(ev, f.idx, life, T + 100, mx).map(function (k) { return ev.mag[f.idx[k]]; });
  assert.deepStrictEqual(vis, [7, 5, 3]);
  vis = QC.visibleAt(ev, f.idx, life, T - 1, mx).map(function (k) { return ev.mag[f.idx[k]]; });
  assert.deepStrictEqual(vis, [5, 1]);
});
t('残る時間と大きさ', function () {
  assert.strictEqual(QC.lifeMs(1, S), QC.DAY);
  assert.strictEqual(QC.lifeMs(3, S), 4 * QC.DAY);
  assert.strictEqual(QC.lifeMs(9, S), 30 * QC.DAY);           // 上限
  assert.strictEqual(QC.lifeMs(-2, S), QC.DAY / 8);           // 1 × 2^(−3) 日
  assert.strictEqual(QC.lifeMs(-5, S), QC.DAY / 24);          // 下限（1時間）
  assert.ok(QC.radius(2, S) > QC.radius(1, S) && QC.radius(7, S) > QC.radius(6, S));
  assert.strictEqual(QC.radius(1, S), 1.5);
  var lin = Object.assign({}, S, { sizeScale: 'lin' });
  assert.ok(Math.abs((QC.radius(3, lin) - QC.radius(2, lin)) - (QC.radius(2, lin) - QC.radius(1, lin))) < 1e-9);
});
t('色の境目', function () {
  var c = function (m) { return QC.colorOf('mag', m, 10, 0); };
  assert.strictEqual(c(2.0), '#1e63d6');
  assert.strictEqual(c(1.9), '#4fc3f7');
  assert.strictEqual(c(7.6), '#7a2bb3');
  assert.strictEqual(c(8.0), '#3b1f7a');
  assert.strictEqual(c(9.0), '#111111');
  assert.notStrictEqual(c(8.0), c(7.9));
  assert.ok(QC.radius(9, S) > QC.radius(8, S) && QC.radius(8, S) > QC.radius(7, S));   // 上限で頭打ちにしない
  assert.ok(QC.alphas(9, 0, S).fill < QC.alphas(7, 0, S).fill);
  assert.strictEqual(c(0.5), '#9ad7ef');
  assert.strictEqual(QC.colorOf('depth', 3, NaN, 0), QC.DEP_UNKNOWN);
  assert.strictEqual(QC.colorOf('depth', 3, 10, 0), '#fb8c00');
  assert.strictEqual(QC.colorOf('depth', 3, 9.9, 0), '#e53935');
  assert.notStrictEqual(QC.colorOf('age', 3, 10, 0), QC.colorOf('age', 3, 10, 1));
  var a0 = QC.alphas(6, 0, S), a1 = QC.alphas(2, 0, S);
  assert.ok(a0.fill < a1.fill && a0.stroke >= a1.stroke);     // 大きい円は中を薄く、輪郭を強く
  assert.ok(QC.alphas(3, 0.9, S).fill < QC.alphas(3, 0.1, S).fill);
});
t('最大震度の色：気象庁の配色・不明は白抜き点線・無感と区別', function () {
  var st = function (code) { return QC.styleOf('maxi', 3, 10, 0, QC.MAXI[code]); };
  assert.strictEqual(st('7').fill, '#b40068');
  assert.strictEqual(st('6+').fill, '#a50021');
  assert.strictEqual(st('5-').fill, '#ffe600');
  assert.strictEqual(st('5+').fill, '#ff9900');
  assert.strictEqual(st('1').fill, '#f2f2ff');
  assert.notStrictEqual(st('1').stroke, st('1').fill);        // 白に近い色は輪郭を濃く
  assert.ok(st('?').dash && st('F').dash);
  assert.ok(!st('').dash && !st('3').dash);
  assert.notStrictEqual(st('?').fill, st('').fill);            // 不明と無感を同じ色にしない
  assert.strictEqual(QC.colorOf('maxi', 3, 10, 0, 9), '#b40068');
  assert.strictEqual(QC.styleOf('mag', 3, 10, 0, 9).fill, '#f5d000'); // 震度は M の色に影響しない
});
t('1日あたりの回数は日本時間の日で区切る', function () {
  var ev = evOf(['2024-01-01T23:59:59.9,35,135,10,2,,P,,', '2024-01-02T00:00:00.0,35,135,10,2,,P,,',
                 '2024-01-02T08:59:59.0,35,135,10,2,,P,,', '2024-01-02T09:00:00.0,35,135,10,2,,P,,']);
  var f = QC.filterEvents(ev, S, -Infinity, Infinity);
  var dc = QC.dailyCounts(ev, f.idx, QC.dateToMs('2024-01-01'), QC.dateToMs('2024-01-03'));
  assert.deepStrictEqual(Array.from(dc.counts), [1, 3]);
});
t('目盛りは日本時間の区切り', function () {
  var tk = QC.timeTicks(QC.dateToMs('2023-12-25'), QC.dateToMs('2024-02-01'), 8);
  assert.ok(tk.some(function (x) { return x.label === '1/1' && x.t === QC.dateToMs('2024-01-01'); }));
  tk = QC.timeTicks(QC.dateToMs('2023-01-01'), QC.dateToMs('2025-01-01'), 6);
  assert.ok(tk.some(function (x) { return x.label === '2024年' && x.t === QC.dateToMs('2024-01-01'); }));
});
t('球：推定震度の式は Python 版（research/sphere_check.py）と同じ答え', function () {
  // 期待値は sphere_check.py の intensity(mw, D, X, amp=1.31) の出力（2026-10-11）
  var near = function (a, b) { return Math.abs(a - b) < 1e-9; };
  assert.ok(near(QC.estIntensity(7.6, 16, 30, 1.31), 5.359511024266217));
  assert.ok(near(QC.estIntensity(8.1, 681.71, 681.71, 1.31), 5.9465942615591585));
  assert.ok(near(QC.estIntensity(3.0, 10, 10, 1.31), 1.9600816381918644));
});
t('球：半径・地表の円', function () {
  var thr = QC.INT_THRESHOLDS['4'];
  var R = QC.sphereRadiusKm(7.6, 16, thr, 1.31);
  assert.ok(R > 16 && Math.abs(QC.estIntensity(7.6, 16, R, 1.31) - thr) < 1e-6);   // 半径の上で推定震度がちょうど境目
  assert.strictEqual(QC.sphereRadiusKm(3.0, 10, QC.INT_THRESHOLDS['3'], 1.31), 0);  // 真上でも届かない
  assert.ok(QC.sphereRadiusKm(7, 10, thr, 1.31) > QC.sphereRadiusKm(6, 10, thr, 1.31));
  assert.ok(QC.sphereRadiusKm(6, 10, thr, 2) > QC.sphereRadiusKm(6, 10, thr, 1.31));
  assert.ok(QC.sphereRadiusKm(6, 10, QC.INT_THRESHOLDS['3'], 1.31) > QC.sphereRadiusKm(6, 10, thr, 1.31));
  assert.strictEqual(QC.surfaceRadiusKm(5, 3), 4);
  assert.strictEqual(QC.surfaceRadiusKm(3, 3), 0);
  assert.strictEqual(QC.surfaceRadiusKm(2, 3), 0);
  // 中くらいの地震は、深いほど地表の円が小さく、やがて消える（M6：10km で 54km、60km で 49km、100km で 0）
  var r6 = function (d) { return QC.surfaceRadiusKm(QC.sphereRadiusKm(6, d, thr, 1.31), d); };
  assert.ok(r6(60) < r6(10) && r6(100) === 0);
  // 大きな地震は、式の深さの項（+0.0038D）のため、深いほど地表の円が大きくなる（2026-10-11 に確かめた式の性質）
  var r7 = function (d) { return QC.surfaceRadiusKm(QC.sphereRadiusKm(7, d, thr, 1.31), d); };
  assert.ok(r7(100) > r7(10));
  assert.ok(QC.estIntensity(7, 100, 150, 1.31) > QC.estIntensity(7, 10, 150, 1.31));
  // 同心円：外ほど弱い震度で半径が大きい。各輪は球の地表の円と同じ
  var rings = QC.ringRadiiKm(7.6, 16, 1.31, ['3', '4', '5-', '6-', '7']);
  for (var n = 1; n < rings.length; n++) assert.ok(rings[n] <= rings[n - 1]);
  assert.ok(rings[0] > rings[1] && rings[1] > 0);
  assert.strictEqual(rings[1], QC.surfaceRadiusKm(QC.sphereRadiusKm(7.6, 16, 3.5, 1.31), 16));
  assert.deepStrictEqual(QC.ringRadiiKm(3, 10, 1.31, ['3', '4']), [0, 0]);
  assert.strictEqual(QC.intensityStyle(QC.MAXI['5+']).label, '震度5強');
  assert.strictEqual(QC.intensityStyle(QC.MAXI['5-']).label, '震度5弱');
  // 図式の球：M だけで決まり、深いほど地表の円が小さい（必ず）
  assert.strictEqual(QC.geomSphereRadiusKm(5, 30, 2), 30);
  assert.strictEqual(QC.geomSphereRadiusKm(7, 30, 2), 120);
  var g = QC.geomSphereRadiusKm(7, 30, 2);
  assert.ok(QC.surfaceRadiusKm(g, 100) < QC.surfaceRadiusKm(g, 10) && QC.surfaceRadiusKm(g, 130) === 0);
  assert.ok(Math.abs(QC.pxPerKm(0, 0) - 256 / 40075.016686) < 1e-12);
  assert.ok(Math.abs(QC.pxPerKm(60, 3) / QC.pxPerKm(0, 3) - 2) < 1e-9);
});
t('奥行き：深いほど小さく・にじみ・薄く。効き0と深さ不明は元のまま。大きな地震は薄めない', function () {
  var D = { vol: 1, viewH: 100, dShrink: true, dBlur: 1, dHaze: 1, hazeMin: 0.25, keepBig: true, keepBigM: 7 };
  var l0 = QC.depthLook(0, 3, D), l100 = QC.depthLook(100, 3, D), l300 = QC.depthLook(300, 3, D);
  assert.deepStrictEqual(l0, { scale: 1, blur: 0, alpha: 1 });
  assert.strictEqual(l100.scale, 0.5);                       // 100 ÷（100＋100）
  assert.strictEqual(l300.scale, 0.25);
  assert.ok(l300.blur > l100.blur && l100.blur > 0);
  assert.ok(l300.alpha < l100.alpha && l100.alpha < 1);
  assert.strictEqual(QC.depthLook(5000, 3, D).alpha, 0.25);  // かすみの下限
  assert.strictEqual(QC.depthLook(100, 3, Object.assign({}, D, { vol: 0.5 })).scale, 100 / 150);
  assert.deepStrictEqual(QC.depthLook(300, 3, Object.assign({}, D, { vol: 0 })), { scale: 1, blur: 0, alpha: 1 });
  assert.deepStrictEqual(QC.depthLook(NaN, 3, D), { scale: 1, blur: 0, alpha: 1 });
  var big = QC.depthLook(682, 8.1, D);
  assert.ok(big.scale < 0.2 && big.alpha === 1 && big.blur === 0);   // 深い大地震：小さくはなるが消えない
  assert.strictEqual(QC.depthLook(300, 3, Object.assign({}, D, { dShrink: false })).scale, 1);
  assert.strictEqual(QC.depthLook(300, 3, Object.assign({}, D, { dBlur: 0 })).blur, 0);
  assert.strictEqual(QC.depthLook(300, 3, Object.assign({}, D, { dHaze: 0 })).alpha, 1);
});
t('地図の回転：画面の位置・ドラッグの向き・画面の横方向の方位', function () {
  var near = function (a, b) { return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9; };
  // 回さなければ、枠の中心と画面の中心をそろえるだけ
  assert.ok(near(QC.rotScreen(150, 100, 300, 200, 300, 200, 0), [150, 100]));
  assert.ok(near(QC.rotScreen(250, 100, 400, 400, 300, 200, 0), [200, 0]));
  // 時計回りに 90 度：枠の中心より右（東）にあった点は、画面の中心より下に来る
  assert.ok(near(QC.rotScreen(250, 200, 400, 400, 300, 200, 90), [150, 150]));
  assert.ok(near(QC.rotScreen(200, 150, 400, 400, 300, 200, 90), [200, 100]));   // 北にあった点は右へ
  // ドラッグ：画面で動かした量を逆に回すと、回した後にちょうど画面の動きに戻る
  [0, 30, 90, -135].forEach(function (d) {
    var u = QC.rotDelta(7, -3, d), back = QC.rotScreen(200 + u[0], 200 + u[1], 400, 400, 0, 0, d);
    assert.ok(near(back, [7, -3]));
  });
  assert.strictEqual(QC.screenXAzimuth(0), 90);
  assert.strictEqual(QC.screenXAzimuth(90), 0);       // 時計回りに 90 度回すと、右は北
  assert.strictEqual(QC.screenXAzimuth(-45), 135);
  assert.strictEqual(QC.dirName(90), '東');
  assert.strictEqual(QC.dirName(0), '北');
  assert.strictEqual(QC.dirName(359), '北');
  assert.strictEqual(QC.dirName(135), '南東');
  assert.deepStrictEqual(QC.depthTicks(700), [0, 200, 400, 600]);
  assert.deepStrictEqual(QC.depthTicks(60), [0, 10, 20, 30, 40, 50, 60]);
});
t('エネルギー：M が 1 増えると約 32 倍、2 増えると 1000 倍。合計を M 相当に戻せる', function () {
  var near = function (a, b, e) { return Math.abs(a - b) < (e || 1e-9); };
  assert.ok(near(QC.energyJ(0), Math.pow(10, 4.8)));
  assert.ok(near(QC.energyJ(7) / QC.energyJ(6), Math.pow(10, 1.5)));
  assert.ok(near(QC.energyJ(8) / QC.energyJ(6), 1000, 1e-6));
  assert.ok(near(QC.magOfEnergy(QC.energyJ(7.6)), 7.6));
  assert.ok(near(QC.magOfEnergy(1000 * QC.energyJ(5)), 7));        // M5 が 1000 個で M7 相当
  assert.ok(isNaN(QC.magOfEnergy(0)));
  assert.strictEqual(QC.formatEnergy(2.5e15), '2.5PJ');
  assert.strictEqual(QC.formatEnergy(3.2e18), '3.2EJ');
  assert.strictEqual(QC.formatEnergy(150e12), '150TJ');
});
t('集計：格子でまとめ、回数・エネルギー・最大の地震・重心が合う', function () {
  var g = QC.aggregate([1, 2, 30, 31], [1, 3, 1, 1], [3, 5, 4, 4], [10, 11, 12, 13], 20);
  assert.strictEqual(g.length, 2);
  var a = g.filter(function (x) { return x.n === 2 && x.maxM === 5; })[0], b = g.filter(function (x) { return x.maxM === 4; })[0];
  assert.ok(a && b);
  assert.strictEqual(a.maxI, 11);
  assert.strictEqual(a.x, 1.5); assert.strictEqual(a.y, 2);
  assert.ok(Math.abs(a.E - (QC.energyJ(3) + QC.energyJ(5))) < 1);
  assert.ok(Math.abs(b.meq - QC.magOfEnergy(2 * QC.energyJ(4))) < 1e-9);
  assert.ok(g[0].E <= g[1].E);                                      // 小さい順（大きいものを最後＝上に描く）
  // 大きさ：M 相当が 1 上がるごとに aggRatio 倍（px を足すのではなく掛ける）
  var s = { aggMin: 6, aggMax: 40, aggBase: 2, aggRatio: 1.5 };
  assert.strictEqual(QC.aggRadius(2, s), 6);
  assert.strictEqual(QC.aggRadius(4, s), 13.5);
  assert.ok(Math.abs(QC.aggRadius(5, s) / QC.aggRadius(4, s) - 1.5) < 1e-12);
  assert.strictEqual(QC.aggRadius(12, s), 40);                      // 上限
  assert.strictEqual(QC.aggRadius(-5, s), 3);                       // 下限
  // マーカーの数の段階：10 段階で 10 → 100、1 段ごとに 10^(1/9) 倍
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(QC.kOfLevel), [10, 13, 17, 22, 28, 36, 46, 60, 77, 100]);
  assert.strictEqual(QC.kOfLevel(0), 10); assert.strictEqual(QC.kOfLevel(11), 100);
});
t('k-means（D 次元）：離れた集まりを分け、マーカーは実際の地震の位置。同じ種なら同じ結果。4 次元では時間で分かれる', function () {
  // 2 次元：左（x≈0）に 30 個、右（x≈1000）に 20 個。右側は 2 つの小さな集まり（y=0 と y=40）
  var P = [], ms = [], ids = [];
  for (var j = 0; j < 30; j++) { P.push(j % 6, Math.floor(j / 6)); ms.push(2); ids.push(j); }
  for (j = 0; j < 20; j++) { P.push(1000 + (j % 4), j < 10 ? 0 : 40); ms.push(j === 15 ? 6 : 3); ids.push(100 + j); }
  P = Float64Array.from(P);
  var C = QC.kmeans(P, 2, 2, { seed: 3 }), g = QC.kmeansClusters(P, 2, ms, ids, C);
  assert.strictEqual(g.length, 2);
  var left = g.filter(function (q) { return q.n === 30; })[0], right = g.filter(function (q) { return q.n === 20; })[0];
  assert.ok(left && right);
  assert.strictEqual(right.maxI, 115);
  assert.ok(Math.abs(right.meq - QC.magOfEnergy(19 * QC.energyJ(3) + QC.energyJ(6))) < 1e-9);
  // 右の中心は 2 つの小さな集まりのあいだ（y≈20、地震の無い所）。マーカーは実際の点（y=0 か 40）
  assert.ok(Math.abs(right.c[1] - 20) < 1e-9);
  var my = P[right.mi * 2 + 1];
  assert.ok(my === 0 || my === 40);
  assert.ok(right.rms >= 20 && right.rms < 21);
  // マーカーの地震は、塊のどの地震よりも中心に近い（同じ距離も可）
  g.forEach(function (q) {
    var d = function (i) { return Math.pow(P[i * 2] - q.c[0], 2) + Math.pow(P[i * 2 + 1] - q.c[1], 2); };
    Array.from(q.members).forEach(function (m) { assert.ok(d(q.mi) <= d(m) + 1e-9); });
    assert.ok(d(q.mi) < d(q.members[0]) || q.mi === q.members[0] || d(q.mi) === d(q.members[0]));
  });
  assert.notStrictEqual(left.mi, left.members[0]);              // 左の塊の最初の点（0,0）は中心（2.5, 2）から遠い
  // 前の中心から続ける：答えが 2 通りありうる並び（3 つの集まりを 2 つに）では、どちらから始めてもそこに留まる
  var T3 = [];
  [0, 100, 200].forEach(function (x0) { for (var q = 0; q < 10; q++) T3.push(x0 + (q % 2), Math.floor(q / 2)); });
  T3 = Float64Array.from(T3);
  var mid = function (a, b) { return [(a + b) / 2 + 0.5, 2]; };
  var initA = Float64Array.from([0.5, 2].concat(mid(100, 200))), initB = Float64Array.from(mid(0, 100).concat([200.5, 2]));
  assert.deepStrictEqual(Array.from(QC.kmeans(T3, 2, 2, { init: initA, iters: 5 })), Array.from(initA));
  assert.deepStrictEqual(Array.from(QC.kmeans(T3, 2, 2, { init: initB, iters: 5 })), Array.from(initB));
  assert.strictEqual(right.members.length, 20);
  assert.deepStrictEqual(Array.from(QC.kmeans(P, 2, 2, { seed: 3 })), Array.from(C));          // 同じ種なら同じ
  assert.deepStrictEqual(Array.from(QC.kmeans(P, 2, 2, { init: C, iters: 3 })), Array.from(C)); // 収まった中心は動かない
  assert.strictEqual(QC.kmeans(Float64Array.from([1, 2, 3, 4]), 2, 5).length, 4);              // k が点より多くても壊れない
  assert.deepStrictEqual(QC.kmeansClusters(new Float64Array(0), 2, [], [], new Float64Array(0)), []);
  var g3 = QC.kmeansClusters(P, 2, ms, ids, QC.kmeans(P, 2, 3, { seed: 3 }));
  assert.deepStrictEqual(g3.map(function (q) { return q.n; }).sort(function (a, b) { return a - b; }), [10, 10, 30]);
  // 4 次元（x, y, z, t）：同じ場所・同じ深さでも、時間が離れていれば別の塊になる
  var Q = [];
  for (j = 0; j < 10; j++) Q.push(0, 0, 10, j);          // 時刻 0〜9
  for (j = 0; j < 10; j++) Q.push(0, 0, 10, 500 + j);    // 同じ場所で時刻 500〜509
  Q = Float64Array.from(Q);
  var g4 = QC.kmeansClusters(Q, 4, new Array(20).fill(3), new Array(20).fill(0).map(function (_, i) { return i; }), QC.kmeans(Q, 4, 2, { seed: 1 }));
  assert.deepStrictEqual(g4.map(function (q) { return q.n; }), [10, 10]);
  assert.ok(g4.every(function (q) { var t0 = Q[q.members[0] * 4 + 3]; return Array.from(q.members).every(function (m) { return Math.abs(Q[m * 4 + 3] - t0) < 20; }); }));
  // 3 次元（深さを含む）：同じ震央でも深さが離れていれば別の塊
  var R = Float64Array.from([0, 0, 5, 1, 0, 6, 0, 1, 5, 0, 0, 300, 1, 0, 301, 0, 1, 299]);
  var g5 = QC.kmeansClusters(R, 3, [3, 3, 3, 3, 3, 3], [0, 1, 2, 3, 4, 5], QC.kmeans(R, 3, 2, { seed: 1 }));
  assert.deepStrictEqual(g5.map(function (q) { return Array.from(q.members).sort().join(); }).sort(), ['0,1,2', '3,4,5']);
});
t('k-means の一式（kmFit・kmAt・kmSolve）と、別の計算場所（js/kmworker.js）が同じ答えを返すこと', function () {
  var D = QC.DAY;
  // 1 つの塊に 3 回（1 日目 M3・2 日目 M5・5 日目 M3）。累積は時刻順、マーカーは中心に近い地震、最大は M5
  var P = Float64Array.from([0, 0, 10, 2, 0, 10, 1, 0, 10]), ms = [3, 5, 3], ids = [40, 41, 42], ts = [1 * D, 2 * D, 5 * D];
  var g = QC.kmFit(P, 3, ms, ids, ts, 1)[0];
  assert.deepStrictEqual(Array.from(g.times), ts);
  assert.ok(Math.abs(g.cumE[2] - g.E) < 1e-6 * g.E && Math.abs(g.cumE[0] - QC.energyJ(3)) < 1e-6 * g.cumE[0]);
  assert.deepStrictEqual(Array.from(g.maxAt), [40, 41, 41]);
  assert.deepStrictEqual(Array.from(g.bestAt), [40, 40, 42]);   // 中心は x=1：1 日目は 40 しか無い、5 日目に x=1 の 42 が入る
  assert.strictEqual(g.ev, 42);
  assert.ok(Math.abs(g.rmsXY - Math.sqrt(2 / 3)) < 1e-12);
  assert.strictEqual(QC.kmAt(g, 0.5 * D, S), null);                       // まだ起きていない
  assert.strictEqual(QC.kmAt(g, 2 * D, S).n, 2);                          // その時刻ちょうどの地震は入る
  assert.strictEqual(QC.kmAt(g, 2 * D, S).maxI, 41);
  var a5 = QC.kmAt(g, 5 * D, S), life = QC.lifeMs(a5.meq, S);
  assert.strictEqual(a5.alpha, 1);
  assert.ok(Math.abs(QC.kmAt(g, 5 * D + life / 2, S).alpha - 0.5) < 1e-9);   // 最後の地震から残る時間の半分で半分
  assert.strictEqual(QC.kmAt(g, 5 * D + life + 1, S), null);
  assert.strictEqual(QC.kmAt(g, null, S).n, 3);
  // 再生（4 次元）：同時に見える数が目標から外れたら、外れた割合だけ塊の数を変えて 1 回まとめ直す
  // 1000km ずつ離れた 20 か所、全部 0 日目に M6（期間 10 日のあいだ消えない）。目標 5 個
  var Q = [], m20 = [], i20 = [], t20 = [];
  for (var j = 0; j < 20; j++) { Q.push(j * 1000, 0, 10, 0); m20.push(6); i20.push(j); t20.push(0); }
  Q = Float64Array.from(Q);
  var job = function (K, k) { return { P: Q, dim: 4, ms: m20, ids: i20, ts: t20, k: k || 5, K: K, t0: 0, t1: 10 * D, s: S }; };
  assert.deepStrictEqual([2, 5, 6, 7].map(function (K) { var r = QC.kmSolve(job(K)); return [r.K, r.active, r.clusters.length]; }),
    [[5, 5, 5],      // 2 個しか見えない → 2×5/2 = 5 個でまとめ直し
     [5, 5, 5],      // 合っていればそのまま
     [5, 5, 5],      // 6 は 5 の +15%（5.75）を超える → 6×5/6 = 5
     [5, 5, 5]]);
  assert.deepStrictEqual((function () { var r = QC.kmSolve(job(23, 20)); return [r.K, r.active]; })(), [23, 20]);   // 20 か所しか無い：23 個頼んでも見えるのは 20（±15% 以内）
  var r3 = QC.kmSolve({ P: Q.filter(function (_, i) { return i % 4 !== 3; }), dim: 3, ms: m20, ids: i20, ts: t20, k: 5, K: 2, t0: 0, t1: 10 * D, s: S });
  assert.deepStrictEqual([r3.K, r3.active], [2, 2]);                        // 静止画（3 次元）はまとめ直さない
  // 座標：東経137度で x=0、東へ 1 度で 111.32×cos(緯度) km、深さは重み倍（地表より上は 0）、時間は日 × 1日あたりの km
  var ev2 = { lon: [137, 138], lat: [35, 60], dep: [-2, 50], mag: [3, 4], t: [10 * D, 12 * D] };
  var pt = QC.kmPoints(ev2, [1, 0], 4, 2, 3, 10 * D);
  assert.deepStrictEqual(Array.from(pt.ids), [1, 0]);
  assert.ok(Math.abs(pt.P[0] - 111.32 * 0.5) < 1e-9 && Math.abs(pt.P[1] - 60 * 110.574) < 1e-9);
  assert.deepStrictEqual([pt.P[2], pt.P[3], pt.P[4], pt.P[6], pt.P[7]], [100, 6, 0, 0, 0]);
  assert.deepStrictEqual([Array.from(pt.ms), Array.from(pt.ts)], [[4, 3], [12 * D, 10 * D]]);
  assert.strictEqual(QC.kmPoints(ev2, [0], 3, 1, 3, 0).P.length, 3);
  // 初めの塊の数：10 個・100×100km・期間 100 日・1日 3km → 一辺 sqrt(1000)≈31.6km、期間 300km → 9.49 倍 → 95 個。上限 600、目標より少なくしない
  assert.strictEqual(QC.kmInitialK(10, 10000, 100, 3), 95);
  assert.strictEqual(QC.kmInitialK(10, 10000, 1000, 3), QC.KM_MAX);
  assert.strictEqual(QC.kmInitialK(10, 1e8, 1, 3), 10);
  // 別の計算場所：js/kmworker.js を Node の中で動かし、画面で計算したときと同じ塊になること（番号を付けて返す）
  var vm = require('vm'), fs = require('fs'), path = require('path'), sent = [];
  var ctx = { postMessage: function (m) { sent.push(m); }, Float64Array: Float64Array, Int32Array: Int32Array };
  ctx.self = ctx;
  ctx.importScripts = function (f) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'kmworker.js'), 'utf8'), ctx);
  var want = QC.kmSolve(job(2)), w = job(2); w.seq = 9;
  ctx.onmessage({ data: w });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].seq, 9);
  assert.deepStrictEqual([sent[0].K, sent[0].active], [want.K, want.active]);
  var sig = function (cl) { return JSON.stringify(cl.map(function (c) { return [c.ev, Array.from(c.members), c.n, Array.from(c.cumE), Array.from(c.bestAt)]; })); };
  assert.strictEqual(sig(sent[0].clusters), sig(want.clusters));    // 別の計算場所の配列は Node では別の世界の物なので、文字にして比べる
  ctx.onmessage({ data: { seq: 10, P: Q, dim: 4 } });                       // 壊れた頼み：落ちずに理由を返す
  assert.ok(sent[1].seq === 10 && sent[1].error);
});
t('想定震源域からの距離：震源から面（升ごとの深さの幅）までの立体の距離。遠い・深さ不明・海域の選び方', function () {
  // 升：(140, 35) 深さ 10km、(140.15, 35) 深さ 20〜25km（長方形が重なって幅がある）。その間の 2 つと 2 段目は空白
  var data = { groups: [{ id: 'a', grid: { lon0: 140, lat0: 35, step: 0.05, nx: 4, ny: 2, z: [100, -2, 200, -4], w: [0, 50] } },
                        { id: 'b', grid: { lon0: 130, lat0: 30, step: 0.05, nx: 1, ny: 1, z: [50], w: [0] } }] };
  var p = QC.srcPrepare(data);
  assert.strictEqual(p.C.length, 15);
  assert.strictEqual(QC.srcDistance(p, 140, 35, 10), 0);
  assert.ok(Math.abs(QC.srcDistance(p, 140, 35, 13) - 3) < 1e-9);
  assert.deepStrictEqual(QC.srcLast(), { group: 0, side: 1 });          // 面より深い
  assert.ok(Math.abs(QC.srcDistance(p, 140, 35, 7) - 3) < 1e-9);
  assert.strictEqual(QC.srcLast().side, -1);                               // 面より浅い
  assert.strictEqual(QC.srcDistance(p, 140.15, 35, 22), 0);               // 幅の中
  assert.strictEqual(QC.srcLast().side, 0);
  assert.ok(Math.abs(QC.srcDistance(p, 140.15, 35, 30) - 5) < 1e-9);
  // 横に離れた所：北へ 0.1 度＝11.06km
  assert.ok(Math.abs(QC.srcDistance(p, 140, 35.1, 10) - 0.1 * 110.574) < 1e-6);
  // 箱（0.2 度）をまたいで遠くの升も見つける：西へ 0.5 度・深さ同じ
  var dW = 0.5 * 111.32 * Math.cos(35 * Math.PI / 180);
  assert.ok(Math.abs(QC.srcDistance(p, 139.5, 35, 10) - dW) < 1e-6);
  assert.strictEqual(QC.srcDistance(p, 150, 45, 10), Infinity);           // 近くに升が無い
  assert.strictEqual(QC.srcDistance(p, 140, 36.6, 10), Infinity);         // 見つかっても 177km（150km より遠い）
  assert.ok(isNaN(QC.srcDistance(p, 140, 35, NaN)));                       // 深さ不明
  assert.strictEqual(QC.srcDistance(p, 130, 30, 5), 0);
  assert.strictEqual(QC.srcLast().group, 1);
  assert.strictEqual(QC.srcDistance(QC.srcPrepare(data, ['a']), 130, 30, 5), Infinity);   // 海域 a だけ
  // 色：M の色のまま、遠いほど鮮やかさを落とす。5km 以内は元の色、80km 以上・震源域が無いときは 9 割、深さ不明は白の点線
  assert.strictEqual(QC.srcFade(4.9), 0);
  assert.strictEqual(QC.srcFade(5), 0);
  assert.ok(Math.abs(QC.srcFade(10) - 0.225) < 1e-9 && Math.abs(QC.srcFade(20) - 0.45) < 1e-9);
  assert.strictEqual(QC.srcFade(80), 0.9);
  assert.strictEqual(QC.srcFade(Infinity), 0.9);
  assert.strictEqual(QC.desaturate('#ff0000', 0), 'rgb(255,0,0)');
  assert.strictEqual(QC.desaturate('#ff0000', 1), 'rgb(116,116,116)');    // 輝度 76＋40
  // 色＝いちばん近い海域の色、鮮やかさ＝近さ。近くに海域が無い・色が無いときは灰色。M には左右されない
  var red = QC.SRC_GROUP_COLORS.japan;
  assert.strictEqual(QC.colorOf('src', 3, 10, 0, 0, 4.9, red), QC.desaturate(red, 0));
  assert.strictEqual(QC.colorOf('src', 6, 10, 0, 0, 40, red), QC.desaturate(red, QC.srcFade(40)));
  assert.strictEqual(QC.colorOf('src', 3, 10, 0, 0, 40, red), QC.colorOf('src', 7, 10, 0, 0, 40, red));
  assert.notStrictEqual(QC.colorOf('src', 6, 10, 0, 0, 3, red), QC.colorOf('src', 6, 10, 0, 0, 3, QC.SRC_GROUP_COLORS.chishima));
  assert.strictEqual(QC.colorOf('src', 6, 10, 0, 0, Infinity, red), QC.SRC_FAR);
  assert.strictEqual(QC.colorOf('src', 6, 10, 0, 0, 3, null), QC.SRC_FAR);
  assert.deepStrictEqual(QC.styleOf('src', 3, NaN, 0, 0, NaN), { fill: '#ffffff', stroke: '#555555', dash: true });
  // 想定震源域ごとの集計：面から 10km 以内（ちょうど 10km を含む）だけ、いちばん近い海域に。エネルギーの大きい順、回数 0 の海域は出さない
  var ev3 = { mag: [5, 6, 4, 7, 3] }, Dd = [2, 10, 10.1, Infinity, 0], Gg = [0, 0, 0, -1, 2];
  var ss = QC.srcStats(ev3, [0, 1, 2, 3, 4], Dd, Gg, 10);
  assert.deepStrictEqual(ss.map(function (g) { return [g.group, g.n, g.max]; }), [[0, 2, 1], [2, 1, 4]]);
  assert.ok(Math.abs(ss[0].meq - QC.magOfEnergy(QC.energyJ(5) + QC.energyJ(6))) < 1e-9);
  assert.deepStrictEqual(QC.srcStats(ev3, [2, 3], Dd, Gg, 10), []);
  // 広さ：空白でない升（0.05 度四方、東西は cos(緯度)）の合計。海域 a は 35 度の 2 升
  var cell35 = 0.05 * 111.32 * Math.cos(35 * Math.PI / 180) * 0.05 * 110.574;
  assert.ok(Math.abs(QC.srcAreaKm2(data.groups[0]) - 2 * cell35) < 1e-9);
  assert.ok(Math.abs(QC.srcAreaKm2({ grid: { lon0: 0, lat0: 60, step: 0.05, nx: 2, ny: 2, z: [-3, 10], w: [0] } }) - 0.05 * 111.32 * Math.cos(60.05 * Math.PI / 180) * 0.05 * 110.574) < 1e-9);
});
t('震源評価（df）：新しい見出しの CSV を読み、前の版（無し）とつなげる。深さ固定等（3・8・9）は既定で深さ不明に、深さ刻み（2）はそのまま', function () {
  var a = QC.parseMonthCsv('t,lat,lon,dep,mag,maxi,src,q,aux,df\n1923-09-01T11:58:32.0,35.33,139.13,23,7.9,6,C,K,,\n1923-09-01T12:01:00.0,35.2,139.5,0,6.5,,C,K,,3\n');
  var b = QC.parseMonthCsv('t,lat,lon,dep,mag,maxi,src,q,aux\n1923-09-02T00:00:00.0,35,139,10,5.0,,C,K,\n');
  assert.deepStrictEqual([a.n, a.bad.length, Array.from(a.df), b.n, Array.from(b.df)], [2, 0, [0, 3], 1, [0]]);
  var codes = QC.parseMonthCsv('t,lat,lon,dep,mag,maxi,src,q,aux,df\n1930-01-01T00:00:00.0,35,139,20,4.0,,C,K,1,2\n1930-01-02T00:00:00.0,35,139,30,4.0,,C,K,1,M\n1930-01-03T00:00:00.0,35,139,0,4.0,,C,K,1,9\n1930-01-04T00:00:00.0,35,139,0,4.0,,C,K,1,8\n');
  assert.deepStrictEqual(Array.from(codes.df), [2, 10, 9, 8]);
  assert.deepStrictEqual([0, 1, 2, 3, 5, 7, 8, 9, 10].map(QC.depthFixed), [false, false, false, true, false, false, true, true, false]);
  assert.strictEqual(QC.parseMonthCsv('t,lat,lon,dep,mag,maxi,src,q,aux,df\n1923-09-02T00:00:00.0,35,139,10,5.0,,C,K,\n').bad.length, 1);   // 10 列の見出しに 9 列の行
  var ev = QC.concatColumns([a, b]);
  assert.deepStrictEqual(Array.from(ev.df), [0, 3, 0]);
  assert.strictEqual(QC.applyFixedDepth(ev, false), 1);
  assert.ok(ev.dep[0] === 23 && isNaN(ev.dep[1]) && ev.dep[2] === 10);
  QC.applyFixedDepth(ev, true);
  assert.deepStrictEqual(Array.from(ev.dep), [23, 0, 10]);
  QC.applyFixedDepth(ev, false);
  assert.ok(isNaN(ev.dep[1]) && ev.depRaw[1] === 0);       // 何度切り替えても元の深さは残る
});
t('累積の k-means：その時刻までの全部をまとめる。先の地震を使わない・前の節目の中心から続ける・回数が合う', function () {
  var D = QC.DAY, P = [], ms = [], ids = [], ts = [];
  // 0〜9 日に A（x≈0）、10〜19 日に B（x≈500）、20〜29 日に C（x≈1000）。各日 3 回
  for (var d = 0; d < 30; d++) for (var j = 0; j < 3; j++) {
    var x0 = d < 10 ? 0 : d < 20 ? 500 : 1000;
    P.push(x0 + j, 0, 10); ms.push(3 + (d === 25 && j === 0 ? 3 : 0)); ids.push(d * 3 + j); ts.push(d * D + j * 3600e3);
  }
  var job = function (Pa, msa) { return { P: Float64Array.from(Pa), dim: 3, ms: msa, ids: ids, ts: ts, k: 3, t0: 0, t1: 30 * D, nk: 6 }; };
  var res = QC.kmCumSolve(job(P, ms));
  assert.strictEqual(res.frames.length, 6);
  // その時刻までの回数の合計（節目のあいだの時刻も、最初の節目より前も）
  [0.5, 4.9, 5, 12.3, 29.9].forEach(function (day) {
    var T = day * D, want = ts.filter(function (t) { return t <= T; }).length;
    assert.strictEqual(QC.kmCumAt(res, T).reduce(function (a, g) { return a + g.n; }, 0), want, 'day ' + day);
  });
  // 15 日目は A と B だけ（C はまだ起きていない）を 3 つに。29.9 日目には A・B・C の 3 つ、最大は 25 日目の M6
  var at15 = QC.kmCumAt(res, 15 * D).map(function (g) { return g.ev; });
  assert.ok(at15.some(function (e) { return e < 30; }) && at15.some(function (e) { return e >= 30 && e < 60; }) && at15.every(function (e) { return e < 60; }));
  var last = QC.kmCumAt(res, 29.9 * D);
  assert.strictEqual(last.length, 3);
  assert.strictEqual(last[last.length - 1].maxI, 75);
  // 先の地震を使わない：20 日目より後の地震の場所と M を変えても、15 日目の姿は同じ
  var P2 = P.slice(), ms2 = ms.slice();
  for (var q = 60; q < 90; q++) { P2[q * 3] = -3000; ms2[q] = 7; }
  var sig = function (a) { return JSON.stringify(a.map(function (g) { return [g.ev, g.n, g.maxI]; })); };
  assert.strictEqual(sig(QC.kmCumAt(QC.kmCumSolve(job(P2, ms2)), 15 * D)), sig(QC.kmCumAt(res, 15 * D)));
  // 前の節目の中心から続ける：新しい地震が無い節目（30 日より後）では中心が動かない（初めからやり直すと変わりうる）
  var long = QC.kmCumSolve(Object.assign(job(P, ms), { t1: 40 * D, nk: 8 })), F = long.frames;
  assert.deepStrictEqual(Array.from(F[7].C), Array.from(F[5].C));
  assert.strictEqual(F[5].end, 90);
  // 中心を増やすとき、前の中心はそのまま残る
  var C0 = Float64Array.from([0, 0, 10]), Cx = QC.extendCenters(Float64Array.from([0, 0, 10, 500, 0, 10, 1000, 0, 10]), 3, C0, 3, QC.rng(1));
  assert.deepStrictEqual(Array.from(Cx.slice(0, 3)), [0, 0, 10]);
  assert.strictEqual(new Set([Cx[3], Cx[6]]).size, 2);
  assert.ok([500, 1000].indexOf(Cx[3]) >= 0 && [500, 1000].indexOf(Cx[6]) >= 0);
  assert.deepStrictEqual(QC.kmCumAt(res, -1), []);
  // 前の節目の中心から続けていること：0〜4 日に x=0 と x=200、5〜9 日に その間の x=100 が加わる（k=2）。
  // 2 つ目の節目の中心は「1 つ目の中心から始めた k-means」と同じで（約 67・201）、初めからやり直したもの（種 7、約 50・151）とは違う
  var P3 = [], m3 = [], i3 = [], t3 = [];
  for (var dd = 0; dd < 10; dd++) for (var jj = 0; jj < 4; jj++) {
    var xx = dd < 5 ? (jj < 2 ? 0 : 200) : 100;
    P3.push(xx + jj % 2, 0, 10); m3.push(3); i3.push(dd * 4 + jj); t3.push(dd * D + jj * 3600e3);
  }
  var j3 = { P: Float64Array.from(P3), dim: 3, ms: m3, ids: i3, ts: t3, k: 2, t0: 0, t1: 10 * D, nk: 2 }, r3 = QC.kmCumSolve(j3);
  var warm = QC.kmeans(Float64Array.from(P3), 3, 2, { init: r3.frames[0].C, iters: 12 }), cold = QC.kmeans(Float64Array.from(P3), 3, 2, { seed: 7, iters: 30 });
  assert.deepStrictEqual(Array.from(r3.frames[1].C), Array.from(warm));
  assert.notDeepStrictEqual(Array.from(warm), Array.from(cold));
  // 別の計算場所でも同じ（累積）
  var vm2 = require('vm'), fs2 = require('fs'), path2 = require('path'), sent2 = [];
  var cx2 = { postMessage: function (m) { sent2.push(m); }, Float64Array: Float64Array, Int32Array: Int32Array };
  cx2.self = cx2; cx2.importScripts = function (f) { vm2.runInContext(fs2.readFileSync(path2.join(__dirname, '..', 'js', f), 'utf8'), cx2); };
  vm2.createContext(cx2); vm2.runInContext(fs2.readFileSync(path2.join(__dirname, '..', 'js', 'kmworker.js'), 'utf8'), cx2);
  cx2.onmessage({ data: Object.assign({}, j3, { P: Float64Array.from(P3), ms: Float64Array.from(m3), ids: Int32Array.from(i3), ts: Float64Array.from(t3), type: 'cum', seq: 3 }) });
  assert.strictEqual(sent2[0].seq, 3);
  assert.strictEqual(JSON.stringify(QC.kmCumAt(sent2[0], 9.5 * D)), JSON.stringify(QC.kmCumAt(r3, 9.5 * D)));
});
t('k-means の重み（M で重み付け）：中心は重み付きの平均、間引いても重い地震は残る、大きな地震が自分の塊になる', function () {
  // 重み：10^M は M が 1 増えるごとに 10 倍、エネルギーは 10^1.5 倍。重みなしは null
  var wg = QC.kmWeights([2, 3, 4], 'gr'), we = QC.kmWeights([2, 4], 'energy');
  assert.ok(Math.abs(wg[0] - 1) < 1e-12 && Math.abs(wg[1] - 10) < 1e-9 && Math.abs(wg[2] - 100) < 1e-9);
  assert.ok(Math.abs(we[1] / we[0] - 1000) < 1e-6);
  assert.strictEqual(QC.kmWeights([3], 'none'), null);
  // 1 つの塊の中心＝重み付きの平均：x=0（重み 1）と x=10（重み 9）→ 9
  var C = QC.kmeans(Float64Array.from([0, 0, 10, 0]), 2, 1, { w: Float64Array.from([1, 9]) });
  assert.ok(Math.abs(C[0] - 9) < 1e-12);
  // 間引き：重いほうの cap/4 個は必ず残り、重みの合計は変わらない
  var n = 1000, P = new Float64Array(n * 2), w = new Float64Array(n);
  for (var i = 0; i < n; i++) { P[i * 2] = i; w[i] = i === 777 ? 1e6 : 1; }
  var f = QC.sampleFit(P, 2, n, 100, w), sum = 0, has = false;
  for (i = 0; i < f.w.length; i++) { sum += f.w[i]; if (f.P[i * 2] === 777) has = true; }
  assert.ok(has);
  assert.ok(f.w.length <= 100 + 1);
  assert.ok(Math.abs(sum - (1e6 + 999)) < 1e-6);
  // 重みなしの間引きはこれまでどおり（等間隔）
  var f0 = QC.sampleFit(P, 2, n, 100, null);
  assert.deepStrictEqual([f0.w, f0.P.length, f0.P[2]], [null, 200, 10]);
  // 大きな地震に中心が寄る：x=0 付近に M2 が 60 回、x=1000 付近に M2 が 60 回、x=400 に M7 が 1 回（k=2）。
  // M7 は x=0 側の塊に入る。重みなしでは中心は小さな地震の側（x≈9）、エネルギーの重みでは M7 の位置（x≈400）
  var Q = [], ms = [], ids = [], ts = [];
  for (i = 0; i < 60; i++) { Q.push(i % 6, 0, 10); ms.push(2); ids.push(i); ts.push(i); }
  for (i = 0; i < 60; i++) { Q.push(1000 + i % 6, 0, 10); ms.push(2); ids.push(60 + i); ts.push(60 + i); }
  Q.push(400, 0, 10); ms.push(7); ids.push(120); ts.push(120);
  var job = function (mode) { return { P: Float64Array.from(Q), dim: 3, ms: ms, ids: ids, ts: ts, k: 2, K: 2, t0: 0, t1: 200, s: S, wmode: mode }; };
  var cx = function (r) { var g = r.clusters.filter(function (q) { return q.maxI === 120; })[0]; return [g.n, Math.round(g.c[0])]; };
  assert.deepStrictEqual(cx(QC.kmSolve(job('none'))), [61, 9]);
  var e = cx(QC.kmSolve(job('energy')));
  assert.ok(e[0] === 61 && Math.abs(e[1] - 400) <= 1, JSON.stringify(e));
  assert.strictEqual(QC.kmSolve(job('energy')).clusters.filter(function (q) { return q.maxI === 120; })[0].ev, 120);   // マーカーは M7 の位置
});
t('時間の幅で切り出す：開始は含まず、終わり（T）は含む', function () {
  var ev = evOf(['2024-01-01T00:00:00.0,35,135,10,2,,P,,', '2024-01-02T00:00:00.0,35,135,10,2,,P,,',
                 '2024-01-03T00:00:00.0,35,135,10,2,,P,,', '2024-01-04T00:00:00.0,35,135,10,2,,P,,']);
  var f = QC.filterEvents(ev, S, -Infinity, Infinity);
  assert.deepStrictEqual(QC.idxRange(ev, f.idx, QC.parseJst('2024-01-01T00:00:00.0'), QC.parseJst('2024-01-03T00:00:00.0')), [1, 3]);
  assert.deepStrictEqual(QC.idxRange(ev, f.idx, -Infinity, QC.parseJst('2024-01-02T12:00')), [0, 2]);
  assert.deepStrictEqual(QC.idxRange(ev, f.idx, QC.parseJst('2024-01-05T00:00'), Infinity), [4, 4]);
  // 遠く離れた座標（大きな倍率）でも、別の格子を取り違えない
  var g = QC.aggregate([1e7, 1e7 + 5, 1e7 + 60], [3e6, 3e6, 3e6], [3, 3, 3], [0, 1, 2], 50);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(QC.aggregate([5, 5], [5, 500], [3, 3], [0, 1], 50).length, 2);   // 横は同じ格子・縦は別の格子
  // 少しずつ足しても、まとめて数えたのと同じ答え（途中で aggFinish しても、足した値は壊れない）
  var xs = [1, 2, 30, 31, 33], ys = [1, 3, 1, 1, 2], ms = [3, 5, 4, 4, 6], ids = [0, 1, 2, 3, 4], s2 = QC.aggState(20);
  for (var j = 0; j < 3; j++) QC.aggAdd(s2, xs[j], ys[j], ms[j], ids[j]);
  QC.aggFinish(s2);
  for (j = 3; j < 5; j++) QC.aggAdd(s2, xs[j], ys[j], ms[j], ids[j]);
  assert.deepStrictEqual(QC.aggFinish(s2), QC.aggregate(xs, ys, ms, ids, 20));
});
t('まとめ：回数・最大・震度・最多の日・深さ', function () {
  var ev = evOf([
    '2024-01-01T08:00:00.0,35,135,10,3.2,1,P,,',
    '2024-01-01T23:59:59.0,35,135,50,5.0,4,P,,',
    '2024-01-02T00:00:00.0,35,135,150,7.6,7,P,,',      // 日本時間で翌日
    '2024-01-02T01:00:00.0,35,135,,1.5,,P,,',
    '2024-01-02T02:00:00.0,35,135,10,2.0,5-,P,,'       // 震度5弱ちょうど（5弱以上に入り、5強以上には入らない）
  ]);
  var f = QC.filterEvents(ev, S, -Infinity, Infinity), st = QC.computeStats(ev, f.idx, QC.dateToMs('2024-01-01'), QC.dateToMs('2024-01-03'));
  assert.strictEqual(st.n, 5);
  assert.strictEqual(st.days, 2);
  assert.strictEqual(st.byM[3], 3); assert.strictEqual(st.byM[5], 2); assert.strictEqual(st.byM[7], 1); assert.strictEqual(st.byM[1], 5);
  assert.ok(Math.abs(ev.mag[st.max] - 7.6) < 1e-6);   // M は Float32 で持つ
  assert.deepStrictEqual(st.byInt, { 1: 4, 4: 3, 5: 2, 7: 1 });
  assert.deepStrictEqual(st.busiest, { day: '2024-01-02', n: 3 });   // 日本時間で区切る（UTC なら 1/1 が 4 件になる）
  assert.deepStrictEqual(st.depth, { shallow: 2, mid: 1, deep: 1, unknown: 1 });
  assert.ok(Math.abs(st.meq - QC.magOfEnergy(QC.energyJ(3.2) + QC.energyJ(5) + QC.energyJ(7.6) + QC.energyJ(1.5) + QC.energyJ(2))) < 1e-6);
});
t('地図の座標（Web メルカトル）', function () {
  var p = QC.project0(0, 0);
  assert.deepStrictEqual(p, [128, 128]);
  // 期待値は Leaflet 1.9.4 の L.CRS.EPSG3857.latLngToPoint(…, 0) で測ったもの（2026-10-11）
  var q = QC.project0(35, 135), r = QC.project0(45.5, 148.2);
  assert.ok(Math.abs(q[0] - 224) < 1e-9 && Math.abs(q[1] - 101.40104481443532) < 1e-9);
  assert.ok(Math.abs(r[0] - 233.38666666666666) < 1e-9 && Math.abs(r[1] - 91.58456464422082) < 1e-9);
});
t('有名な地震のテロップ：起きる前には出さない・4秒ぶんで消える・震度の書き方・日時は日本時間', function () {
  var hold = QC.telopHold(6 * QC.HOUR, 30);
  assert.strictEqual(hold, 6 * QC.HOUR * 30 * QC.TELOP_SEC);
  assert.strictEqual(QC.telopHold(QC.DAY, 0.1), QC.DAY);                 // 1 コマより短くしない
  var a = { ms: QC.parseJst('1995-01-17T05:46:51.8') }, b = { ms: QC.parseJst('1995-01-18T00:00') }, L = [b, a];
  assert.deepStrictEqual(QC.namedActive(L, a.ms - 1, hold), []);
  assert.deepStrictEqual(QC.namedActive(L, a.ms, hold), [a]);
  assert.deepStrictEqual(QC.namedActive(L, b.ms, hold), [a, b]);           // 古い順
  assert.deepStrictEqual(QC.namedActive(L, a.ms + hold - 1, hold), [a, b]);
  assert.deepStrictEqual(QC.namedActive(L, a.ms + hold, hold), [b]);
  assert.deepStrictEqual(QC.namedInPeriod(L, a.ms, b.ms), [a]);           // 終わりは含まない
  assert.strictEqual(QC.namedInt('7'), '最大震度7');
  assert.strictEqual(QC.namedInt('6'), '最大震度6');                     // 旧い階級はそのまま
  assert.strictEqual(QC.namedInt('6-'), '最大震度6弱');
  assert.strictEqual(QC.namedInt('5+'), '最大震度5強');
  assert.strictEqual(QC.namedInt('F'), '');
  assert.strictEqual(QC.namedInt('?'), '');
  assert.strictEqual(QC.namedInt(''), '');
  var x = QC.namedText({ name: '平成7年(1995年)兵庫県南部地震', alias: '阪神・淡路大震災', note: '', t: '1995-01-17T05:46:51.8', mag: 7.3, maxi: '7', dep: 16.06 });
  assert.strictEqual(x.title, '平成7年(1995年)兵庫県南部地震「阪神・淡路大震災」');
  assert.strictEqual(x.sub, '1995年1月17日 5時46分　M7.3　最大震度7　深さ16km');
  var y = QC.namedText({ name: '1978年宮城県沖地震', alias: '', note: '', t: '1978-06-12T17:14:25.4', mag: 7.4, maxi: 'F', dep: null });
  assert.strictEqual(y.sub, '1978年6月12日 17時14分　M7.4');
});
t('有名な地震の一覧：どれもデータの中の地震そのもの（時刻・震源・M・震度が CSV の行と一致）、出典が付いている', function () {
  var fs = require('fs'), path = require('path'), root = path.join(__dirname, '..');
  var d = JSON.parse(fs.readFileSync(path.join(root, 'data/overlays/named_quakes.json'), 'utf8'));
  assert.ok(d.quakes.length >= 40);
  var prev = -Infinity;
  d.quakes.forEach(function (q) {
    assert.ok(d.sources[q.src], q.name + ' の出典');
    var ms = QC.parseJst(q.t);
    assert.ok(ms > prev, q.name + ' が時刻順');
    prev = ms;
    var csv = fs.readFileSync(path.join(root, 'data/events', q.t.slice(0, 4), q.t.slice(0, 7) + '.csv'), 'utf8');
    var row = csv.split('\n').filter(function (r) { return r.indexOf(q.t + ',') === 0; });
    assert.strictEqual(row.length, 1, q.name + ' の行');
    var c = row[0].split(',');
    assert.deepStrictEqual([+c[1], +c[2], +c[4], c[5]], [q.lat, q.lon, q.mag, q.maxi], q.name);
    assert.strictEqual(c[3] === '' ? null : +c[3], q.dep, q.name + ' の深さ');
  });
});

console.log((n - ng) + ' / ' + n + ' 通過');
process.exit(ng ? 1 : 0);
