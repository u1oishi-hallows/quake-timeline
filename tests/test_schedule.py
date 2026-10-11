"""いつ取得するか（scripts/schedule.py）の検査。時刻はすべて日本時間で指定する。

見ている点:
 1 ふだんは土曜 11 時の後に 1 回だけ（10 時台・日曜・同じ週の 2 回目は取らない）
 2 震度5弱・5強：発生から 14 日間は 1 日 1 回。15 日目からはふだんに戻る
 3 震度6弱以上：発生から 7 日間は 6 時間ごと、その後 14 日間は 1 日 1 回、22 日目からふだん
 4 検知した直後（前回の取得より後に起きた）は、間隔を待たずにすぐ取る
 5 震度4以下では何もしない。手で動かしたとき・記録が無いときは取る
"""
import datetime as dt
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'scripts'))
import schedule as sc  # noqa: E402

J = sc.JST


def t(s):
    return dt.datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=J)


def run(now, events, last, manual=False):
    return sc.decide(t(now), [(t(e[0]), e[1], 'テスト') for e in events], t(last) if last else None, None, manual)[0]


class Weekly(unittest.TestCase):
    # 2026-10-10 は土曜
    def test_saturday(self):
        self.assertTrue(run('2026-10-10 11:23', [], '2026-10-03 11:23'))
        self.assertFalse(run('2026-10-10 10:23', [], '2026-10-03 11:23'))
        self.assertFalse(run('2026-10-10 12:23', [], '2026-10-10 11:23'))    # 同じ週の 2 回目
        self.assertFalse(run('2026-10-11 09:23', [], '2026-10-10 11:23'))    # 日曜
        self.assertTrue(run('2026-10-12 09:23', [], '2026-10-03 11:23'))     # 土曜を取りこぼしたら次の回で取る
        self.assertFalse(run('2026-10-12 09:23', [], '2026-10-10 11:23'))    # 月曜：土曜に取ってあれば取らない
        self.assertFalse(run('2026-10-15 23:23', [], '2026-10-10 11:23'))    # 木曜
        self.assertEqual(sc.last_weekly(t('2026-10-12 09:00'), sc.DEFAULT['weekly']), t('2026-10-10 11:00'))
        self.assertEqual(sc.last_weekly(t('2026-10-16 23:00'), sc.DEFAULT['weekly']), t('2026-10-10 11:00'))
        self.assertEqual(sc.last_weekly(t('2026-10-10 11:00'), sc.DEFAULT['weekly']), t('2026-10-10 11:00'))
        self.assertEqual(sc.last_weekly(t('2026-10-10 10:59'), sc.DEFAULT['weekly']), t('2026-10-03 11:00'))

    def test_manual_and_first(self):
        self.assertTrue(run('2026-10-11 09:23', [], '2026-10-11 09:00', manual=True))
        self.assertTrue(run('2026-10-11 09:23', [], None))

    def test_weak_shaking_ignored(self):
        self.assertFalse(run('2026-10-11 09:23', [('2026-10-11 08:00', '4')], '2026-10-10 11:23'))


class Lower5(unittest.TestCase):
    EV = [('2026-10-01 03:10', '5-')]

    def test_detect_now(self):
        self.assertTrue(run('2026-10-01 03:23', self.EV, '2026-09-30 22:00'))   # 前回の取得の後に起きた

    def test_daily_for_14_days(self):
        self.assertFalse(run('2026-10-01 20:23', self.EV, '2026-10-01 03:23'))
        self.assertTrue(run('2026-10-02 03:23', self.EV, '2026-10-01 03:23'))   # 24 時間（20 分の余裕込み）
        self.assertTrue(run('2026-10-14 05:23', self.EV, '2026-10-13 05:23'))   # 13 日目
        self.assertFalse(run('2026-10-15 05:23', self.EV, '2026-10-14 05:23'))  # 14 日を過ぎたらふだん（日曜ではない木曜）

    def test_upper5_same_rule(self):
        self.assertTrue(run('2026-10-02 03:23', [('2026-10-01 03:10', '5+')], '2026-10-01 03:23'))


class Upper6(unittest.TestCase):
    EV = [('2026-10-01 03:10', '6-')]

    def test_6h_for_7_days(self):
        self.assertTrue(run('2026-10-01 09:23', self.EV, '2026-10-01 03:23'))
        self.assertFalse(run('2026-10-01 07:23', self.EV, '2026-10-01 03:23'))
        self.assertTrue(run('2026-10-07 21:23', self.EV, '2026-10-07 15:23'))   # 7 日目

    def test_daily_next_14_days(self):
        self.assertFalse(run('2026-10-08 21:23', self.EV, '2026-10-08 15:23'))  # 8 日目は 1 日 1 回
        self.assertTrue(run('2026-10-09 15:23', self.EV, '2026-10-08 15:23'))
        self.assertTrue(run('2026-10-21 15:23', self.EV, '2026-10-20 15:23'))   # 21 日目
        self.assertFalse(run('2026-10-22 15:23', self.EV, '2026-10-21 15:23'))  # 22 日目（木曜）はふだん

    def test_strongest_wins(self):
        evs = [('2026-10-01 03:10', '5-'), ('2026-10-03 12:00', '7')]
        self.assertTrue(run('2026-10-04 00:23', evs, '2026-10-03 18:23'))       # 7 の 6 時間ごとが優先

    def test_new_event_during_disaster(self):
        self.assertTrue(run('2026-10-02 10:23', self.EV + [('2026-10-02 10:05', '5+')], '2026-10-02 09:23'))


class ListJson(unittest.TestCase):
    def test_events_from_real_list(self):
        with open(os.path.join(HERE, 'fixtures', 'list_sample.json'), encoding='utf-8') as f:
            ev = sc.events_from_list(json.load(f))
        self.assertTrue(all(e[0].tzinfo is not None for e in ev))
        self.assertEqual(ev[0][0], t('2026-10-11 15:49'))
        self.assertEqual(ev[0][1], '1')
        # 震度5強の発表があれば、震度6弱の決まりには入らず、5弱の決まりに入る
        p = sc.plans([(t('2026-10-01 00:00'), '5+', 'x')], sc.DEFAULT)
        self.assertEqual([(x['every_hours'], (x['to'] - x['from']).days) for x in p], [(24, 14)])
        p = sc.plans([(t('2026-10-01 00:00'), '6-', 'x')], sc.DEFAULT)
        self.assertEqual([(x['every_hours'], (x['to'] - x['from']).days) for x in p], [(6, 7), (24, 14)])


if __name__ == '__main__':
    unittest.main()
