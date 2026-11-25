/* 在 Node 里用真实静态数据跑一遍 Bridge，检查字段和数值。 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const Engine = require(path.join(root, "docs", "engine.js"));

const files = {};
global.fetch = async (url) => {
  const rel = String(url).replace(/^\.?\//, "");
  const file = path.join(root, "docs", rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buffer = fs.readFileSync(file);
  files[rel] = true;
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    json: async () => JSON.parse(buffer.toString("utf8")),
    text: async () => buffer.toString("utf8"),
  };
};
global.TextDecoder = global.TextDecoder || require("util").TextDecoder;

const dataSrc = fs.readFileSync(path.join(root, "docs", "data.js"), "utf8");
const Data = new Function(`${dataSrc}; return Data;`)();

const bridgeSrc = fs.readFileSync(path.join(root, "docs", "bridge.js"), "utf8");
const { Bridge } = new Function("Engine", "Data", "performance", `${bridgeSrc}; return { Bridge, Paper };`)(
  Engine, Data, performance
);

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    failed++;
    console.log("FAIL " + msg);
  }
};

(async () => {
  const meta = await Data.loadBars("NVDA", "1d", "2023-11-25", "2026-11-25");
  check(meta.bars.length > 500, `NVDA 载入 ${meta.bars.length} 根`);
  check(meta.adjusted === true, "复权标记");

  const result = Bridge.backtest({
    symbol: "NVDA", interval: "1d", start: "2023-11-25", end: "2026-11-25",
    meta, strategyId: "sma_cross", params: { fast: 20, slow: 60 },
    cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false, benchmark: "self",
  });

  const m = result.metrics;
  check(["total_return", "max_drawdown", "sharpe", "win_rate", "ending_equity"].every((k) => k in m), "绩效字段齐全");
  check(close(m.total_return, 0.576, 0.002), `总收益 ${m.total_return}`);
  check(close(m.sharpe, 0.629, 0.01), `夏普 ${m.sharpe}`);
  check(m.trades === 7, `成交笔数 ${m.trades}`);
  check(result.trades.length > 0 && "entry_label" in result.trades[0], "成交字段映射");
  check(result.trades.some((t) => "bars_held" in t), "bars_held 映射");
  check(result.equity.length === meta.bars.length, "净值长度");
  check(Number.isFinite(result.equity[0].bench), "基准净值");
  check(result.overlays.length === 2 && result.overlays[0].values.length === meta.bars.length, "叠加线长度");
  check(result.split && close(result.split.in_sample.total_return, 0.8068, 0.003), `前 70% ${result.split?.in_sample?.total_return}`);
  check(result.split && result.split.out_of_sample.total_return < 0, "后 30% 亏损");
  check(result.benchmark && result.benchmark.label.includes("NVDA"), "基准标签");
  check(result.warnings.length === 0, `不该有警告：${result.warnings}`);
  console.log(`NVDA 日线：收益 ${(m.total_return * 100).toFixed(2)}% 夏普 ${m.sharpe.toFixed(3)} 成交 ${m.trades}`);

  const cmp = Bridge.compare({
    symbol: "NVDA", interval: "1d", start: "2023-11-25", end: "2026-11-25",
    meta, cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false, benchmark: "self",
  });
  check(cmp.rows.length === 8, `策略数 ${cmp.rows.length}`);
  check(cmp.rows.every((r) => r.metrics || r.error), "每行有结果");
  check(cmp.best_sharpe && cmp.best_return, "有最优标记");
  console.log(`对比：${cmp.rows.map((r) => `${r.id} ${(r.metrics.total_return * 100).toFixed(0)}%`).join("  ")}`);

  const sweep = Bridge.sweep({
    symbol: "NVDA", interval: "1d", start: "2023-11-25", end: "2026-11-25",
    meta, strategyId: "sma_cross", params: { fast: 20, slow: 60 },
    cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false,
    sweepKey: "fast", min: 10, max: 30, step: 10,
  });
  check(sweep.rows.length === 3, `扫描点数 ${sweep.rows.length}`);
  check(sweep.rows.every((r) => "total_return" in r.metrics), "扫描字段映射");
  console.log(`扫描 fast：${sweep.rows.map((r) => `${r.value}→${(r.metrics.total_return * 100).toFixed(1)}%`).join("  ")}`);

  const cn = await Data.loadBars("600519", "1d", "2025-01-01", "2026-11-26").catch((e) => ({ error: e.message }));
  if (cn.error) {
    console.log("A 股直连跳过（Node 里没有 GBK 解码或网络受限）：" + cn.error);
  } else {
    check(cn.bars.length > 100, `A 股载入 ${cn.bars.length} 根`);
    check(cn.currency === "CNY", "A 股币种");
    check(cn.adjusted === true, "A 股前复权");
    console.log(`A 股 600519：${cn.bars.length} 根，${cn.start} → ${cn.end}，${cn.source}`);
  }

  if (failed) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log("\nBridge 端到端通过。");
})();
