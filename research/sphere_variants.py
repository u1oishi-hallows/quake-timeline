"""sphere_check.json（観測点の震度）を使い、地盤の増幅 amp とプレート内補正 d を変えて当たり具合を比べる。
通信はしない。

  python3 research/sphere_variants.py
"""
import json
import os
import statistics as S
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sphere_check import sphere_radius, surface_radius, km, SHINDO_RANK, KCLASS, K_RANK  # noqa: E402


def score(ev, k, amp, dtype):
    la, lo = ev['hyp']
    R = sphere_radius(ev['M'], ev['depth'], KCLASS[k], amp, dtype)
    rs = surface_radius(R, ev['depth'])
    tp = fn = fp = 0
    for s, a, b in ev['raw_int']:
        rk = SHINDO_RANK.get(s, 0)
        inside = km(la, lo, float(a), float(b)) <= rs
        if rk >= K_RANK[k]:
            tp += inside
            fn += not inside
        elif inside:
            fp += 1
    if tp + fn == 0:
        return None
    rec = tp / (tp + fn)
    pre = tp / (tp + fp) if tp + fp else 0.0
    f1 = 2 * rec * pre / (rec + pre) if rec + pre else 0.0
    return rec, pre, f1


def main():
    d = json.load(open(os.path.join(HERE, 'sphere_check.json'), encoding='utf-8'))
    evs = [e for e in d['results'] if e.get('raw_int') and e.get('hyp')]
    groups = {'代表10': [e for e in evs if e['label']], '無作為': [e for e in evs if not e['label']]}
    variants = [(amp, dt) for dt in ('0', 'deep') for amp in (1.0, 1.31, 1.6, 2.0, 2.5, 3.0)]
    print('d：0 は全部 0、deep は深さ 40km 以上を 0.12（プレート内とみなす）')
    for name, g in groups.items():
        print('\n== %s（%d 地震）  F値の中央値（拾えた割合 / 当たった割合） ==' % (name, len(g)))
        for k in ('3', '4'):
            line = []
            for amp, dt in variants:
                rs = [score(e, k, amp, 0.12 if (dt == 'deep' and e['depth'] >= 40) else 0.0) for e in g]
                rs = [x for x in rs if x]
                if not rs:
                    continue
                line.append('amp%.2f d%s: %.2f (%.2f/%.2f)' % (amp, dt, S.median(x[2] for x in rs),
                                                           S.median(x[0] for x in rs), S.median(x[1] for x in rs)))
            print('震度%s以上 n=%d' % (k, len(rs)))
            for L in line:
                print('   ' + L)


if __name__ == '__main__':
    main()
