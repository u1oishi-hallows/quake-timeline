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
                              poorQuality: 2, artificial: 1, lowFreq: 1, depth: 1 });
  var f2 = QC.filterEvents(ev, Object.assign({}, S, { lowFreq: true, reference: true }), -Infinity, Infinity);
  assert.strictEqual(f2.idx.length, 4);
  assert.strictEqual(f2.why.poorQuality, 1);    // N は常に除く
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
t('地図の座標（Web メルカトル）', function () {
  var p = QC.project0(0, 0);
  assert.deepStrictEqual(p, [128, 128]);
  // 期待値は Leaflet 1.9.4 の L.CRS.EPSG3857.latLngToPoint(…, 0) で測ったもの（2026-10-11）
  var q = QC.project0(35, 135), r = QC.project0(45.5, 148.2);
  assert.ok(Math.abs(q[0] - 224) < 1e-9 && Math.abs(q[1] - 101.40104481443532) < 1e-9);
  assert.ok(Math.abs(r[0] - 233.38666666666666) < 1e-9 && Math.abs(r[1] - 91.58456464422082) < 1e-9);
});

console.log((n - ng) + ' / ' + n + ' 通過');
process.exit(ng ? 1 : 0);
