# 申し送り（2026-10-12 22:40 JST 時点）

地震の時系列地図。仕組み・データの出どころ・検査は README.md に書いてある。ここは「次の人がすぐ続けられる」ための記録。

- 公開ページ：https://u1oishi-hallows.github.io/quake-timeline/
- リポジトリ：https://github.com/u1oishi-hallows/quake-timeline （公開、main に push すると Pages に数分で反映）
- 手元：`Dropbox/Claude Code/地震可視化`。プレビューは 出張医調整システム/.claude/launch.json の `quake`（python http.server 8741）
- 最新のコミット：下の B を参照（2026-10-13）

## 作業の状態（2026-10-12 深夜）

### A. パン・ピンチをなめらかに — 済み（a511a70）
k-means は Web Worker（js/kmworker.js、中身は QC.kmSolve）。手が止まって 0.4 秒後に開始、計算中は前の塊、古い答えは捨てる。動画の書き出し中だけ画面側で計算。

### C. 立体表示（試作）— 済み（db6acc9）
js/view3d.js、deck.gl 9.3.11 を vendor/ に同梱。地図の「3D」→ 範囲をドラッグ → 立体。3 つの表示モードと再生に対応、回転では計算し直さない。
利用者の「深度情報はいりません」は「地面は平ら（地形・海の深さなし）、平面の断面図・奥行きの効きは使わない」と解釈した（確認待ち）。
まだ無い：立体での動画書き出し、プレート境界の面。

### B. 日本中の想定震源域 — 済み（2026-10-13）
research/build_source_areas.py（元の J-SHIS は scratchpad のみ）→ data/overlays/source_areas.json、確かめは research/check_source_areas.py。
色「想定震源域からの距離」＝M の色の鮮やかさを距離で落とす（QC.srcPrepare / srcDistance / srcFade）。最後の統計に想定震源域ごとの解放エネルギー（QC.srcStats、面から S.srcNearKm 以内）。
立体表示は OrbitView の模型（下からも見られる。地面は範囲 1 枚の地形の面、中心＝箱の中心）、凡例などを隠す（H）。
立体の画面の確かめは、プレビューの窓が隠れていると描かれないので、見えない Chrome（scratchpad/hc/shot.js、CDP で操作して PNG）で撮った。

### D. 1919年からの確定版 — 済み（2026-10-13）
`python3 scripts/fetch.py catalog 1919 2023`（古い年はまとめたファイル、fetch.hypo_files）。CSV に 10 列目 df（震源評価）。深さの欄の桁ずれは震度データベースと突き合わせて確かめた。
再生ボタン：終わりにいるときは期間の始めから、途中で止めたらそこから（playEnd＝期間の終わりとデータの最後の早いほう）。

### E. k-means（累積）と期間の連れ動き — 済み（2026-10-13）
QC.kmCumSolve / kmCumAt / extendCenters（core.js）、kmworker の type 'cum'、app の aggMethod 'kmcum'（kmView）、立体表示も対応。期間：onPeriodChange(which)。

### 次の候補
- 距離の計算（1 年分で約 0.5 秒）を別の計算場所へ
- 日本海溝・日本海東縁部で名前の文字が重なる
- 立体での動画の書き出し

## 利用者が決めたこと（変えるときは相談）
- 取得の頻度：ふだん週1回 土曜11時JST。震度5弱以上で発生から14日間1日1回。震度6弱以上で7日間6時間ごと＋その後14日間1日1回。検知直後はすぐ1回。手動は Actions の Run workflow。
  GitHub は1時間ごとの予定を間引く（半日で3回程度）。判断は `scripts/schedule.py`、決まりは `config.json` の `schedule`。
- 置き場所は GitHub（公開）。Drive は使わない。
- 動画はブラウザ内で書き出し。書き出し開始で操作盤を引っ込める。最後に集合マーカー→暗転して統計。
- 集合マーカー：既定は k-means（静止画 xyz・再生 xyzt）。数は10段階（10〜100、1段で×10^(1/9)）。大きさは M相当ごとに倍率（既定1.35）。
  利用者は「集合マーカーの見え方が非常にいい」と言っている（段階3＝17個の画面を見て）。既定の段階は6のまま（変えるかは未確認）。
- 重いつまみ（マーカーの数・地図の向き）は離してから計算。
- 3D の効き（奥行き：小さく・ぼかし・かすみ）は円の表示で既定50%、設定欄は普段は畳む。

## 守ること（利用者と共有の理念）
実測してから書く／検査を書いたら壊して落ちるのを確かめる（`python3 tests/mutate.py`、いま122通り全部落ちる）／もっともらしく壊れるのを最優先で潰す
（間違った場所・時刻に出さない、不明は不明のまま）／黙って落とさない（件数と理由）／時刻を示す／色は意味に使い凡例を付ける／
外部データは非公式で変わる・出典を出す／設定はコードに埋めない。説明は平易な日本語で結論から。

## 検査
```
python3 -m unittest tests.test_jma tests.test_schedule
TZ=America/New_York node tests/core.test.js
python3 tests/mutate.py
```
