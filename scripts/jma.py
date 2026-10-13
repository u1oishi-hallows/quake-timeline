"""気象庁の各データを解読する（通信はしない。純粋な関数だけ）。

出どころ（2026-10-11 実測）:
  確定 震源データ  eqev/data/bulletin/data/hypo/hYYYY.zip   96byte固定長
  速報 震源リスト  eqev/data/daily_map/YYYYMMDD.html        <pre> 内の表
  震度データベース eqdb/data/shindo/api/                    POST, JSON
  地震情報の一覧   bosai/quake/data/list.json               直近30日

1 行 = 1 地震を dict で返す:
  t     発生時刻 JST 'YYYY-MM-DDTHH:MM:SS.s'（秒が無いものは 'YYYY-MM-DDTHH:MM'）
  lat   緯度（度） lon 経度（度） dep 深さ km（不明は None）
  mag   M（不明は None） maxi 最大震度コード（下の INTENSITY_CODES、無感は ''、不明は '?'）
  src   C=確定 P=速報 I=震度DBのみ Q=地震情報の一覧
  q     確定版の震源決定フラグ（K k A S s a N F。確定以外は ''）
  aux   確定版の震源補助情報（1 通常 3 人工 4 噴火 5 低周波。確定以外は ''）
"""
import re

INTENSITY_CODES = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7',
                   '5', '6', 'F']  # 5,6 は1996年9月以前の旧階級、F は階級不明の有感

HYPO_MAXI = {'1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7',
             'A': '5-', 'B': '5+', 'C': '6-', 'D': '6+',
             'L': 'F', 'S': 'F', 'M': 'F', 'R': 'F', 'F': 'F', 'X': 'F', ' ': ''}

SHINDO_MAXI = {'震度１': '1', '震度２': '2', '震度３': '3', '震度４': '4',
               '震度５弱': '5-', '震度５強': '5+', '震度６弱': '6-', '震度６強': '6+',
               '震度７': '7', '震度５': '5', '震度６': '6'}

LIST_MAXI = {'1': '1', '2': '2', '3': '3', '4': '4', '5-': '5-', '5+': '5+',
             '6-': '6-', '6+': '6+', '7': '7'}


class FormatError(Exception):
    """書式が想定と違う。黙って読み飛ばさず、呼び出し側で止める。"""


def _fnum(s, dec):
    """Fortran の Fw.d（小数点省略）。空欄は None。
    空白は 0 として読む。深さ固定の ' 50  '（I3,2X）も、小数部が空欄の秒 '01  ' も、これで正しく読める。"""
    if not s.strip():
        return None
    if '.' in s:
        return float(s)
    return float(s.replace(' ', '0')) / (10 ** dec)


def hypo_mag(s):
    """確定版の M 欄（F2.1）。-0.1 は '-1'、-1.0 は 'A0'、-2.0 は 'B0'。"""
    if not s.strip():
        return None
    c = s[0]
    if c in 'ABC':
        return -(('ABC'.index(c) + 1) + int(s[1]) / 10)
    if c == '-':
        return -int(s[1]) / 10
    return int(s.replace(' ', '0')) / 10


class SkipRecord(Exception):
    """読めるが地図に置けない行（理由を数えて捨てる）"""


def parse_hypo_line(L):
    """確定版の 1 行。気象庁以外（U/I）の震源は None を返す（呼び出し側で数える）。
    古い年（1919〜）には次の行がある:
      秒が空欄 … 時刻は分まで。0 秒として入れ、sec_na を付ける（呼び出し側で数える）
      緯度・経度の分が空欄 … 位置が度まで（最大 100km ほどずれる）なので SkipRecord（もっともらしい位置に出さない）
    df：震源評価（60 桁目、震源を決めるときの条件）。1 深さフリー・2 深さ刻み（1926〜1960・1967〜1982年は 10km、1961〜1966年は 20km、
        1983年からは 1km 刻みで最適解）・3 深さ固定等（人の判断）・4 Depth Phase・5 S-P・7 参考・8 決定不能・9 震源固定・M Matched Filter、空白は不明。
        深さの欄が整数（I3,2X）なのは 3・9 だけでなく 2 も（2026-10-13 に気象庁のフォーマットの説明と、年ごとの数で確かめた）"""
    L = L.rstrip('\r\n')
    if len(L) < 96:
        L = L.ljust(96)
    if L[0] != 'J':
        if L[0] in 'UI':
            return None
        raise FormatError('レコード種別が想定外: %r' % L[:20])
    if not L[24:28].strip() or not L[36:40].strip():
        raise SkipRecord('位置が度までしか無い（緯度・経度の分が空欄）')
    sec = _fnum(L[13:17], 2)
    sec_na = sec is None
    if sec_na:
        sec = 0.0
    lat = _deg(L[21:24], _fnum(L[24:28], 2))
    lon = _deg(L[32:36], _fnum(L[36:40], 2))
    dep = _fnum(L[44:49], 2)      # F5.2 深さフリー／I3,2X 深さ固定（小数部が空欄）の両方
    maxi = HYPO_MAXI.get(L[61])
    if maxi is None:
        raise FormatError('最大震度の欄が想定外: %r' % L[61])
    r = {
        't': '%s-%s-%sT%s:%s:%04.1f' % (L[1:5], L[5:7], L[7:9], L[9:11], L[11:13], _round1(sec)),
        'lat': lat, 'lon': lon, 'dep': dep, 'mag': hypo_mag(L[52:54]),
        'maxi': maxi, 'src': 'C', 'q': L[95].strip(), 'aux': L[60].strip(),
        'df': L[59].strip(),
    }
    if sec_na:
        r['sec_na'] = True
    return r


def _deg(d, m):
    """度と分。南緯・西経（度の欄が負）は分も引く。"""
    d = d.strip()
    m = m or 0.0
    return -(abs(int(d)) + m / 60) if d.startswith('-') else int(d) + m / 60


def _round1(x):
    # 59.96 秒を 60.0 にしない（切り捨てで 0.1 秒に揃える）
    return int(x * 10 + 1e-6) / 10


_DAILY_ROW = re.compile(
    r"^(\d{4})\s+(\d+)\s+(\d+)\s+(\d+):(\d+)\s+(\d+\.\d)\s+"
    r"(\d+)°\s*(\d+\.\d)'N\s+(\d+)°\s*(\d+\.\d)'E\s+(-?\d+)\s+(-?\d+\.\d|-)\s+(.*)$")


def parse_daily_html(html, day):
    """速報 震源リストの 1 日分。day='YYYY-MM-DD'。
    表の行らしいのに読めない行があれば FormatError（黙って捨てない）。"""
    m = re.search(r'<pre>(.*?)</pre>', html, re.S)
    if not m:
        raise FormatError('<pre> が無い')
    body = m.group(1)
    if '深さ' not in body or '震央地名' not in body:
        raise FormatError('見出し行が無い')
    out = []
    for L in body.splitlines():
        if not re.match(r'^\d{4}\s', L):
            continue
        r = _DAILY_ROW.match(L.rstrip())
        if not r:
            raise FormatError('読めない行: %r' % L)
        y, mo, d, h, mi, s, la, lam, lo, lom, dep, mag, name = r.groups()
        t = '%s-%02d-%02dT%02d:%02d:%04.1f' % (y, int(mo), int(d), int(h), int(mi), float(s))
        if t[:10] != day:
            raise FormatError('別の日の行が混ざっている: %s（期待 %s）' % (t, day))
        out.append({
            't': t, 'lat': int(la) + float(lam) / 60, 'lon': int(lo) + float(lom) / 60,
            'dep': float(dep), 'mag': None if mag == '-' else float(mag),
            'maxi': '', 'src': 'P', 'q': '', 'aux': '', 'name': name.strip(),
        })
    return out


def shindo_time(ot):
    """震度DBの '2024/01/01 16:10:22.5' → '2024-01-01T16:10:22.5'"""
    m = re.match(r'^(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2}\.\d)$', ot)
    if not m:
        raise FormatError('震度DBの時刻が想定外: %r' % ot)
    return '%s-%s-%sT%s:%s:%s' % m.groups()


def shindo_not_yet(msg):
    """震度DBが「まだその日まで集計していない」と答えたか（毎日起きる普通の遅れ。失敗ではない）。
    実例（2026-10-11）：'現時点の震度データベースには 2026-10-09 より後のデータはありません　検索終了日時の設定を見直してください'"""
    return bool(re.search(r'\d{4}-\d{2}-\d{2} より後のデータはありません', msg or ''))


def parse_shindo_result(obj):
    """震度DBの応答。(行のリスト, 上限を超えたか) を返す。"""
    res = obj.get('res')
    if not isinstance(res, list):
        raise FormatError('震度DBが一覧を返さない: %r' % (res,))
    over = any('上限を超え' in s for s in (obj.get('str') or []))
    out = []
    for r in res:
        maxi = SHINDO_MAXI.get(r.get('maxI'))
        if maxi is None:
            raise FormatError('震度DBの震度が想定外: %r' % r.get('maxI'))
        dep = re.match(r'^(\d+) km$', r.get('dep') or '')
        try:
            mag = float(r['mag'])
        except (TypeError, ValueError):
            mag = None
        out.append({
            't': shindo_time(r['ot']), 'lat': float(r['lat']), 'lon': float(r['lon']),
            'dep': float(dep.group(1)) if dep else None, 'mag': mag, 'maxi': maxi,
            'src': 'I', 'q': '', 'aux': '', 'name': r.get('name') or '',
        })
    return out, over


def join_intensity(rows, shindo_rows, tol_deg=0.01):
    """速報の行に震度を付ける。発生時刻（0.1秒）が完全一致し、座標も一致するものだけ。
    合わないものは捨てずに返す（呼び出し側が src='I' の行として足し、件数を記録する）。
    1 つの震度DBの行が 2 つの速報行に付くことはない。"""
    by_t = {}
    for r in rows:
        by_t.setdefault(r['t'], []).append(r)
    unmatched = []
    for s in shindo_rows:
        hit = [r for r in by_t.get(s['t'], [])
               if abs(r['lat'] - s['lat']) <= tol_deg and abs(r['lon'] - s['lon']) <= tol_deg
               and r['maxi'] == '']
        if len(hit) == 1:
            hit[0]['maxi'] = s['maxi']
        else:  # 0 件、または同時刻同地点に 2 件以上（どちらか決められない）
            unmatched.append(s)
    return unmatched


_COD = re.compile(r'^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?/$')


LIST_TTL_HYPO = ('震源・震度情報', '震源に関する情報')


def parse_list_json(items):
    """地震情報の一覧。同じ地震（eid）の最後の発表で、国内の震源を含むものだけ。
    遠地地震は速報の震源リストに入らないので、ここでも入れない（日によって扱いが変わらないように）。
    (行のリスト, 捨てた件数 {理由: 件数}) を返す。"""
    latest, other = {}, {}
    for it in items:
        eid = it.get('eid')
        if not eid or it.get('ttl') not in LIST_TTL_HYPO:
            other.setdefault(eid or it.get('ttl'), it.get('ttl'))
            continue
        if eid not in latest or (it.get('rdt') or '') >= (latest[eid].get('rdt') or ''):
            latest[eid] = it
    out, dropped = [], {}
    for k, ttl in other.items():
        if k in latest:
            continue
        why = '震源の発表がまだ無い（震度速報のみ）' if ttl == '震度速報' else '地震の震源ではない情報（%s）' % ttl
        dropped[why] = dropped.get(why, 0) + 1
    for eid, it in latest.items():
        m = _COD.match(it.get('cod') or '')
        if not m:
            dropped['震源の座標が無い（震度速報のみ等）'] = dropped.get('震源の座標が無い（震度速報のみ等）', 0) + 1
            continue
        at = re.match(r'^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):00\+09:00$', it.get('at') or '')
        if not at:
            raise FormatError('一覧の発生時刻が想定外: %r' % it.get('at'))
        try:
            mag = float(it.get('mag'))
        except (TypeError, ValueError):
            mag = None
        maxi = it.get('maxi') or ''
        out.append({
            't': '%sT%s' % at.groups(), 'lat': float(m.group(1)), 'lon': float(m.group(2)),
            'dep': (-int(m.group(3)) / 1000) if m.group(3) else None, 'mag': mag,
            'maxi': LIST_MAXI.get(maxi, '?' if maxi else ''),
            'src': 'Q', 'q': '', 'aux': '', 'name': it.get('anm') or '',
        })
    return out, dropped
