/* 集合マーカー（k-means）を、画面とは別の計算場所でまとめる。
 * 画面（js/app.js）が地図を動かし終えたときに、見えている地震の座標を送ってくる。
 * 計算は js/core.js の QC.kmSolve（画面で計算するときと同じもの）。答えには送られてきた番号（seq）を付けて返し、
 * 古い答えかどうかは画面の側で判断する。 */
importScripts('core.js');

self.onmessage = function (e) {
  var job = e.data, t = Date.now();
  try {
    var r = QC.kmSolve(job), buf = [];
    r.clusters.forEach(function (g) {
      buf.push(g.members.buffer, g.times.buffer, g.cumE.buffer, g.bestAt.buffer, g.maxAt.buffer);
    });
    self.postMessage({ seq: job.seq, clusters: r.clusters, K: r.K, active: r.active, ms: Date.now() - t }, buf);
  } catch (err) {
    self.postMessage({ seq: job.seq, error: String(err && err.message || err) });
  }
};
