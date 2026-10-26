"""破壊試験：実装を 1 か所ずつ壊した写しで検査を動かし、毎回落ちることを確かめる。
落ちなかった壊し方があれば、その検査は空振りしている。
.py を壊したら Python の検査、.js を壊したら Node の検査を動かす。
Node の検査は端末をニューヨーク時間にして動かす（日本時間の端末では、時刻の壊れ方が見えないことがある）。

  python3 tests/mutate.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (ファイル, 壊す前, 壊した後, 何を壊したか)
MUTANTS = [
    ('scripts/jma.py', "/ (10 ** dec)", "/ (10 ** (dec - 1))", '小数点省略の桁'),
    ('scripts/jma.py', "return -(('ABC'.index(c) + 1) + int(s[1]) / 10)", "return -(('ABC'.index(c)) + int(s[1]) / 10)", '負のM（A0型）'),
    ('scripts/jma.py', "return -int(s[1]) / 10", "return int(s[1]) / 10", '負のM（-1型）'),
    ('scripts/jma.py', "return float(s.replace(' ', '0')) / (10 ** dec)", "return float(s.replace(' ', '')) / (10 ** dec)", '空白の扱い（深さ固定 50km）'),
    ('scripts/jma.py', "'A': '5-', 'B': '5+', 'C': '6-', 'D': '6+',", "'A': '5-', 'B': '5+', 'C': '6-', 'D': '6-',", '確定版の震度コード'),
    ('scripts/jma.py', "return -(abs(int(d)) + m / 60) if d.startswith('-') else int(d) + m / 60", "return int(d) + m / 60", '南緯・西経'),
    ('scripts/jma.py', "            raise FormatError('読めない行: %r' % L)", "            continue", '読めない行を黙って捨てる'),
    ('scripts/jma.py', "        if t[:10] != day:\n            raise", "        if False:\n            raise", '別の日の行'),
    ('scripts/jma.py', "if '深さ' not in body or '震央地名' not in body:", "if False:", '見出しの確認'),
    ('scripts/jma.py', "if abs(r['lat'] - s['lat']) <= tol_deg and abs(r['lon'] - s['lon']) <= tol_deg\n", "if True\n", '突き合わせで座標を見ない'),
    ('scripts/jma.py', "        by_t.setdefault(r['t'], []).append(r)", "        by_t.setdefault(r['t'][:16], []).append(r)", '突き合わせを分単位にゆるめる（鍵）'),
    ('scripts/jma.py', "for r in by_t.get(s['t'], [])", "for r in rows if r['t'][:16] == s['t'][:16]", '突き合わせを分単位にゆるめる（引く側も）'),
    ('scripts/jma.py', "        if len(hit) == 1:", "        if hit:", '同時刻同地点が複数でも付ける'),
    ('scripts/jma.py', "return bool(re.search(", "return True or bool(re.search(", '震度DBのほかの誤りを「未集計」とみなす'),
    ('scripts/jma.py', "over = any('上限を超え' in s for s in (obj.get('str') or []))", "over = False", '震度DBの上限超えを見落とす'),
    ('scripts/jma.py', "(it.get('rdt') or '') >= (latest[eid].get('rdt') or '')", "(it.get('rdt') or '') < (latest[eid].get('rdt') or '')", '一覧で古い発表を使う'),
    ('scripts/jma.py', "        dropped[why] = dropped.get(why, 0) + 1", "        pass", '一覧で捨てた件数を数えない'),
    ('scripts/jma.py', "if not eid or it.get('ttl') not in LIST_TTL_HYPO:", "if not eid:", '遠地地震を入れてしまう'),
    ('scripts/store.py', "        if cur > rank:\n            return False", "        if False:\n            return False", '確かな出どころを上書きする'),
    ('scripts/store.py', "            self.manifest['revisions'].append({", "            ({", '書き換わりを記録しない'),
    ('scripts/store.py', "            if x[0][:10] != day:", "            if False:", '別の日の行を保存する'),
    # ---- いつ取得するか（scripts/schedule.py）
    ('scripts/schedule.py', "due = now - last_full >= dt.timedelta(hours=p['every_hours']) - slack", "due = now - last_full >= dt.timedelta(hours=p['every_hours']) + slack", '取得の間隔の余裕が逆'),
    ('scripts/schedule.py', "        if last_full < p['event'] <= now:", "        if False:", '検知した直後に取らない'),
    ('scripts/schedule.py', "t -= dt.timedelta(days=(t.weekday() - weekly['weekday']) % 7)", "t -= dt.timedelta(days=(t.weekday() - weekly['weekday']) % 6)", '週1回の曜日'),
    ('scripts/schedule.py', "            start = end", "            pass", '6弱の後の1日1回を発生から数える'),
    ('scripts/schedule.py', "if RANK.get(maxi, 0) >= RANK[r['min_intensity']]", "if RANK.get(maxi, 0) > RANK[r['min_intensity']]", '震度の境目（5弱ちょうど）'),
    ('scripts/schedule.py', "p = min(active, key=lambda x: x['every_hours'])", "p = max(active, key=lambda x: x['every_hours'])", '強い揺れの間隔を優先しない'),
    ('scripts/schedule.py', "        return True, '手で動かした'", "        pass", '手で動かしても取らない'),
    # ---- 画面の計算（js/core.js）
    ('js/core.js', "return Date.UTC(+m[1], mo - 1, d, h, mi, 0) + Math.round(sec * 1000) - JST;", "return Date.UTC(+m[1], mo - 1, d, h, mi, 0) + Math.round(sec * 1000);", '読み取りで日本時間の差を引かない'),
    ('js/core.js', "var d = new Date(ms + JST);", "var d = new Date(ms);", '表示で日本時間の差を足さない'),
    ('js/core.js', "h: d.getUTCHours(), mi:", "h: new Date(ms).getHours(), mi:", '端末のタイムゾーンで時を出す'),
    ('js/core.js', "function floorDayJst(ms) { return Math.floor((ms + JST) / DAY) * DAY - JST; }", "function floorDayJst(ms) { return Math.floor(ms / DAY) * DAY; }", '日の区切りを UTC にする'),
    ('js/core.js', "if (stepMs < DAY) s += ", "if (stepMs <= DAY) s += ", '刻み1日で時刻も出す'),
    ('js/core.js', "bad.push(i + 1); continue;", "continue;", 'CSV の読めない行を数えない'),
    ('js/core.js', "!(c[5] in MAXI) || ", "", '想定外の震度コードを通す'),
    ('js/core.js', "if (o.t[k] < o.t[k - 1]) throw", "if (false) throw", '時刻順を確かめない'),
    ('js/core.js', "if (isNaN(m)) { why.magUnknown++; continue; }", "if (isNaN(m)) { continue; }", 'M 不明を数えない'),
    ('js/core.js', "if (m < s.magMin) {", "if (m <= s.magMin) {", 'M 下限の境目'),
    ('js/core.js', "if (ev.q[i] === 'N' || ", "if (", '震源固定（N）を描く'),
    ('js/core.js', "if (mx < 0 && mx !== -2) { why.intUnknown++; continue; }", "", '震度不明を下限で落とさない'),
    ('js/core.js', "if (age < 0) break;", "if (age < -1e15) break;", '未来の地震を描く'),
    ('js/core.js', "if (age <= life[k]) out.push(k);", "if (age <= 2 * life[k]) out.push(k);", '残る時間を過ぎても描く'),
    ('js/core.js', "return ev.mag[idx[b]] - ev.mag[idx[a]];", "return ev.mag[idx[a]] - ev.mag[idx[b]];", '小さい順に描く（大きい円が上に来る）'),
    ('js/core.js', "Math.min(d, s.lifeMax)", "d", '残る時間の上限'),
    ('js/core.js', "if (v >= list[i].lo) c = list[i].c;", "if (v > list[i].lo) c = list[i].c;", '色の境目'),
    ('js/core.js', "var fill = s.fillAlpha * (m >= 8 ? 0.18 : m >= 6 ? 0.25 : m >= 5 ? 0.35 : m >= 4 ? 0.5 : m >= 3 ? 0.7 : 1);", "var fill = s.fillAlpha;", '大きい円の中を薄くしない'),
    ('js/core.js', "var d0 = floorDayJst(t0), nd", "var d0 = Math.floor(t0 / DAY) * DAY, nd", '1日の回数を UTC で区切る'),
    ('js/core.js', "256 * (0.5 - Math.log(", "256 * (0.5 + Math.log(", '地図の座標の向き'),
    ('js/core.js', "    { lo: 9, c: '#111111', label: 'M9以上' }];", "    ];", 'M9 の色が無い'),
    ('js/core.js', "return surfaceRadiusKm(sphereRadiusKm(mw, depKm, INT_THRESHOLDS[lv], amp), depKm);", "return sphereRadiusKm(mw, depKm, INT_THRESHOLDS[lv], amp);", '同心円：深さを効かせない'),
    ('js/core.js', "'5-': 5, '5+': 6, '6-': 7", "'5-': 6, '5+': 6, '6-': 7", '震度コードの取り違え（同心円の輪の色・CSV）'),
    ('js/core.js', "var near = s.viewH / (s.viewH + Math.max(dep, 0) * s.vol);", "var near = s.viewH / (s.viewH + Math.max(dep, 0));", '奥行き：3Dの効きが効かない'),
    ('js/core.js', "Math.max(s.hazeMin, Math.pow(near, s.dHaze))", "Math.pow(near, s.dHaze)", '奥行き：かすみの下限が無い'),
    ('js/core.js', "if (s.keepBig && mag >= s.keepBigM) { o.blur = 0; o.alpha = 1; }", "", '奥行き：深い大地震が消える'),
    ('js/core.js', "if (!(s.vol > 0) || isNaN(dep)) return", "if (!(s.vol > 0)) return", '奥行き：深さ不明を扱えない'),
    ('js/core.js', "return [vw / 2 + x * c - y * s, vh / 2 + x * s + y * c];", "return [vw / 2 + x * c + y * s, vh / 2 - x * s + y * c];", '回転の向きが逆'),
    ('js/core.js', "return [dx * c + dy * s, -dx * s + dy * c];", "return [dx, dy];", 'ドラッグを逆回転しない'),
    ('js/core.js', "function screenXAzimuth(deg) { return (((90 - deg) % 360) + 360) % 360; }", "function screenXAzimuth(deg) { return (((90 + deg) % 360) + 360) % 360; }", '断面図の方位が逆'),
    ('js/core.js', "function energyJ(m) { return Math.pow(10, 1.5 * m + 4.8); }", "function energyJ(m) { return Math.pow(10, 1.0 * m + 4.8); }", 'エネルギーの式の係数'),
    ('js/core.js', "g.sx += x; g.sy += y; g.n++; g.E += energyJ(m);", "g.sx += x; g.sy += y; g.n++; g.E += m;", '集計で M をそのまま足す'),
    ('js/core.js', "if (m > g.maxM) { g.maxM = m; g.maxI = id; }", "if (m > g.maxM) { g.maxM = m; }", '集計で最大の地震を覚えない'),
    ('js/core.js', "var dk = formatDate(ev.t[i]);", "var dk = new Date(ev.t[i]).toISOString().slice(0, 10);", 'まとめの日付を UTC で区切る'),
    ('js/core.js', "if (mx >= 5) s.byInt[5]++;", "if (mx >= 6) s.byInt[5]++;", 'まとめの震度5弱以上'),
    ('js/core.js', "if (ev.t[idx[m]] <= tLo) lo = m + 1; else hi = m; }", "if (ev.t[idx[m]] < tLo) lo = m + 1; else hi = m; }", '時間の幅：開始を含めてしまう'),
    ('js/core.js', "if (ev.t[idx[m]] <= tHi) lo = m + 1; else hi = m; }", "if (ev.t[idx[m]] < tHi) lo = m + 1; else hi = m; }", '時間の幅：T ちょうどを落とす'),
    ('js/core.js', "+ (Math.floor(y / s.cell) + 1e7), g = s.map.get(key);", "+ 0 * y, g = s.map.get(key);", '集計で縦の格子を見ない'),
    ('js/core.js', "if (T > last) { alpha = 1 - (T - last) / life; if (alpha <= 0) return null; }", "if (T > last + life) return null;", 'k-means 再生：最後の地震から薄くならない'),
    ('js/core.js', "while (lo < hi) { var m = (lo + hi) >> 1; if (g.times[m] <= T) lo = m + 1; else hi = m; }\n    if (!lo) return null;", "while (lo < hi) { var m = (lo + hi) >> 1; if (g.times[m] < T) lo = m + 1; else hi = m; }\n    if (!lo) return null;", 'k-means 再生：その時刻ちょうどの地震を入れない'),
    ('js/core.js', "if (job.dim === 4 && (active < 0.85 * k || active > 1.15 * k)", "if (job.dim === 4 && (active < 0.85 * k)", 'k-means 再生：多すぎるときにまとめ直さない'),
    ('js/core.js', "K = Math.min(KM_MAX, Math.max(k, Math.round(K * k / Math.max(active, 1))));", "K = Math.min(KM_MAX, Math.max(k, K + 1));", 'k-means 再生：外れた割合で塊の数を変えない'),
    ('js/core.js', "g.times[a] = ts[pt]; g.cumE[a] = E; g.bestAt[a] = bi; g.maxAt[a] = mxi;", "g.times[a] = ts[pt]; g.cumE[a] = E; g.bestAt[a] = ids[pt]; g.maxAt[a] = mxi;", 'k-means 再生：マーカーを中心に近い地震に置かない'),
    ('js/core.js', "P[q * dim + 2] = Math.max(ev.dep[i], 0) * depthW;", "P[q * dim + 2] = ev.dep[i] * depthW;", 'k-means の座標：地表より上（負の深さ）を 0 にしない'),
    ('js/core.js', "var cellKm = Math.sqrt(areaKm2 / k), spanKm", "var cellKm = Math.sqrt(areaKm2), spanKm", 'k-means 再生：初めの塊の数で塊 1 つ分の広さを使わない'),
    ('js/core.js', "var ez = dep < C[i + 2] ? C[i + 2] - dep : dep > C[i + 3] ? dep - C[i + 3] : 0,", "var ez = dep < C[i + 2] ? C[i + 2] - dep : dep > C[i + 2] ? dep - C[i + 2] : 0,", '想定震源域の距離：深さの幅を見ない'),
    ('js/core.js', "if (r >= 2 && (r - 1) * binKm > best) break;", "if (r >= 1) break;", '想定震源域の距離：隣の箱より外を探さない'),
    ('js/core.js', "if (ids && ids.length && ids.indexOf(g.id) < 0) return;", "if (false) return;", '想定震源域の距離：選んだ海域に絞らない'),
    ('js/core.js', "        if (v < 0) { n -= v; continue; }", "        if (v < 0) { n += 1; continue; }", '想定震源域の格子：続く空白を 1 つと数える'),
    ('js/core.js', "      if (v < 0) { n -= v; continue; }\n      var lat", "      if (v < 0) { n += 1; continue; }\n      var lat", '想定震源域の広さ：続く空白を 1 つと数える'),
    ('js/core.js', "return best <= SRC_MAX_KM ? best : Infinity;", "return best;", '想定震源域の距離：遠すぎるのを分けない'),
    ('js/core.js', "if (!(D[i] <= nearKm) || G[i] < 0) continue;", "if (!(D[i] < nearKm) || G[i] < 0) continue;", '想定震源域ごとの集計：ちょうどの距離を入れない'),
    ('js/core.js', "if (g.max < 0 || ev.mag[i] > ev.mag[g.max]) g.max = i;", "if (g.max < 0) g.max = i;", '想定震源域ごとの集計：最大の地震を選ばない'),
    ('js/core.js', "return 0.9 * Math.min(1, Math.log(d / 5) / Math.log(16));", "return 0.9 * Math.min(1, (d - 5) / 75);", '想定震源域の鮮やかさ：距離の倍ごとでなく一様に落とす'),
    ('js/core.js', "A += gr.step * 111.32 * Math.cos(lat * Math.PI / 180) * gr.step * 110.574;", "A += gr.step * 111.32 * gr.step * 110.574;", '想定震源域の広さ：東西の縮み cos(緯度) を掛けない'),
    ('scripts/jma.py', "    if not L[24:28].strip() or not L[36:40].strip():", "    if not L[24:28].strip() and not L[36:40].strip():", '古い年：経度だけが度までの行を捨てない'),
    ('scripts/jma.py', "'df': L[59].strip(),", "'df': L[60].strip(),", '震源評価の桁を間違える'),
    ('scripts/jma.py', "    if sec_na:\n        r['sec_na'] = True", "    if False:\n        r['sec_na'] = True", '古い年：秒が不明の印を付けない'),
    ('scripts/fetch.py', "    for a, b in ((1919, 1950), (1951, 1960), (1961, 1966), (1967, 1982)):", "    for a, b in ((1919, 1950), (1951, 1960), (1961, 1967), (1968, 1982)):", '確定版のまとめたファイルの境目を間違える'),
    ('scripts/store.py', "                        if head == COLS_V1:\n                            line = line + ['']", "                        if False:\n                            line = line + ['']", '前の版の見出しの行に df を足さない'),
    ('scripts/store.py', "        if cur == rank and old and _digest([r[:9] for r in old]) != _digest([r[:9] for r in new]):", "        if cur == rank and old and _digest(old) != _digest(new):", 'df だけが増えた取り直しを書き換わりとして記録する'),
    ('js/core.js', "      if (depthFixed(ev.df[i])) { n++; ev.dep[i] = use ? ev.depRaw[i] : NaN; }", "      if (depthFixed(ev.df[i])) { n++; ev.dep[i] = ev.depRaw[i]; }", '深さ固定を不明にしない'),
    ('js/core.js', "return code === 3 || code === 8 || code === 9;", "return code === 3 || code === 2;", '深さ刻み（2）を深さ固定と取り違える'),
    ('js/core.js', "(c[9] === 'M' ? 10 : +c[9] || 0)", "(+c[9] || 0)", 'Matched Filter（M）の印を読まない'),
    ('js/core.js', "    var ncol = lines[0] === H2 ? 10 : 9;", "    var ncol = 10;", 'df の無い前の版の CSV を読めない'),
    ('js/core.js', "      var T = job.t0 + (job.t1 - job.t0) * (f + 1) / nk, m = lowerBoundT(ts, T, n);", "      var T = job.t0 + (job.t1 - job.t0) * (f + 1) / nk, m = n;", 'k-means 累積：節目より先の地震も使う'),
    ('js/core.js', "      var C = kmeans(SP, D, kk, init ? { init: init, iters: 12, w: fit.w } : { seed: 7, iters: 30, w: fit.w });", "      var C = kmeans(SP, D, kk, { seed: 7, iters: 30, w: fit.w });", 'k-means 累積：前の節目の中心から続けない'),
    ('js/core.js', "      for (var i = b.end; i < end; i++) {       // 節目のあとに起きた地震", "      for (var i = b.end; i < b.end; i++) {       // 節目のあとに起きた地震", 'k-means 累積：節目のあとの地震を足さない'),
    ('js/core.js', "    for (var f = 0; f < F.length; f++) { if (F[f].t <= T) j = f; else break; }", "    for (var f = 0; f < F.length; f++) { j = f; if (F[f].t > T) break; }", 'k-means 累積：その時刻より後の節目を使う'),
    ('js/core.js', "for (i = 0; i < n; i++) { var wi = w ? w[i] : 1; cnt[assign[i]] += wi;", "for (i = 0; i < n; i++) { var wi = 1; cnt[assign[i]] += wi;", 'k-means の重み：中心を重み付きの平均にしない'),
    ('js/core.js', "    for (q = 0; q < Math.min(h, n); q++) { keep[order[q]] = 1; pick.push(order[q]); ww.push(w[order[q]]); }", "    for (q = 0; q < 0; q++) { keep[order[q]] = 1; pick.push(order[q]); ww.push(w[order[q]]); }", 'k-means の重み：間引くとき重い地震を残さない'),
    ('js/core.js', "    var scale = sampW > 0 ? restW / sampW : 1;", "    var scale = 1;", 'k-means の重み：間引いた分の重みを増やさない'),
    ('js/core.js', "    var a = mode === 'gr' ? 1 : 1.5, w = new Float64Array(ms.length);", "    var a = 1, w = new Float64Array(ms.length);", 'k-means の重み：エネルギーの重みを 10^M にしてしまう'),
    ('js/kmworker.js', "self.postMessage({ seq: job.seq, clusters", "self.postMessage({ seq: 0, clusters", '別の計算場所：答えに番号を付けない'),
    ('js/core.js', "if (cnt[c] > 0) for (j = 0; j < D; j++) C[c * D + j] = sum2[c * D + j] / cnt[c];", "if (cnt[c] > 0) for (j = 0; j < 1; j++) C[c * D + j] = sum2[c * D + j] / cnt[c];", 'k-means：中心の 2 次元目以降を動かさない'),
    ('js/core.js', "if (bd < q.bd) { q.bd = bd; q.mi = i; }", "if (q.mi < 0) { q.mi = i; }", 'k-means：マーカーを中心に近い地震に置かない'),
    ('js/core.js', "u -= w ? w[i] * d2[i] : d2[i]; if (u <= 0) { pick = i; break; }", "u -= w ? w[i] * d2[i] : d2[i]; if (u <= 0) { pick = 0; break; }", 'k-means++ の選び方'),
    ('js/core.js', "u -= (w ? w[i] : 1) * (d2[i] === Infinity ? 1 : d2[i]); if (u <= 0) { pick = i; break; }", "u -= (w ? w[i] : 1) * (d2[i] === Infinity ? 1 : d2[i]); if (u <= 0) { pick = 0; break; }", 'k-means 累積：中心を増やすとき遠い点を選ばない'),
    ('js/core.js', "if (opt.init && opt.init.length === k * D) C.set(opt.init);", "if (false) {}", 'k-means：前の中心から続けない'),
    ('js/core.js', "for (var j = 0; j < D; j++) { var e = P[i * D + j] - C[c * D + j]; d += e * e; }", "for (var j = 0; j < 2; j++) { var e = P[i * D + j] - C[c * D + j]; d += e * e; }", 'k-means：深さ・時間を距離に入れない'),
    ('js/core.js', "s.aggMin * Math.pow(s.aggRatio, meq - s.aggBase)", "s.aggMin + (meq - s.aggBase) * s.aggRatio", 'マーカーの大きさを倍でなく足し算に'),
    ('js/core.js', "return Math.round(10 * Math.pow(10, (L - 1) / 9));", "return Math.round(10 * Math.pow(10, (L - 1) / 10));", 'マーカーの数の段階の倍率'),
    ('js/core.js', "if (ev.src[i] !== 0) { why.lfeUnknown++; continue; }", "", '低周波だけ：速報を区別できないのに描く'),
    ('js/core.js', "if (ev.aux[i] !== 5) { why.notLfe++; continue; }", "if (ev.aux[i] !== 5) { continue; }", '低周波だけ：除いた数を数えない'),
    ('js/core.js', "return r5 * Math.pow(growth, mw - 5);", "return r5 * Math.pow(growth, mw - 4);", '図式の球の大きさ'),
    ('js/core.js', "- 0.002 * xKm;", "- 0.0002 * xKm;", '球：減衰式の係数'),
    ('js/core.js', "return 2.68 + 1.72 * (lp + log10(amp));", "return 2.68 + 1.72 * lp;", '球：地盤の増幅を無視'),
    ('js/core.js', "if (!(estIntensity(mw, depKm, lo, amp, dtype) >= ithr)) return 0;", "", '球：届かない地震にも球を出す'),
    ('js/core.js', "function surfaceRadiusKm(R, depKm) { return R > depKm ? Math.sqrt(R * R - depKm * depKm) : 0; }", "function surfaceRadiusKm(R, depKm) { return R; }", '球：地表の円に深さを効かせない'),
    ('js/core.js', "/ (40075.016686 * Math.cos(lat * Math.PI / 180))", "/ 40075.016686", '球：緯度による縮尺'),
    ('js/core.js', "Math.min(r, 400)", "Math.min(r, 60)", '大きさの頭打ち（M8・M9 が同じ大きさ）'),
    ('js/core.js', "return mx >= 0 && mx <= 9 ? INT_STYLES[mx] : INT_UNKNOWN;", "return mx >= 0 && mx <= 9 ? INT_STYLES[mx] : INT_STYLES[0];", '震度不明を無感として描く'),
    ('js/core.js', "{ v: 9, fill: '#b40068'", "{ v: 9, fill: '#a50021'", '震度7と6強が同じ色'),
    ('js/core.js', "if (mode === 'maxi') { var s = intensityStyle(maxi); return { fill: s.fill, stroke: s.stroke, dash: !!s.dash }; }", "", '最大震度の切り替えが効かない'),
    ('js/core.js', "return d >= 0 && d < hold;", "return d >= -hold && d < hold;", 'テロップが起きる前から出る'),
    ('js/core.js', "return d >= 0 && d < hold;", "return d >= 0 && d <= hold;", 'テロップが消える境目'),
    ('js/core.js', "return Math.max(step, step * fps * TELOP_SEC);", "return step * fps * TELOP_SEC;", 'テロップが1コマより短い'),
    ('js/core.js', "if (/^[1-7]$/.test(maxi)) return '最大震度' + maxi;", "if (/^[1-7F]$/.test(maxi)) return '最大震度' + maxi;", '階級不明を震度と書く'),
    ('js/core.js', "(maxi[1] === '-' ? '弱' : '強')", "(maxi[1] === '+' ? '弱' : '強')", '弱・強の取り違え'),
    ('js/core.js', "return list.filter(function (q) { return q.ms >= t0 && q.ms < t1; });", "return list.filter(function (q) { return q.ms >= t0 && q.ms <= t1; });", '期間の終わりを含む'),
    ('js/core.js', "+m[1] + '年' + +m[2] + '月' + +m[3] + '日 '", "+m[1] + '年' + +m[3] + '月' + +m[2] + '日 '", 'テロップの月と日の取り違え'),
]


def run_tests(root, path='x.py'):
    if path.endswith('.js'):
        env = dict(os.environ, TZ='America/New_York')
        p = subprocess.run(['node', 'tests/core.test.js'], cwd=root, capture_output=True, text=True, env=env)
    else:
        p = subprocess.run([sys.executable, '-m', 'unittest', 'tests.test_jma', 'tests.test_schedule'], cwd=root,
                           capture_output=True, text=True)
    return p.returncode == 0


def main():
    tmp = tempfile.mkdtemp()
    work = os.path.join(tmp, 'w')
    shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns('.git', 'data', 'node_modules'))
    os.symlink(os.path.join(ROOT, 'data'), os.path.join(work, 'data'))   # データは写さず読むだけ（有名な地震の一覧と CSV の突き合わせに使う）
    if not run_tests(work) or not run_tests(work, 'x.js'):
        print('壊す前の検査がすでに落ちている')
        return 1
    survived = 0
    for path, old, new, what in MUTANTS:
        f = os.path.join(work, path)
        src = open(f, encoding='utf-8').read()
        if src.count(old) != 1:
            print('?  壊す場所が見つからない（%d 箇所）: %s' % (src.count(old), what))
            survived += 1
            continue
        open(f, 'w', encoding='utf-8').write(src.replace(old, new))
        ok = run_tests(work, path)
        open(f, 'w', encoding='utf-8').write(src)
        print('%s  %s' % ('✗ 検査が通ってしまった' if ok else '✓ 落ちた', what))
        survived += ok
    shutil.rmtree(tmp)
    print('%d 通り中 %d 通りで検査が落ちた' % (len(MUTANTS), len(MUTANTS) - survived))
    return 1 if survived else 0


if __name__ == '__main__':
    sys.exit(main())
