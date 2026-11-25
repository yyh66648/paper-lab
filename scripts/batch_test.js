/* 测批量稳健性：同一参数跑遍股票池。 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const Engine = require(path.join(root, "docs", "engine.js"));

global.fetch = async (url) => {
  const rel = String(url).replace(/^\.?\//, "");
  const file = path.join(root, "docs", rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buffer = fs.readFileSync(file);
  return {
    ok: true, status: 200,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    json: async () => JSON.parse(buffer.toString("utf8")),
  };
};

const dataSrc = fs.readFileSync(path.join(root, "docs", "data.js"), "utf8");
const Data = new Function(`${dataSrc}; return Data;`)();
const bridgeSrc = fs.readFileSync(path.join(root, "docs", "bridge.js"), "utf8");
const { Bridge } = new Function("Engine", "Data", "performance", `${bridgeSrc}; return { Bridge, Paper };`)(Engine, Data, performance);

(async () => {
  const index = await Data.loadStockIndex();
  const symbols = index.symbols.map((item) => item.symbol);
  const started = Date.now();
  let lastDone = 0;
  const result = await Bridge.batch({
    symbols, interval: "1d", start: "2023-11-25", end: "2026-11-25",
    strategyId: "sma_cross", params: { fast: 20, slow: 60 },
    cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false,
    onProgress: (done) => { lastDone = done; },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  const s = result.summary;
  console.log(`池 ${s.total} 只，成功 ${s.ok}，进度回调 ${lastDone}，耗时 ${elapsed}s`);
  console.log(`正收益 ${s.positive} (${(s.positive_rate * 100).toFixed(0)}%)  跑赢持有 ${s.beat_hold} (${(s.beat_hold_rate * 100).toFixed(0)}%)`);
  console.log(`收益中位数 ${(s.median_return * 100).toFixed(1)}%  超额中位数 ${(s.median_excess * 100).toFixed(1)}%  夏普中位数 ${s.median_sharpe.toFixed(2)}`);
  console.log(`最好 ${s.best.symbol} ${(s.best.total_return * 100).toFixed(0)}% / 最差 ${s.worst.symbol} ${(s.worst.total_return * 100).toFixed(0)}%`);
  const bad = result.rows.filter((row) => !row.ok);
  if (bad.length) console.log("失败：", bad.slice(0, 3).map((row) => `${row.symbol}: ${row.error}`));
  if (s.ok < symbols.length) {
    console.log("有标的没跑通");
    process.exit(1);
  }
  console.log("批量稳健性通过。");
})();
