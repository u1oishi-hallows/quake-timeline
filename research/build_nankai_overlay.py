"""南海トラフ地震の想定震源域（地震調査研究推進本部の長期評価モデル）を、地図に重ねる図形に加工する。

元のデータ：J-SHIS（防災科学技術研究所）震源断層 API
  https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/ANNKI/fltinfo.geojson?epsg=4326
  177 通りの震源域のパターン（格子点 約5km間隔、深さ付き）と、その起こりやすさの重み。
J-SHIS の利用規約では、データをそのまま複製・形式変換して配布することは禁止、編集・加工した成果物は配布してよい。
そのため元のデータはリポジトリに置かず、ここで作った「加工した図形」だけを data/overlays/ に置く。

作るもの:
  bands   … 各地点が震源域に含まれる割合（パターンの重みの合計）の帯：1%以上・25%以上・50%以上・75%以上
  depth   … プレート境界の深さの等深線：10・20・30km
作り方：格子点の値を 0.02度の格子に線形補間し（格子点から 6km より離れた所は空白）、等値線を引く。

  python3 research/build_nankai_overlay.py <J-SHIS の GeoJSON>    → data/overlays/nankai_source.json
"""
import json
import math
import os
import sys

import numpy as np
from scipy.interpolate import griddata
from scipy.spatial import cKDTree
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'overlays', 'nankai_source.json')
BANDS = [0.01, 0.25, 0.5, 0.75, 1.01]
DEPTHS = [10, 20, 30]


def rings(path):
    """matplotlib の等値線の形 → 輪の並び（[[経度, 緯度], …]）。穴は even-odd で塗る前提"""
    out = []
    for poly in path.to_polygons():
        if len(poly) < 4:
            continue
        out.append([[round(float(x), 3), round(float(y), 3)] for x, y in poly])
    return out


def main(src):
    d = json.load(open(src, encoding='utf-8'))
    fs = d['features']
    tot = sum(float(f['properties']['weight']) for f in fs)
    share, depth = {}, {}
    for f in fs:
        w = float(f['properties']['weight']) / tot
        for p in f['geometry']['coordinates']:
            k = (round(p[0], 4), round(p[1], 4))
            share[k] = share.get(k, 0) + w
            depth[k] = p[2]
    keys = list(share)
    P = np.array(keys)
    S = np.array([share[k] for k in keys])
    Z = np.array([depth[k] for k in keys])
    lon = np.arange(P[:, 0].min() - 0.1, P[:, 0].max() + 0.1, 0.02)
    lat = np.arange(P[:, 1].min() - 0.1, P[:, 1].max() + 0.1, 0.02)
    LO, LA = np.meshgrid(lon, lat)
    # 格子点から 6km より離れた所は空白（凸包で埋めない＝震源域の外を塗らない）
    c = math.cos(math.radians(33.5))
    tree = cKDTree(np.c_[P[:, 0] * 111.32 * c, P[:, 1] * 110.57])
    dist, _ = tree.query(np.c_[LO.ravel() * 111.32 * c, LA.ravel() * 110.57])
    far = (dist > 6.0).reshape(LO.shape)
    GS = griddata(P, S, (LO, LA), method='linear'); GS[far] = np.nan
    GZ = griddata(P, Z, (LO, LA), method='linear'); GZ[far] = np.nan
    out = {
        'about': '南海トラフ地震の想定震源域（地震調査研究推進本部 長期評価のモデル）を加工したもの。固着域の観測値ではない。',
        'source': 'J-SHIS（防災科学技術研究所）震源断層 Y2024 AVR ANNKI を加工',
        'method': '177通りの震源域パターンの重みを格子点ごとに合計し（その地点が震源域に含まれる割合）、0.02度格子に線形補間して等値線を引いた。格子点から6km以上離れた所は空白。',
        'bands': [], 'depth': []}
    fig = plt.figure()
    cf = plt.contourf(LO, LA, GS, levels=BANDS)
    for i, segs in enumerate(cf.get_paths()):
        r = rings(segs)
        if r:
            out['bands'].append({'min': BANDS[i], 'max': min(BANDS[i + 1], 1.0), 'rings': r})
    cs = plt.contour(LO, LA, GZ, levels=DEPTHS)
    for i, segs in enumerate(cs.get_paths()):
        lines = []
        for v in segs.to_polygons(closed_only=False):
            if len(v) >= 2:
                lines.append([[round(float(x), 3), round(float(y), 3)] for x, y in v])
        if lines:
            out['depth'].append({'km': DEPTHS[i], 'lines': lines})
    plt.close(fig)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('bands', [(b['min'], len(b['rings']), sum(len(r) for r in b['rings'])) for b in out['bands']])
    print('depth', [(x['km'], len(x['lines'])) for x in out['depth']])
    print('bytes', os.path.getsize(OUT))


if __name__ == '__main__':
    main(sys.argv[1])
