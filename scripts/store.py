"""月ごとの CSV と manifest.json の読み書き。

data/events/YYYY/YYYY-MM.csv  1 行 = 1 地震。時刻は日本時間（+09:00）。
data/manifest.json            月ごとの件数、日ごとの出どころ、捨てた件数と理由、書き換わりの記録。

日ごとに「いちばん確かな出どころ」の行だけを持つ。
  C 確定(4) > P 速報(3、震度DBのみの I 行を含む) > Q 地震情報の一覧(1)
同じかより確かな出どころで取り直したときだけ、その日の行を丸ごと入れ替える。
"""
import csv
import datetime as dt
import hashlib
import io
import json
import os

COLS = ['t', 'lat', 'lon', 'dep', 'mag', 'maxi', 'src', 'q', 'aux']
RANK = {'C': 4, 'P': 3, 'I': 3, 'Q': 1}
JST = dt.timezone(dt.timedelta(hours=9))


def now_jst():
    return dt.datetime.now(JST).isoformat(timespec='seconds')


def _num(x, nd):
    if x is None:
        return ''
    s = ('%.' + str(nd) + 'f') % x
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return '0' if s == '-0' else s


def row_to_csv(r):
    return [r['t'], _num(r['lat'], 4), _num(r['lon'], 4), _num(r['dep'], 2),
            '' if r['mag'] is None else '%.1f' % r['mag'], r['maxi'], r['src'], r['q'], r['aux']]


class Store:
    def __init__(self, root):
        self.root = root
        self.data = os.path.join(root, 'data')
        self.mpath = os.path.join(self.data, 'manifest.json')
        if os.path.exists(self.mpath):
            with open(self.mpath, encoding='utf-8') as f:
                self.manifest = json.load(f)
        else:
            self.manifest = {
                'about': '気象庁の震源カタログを日ごとに溜めたもの。時刻は日本時間。',
                'timezone': '+09:00', 'columns': COLS,
                'src': {'C': '気象庁 震源データ（確定、地震月報カタログ編）',
                        'P': '気象庁 震源リスト（速報、暫定値）',
                        'I': '気象庁 震度データベース（速報の震源リストに無い有感地震）',
                        'Q': '気象庁 地震情報（発表直後、座標0.1度・時刻は分まで）'},
                'months': {}, 'days': {}, 'years': {}, 'revisions': [], 'errors': [],
            }
        self._months = {}

    # ---- 月ファイル ----
    def _mfile(self, ym):
        return os.path.join(self.data, 'events', ym[:4], ym + '.csv')

    def _load_month(self, ym):
        if ym not in self._months:
            rows = {}
            p = self._mfile(ym)
            if os.path.exists(p):
                with open(p, encoding='utf-8', newline='') as f:
                    rd = csv.reader(f)
                    head = next(rd)
                    if head != COLS:
                        raise ValueError('%s の見出しが想定外: %r' % (p, head))
                    for line in rd:
                        rows.setdefault(line[0][:10], []).append(line)
            self._months[ym] = rows
        return self._months[ym]

    def day_rank(self, day):
        rows = self._load_month(day[:7]).get(day, [])
        return max((RANK[r[6]] for r in rows), default=0)

    def day_rows(self, day):
        return list(self._load_month(day[:7]).get(day, []))

    def put_day(self, day, rows, rank, info):
        """その日の行を入れ替える。より確かな出どころが既にあれば何もしない（False）。"""
        cur = self.day_rank(day)
        if cur > rank:
            return False
        new = sorted((row_to_csv(r) for r in rows), key=lambda x: x[0])
        for x in new:
            if x[0][:10] != day:
                raise ValueError('%s の行に別の日 %s が混ざっている' % (day, x[0]))
        old = self._load_month(day[:7]).get(day, [])
        if cur == rank and old and _digest(old) != _digest(new):
            # 同じ出どころで中身が変わった（速報の書き換え）。黙って上書きせず記録する。
            self.manifest['revisions'].append({
                'day': day, 'at': now_jst(), 'src': new[0][6] if new else '',
                'before': len(old), 'after': len(new),
                'changed': _diff_count(old, new)})
        self._load_month(day[:7])[day] = new
        info = dict(info, rows=len(new), fetched=now_jst())
        self.manifest['days'][day] = info
        return True

    def save(self):
        for ym, days in self._months.items():
            rows = [r for d in sorted(days) for r in days[d]]
            p = self._mfile(ym)
            if not rows:
                if os.path.exists(p):
                    os.remove(p)
                self.manifest['months'].pop(ym, None)
                continue
            os.makedirs(os.path.dirname(p), exist_ok=True)
            buf = io.StringIO()
            w = csv.writer(buf, lineterminator='\n')
            w.writerow(COLS)
            w.writerows(rows)
            text = buf.getvalue()
            if not os.path.exists(p) or open(p, encoding='utf-8').read() != text:
                with open(p, 'w', encoding='utf-8', newline='') as f:
                    f.write(text)
            cnt = {}
            for r in rows:
                cnt[r[6]] = cnt.get(r[6], 0) + 1
            self.manifest['months'][ym] = {
                'file': 'events/%s/%s.csv' % (ym[:4], ym), 'rows': len(rows),
                'bytes': len(text.encode('utf-8')), 'src': cnt,
                'first': rows[0][0], 'last': rows[-1][0]}
        self.manifest['months'] = dict(sorted(self.manifest['months'].items()))
        self.manifest['days'] = dict(sorted(self.manifest['days'].items()))
        self.manifest['revisions'] = self.manifest['revisions'][-500:]
        self.manifest['errors'] = self.manifest['errors'][-200:]
        self.manifest['updated'] = now_jst()
        os.makedirs(self.data, exist_ok=True)
        with open(self.mpath, 'w', encoding='utf-8') as f:
            json.dump(self.manifest, f, ensure_ascii=False, indent=1)
            f.write('\n')

    def error(self, what, msg):
        self.manifest['errors'].append({'at': now_jst(), 'what': what, 'msg': str(msg)[:500]})


def _digest(rows):
    return hashlib.sha1('\n'.join(','.join(r) for r in rows).encode()).hexdigest()


def _diff_count(old, new):
    a = set(','.join(r) for r in old)
    b = set(','.join(r) for r in new)
    return {'removed': len(a - b), 'added': len(b - a)}
