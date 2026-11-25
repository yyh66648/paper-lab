/* 测二维参数扫描。 */
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
  const meta = await Data.loadBars("NVDA", "1d", "2023-11-25", "2026-11-25");
  const started = Date.now();
  const map = Bridge.heatmap({
    symbol: "NVDA", interval: "1d", meta,
    strategyId: "sma_cross", params: { fast: 20, slow: 60 },
    cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false,
    xKey: "fast", yKey: "slow",
    xMin: 10, xMax: 30, xStep: 10,
    yMin: 40, yMax: 120, yStep: 40,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`网格 ${map.xValues.length}×${map.yValues.length}=${map.cells.length}，耗时 ${elapsed}s`);
  console.log("X", map.xValues.join(","), "Y", map.yValues.join(","));
  const grid = [];
  for (const y of map.yValues) {
    const row = map.xValues.map((x) => {
      const cell = map.cells.find((c) => c.x === x && c.y === y);
      return ((cell.sharpe ?? 0).toFixed(2)).padStart(6);
    });
    grid.push(y.toString().padStart(4) + row.join(""));
  }
  console.log(grid.join("\n"));
  console.log("最佳", map.best.x, map.best.y, map.best.sharpe.toFixed(2), (map.best.total_return * 100).toFixed(0) + "%");

  let threw = null;
  try {
    Bridge.heatmap({
      symbol: "NVDA", interval: "1d", meta, strategyId: "sma_cross", params: {},
      cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false,
      xKey: "fast", yKey: "fast", xMin: 5, xMax: 10, xStep: 1, yMin: 5, yMax: 10, yStep: 1,
    });
  } catch (error) {
    threw = error.message;
  }
  console.log("同参数应报错：", threw ? "ok" : "FAIL");

  let tooMany = null;
  try {
    Bridge.heatmap({
      symbol: "NVDA", interval: "1d", meta, strategyId: "sma_cross", params: {},
      cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false,
      xKey: "fast", yKey: "slow", xMin: 2, xMax: 100, xStep: 1, yMin: 5, yMax: 300, yStep: 5,
    });
  } catch (error) {
    tooMany = error.message;
  }
  console.log("超限应报错：", tooMany ? "ok" : "FAIL");
  if (!threw || !tooMany) process.exit(1);
  console.log("二维扫描通过。");
})();
