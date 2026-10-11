"""球の表示（推定の揺れの範囲）を、観測点の震度と突き合わせる。

モデル（文献の式。点震源として震源距離を使う）:
  log10 PGV600 = 0.58 Mw + 0.0038 D + d − 1.29 − log10(X + 0.0028·10^(0.5 Mw)) − 0.002 X   司・翠川(1999)
  PGV地表 = A × PGV600（A：地盤の増幅。既定 1.31＝S波速度 400m/s 相当）
  計測震度 I = 2.68 + 1.72 log10 PGV地表                                               翠川ほか(1999)
  X：震源距離 km、D：深さ km、Mw は気象庁 M をそのまま使う、d：地殻内 0（既定）
  震度 k 以上 ⇔ I ≥ 境目（震度3: 2.5、4: 3.5、5弱: 4.5、5強: 5.0、6弱: 5.5）
  球の半径 R_k：I(X) = 境目 となる X。地表の円の半径 r_k = √(R_k² − D²)（R_k ≤ D なら円は出ない）

観測：震度データベースの観測点ごとの震度（揺れを感じた観測点だけが返る）と位置。
指標（地震ごと・k ごと）:
  拾えた割合  … 震度 k 以上だった観測点のうち、円の内側にあった割合
  当たった割合 … 円の内側の観測点のうち、震度 k 以上だった割合（無感の観測点は返らないので甘めに出る）
  観測の広がり … 震度 k 以上の観測点の震央距離（中央値・90%）

  python3 research/sphere_check.py        → research/sphere_check.json と標準出力の表
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'scripts'))
import fetch  # noqa: E402
from store import Store  # noqa: E402

KCLASS = {'3': 2.5, '4': 3.5, '5-': 4.5}
SHINDO_RANK = {'震度１': 1, '震度２': 2, '震度３': 3, '震度４': 4, '震度５弱': 5, '震度５強': 6,
               '震度６弱': 7, '震度６強': 8, '震度７': 9, '震度５': 5, '震度６': 7}
K_RANK = {'3': 3, '4': 4, '5-': 5}

NAMED = [  # (日本時間, 呼び名)
    ('2011-03-11T14:46', '東北地方太平洋沖 M9.0'),
    ('2015-05-30T20:23', '小笠原諸島西方沖 M8.1 深さ682km'),
    ('2016-04-16T01:25', '熊本 M7.3'),
    ('2018-06-18T07:58', '大阪府北部 M6.1'),
    ('2018-09-06T03:07', '北海道胆振東部 M6.7'),
    ('2021-02-13T23:07', '福島県沖 M7.3 深さ55km'),
    ('2022-03-16T23:36', '福島県沖 M7.4 深さ57km'),
    ('2023-05-05T14:42', '珠洲 M6.5'),
    ('2024-01-01T16:10', '能登半島 M7.6'),
    ('2024-08-08T16:42', '日向灘 M7.1'),
]


def pgv600(mw, d_km, x_km, dtype=0.0):
    return 10 ** (0.58 * mw + 0.0038 * d_km + dtype - 1.29
                  - math.log10(x_km + 0.0028 * 10 ** (0.5 * mw)) - 0.002 * x_km)


def intensity(mw, d_km, x_km, amp=1.31, dtype=0.0):
    return 2.68 + 1.72 * math.log10(amp * pgv600(mw, d_km, x_km, dtype))


def sphere_radius(mw, d_km, ithr, amp=1.31, dtype=0.0):
    """I(X) = ithr となる震源距離 X（km）。X を d_km から伸ばして探す。届かなければ 0。"""
    lo = max(d_km, 0.1)
    if intensity(mw, d_km, lo, amp, dtype) < ithr:
        return 0.0
    hi = lo
    while intensity(mw, d_km, hi, amp, dtype) >= ithr:
        hi *= 2
        if hi > 5000:
            return hi
    for _ in range(60):
        mid = (lo + hi) / 2
        if intensity(mw, d_km, mid, amp, dtype) >= ithr:
            lo = mid
        else:
            hi = mid
    return lo


def surface_radius(R, d_km):
    return math.sqrt(R * R - d_km * d_km) if R > d_km else 0.0


def km(a, b, c, d):
    p = math.radians
    return 6371 * 2 * math.asin(math.sqrt(math.sin(p(c - a) / 2) ** 2 +
                                          math.cos(p(a)) * math.cos(p(c)) * math.sin(p(d - b) / 2) ** 2))


def shindo_event(ot):
    """発生時刻（日本時間、秒まで）から震度DBの1地震分を取る。id は秒までの時刻（2026-10-11 実測）。"""
    eid = ot[:19].replace('-', '').replace('T', '').replace(':', '')
    body, ctype = fetch._multipart([('mode', 'event'), ('id', eid)])
    st, raw, _ = fetch.http(fetch.URL_SHINDO, data=body, headers={'Content-Type': ctype})
    obj = json.loads(raw.decode('utf-8'))
    if not isinstance(obj.get('res'), dict):
        return None
    return obj['res']


def pick_events(store):
    """取り込み済みのデータから対象を選ぶ"""
    named, pool = [], []
    for ym in sorted(store.manifest['months']):
        for day, rows in store._load_month(ym).items():
            for r in rows:
                if r[4] == '' or r[5] in ('', '?'):
                    continue
                m = float(r[4])
                for t, label in NAMED:
                    if r[0].startswith(t) and m >= 6:
                        named.append((r, label))
                if 4.0 <= m <= 6.0 and r[5] in ('3', '4', '5-', '5+', '6-', '6+', '7'):
                    pool.append(r)
    random.seed(20261011)
    sample = random.sample(pool, min(120, len(pool)))
    return named, sample


def evaluate(r, label, res, amp=1.31):
    hyp = res['hyp'][0]
    la, lo = float(hyp['lat']), float(hyp['lon'])
    mw, dep = float(r[4]), float(r[3] or 0)
    sts = [(SHINDO_RANK.get(s['int'], 0), km(la, lo, float(s['lat']), float(s['lon'])))
           for s in res['int'] if s.get('lat') and s.get('lon')]
    out = {'t': r[0], 'label': label, 'M': mw, 'depth': dep, 'maxi': r[5], 'stations': len(sts), 'k': {}}
    for k, ithr in KCLASS.items():
        R = sphere_radius(mw, dep, ithr, amp)
        rs = surface_radius(R, dep)
        hit = [x for rk, x in sts if rk >= K_RANK[k]]
        inside = [rk for rk, x in sts if x <= rs]
        if not hit and rs == 0:
            continue
        hs = sorted(hit)
        out['k'][k] = {
            'R': round(R, 1), 'r_surface': round(rs, 1), 'observed': len(hit),
            'recall': round(sum(x <= rs for x in hit) / len(hit), 3) if hit else None,
            'precision': round(sum(rk >= K_RANK[k] for rk in inside) / len(inside), 3) if inside else None,
            'obs_median_km': round(hs[len(hs) // 2], 1) if hs else None,
            'obs_p90_km': round(hs[int(len(hs) * 0.9) - 1 if len(hs) >= 10 else -1], 1) if hs else None,
        }
    return out


def main():
    store = Store(os.path.join(HERE, '..'))
    named, sample = pick_events(store)
    print('代表 %d 件、無作為 %d 件' % (len(named), len(sample)), file=sys.stderr)
    results, missing = [], []
    for r, label in named + [(x, '') for x in sample]:
        try:
            res = shindo_event(r[0])
        except Exception as e:
            missing.append((r[0], str(e)))
            continue
        if not res:
            missing.append((r[0], '震度DBに見つからない'))
            continue
        ev = evaluate(r, label, res)
        ev['hyp'] = [float(res['hyp'][0]['lat']), float(res['hyp'][0]['lon'])]
        ev['raw_int'] = [(s['int'], s['lat'], s['lon']) for s in res['int']]
        results.append(ev)
    with open(os.path.join(HERE, 'sphere_check.json'), 'w', encoding='utf-8') as f:
        json.dump({'results': results, 'missing': missing}, f, ensure_ascii=False, indent=1)
    print('取れなかった %d 件' % len(missing), file=sys.stderr)


if __name__ == '__main__':
    main()
