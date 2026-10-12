"""build_source_areas.py の出来を元のデータと突き合わせる（元のデータのフォルダを渡す）。
  外形：元の点（長方形は面の内側の 9 点）のうち外形の内側にある割合
  深さ：元の点の深さが、加工した 0.05 度の深さの格子（いちばん近い升）の深さの幅からはみ出した分
  python3 research/check_source_areas.py <元の GeoJSON を置いたフォルダ>
"""
import json
import os
import sys

import numpy as np
from matplotlib.path import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def unrle(z):
    out = []
    for v in z:
        out += [-1] * (-v) if v < 0 else [v]
    return np.array(out)


def main(src):
    d = json.load(open(os.path.join(ROOT, 'data', 'overlays', 'source_areas.json'), encoding='utf-8'))
    for g in d['groups']:
        gr = g['grid']; zr = unrle(gr['z']); W = np.zeros(len(zr)); W[zr >= 0] = gr['w']
        Z = zr.reshape(gr['ny'], gr['nx']) / 10.0; Wd = W.reshape(gr['ny'], gr['nx']) / 10.0
        for c in g['codes']:
            raw = json.load(open(os.path.join(src, c['code'] + '.geojson'), encoding='utf-8'))
            pts = []
            for f in raw['features']:
                geo = f['geometry']
                if geo['type'] == 'MultiPoint':
                    pts += geo['coordinates']
                else:
                    # 長方形：4 隅は外形の線の上にあるので使わず、面の内側の 9 点（上の辺からの割合 0.25・0.5・0.75 × 走向方向 0.25・0.5・0.75）
                    q = np.array(geo['coordinates'][0][:4], float)
                    for u in (0.25, 0.5, 0.75):
                        top = q[0] + u * (q[1] - q[0]); bot = q[3] + u * (q[2] - q[3])
                        for v in (0.25, 0.5, 0.75):
                            pts.append(list(top + v * (bot - top)))
            P = np.array(pts)
            inside = np.zeros(len(P), bool)
            for ring in c['outline']:
                inside ^= Path([(p[0], p[1]) for p in ring]).contains_points(P[:, :2], radius=1e-9)   # 穴は even-odd
            j = np.clip(np.round((P[:, 0] - gr['lon0']) / gr['step']).astype(int), 0, gr['nx'] - 1)
            i = np.clip(np.round((P[:, 1] - gr['lat0']) / gr['step']).astype(int), 0, gr['ny'] - 1)
            zz = Z[i, j]; ww = Wd[i, j]; ok = zz >= 0
            # 深さの幅（いちばん浅い〜深い）の外にはみ出した分
            err = np.maximum(0, np.maximum(zz[ok] - P[ok, 2], P[ok, 2] - (zz[ok] + ww[ok])))
            print('%-9s %-6s 点%6d  外形の内側 %5.1f%%  はみ出し 中央値 %.1fkm・95%% %.1fkm（格子に値がある点 %5.1f%%）' % (
                g['id'], c['code'], len(P), 100 * inside.mean(), np.median(err), np.percentile(err, 95), 100 * ok.mean()))


if __name__ == '__main__':
    main(sys.argv[1])
