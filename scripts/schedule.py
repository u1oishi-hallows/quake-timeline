"""いつ取得するかを決める（GitHub Actions が 1 時間ごとに呼ぶ）。

  ふだん        ：週 1 回（config.json の schedule.weekly、既定は土曜 11 時・日本時間）
  震度5弱・5強  ：その地震の発生から 14 日間、1 日 1 回
  震度6弱以上   ：その地震の発生から 7 日間は 6 時間ごと、その後 14 日間は 1 日 1 回
  検知した直後  ：前回の取得より後に起きた対象の地震があれば、間隔を待たずにすぐ取得
  手で動かしたとき（workflow_dispatch）は、いつでも取得する

対象の地震は、気象庁の地震情報の一覧（直近30日）から毎回判断し直す。決まりの期間（最長21日）は一覧の残る期間より短いので、
状態を覚えておく必要はない。前回の取得の時刻だけ data/schedule.json に残す（取得したときだけ書き換える）。

  python3 scripts/schedule.py decide        → 標準出力に run / skip と理由。GITHUB_OUTPUT があればそこにも書く
  python3 scripts/schedule.py done          → 取得が終わったことを data/schedule.json に記録する
"""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jma  # noqa: E402

JST = dt.timezone(dt.timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, 'data', 'schedule.json')
RANK = {'1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9}
LABEL = {'5-': '震度5弱', '5+': '震度5強', '6-': '震度6弱', '6+': '震度6強', '7': '震度7'}

DEFAULT = {
    'weekly': {'weekday': 5, 'hour': 11},   # 月曜 0 … 土曜 5、日本時間
    'rules': [
        {'min_intensity': '6-', 'phases': [{'every_hours': 6, 'days': 7}, {'every_hours': 24, 'days': 14}]},
        {'min_intensity': '5-', 'phases': [{'every_hours': 24, 'days': 14}]},
    ],
    'slack_minutes': 20,   # 定期実行の遅れを見込んで、間隔より少し早くても取得する
}


def last_weekly(now, weekly):
    """now 以前でいちばん近い「週 1 回の取得の時刻」（日本時間）"""
    n = now.astimezone(JST)
    t = n.replace(hour=weekly['hour'], minute=0, second=0, microsecond=0)
    t -= dt.timedelta(days=(t.weekday() - weekly['weekday']) % 7)
    if t > n:
        t -= dt.timedelta(days=7)
    return t


def plans(events, cfg):
    """対象の地震ごとに、取得の間隔と期間を並べる。events は [(発生時刻, 震度コード, 名前)]"""
    out = []
    for t, maxi, name in events:
        rule = next((r for r in cfg['rules'] if RANK.get(maxi, 0) >= RANK[r['min_intensity']]), None)
        if not rule:
            continue
        start = t
        for ph in rule['phases']:
            end = start + dt.timedelta(days=ph['days'])
            out.append({'from': start, 'to': end, 'every_hours': ph['every_hours'], 'event': t, 'maxi': maxi, 'name': name})
            start = end
    return out


def decide(now, events, last_full, cfg=None, manual=False):
    """(run か, 理由)。now・last_full は時刻（last_full は無ければ None）"""
    cfg = cfg or DEFAULT
    if manual:
        return True, '手で動かした'
    if last_full is None:
        return True, '取得の記録が無い'
    slack = dt.timedelta(minutes=cfg.get('slack_minutes', 20))
    # 検知した直後：前回の取得より後に起きた対象の地震
    for p in plans(events, cfg):
        if last_full < p['event'] <= now:
            return True, '%s（%s %s）を検知' % (LABEL.get(p['maxi'], p['maxi']), p['event'].astimezone(JST).strftime('%m/%d %H:%M'), p['name'])
    # 災害の間：いま有効な決まりの中でいちばん短い間隔
    active = [p for p in plans(events, cfg) if p['from'] <= now < p['to']]
    if active:
        p = min(active, key=lambda x: x['every_hours'])
        due = now - last_full >= dt.timedelta(hours=p['every_hours']) - slack
        why = '%s（%s）の後：%d時間ごと（%sまで）' % (LABEL.get(p['maxi'], p['maxi']), p['event'].astimezone(JST).strftime('%m/%d %H:%M'),
                                              p['every_hours'], p['to'].astimezone(JST).strftime('%m/%d %H:%M'))
        if due:
            return True, why
        weekly_due = last_full < last_weekly(now, cfg['weekly'])
        return (True, why + '、週1回の時刻も過ぎた') if weekly_due else (False, why + '、前回から間隔が経っていない')
    # ふだん：週 1 回
    w = last_weekly(now, cfg['weekly'])
    if last_full < w:
        return True, '週1回（%s）' % w.strftime('%m/%d %H:%M')
    return False, 'ふだん（週1回）。次は %s' % (w + dt.timedelta(days=7)).strftime('%m/%d %H:%M')


def load_cfg():
    with open(os.path.join(ROOT, 'config.json'), encoding='utf-8') as f:
        c = json.load(f).get('schedule') or {}
    cfg = dict(DEFAULT)
    cfg.update({k: v for k, v in c.items() if not k.startswith('_')})
    return cfg


def load_state():
    if os.path.exists(STATE):
        with open(STATE, encoding='utf-8') as f:
            return json.load(f)
    return {}


def events_from_list(items):
    rows, _ = jma.parse_list_json(items)
    out = []
    for r in rows:
        if r['maxi'] in RANK:
            t = dt.datetime.strptime(r['t'], '%Y-%m-%dT%H:%M').replace(tzinfo=JST)
            out.append((t, r['maxi'], r.get('name', '')))
    return out


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    now = dt.datetime.now(JST)
    st = load_state()
    if cmd == 'done':
        st['last_full'] = now.isoformat(timespec='seconds')
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, 'w', encoding='utf-8') as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
            f.write('\n')
        return 0
    if cmd != 'decide':
        print(__doc__)
        return 2
    manual = os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
    last = dt.datetime.fromisoformat(st['last_full']) if st.get('last_full') else None
    events, note = [], ''
    try:
        import fetch  # 通信の部品（間隔・やり直し）を使う
        code, raw, _ = fetch.http(fetch.URL_LIST)
        if code != 200:
            raise RuntimeError('HTTP %s' % code)
        events = events_from_list(json.loads(raw.decode('utf-8')))
    except Exception as e:
        note = '（地震情報の一覧を読めず、震度による判断はできなかった：%s）' % e
    run, why = decide(now, events, last, load_cfg(), manual)
    print(('run' if run else 'skip') + '：' + why + note)
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write('run=%s\n' % ('true' if run else 'false'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
