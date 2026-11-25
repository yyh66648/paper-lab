/* 对比 Python 与 JS 引擎在同一份数据上的结果。 */
const fs = require("fs");
const path = require("path");
const engine = require(path.join(__dirname, "..", "docs", "engine.js"));

const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "cache", "_parity.json"), "utf8"));
const bars = payload.bars;

const cases = [
  ["sma_cross", { fast: 20, slow: 60 }],
  ["bollinger", { period: 20, k: 2.0 }],
  ["macd", {}],
  ["donchian", {}],
];

let failed = 0;
const close = (a, b, tol) => Math.abs(a - b) <= tol;

for (const [id, params] of cases) {
  const { strategy } = engine.createStrategy(id, params);
  const raw = engine.runBacktest(bars, strategy, {
    cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false, symbol: "NVDA",
  });
  const m = engine.summarize(100000, raw.equity, raw.trades, raw.fees, "1d");
  const sp = engine.splitReport(100000, raw.equity, "1d");
  const expected = payload.python[id];
  const got = {
    total_return: m.totalReturn,
    sharpe: m.sharpe,
    max_drawdown: m.maxDrawdown,
    trades: m.trades,
    fees: m.fees,
    ending_equity: m.endingEquity,
    win_rate: m.winRate,
    volatility: m.volatility,
    exposure: m.exposure,
    split_in: sp ? sp.inSample.totalReturn : null,
    split_out: sp ? sp.outOfSample.totalReturn : null,
  };
  const diffs = [];
  for (const key of ["total_return", "sharpe", "max_drawdown", "fees", "ending_equity", "volatility", "exposure", "win_rate", "split_in", "split_out"]) {
    const a = expected[key];
    const b = got[key];
    if (a === null && b === null) continue;
    if (a === null || b === null || !close(a, b, 1e-6)) diffs.push(`${key}: python=${a} js=${b}`);
  }
  if (expected.trades !== got.trades) diffs.push(`trades: python=${expected.trades} js=${got.trades}`);
  if (diffs.length) {
    failed++;
    console.log(`FAIL ${id}`);
    diffs.forEach((d) => console.log("   " + d));
  } else {
    console.log(`ok   ${id}  ret=${(m.totalReturn * 100).toFixed(2)}% trades=${m.trades} sharpe=${m.sharpe?.toFixed(3)}`);
  }
}

if (failed) {
  console.log(`\n${failed} 个策略结果不一致`);
  process.exit(1);
}
console.log("\nJS 引擎与 Python 结果一致。");
