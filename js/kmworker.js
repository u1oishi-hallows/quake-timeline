/* 集合マーカー（k-means）を、画面とは別の計算場所でまとめる。
 * 画面（js/app.js）が地図を動かし終えたときに、見えている地震の座標を送ってくる。
 * 計算は js/core.js の QC.kmSolve（画面で計算するときと同じもの）。答えには送られてきた番号（seq）を付けて返し、
 * 古い答えかどうかは画面の側で判断する。 */
importScripts('core.js');

self.onmessage = function (e) {
  var job = e.data, t = Date.now();
  try {
    var r, buf = [];
    if (job.type === 'cum') {     // 累積：節目ごとの中心とまとめ、割り当てに使う座標も返す
      r = QC.kmCumSolve(job);
      r.frames.forEach(function (f) { if (f.n) buf.push(f.C.buffer, f.n.buffer, f.E.buffer, f.maxI.buffer, f.mi.buffer, f.mx.buffer, f.bd.buffer); });
      buf.push(r.P.buffer, r.ms.buffer, r.ids.buffer, r.ts.buffer);
      self.postMessage({ seq: job.seq, frames: r.frames, P: r.P, dim: r.dim, ms: r.ms, ids: r.ids, ts: r.ts, k: r.k, t0: r.t0, t1: r.t1, ms_: Date.now() - t }, buf);
      return;
    }
    r = QC.kmSolve(job);
    r.clusters.forEach(function (g) {
      buf.push(g.members.buffer, g.times.buffer, g.cumE.buffer, g.bestAt.buffer, g.maxAt.buffer);
    });
    self.postMessage({ seq: job.seq, clusters: r.clusters, K: r.K, active: r.active, ms: Date.now() - t }, buf);
  } catch (err) {
    self.postMessage({ seq: job.seq, error: String(err && err.message || err) });
  }
};
