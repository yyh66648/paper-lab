/* 全量验收：所有标的所有周期跑所有策略，检查数据与引擎的边界。 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "docs", "data");
const Engine = require(path.join(root, "docs", "engine.js"));

const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const catalog = Engine.strategyCatalog();
let problems = 0;
const report = (msg) => {
  problems++;
  if (problems <= 40) console.log("  " + msg);
};

const dataIssues = new Map();
function checkBars(symbol, interval, bars) {
  if (!Array.isArray(bars) || bars.length < 2) return report(`${symbol} ${interval}: K 线不足 ${bars?.length}`);
  let prev = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    for (const key of ["t", "o", "h", "l", "c", "v"]) {
      if (!Number.isFinite(b[key])) return report(`${symbol} ${interval}[${i}]: ${key} 不是有限数`);
    }
    if (b.t <= prev) return report(`${symbol} ${interval}[${i}]: 时间戳没有递增`);
    prev = b.t;
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)) return report(`${symbol} ${interval}[${i}]: 有非正价格`);
    if (b.h < Math.max(b.o, b.c) - 1e-6) {
      dataIssues.set(symbol, (dataIssues.get(symbol) || 0) + 1);
    }
    if (b.l > Math.min(b.o, b.c) + 1e-6) {
      dataIssues.set(symbol, (dataIssues.get(symbol) || 0) + 1);
    }
    if (b.h < b.l - 1e-6) return report(`${symbol} ${interval}[${i}]: 最高价低于最低价`);
  }
}

let runs = 0;
let totalTrades = 0;
const started = Date.now();
const shape = [];

for (const entry of index.symbols) {
  for (const interval of ["1d", "1wk"]) {
    const file = path.join(dataDir, `${entry.symbol}_${interval}.json`);
    if (!fs.existsSync(file)) {
      report(`${entry.symbol} ${interval}: 缺少数据文件`);
      continue;
    }
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    checkBars(entry.symbol, interval, payload.bars);
    const bars = payload.bars;
    for (const item of catalog) {
      try {
        const { strategy } = Engine.createStrategy(item.id, {});
        const raw = Engine.runBacktest(bars, strategy, {
          cash: 100000, commissionBps: 1, slippageBps: 5, allowShort: false, symbol: entry.symbol,
        });
        if (raw.equity.length !== bars.length) report(`${entry.symbol} ${interval} ${item.id}: 净值长度不符`);
        if (raw.equity.some((row) => !Number.isFinite(row.equity))) report(`${entry.symbol} ${interval} ${item.id}: 净值有 NaN`);
        if (raw.equity.some((row) => row.equity < 0)) report(`${entry.symbol} ${interval} ${item.id}: 净值为负`);
        const metrics = Engine.summarize(100000, raw.equity, raw.trades, raw.fees, interval);
        for (const key of ["totalReturn", "maxDrawdown"]) {
          if (metrics[key] !== null && !Number.isFinite(metrics[key])) report(`${entry.symbol} ${interval} ${item.id}: ${key} 非有限`);
        }
        if (metrics.maxDrawdown > 1e-9) report(`${entry.symbol} ${interval} ${item.id}: 最大回撤为正`);
        totalTrades += raw.trades.length;
        runs++;
      } catch (error) {
        report(`${entry.symbol} ${interval} ${item.id}: 回测抛错 ${error.message}`);
      }
    }
    shape.push({ symbol: entry.symbol, interval, bars: bars.length, first: bars[0].label, last: bars[bars.length - 1].label });
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(2);
console.log(`回测 ${runs} 次，成交 ${totalTrades} 笔，耗时 ${elapsed}s`);
console.log(`日线区间：${shape.filter((s) => s.interval === "1d").length} 个标的`);
if (dataIssues.size) {
  console.log(`K 线高低价不自洽的标的有 ${dataIssues.size} 个：` + [...dataIssues.entries()].slice(0, 8).map(([s, n]) => `${s}(${n})`).join(" "));
}
if (problems) {
  console.log(`\n${problems} 个问题`);
  process.exit(1);
}
console.log("全部通过。");
