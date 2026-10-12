# 申し送り（2026-10-12 22:40 JST 時点）

地震の時系列地図。仕組み・データの出どころ・検査は README.md に書いてある。ここは「次の人がすぐ続けられる」ための記録。

- 公開ページ：https://u1oishi-hallows.github.io/quake-timeline/
- リポジトリ：https://github.com/u1oishi-hallows/quake-timeline （公開、main に push すると Pages に数分で反映）
- 手元：`Dropbox/Claude Code/地震可視化`。プレビューは 出張医調整システム/.claude/launch.json の `quake`（python http.server 8741）
- 最新のコミット：e804651（低周波地震だけ・南海トラフの想定震源域）

## 作業中（未完了）— 利用者の最新の依頼（2026-10-12）

### A. マップのパン・ピンチもなめらかに（未着手）
原因：`map.on('moveend zoomend resize', …)` で `st.viewVer` を上げ、集合マーカー（k-means）を画面と同じスレッドで計算し直す（0.5〜2秒止まる）。
方針（利用者に説明済み）：
1. k-means（`QC.kmeans` と `QC.kmeansClusters`）を Web Worker で計算する。worker は `importScripts('js/core.js')`（core.js は `this`＝self に QC を置くので worker でも動く）。
   P・ms・ids は Transferable で渡す。戻りは塊（members・c・mi など）。累積の前処理（`kmFit` の後半：times/cumE/bestAt/maxAt/rmsXY）と、
   同時に見える数の合わせ直し（`kmActiveMedian`→もう一度 fit）は画面側のまま。
2. 計算中は今の塊を表示し続け、終わったら差し替え。地図を続けて動かしたら、手が止まってから 400ms ほど待って開始。古い結果は版（viewVer）を見て捨てる。
3. 確かめ：パン・ピンチ中に main thread が止まらないこと（長いタスクを測る）、結果がこれまでと同じ（同じ種・同じ入力なら同じ塊）。
該当コード：js/app.js の `kmClusters` / `kmFit` / `kmActiveMedian` / `kmAt` / `drawKm`、地図のイベントは `initMap`。

### B. 固着帯（想定震源域）を日本中に（調査途中）
利用者の依頼：南海・東海以外に、北海道沖（千島海溝）・東日本（日本海溝）なども含めて日本中。
- 南海トラフは済み：J-SHIS 震源断層 API `https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/ANNKI/fltinfo.geojson?epsg=4326`
  （177 パターン・格子点約5km・深さ付き・重み）→ `research/build_nankai_overlay.py` で加工 → `data/overlays/nankai_source.json`
- 次にやること：千島海溝・日本海溝・相模トラフ・日向灘・南西諸島などの ltecode を探す。API の一覧ページ（api-list）には符号の一覧が無かった。
  「J-SHIS Fault Code document」を探すか、J-SHIS Map の画面の通信から符号を読む。見つかったら南海と同じく加工（形が矩形断層の集まりなら外形の和）。
- **J-SHIS 利用規約**（https://www.j-shis.bosai.go.jp/agreement）：元のデータをそのまま複製・形式変換して配布するのは禁止、編集・加工した成果物は配布可。
  → 元の GeoJSON はリポジトリに置かない（手元の scratchpad のみ）。出典「J-SHIS（防災科学技術研究所）を加工」を必ず出す。
- 名前は「固着域」ではなく「（長期評価の）想定震源域」と出す（観測で測った固着の分布ではない。Yokota et al. 2016 などの観測による分布はデータで公開されていない）。
- 画面側：`applyNankai`（js/app.js）を領域ごとに一般化。凡例 `nankaiLegendHtml`、動画は `.leaflet-overlay-pane canvas` を snapshotTiles で写している。

### C. 3D 表示モード（提案のみ、利用者の返事待ち）
deck.gl（MIT）で別ページ。地理院タイルを半透明の地面に、震源を実際の深さ（強調可）に。J-SHIS の格子点でプレート境界の面も立体に。
まず試作（立体・再生・震源の球・プレート境界の面）を見せてから広げる、と提案した。

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
実測してから書く／検査を書いたら壊して落ちるのを確かめる（`python3 tests/mutate.py`、いま85通り全部落ちる）／もっともらしく壊れるのを最優先で潰す
（間違った場所・時刻に出さない、不明は不明のまま）／黙って落とさない（件数と理由）／時刻を示す／色は意味に使い凡例を付ける／
外部データは非公式で変わる・出典を出す／設定はコードに埋めない。説明は平易な日本語で結論から。

## 検査
```
python3 -m unittest tests.test_jma tests.test_schedule
TZ=America/New_York node tests/core.test.js
python3 tests/mutate.py
```
