"""日本中の海溝型地震などの想定震源域（地震調査研究推進本部の長期評価モデル）を、地図・立体表示に重ねる図形に加工する。

元のデータ：J-SHIS（防災科学技術研究所）震源断層 API（Y2024・AVR）
  https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/{符号}/fltinfo.geojson?epsg=4326
  符号の一覧は J-SHIS の断層コード規約（A-RULES.pdf）の表2-2・2-3。今のモデルで使える符号は fltsearch API で確かめた。
  ・点の集まり（MultiPoint）：1 つの地物が 1 つの震源域のパターン（格子点 約5km、点ごとにプレート境界の深さ）。weight＝パターンの重み
    （千島海溝寄りの津波地震 BCHTN だけは weight が無く freq＝どのパターンも同じ）
  ・長方形（Polygon）：断層面の 4 隅（上の辺の深さと下の辺の深さ）。どの長方形も同じ起こりやすさ
J-SHIS の利用規約では、データをそのまま複製・形式変換して配布することは禁止、編集・加工した成果物は配布してよい。
そのため元のデータはリポジトリに置かず、ここで作った「加工した図形」だけを data/overlays/ に置く。

作るもの（海域ごと）:
  codes[].outline … その符号のどれかのパターンに入る範囲の外形（立体用に各点の深さ付き）
  codes[].bands   … 主な符号だけ：その地点が震源域に入る割合（パターンの重みの合計）の帯 1・25・50・75%以上
  depth           … 海域のプレート境界（断層面）の深さの等深線（10km ごと）
  grid            … 距離で色を変えるための深さの格子（0.05度、震源域の外は空白）。z＝いちばん浅い深さ km×10 の整数（負の数 -n は空白が n 個続く）、
                    w＝深さの幅 km×10（空白でない升だけ、順に）。長方形が何通りも重なる所では深さが 1 つに決まらないので幅を持つ
作り方：0.02度の格子で、点の集まりは格子点の値を線形補間（格子点から 6km より離れた所は空白）、長方形はその中かどうかで数え、
深さは長方形の面の上で比例させる。海域の深さは、重なった符号の深さの平均。

  python3 research/build_source_areas.py <元の GeoJSON を置いたフォルダ>    → data/overlays/source_areas.json
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
from matplotlib.path import Path  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'overlays', 'source_areas.json')
STEP = 0.02
GRID_STEP = 0.05
BANDS = [0.01, 0.25, 0.5, 0.75, 1.01]

# 海域（画面で選ぶ単位）と符号。main＝割合の帯を描く符号（その海域でいちばん広い想定）
GROUPS = [
    ('nankai', '南海トラフ', [('ANNKI', True)]),
    ('chishima', '千島海溝', [('ACHSM', True), ('ATKCH', False), ('ANMRO', False), ('BCHTN', False)]),
    ('japan', '日本海溝', [('AJTHK', True), ('AAEIN', False), ('AMYGI', False), ('BJPTN', False)]),
    ('sagami', '相模トラフ', [('ASGMI', True)]),
    ('hyuga', '日向灘', [('BHGNL', True), ('BHGNS', False)]),
    ('yonaguni', '与那国島周辺', [('BYNGN', True)]),
    ('japansea', '日本海東縁部', [('AHKDW', False), ('AHKSW', False), ('AAOMW', False), ('AYMGA', False), ('ANIGT', False),
                               ('BHKNW', False), ('BAKIT', False), ('BSDGN', False)]),
]
# 地図に出す短い名前（長期評価の名前から）
SHORT = {
    'ANNKI': '南海トラフ', 'ACHSM': '千島海溝 超巨大（17世紀型）', 'ATKCH': '十勝沖', 'ANMRO': '根室沖', 'BCHTN': '千島海溝寄り 津波地震等',
    'AJTHK': '日本海溝 超巨大（東北沖型）', 'AAEIN': '青森県東方沖・岩手県沖北部', 'AMYGI': '宮城県沖', 'BJPTN': '日本海溝寄り 津波地震等',
    'ASGMI': '相模トラフ M8級', 'BHGNL': '日向灘 M7.6程度', 'BHGNS': '日向灘 ひとまわり小さい', 'BYNGN': '与那国島周辺',
    'AHKDW': '北海道西方沖', 'AHKSW': '北海道南西沖', 'AAOMW': '青森県西方沖', 'AYMGA': '山形県沖', 'ANIGT': '新潟県北部沖',
    'BHKNW': '北海道北西沖', 'BAKIT': '秋田県沖', 'BSDGN': '佐渡島北方沖',
}


def km_xy(lon, lat, lat0):
    return np.asarray(lon) * 111.32 * math.cos(math.radians(lat0)), np.asarray(lat) * 110.574


def code_raster(d, LO, LA):
    """符号 1 つ → 格子の上の（割合, 深さの平均, いちばん浅い, いちばん深い）。割合はパターンの重みの合計（0〜1）、深さは km（範囲の外は NaN）"""
    fs = d['features']
    lat0 = float(np.mean(LA))
    if fs[0]['geometry']['type'] == 'MultiPoint':
        ws = [float(f['properties'].get('weight') or f['properties'].get('freq')) for f in fs]
        tot = sum(ws)
        share, depth = {}, {}
        for f, w in zip(fs, ws):
            for p in f['geometry']['coordinates']:
                k = (round(p[0], 4), round(p[1], 4))
                share[k] = share.get(k, 0) + w / tot
                depth[k] = p[2]
        keys = list(share)
        P = np.array(keys)
        S = np.array([share[k] for k in keys])
        Z = np.array([depth[k] for k in keys])
        tree = cKDTree(np.c_[km_xy(P[:, 0], P[:, 1], lat0)])
        dist, _ = tree.query(np.c_[km_xy(LO.ravel(), LA.ravel(), lat0)])
        far = (dist > 6.0).reshape(LO.shape)
        GS = griddata(P, S, (LO, LA), method='linear'); GS[far] = np.nan
        GZ = griddata(P, Z, (LO, LA), method='linear'); GZ[far] = np.nan
        return np.nan_to_num(GS, nan=0.0), GZ, GZ, GZ
    # 長方形：中に入る長方形の数の割合、深さは面の上で上の辺から下の辺へ比例
    n = len(fs)
    S = np.zeros(LO.shape)
    Zs = np.zeros(LO.shape)
    Zn = np.zeros(LO.shape)
    Zlo = np.full(LO.shape, np.inf)
    Zhi = np.full(LO.shape, -np.inf)
    X, Y = km_xy(LO, LA, lat0)
    pts = np.c_[LO.ravel(), LA.ravel()]
    for f in fs:
        c = f['geometry']['coordinates'][0][:4]
        inside = Path([(p[0], p[1]) for p in c]).contains_points(pts).reshape(LO.shape)
        x0, y0 = km_xy(c[0][0], c[0][1], lat0)
        x3, y3 = km_xy(c[3][0], c[3][1], lat0)
        vx, vy = x3 - x0, y3 - y0
        v = ((X - x0) * vx + (Y - y0) * vy) / (vx * vx + vy * vy)
        z = c[0][2] + np.clip(v, 0, 1) * (c[3][2] - c[0][2])
        S[inside] += 1.0 / n
        Zs[inside] += z[inside]
        Zn[inside] += 1
        Zlo[inside] = np.minimum(Zlo[inside], z[inside])
        Zhi[inside] = np.maximum(Zhi[inside], z[inside])
    Z = np.where(Zn > 0, Zs / np.maximum(Zn, 1), np.nan)
    # 長方形が何通りも重なる所（与那国島周辺・日本海東縁部など）は、場所ごとの深さが 1 つに決まらない → いちばん浅い〜深いを持つ
    return S, Z, np.where(Zn > 0, Zlo, np.nan), np.where(Zn > 0, Zhi, np.nan)


def simplify(pts, tol):
    """点の並びを間引く（Douglas-Peucker。tol 度より細かい凹凸は省く）"""
    pts = np.asarray(pts, dtype=float)
    if len(pts) < 3:
        return pts
    keep = np.zeros(len(pts), bool); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        p, q = pts[a], pts[b]
        d = q - p
        seg = pts[a + 1:b] - p
        L = math.hypot(*d)
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L if L > 0 else np.hypot(seg[:, 0], seg[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > tol:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return pts[keep]


TOL = 0.006   # 約 0.6km より細かい凹凸は省く（格子 0.02 度より細かい）


def rings_of(paths, closed=True):
    out = []
    for path in paths:
        for poly in (path.to_polygons() if closed else path.to_polygons(closed_only=False)):
            if len(poly) >= (4 if closed else 2):
                poly = simplify(poly, TOL)
                if len(poly) >= (4 if closed else 2):
                    out.append([[round(float(x), 3), round(float(y), 3)] for x, y in poly])
    return out


def rle(z):
    """空白（-1）が続くところを、負の数（-続く数）1 つにまとめる"""
    out, run = [], 0
    for v in z:
        if v < 0:
            run += 1
            continue
        if run:
            out.append(-run); run = 0
        out.append(v)
    if run:
        out.append(-run)
    return out


def depth_at(GZ, lon, lat, l0, b0, tree, valid):
    """格子の深さ（NaN の所はいちばん近い値）"""
    i = int(round((lat - b0) / STEP)); j = int(round((lon - l0) / STEP))
    if 0 <= i < GZ.shape[0] and 0 <= j < GZ.shape[1] and not np.isnan(GZ[i, j]):
        return float(GZ[i, j])
    _, k = tree.query([lon, lat])
    return float(valid[k])


def main(src):
    out = {
        'about': '海溝型地震などの想定震源域（地震調査研究推進本部 長期評価のモデル）を加工したもの。固着域の観測値ではない。',
        'source': 'J-SHIS（防災科学技術研究所）震源断層 Y2024 AVR を加工',
        'method': '点の集まりはパターンの重みを格子点ごとに合計し（その地点が震源域に入る割合）0.02度格子に線形補間（格子点から6km以上離れた所は空白）、'
                  '長方形は中に入る長方形の数の割合。外形・割合の帯・プレート境界の等深線を引いた。海域の深さは重なった符号の平均。',
        'groups': []}
    for gid, gname, codes in GROUPS:
        ds = {c: json.load(open(os.path.join(src, c + '.geojson'), encoding='utf-8')) for c, _ in codes}
        lons, lats = [], []
        for d in ds.values():
            for f in d['features']:
                g = f['geometry']
                pts = g['coordinates'] if g['type'] == 'MultiPoint' else g['coordinates'][0]
                lons += [p[0] for p in pts]; lats += [p[1] for p in pts]
        l0 = math.floor((min(lons) - 0.1) / STEP) * STEP; b0 = math.floor((min(lats) - 0.1) / STEP) * STEP
        lon = l0 + np.arange(int((max(lons) + 0.1 - l0) / STEP) + 2) * STEP
        lat = b0 + np.arange(int((max(lats) + 0.1 - b0) / STEP) + 2) * STEP
        LO, LA = np.meshgrid(lon, lat)
        zsum = np.zeros(LO.shape); zcnt = np.zeros(LO.shape)
        zlo = np.full(LO.shape, np.inf); zhi = np.full(LO.shape, -np.inf)
        rast = {}
        for c, main_ in codes:
            S, Z, Zl, Zh = code_raster(ds[c], LO, LA)
            rast[c] = (S, Z)
            ok = ~np.isnan(Z) & (S > 0)
            zsum[ok] += Z[ok]; zcnt[ok] += 1
            zlo[ok] = np.minimum(zlo[ok], Zl[ok]); zhi[ok] = np.maximum(zhi[ok], Zh[ok])
        GZ = np.where(zcnt > 0, zsum / np.maximum(zcnt, 1), np.nan)
        GLO = np.where(zcnt > 0, zlo, np.nan); GHI = np.where(zcnt > 0, zhi, np.nan)
        GZc = np.where(GHI - GLO <= 5, GZ, np.nan)      # 等深線は、深さが 1 つに決まる所（幅 5km 以内）だけ
        valid_idx = np.argwhere(~np.isnan(GZ))
        vpts = np.c_[lon[valid_idx[:, 1]], lat[valid_idx[:, 0]]]
        vz = GZ[~np.isnan(GZ)]
        tree = cKDTree(vpts)
        group = {'id': gid, 'name': gname, 'codes': [], 'depth': []}
        fig = plt.figure()
        for c, main_ in codes:
            S, Z = rast[c]
            n = len(ds[c]['features'])
            # 外形：どれかのパターンに入る所（点の集まりは割合 0.1% 以上、長方形は 1 つでも入る所）
            lv = 0.001 if ds[c]['features'][0]['geometry']['type'] == 'MultiPoint' else 0.5 / n
            cs = plt.contour(LO, LA, S, levels=[lv])
            outline = []
            for ring in rings_of(cs.get_paths()):
                outline.append([[p[0], p[1], round(depth_at(GZ, p[0], p[1], l0, b0, tree, vz), 1)] for p in ring])
            item = {'code': c, 'name': SHORT[c], 'long': ds[c]['seisact_model'].get('ltename', ''), 'kind': 'rect' if lv != 0.001 else 'points',
                    'patterns': n, 'main': main_, 'outline': outline}
            m = S > 0
            if m.any():
                item['label'] = [round(float(LO[m].mean()), 3), round(float(LA[m].mean()), 3)]
            if main_:
                cf = plt.contourf(LO, LA, S, levels=BANDS)
                item['bands'] = []
                for i, segs in enumerate(cf.get_paths()):
                    r = rings_of([segs])
                    if r:
                        item['bands'].append({'min': BANDS[i], 'max': min(BANDS[i + 1], 1.0), 'rings': r})
            group['codes'].append(item)
        top = int(np.nanmax(GZ) // 10) * 10
        levels = [k for k in range(10, top + 1, 10)]
        if levels:
            cs = plt.contour(LO, LA, GZc, levels=levels)
            for i, segs in enumerate(cs.get_paths()):
                lines = rings_of([segs], closed=False)
                if lines:
                    group['depth'].append({'km': levels[i], 'lines': lines})
        plt.close(fig)
        # 距離で色を変えるための深さの格子（0.05度）。その格子の中心にいちばん近い 0.02 度の格子の値
        gl = np.arange(l0, lon[-1] + 1e-9, GRID_STEP); gb = np.arange(b0, lat[-1] + 1e-9, GRID_STEP)
        z, zw = [], []
        for y in gb:
            i = int(round((y - b0) / STEP))
            for x in gl:
                j = int(round((x - l0) / STEP))
                inn = 0 <= i < GZ.shape[0] and 0 <= j < GZ.shape[1] and not np.isnan(GLO[i, j])
                z.append(int(round(GLO[i, j] * 10)) if inn else -1)
                if inn:
                    zw.append(int(round((GHI[i, j] - GLO[i, j]) * 10)))
        group['grid'] = {'lon0': round(l0, 4), 'lat0': round(b0, 4), 'step': GRID_STEP, 'nx': len(gl), 'ny': len(gb), 'z': rle(z), 'w': zw}
        out['groups'].append(group)
        print(gid, 'codes', [(x['code'], len(x['outline']), len(x.get('bands', []))) for x in group['codes']],
              'depth', [x['km'] for x in group['depth']], 'grid', len(gl), 'x', len(gb), 'cells', sum(1 for v in z if v >= 0),
              'depth range %.1f-%.1f' % (np.nanmin(GZ), np.nanmax(GZ)))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('bytes', os.path.getsize(OUT))


if __name__ == '__main__':
    main(sys.argv[1])
