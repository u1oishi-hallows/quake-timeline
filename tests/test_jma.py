"""解読と保存の検査。fixtures は 2026-10-11 に気象庁から取った実物の切れ端。

見ている点:
 1 確定版の1行を、気象庁の発表どおりに読む（珠洲 M6.5：時刻・座標・深さ・震度6強）
 2 深さ固定（I3,2X）・負のM（-0.6、-1.0）・M空欄・気象庁以外（U）を取り違えない
 3 速報の表を読み、読めない行・別の日の行は黙って捨てず止める
 4 震度の突き合わせは時刻0.1秒と座標の一致だけ。外れたものは捨てずに返す
 5 地震情報の一覧は、震源の無い発表・遠地地震を理由付きで数え、eid の最新だけ使う
 6 保存：より確かな出どころを弱いもので上書きしない。同じ出どころの書き換えを記録する
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'scripts'))
import jma  # noqa: E402
from store import Store  # noqa: E402

FX = os.path.join(HERE, 'fixtures')


def fx(name):
    with open(os.path.join(FX, name), encoding='utf-8') as f:
        return f.read()


class Hypo(unittest.TestCase):
    def setUp(self):
        self.lines = fx('hypo_2023_sample.txt').splitlines()

    def test_suzu(self):
        r = jma.parse_hypo_line(self.lines[0])
        self.assertEqual(r['t'], '2023-05-05T14:42:04.1')
        self.assertAlmostEqual(r['lat'], 37 + 32.34 / 60, places=6)
        self.assertAlmostEqual(r['lon'], 137 + 18.27 / 60, places=6)
        self.assertAlmostEqual(r['dep'], 12.14)
        self.assertEqual(r['mag'], 6.5)
        self.assertEqual(r['maxi'], '6+')
        self.assertEqual((r['src'], r['q'], r['aux']), ('C', 'K', '1'))

    def test_fixed_depth_and_blank_mag(self):
        r = jma.parse_hypo_line(self.lines[1])
        self.assertEqual(r['dep'], 0.0)
        self.assertIsNone(r['mag'])
        self.assertEqual(r['maxi'], '')

    def test_fixed_depth_nonzero(self):
        r = jma.parse_hypo_line(self.lines[6])  # 深さ欄 ' 50  '（I3,2X）
        self.assertEqual(r['dep'], 50.0)
        self.assertEqual(r['mag'], 0.3)
        self.assertEqual(r['t'], '2023-01-01T00:08:01.5')

    def test_tohoku_m9(self):
        r = jma.parse_hypo_line(self.lines[7])   # 2011-03-11 東北地方太平洋沖地震
        self.assertEqual(r['t'], '2011-03-11T14:46:18.1')
        self.assertEqual((r['mag'], r['maxi'], r['q']), (9.0, '7', 'K'))
        self.assertAlmostEqual(r['dep'], 23.74)
        self.assertAlmostEqual(r['lat'], 38 + 6.21 / 60, places=6)
        self.assertAlmostEqual(r['lon'], 142 + 51.66 / 60, places=6)

    def test_negative_mag(self):
        self.assertEqual(jma.parse_hypo_line(self.lines[2])['mag'], -0.6)
        self.assertEqual(jma.parse_hypo_line(self.lines[3])['mag'], -1.0)
        self.assertEqual(jma.hypo_mag('A9'), -1.9)
        self.assertEqual(jma.hypo_mag('B0'), -2.0)
        self.assertEqual(jma.hypo_mag('-1'), -0.1)
        self.assertEqual(jma.hypo_mag('05'), 0.5)

    def test_matched_filter_line(self):
        r = jma.parse_hypo_line(self.lines[2])  # 標準誤差が空欄の行
        self.assertEqual(r['t'], '2023-01-01T00:19:55.9')
        self.assertAlmostEqual(r['lat'], 34 + 1.34 / 60, places=6)
        self.assertEqual(r['q'], 'a')

    def test_other_agency_and_south(self):
        self.assertIsNone(jma.parse_hypo_line(self.lines[4]))
        self.assertAlmostEqual(jma._deg('-14', 56.80), -(14 + 56.8 / 60))

    def test_bad_record(self):
        with self.assertRaises(jma.FormatError):
            jma.parse_hypo_line('X' + self.lines[0][1:])


class Daily(unittest.TestCase):
    def test_parse(self):
        rows = jma.parse_daily_html(fx('daily_20240101_sample.html'), '2024-01-01')
        self.assertEqual(len(rows), 12)
        noto = [r for r in rows if r['t'] == '2024-01-01T16:10:22.5']
        self.assertEqual(len(noto), 1)
        self.assertEqual(noto[0]['mag'], 7.6)
        self.assertAlmostEqual(noto[0]['lat'], 37 + 29.7 / 60, places=6)
        self.assertAlmostEqual(noto[0]['lon'], 137 + 16.2 / 60, places=6)
        self.assertEqual(noto[0]['dep'], 16.0)
        self.assertEqual(sum(r['mag'] is None for r in rows), 2)   # 'M -' の行（16:10:08.3、00:33:56.0）
        self.assertTrue(all(r['maxi'] == '' and r['src'] == 'P' for r in rows))

    def test_unreadable_row_stops(self):
        html = fx('daily_20240101_sample.html').replace("37°29.7'N", "37°29.7N", 1)
        with self.assertRaises(jma.FormatError):
            jma.parse_daily_html(html, '2024-01-01')

    def test_other_day_stops(self):
        with self.assertRaises(jma.FormatError):
            jma.parse_daily_html(fx('daily_20240101_sample.html'), '2024-01-02')

    def test_no_header_stops(self):
        with self.assertRaises(jma.FormatError):
            jma.parse_daily_html('<pre>\n</pre>', '2024-01-01')


class Join(unittest.TestCase):
    def setUp(self):
        self.rows = jma.parse_daily_html(fx('daily_20240101_sample.html'), '2024-01-01')
        self.sh, self.over = jma.parse_shindo_result(json.loads(fx('shindo_20240101_sample.json')))

    def test_shindo_parse(self):
        self.assertFalse(self.over)
        self.assertEqual(len(self.sh), 3)
        top = [s for s in self.sh if s['t'] == '2024-01-01T16:10:22.5'][0]
        self.assertEqual((top['maxi'], top['mag'], top['dep']), ('7', 7.6, 16.0))

    def test_join(self):
        un = jma.join_intensity(self.rows, self.sh)
        by = {r['t']: r for r in self.rows}
        self.assertEqual(by['2024-01-01T16:10:22.5']['maxi'], '7')
        self.assertEqual(by['2024-01-01T21:45:09.8']['maxi'], '1')
        # 21:45:48.2 は速報の震源リストに無い（実測）。近い時刻の別の地震に付けない
        self.assertEqual([u['t'] for u in un], ['2024-01-01T21:45:48.2'])
        self.assertEqual(by['2024-01-01T21:45:34.6']['maxi'], '')
        self.assertEqual(sum(r['maxi'] != '' for r in self.rows), 2)

    def test_same_time_far_place_not_joined(self):
        s = dict(self.sh[0])
        target = [x for x in self.sh if x['t'] == '2024-01-01T16:10:22.5'][0]
        s.update(t=target['t'], lat=target['lat'] + 0.5)
        un = jma.join_intensity(self.rows, [s])
        self.assertEqual(len(un), 1)

    def test_same_minute_same_place_other_second_not_joined(self):
        target = dict([x for x in self.sh if x['t'] == '2024-01-01T16:10:22.5'][0])
        target['t'] = '2024-01-01T16:10:25.5'
        un = jma.join_intensity(self.rows, [target])
        self.assertEqual(len(un), 1)
        self.assertTrue(all(r['maxi'] == '' for r in self.rows))

    def test_ambiguous_not_joined(self):
        noto = [r for r in self.rows if r['t'] == '2024-01-01T16:10:22.5'][0]
        rows = self.rows + [dict(noto)]          # 同時刻・同地点が 2 つ
        un = jma.join_intensity(rows, [x for x in self.sh if x['t'] == noto['t']])
        self.assertEqual(len(un), 1)
        self.assertTrue(all(r['maxi'] == '' for r in rows if r['t'] == noto['t']))

    def test_not_yet(self):
        self.assertTrue(jma.shindo_not_yet('現時点の震度データベースには 2026-10-09 より後のデータはありません　検索終了日時の設定を見直してください'))
        self.assertFalse(jma.shindo_not_yet('年月日が不正です'))
        self.assertFalse(jma.shindo_not_yet(''))

    def test_over_limit_flag(self):
        obj = json.loads(fx('shindo_20240101_sample.json'))
        obj['str'] = ['検索結果地震数 ： 上限を超えました']
        self.assertTrue(jma.parse_shindo_result(obj)[1])


class ListJson(unittest.TestCase):
    def test_list(self):
        items = json.loads(fx('list_sample.json'))
        rows, dropped = jma.parse_list_json(items)
        eids = {it['eid'] for it in items if it.get('ttl') in jma.LIST_TTL_HYPO}
        self.assertEqual(len(rows), len(eids))
        self.assertTrue(all(r['src'] == 'Q' and len(r['t']) == 16 for r in rows))
        first = [r for r in rows if r['t'] == '2026-10-11T15:49'][0]
        self.assertEqual((first['lat'], first['lon'], first['dep'], first['mag'], first['maxi']),
                         (32.0, 131.4, 10.0, 2.3, '1'))

    def test_latest_report_wins(self):
        base = {'eid': 'e', 'at': '2026-01-01T01:00:00+09:00', 'cod': '+36.0+137.6-10000/'}
        items = [dict(base, ttl='震源・震度情報', rdt='2026-01-01T01:05:00+09:00', mag='3.0', maxi='2'),
                 dict(base, ttl='震源・震度情報', rdt='2026-01-01T01:20:00+09:00', mag='3.4', maxi='3'),
                 dict(base, ttl='震源に関する情報', rdt='2026-01-01T01:02:00+09:00', mag='2.9', maxi='')]
        rows, _ = jma.parse_list_json(items)
        self.assertEqual([(r['mag'], r['maxi']) for r in rows], [(3.4, '3')])

    def test_dropped_reasons(self):
        items = [
            {'eid': 'a', 'ttl': '震度速報', 'rdt': '1', 'at': '2026-01-01T00:00:00+09:00', 'cod': ''},
            {'eid': 'b', 'ttl': '遠地地震に関する情報', 'rdt': '1', 'at': '2026-01-01T00:00:00+09:00', 'cod': '+07.5-080.8/'},
            {'eid': 'c', 'ttl': '震度速報', 'rdt': '1', 'at': '2026-01-01T01:00:00+09:00', 'cod': ''},
            {'eid': 'c', 'ttl': '震源・震度情報', 'rdt': '2', 'at': '2026-01-01T01:00:00+09:00',
             'cod': '+36.0+137.6-10000/', 'mag': '3.1', 'maxi': '5+'},
        ]
        rows, dropped = jma.parse_list_json(items)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['maxi'], '5+')
        self.assertEqual(dropped, {'震源の発表がまだ無い（震度速報のみ）': 1,
                                   '地震の震源ではない情報（遠地地震に関する情報）': 1})


def _row(t, src='P', mag=1.0):
    return {'t': t, 'lat': 35.0, 'lon': 135.0, 'dep': 10.0, 'mag': mag, 'maxi': '', 'src': src, 'q': '', 'aux': ''}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_rank_and_revision(self):
        st = Store(self.tmp)
        self.assertTrue(st.put_day('2024-01-01', [_row('2024-01-01T00:00:01.0', 'C')], 4, {'src': 'C'}))
        self.assertFalse(st.put_day('2024-01-01', [_row('2024-01-01T00:00:02.0')], 3, {'src': 'P'}))
        st.put_day('2024-01-02', [_row('2024-01-02T00:00:01.0', 'Q')], 1, {'src': 'Q'})
        self.assertTrue(st.put_day('2024-01-02', [_row('2024-01-02T00:00:01.5')], 3, {'src': 'P'}))
        self.assertFalse(st.put_day('2024-01-02', [_row('2024-01-02T00:00:09.0', 'Q')], 1, {'src': 'Q'}))
        self.assertEqual(st.manifest['revisions'], [])
        st.put_day('2024-01-02', [_row('2024-01-02T00:00:01.5', mag=1.2)], 3, {'src': 'P'})
        self.assertEqual(len(st.manifest['revisions']), 1)
        self.assertEqual(st.manifest['revisions'][0]['changed'], {'removed': 1, 'added': 1})
        st.save()
        st2 = Store(self.tmp)
        self.assertEqual(st2.day_rows('2024-01-01')[0][6], 'C')
        self.assertEqual(st2.day_rows('2024-01-02')[0][4], '1.2')
        self.assertEqual(st2.manifest['months']['2024-01']['rows'], 2)

    def test_wrong_day_rejected(self):
        st = Store(self.tmp)
        with self.assertRaises(ValueError):
            st.put_day('2024-01-01', [_row('2024-01-02T00:00:01.0')], 3, {'src': 'P'})


if __name__ == '__main__':
    unittest.main()
