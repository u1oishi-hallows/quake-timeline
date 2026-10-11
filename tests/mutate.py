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
]


def run_tests(root, path='x.py'):
    if path.endswith('.js'):
        env = dict(os.environ, TZ='America/New_York')
        p = subprocess.run(['node', 'tests/core.test.js'], cwd=root, capture_output=True, text=True, env=env)
    else:
        p = subprocess.run([sys.executable, '-m', 'unittest', 'tests.test_jma'], cwd=root,
                           capture_output=True, text=True)
    return p.returncode == 0


def main():
    tmp = tempfile.mkdtemp()
    work = os.path.join(tmp, 'w')
    shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns('.git', 'data', 'node_modules'))
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
