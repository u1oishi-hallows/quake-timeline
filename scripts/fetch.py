"""気象庁から取得して data/ に溜める。

  python3 scripts/fetch.py catalog 2020 2023     確定版（年ごと）。範囲で指定
  python3 scripts/fetch.py daily 2024-01-01 2024-01-31   速報 震源リスト＋震度DB
  python3 scripts/fetch.py recent                地震情報の一覧（直近、速報がまだ無い日だけ）
  python3 scripts/fetch.py update                定期実行用：recent ＋ 直近 refetch_days 日の daily

1 日分の取得に失敗しても全体は止めない。失敗は manifest の errors に残し、終了コードで知らせる。
"""
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jma  # noqa: E402
from store import Store, JST, now_jst  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))

HOST_DATA = 'https://www.data.jma.go.jp'
URL_HYPO_ZIP = HOST_DATA + '/eqev/data/bulletin/data/hypo/h%s.zip'
URL_DAILY = HOST_DATA + '/eqev/data/daily_map/%s.html'
URL_SHINDO = HOST_DATA + '/eqdb/data/shindo/api/'
URL_LIST = 'https://www.jma.go.jp/bosai/quake/data/list.json'

_last = [0.0]


def _polite():
    wait = CFG['request_interval_sec'] - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()


def http(url, data=None, headers=None, tries=3):
    """(status, bytes, headers)。404 はそのまま返す。それ以外の失敗は数回やり直して例外。"""
    h = {'User-Agent': CFG['user_agent']}
    h.update(headers or {})
    err = None
    for i in range(tries):
        _polite()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=60) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, b'', dict(e.headers)
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        time.sleep(3 * (i + 1))
    raise RuntimeError('%s: %s' % (url, err))


def _multipart(fields):
    b = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields:
        out.write(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (b, k, v)).encode())
    out.write(('--%s--\r\n' % b).encode())
    return out.getvalue(), 'multipart/form-data; boundary=' + b


class ShindoNotYet(Exception):
    """震度DBがまだその日まで集計していない"""


def shindo_query(d0, t0, d1, t1):
    """震度DBの検索。時刻は分単位で、開始・終了の分を両方含む（2026-10-11 実測）。"""
    fields = [('mode', 'search'), ('dateTimeF[]', d0), ('dateTimeF[]', t0),
              ('dateTimeT[]', d1), ('dateTimeT[]', t1),
              ('mag[]', '0.0'), ('mag[]', '9.9'), ('dep[]', '000'), ('dep[]', '999'),
              ('epi[]', '99'), ('pref[]', '99'), ('city[]', '99'), ('station[]', '99'),
              ('obsInt', '1'), ('maxInt', '1'), ('additionalC', 'false'), ('Sort', 'S0'),
              ('Comp', 'C0'), ('seisCount', 'false'), ('observed', 'false')]
    body, ctype = _multipart(fields)
    st, raw, _ = http(URL_SHINDO, data=body, headers={'Content-Type': ctype})
    if st != 200:
        raise RuntimeError('震度DB HTTP %s' % st)
    obj = json.loads(raw.decode('utf-8'))
    if isinstance(obj.get('res'), str):
        if 'ありませんでした' in ''.join(obj.get('str') or []) or 'ありませんでした' in obj['res']:
            return [], False
        if jma.shindo_not_yet(obj['res']):
            raise ShindoNotYet(obj['res'])
        raise jma.FormatError('震度DB: %s' % obj['res'])
    return jma.parse_shindo_result(obj)


def shindo_day(day):
    """1 日分。1000 件の上限を超えたら時間を割って取り直す（上限で切れたまま使わない）。"""
    def window(m0, m1):  # 0:00 からの分。両端を含む
        rows, over = shindo_query(day, '%02d:%02d' % divmod(m0, 60), day, '%02d:%02d' % divmod(m1, 60))
        if not over:
            return rows
        if m0 == m1:
            raise RuntimeError('%s %02d:%02d の1分間で震度DBの上限を超えた' % ((day,) + divmod(m0, 60)))
        mid = (m0 + m1) // 2
        return window(m0, mid) + window(mid + 1, m1)
    rows = window(0, 24 * 60 - 1)
    seen = set()
    for r in rows:
        k = (r['t'], r['lat'], r['lon'])
        if k in seen:
            raise RuntimeError('%s 震度DBで同じ地震が二重に返った: %s' % (day, r['t']))
        seen.add(k)
    return rows


# ---------------------------------------------------------------- 確定版
def cmd_catalog(store, y0, y1):
    bad = 0
    for y in range(int(y0), int(y1) + 1):
        try:
            st, raw, hd = http(URL_HYPO_ZIP % y)
            if st != 200:
                raise RuntimeError('HTTP %s' % st)
            zf = zipfile.ZipFile(io.BytesIO(raw))
            byday, other = {}, 0
            for name in zf.namelist():
                for L in zf.read(name).decode('latin-1').splitlines():
                    if not L.strip():
                        continue
                    r = jma.parse_hypo_line(L)
                    if r is None:
                        other += 1
                        continue
                    if r['t'][:4] != str(y):
                        raise jma.FormatError('%s 年のファイルに %s が混ざっている' % (y, r['t']))
                    byday.setdefault(r['t'][:10], []).append(r)
            n = 0
            d = dt.date(y, 1, 1)
            while d.year == y:   # 地震の無い日も「確定で 0 件」として入れる
                day = d.isoformat()
                rows = byday.get(day, [])
                store.put_day(day, rows, 4, {'src': 'C'})
                n += len(rows)
                d += dt.timedelta(days=1)
            store.manifest['years'][str(y)] = {
                'src': 'C', 'rows': n, 'zip_last_modified': hd.get('Last-Modified', ''),
                'dropped': {'気象庁以外の機関が決めた震源（U/I）': other}, 'fetched': now_jst()}
            print('catalog %s: %d 件（気象庁以外 %d 件は除外）' % (y, n, other))
        except Exception as e:  # 1 年分の失敗で全体を止めない
            bad += 1
            store.error('catalog %s' % y, e)
            print('catalog %s: 失敗 %s' % (y, e), file=sys.stderr)
        store.save()
    return bad


# ---------------------------------------------------------------- 速報
def fetch_daily(store, day):
    """1 日分。戻り値 'ok' / 'notyet' / 'skip'。失敗は例外。"""
    if store.day_rank(day) > 3:
        return 'skip'   # 確定版がある日は速報で上書きしない
    st, raw, _ = http(URL_DAILY % day.replace('-', ''))
    if st == 404:
        return 'notyet'
    if st != 200:
        raise RuntimeError('震源リスト HTTP %s' % st)
    rows = jma.parse_daily_html(raw.decode('utf-8'), day)
    info = {'src': 'P'}
    try:
        sh = shindo_day(day)
        unmatched = jma.join_intensity(rows, sh)
        for s in unmatched:
            rows.append(s)
        info.update(intensity='ok', felt=len(sh), felt_joined=len(sh) - len(unmatched),
                    felt_only_in_shindo=len(unmatched))
    except ShindoNotYet:
        # 震度DBの集計がまだ（毎日の普通の遅れ）。震度は「不明」にし、次の取得で埋める
        for r in rows:
            r['maxi'] = '?'
        info.update(intensity='pending')
    except Exception as e:
        # 震度が取れなかった日は「無感」ではなく「不明」にする
        for r in rows:
            r['maxi'] = '?'
        info.update(intensity='failed')
        store.error('shindo %s' % day, e)
    store.put_day(day, rows, 3, info)
    return 'ok'


def cmd_daily(store, d0, d1):
    a, b = dt.date.fromisoformat(d0), dt.date.fromisoformat(d1)
    bad, d, k = 0, a, 0
    while d <= b:
        day = d.isoformat()
        try:
            res = fetch_daily(store, day)
            info = store.manifest['days'].get(day, {})
            print('daily %s: %s %s' % (day, res, {x: info.get(x) for x in ('rows', 'felt', 'felt_only_in_shindo', 'intensity')} if res == 'ok' else ''))
        except Exception as e:
            bad += 1
            store.error('daily %s' % day, e)
            print('daily %s: 失敗 %s' % (day, e), file=sys.stderr)
        k += 1
        if k % 20 == 0:
            store.save()
        d += dt.timedelta(days=1)
    store.save()
    return bad


# ---------------------------------------------------------------- 直近
def cmd_recent(store):
    try:
        st, raw, _ = http(URL_LIST)
        if st != 200:
            raise RuntimeError('一覧 HTTP %s' % st)
        rows, dropped = jma.parse_list_json(json.loads(raw.decode('utf-8')))
    except Exception as e:
        store.error('recent', e)
        print('recent: 失敗 %s' % e, file=sys.stderr)
        store.save()
        return 1
    byday = {}
    for r in rows:
        byday.setdefault(r['t'][:10], []).append(r)
    put = 0
    for day, rs in byday.items():
        if store.day_rank(day) <= 1:
            store.put_day(day, rs, 1, {'src': 'Q'})
            put += 1
    store.manifest['recent'] = {'fetched': now_jst(), 'rows': len(rows), 'days_put': put, 'dropped': dropped}
    print('recent: %d 件、速報がまだ無い %d 日に入れた。除外 %s' % (len(rows), put, dropped))
    store.save()
    return 0


def cmd_update(store):
    bad = cmd_recent(store)
    today = dt.datetime.now(JST).date()
    d0 = (today - dt.timedelta(days=CFG['refetch_days'])).isoformat()
    # 前回以降に取りこぼした日も埋める（Actions が止まっていた日など）
    p_days = [d for d, v in store.manifest['days'].items() if v.get('src') == 'P']
    if p_days and p_days[-1] < d0:
        d0 = (dt.date.fromisoformat(p_days[-1]) + dt.timedelta(days=1)).isoformat()
    bad += cmd_daily(store, d0, (today - dt.timedelta(days=1)).isoformat())
    return bad


def main(argv):
    store = Store(ROOT)
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'catalog':
        bad = cmd_catalog(store, argv[2], argv[3] if len(argv) > 3 else argv[2])
    elif cmd == 'daily':
        bad = cmd_daily(store, argv[2], argv[3] if len(argv) > 3 else argv[2])
    elif cmd == 'recent':
        bad = cmd_recent(store)
    elif cmd == 'update':
        bad = cmd_update(store)
    else:
        print(__doc__)
        return 2
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
