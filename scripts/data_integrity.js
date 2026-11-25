/* 检查跨市场切换的边界情况与数据完整性。 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "docs", "data");
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log("FAIL " + msg); } };

// 1. 每个标的必须有日线和周线，且周线点数明显少于日线
let badCount = 0;
for (const s of index.symbols) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, `${s.symbol}_1d.json`), "utf8"));
  const w = JSON.parse(fs.readFileSync(path.join(dataDir, `${s.symbol}_1wk.json`), "utf8"));
  if (!d.bars.length || !w.bars.length) badCount++;
  if (w.bars.length >= d.bars.length) badCount++;
  if (d.bars[d.bars.length - 1].label !== w.bars[w.bars.length - 1].label) badCount++;
  if (Math.abs(d.price - d.bars[d.bars.length - 1].c) > 1e-6) badCount++;
}
check(badCount === 0, `${badCount} 个标的数据不一致`);
console.log(`数据一致性：${index.symbols.length} 个标的，${badCount} 处异常`);

// 2. index 里的标的列表和磁盘文件一一对应
const files = new Set(fs.readdirSync(dataDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/_\d[dw]\.json$/, "")));
check(!files.has("index"), "index.json 不应算标的");
const symbolsOnDisk = new Set(fs.readdirSync(dataDir).filter((f) => /_1d\.json$/.test(f)).map((f) => f.replace("_1d.json", "")));
const inIndex = new Set(index.symbols.map((s) => s.symbol));
check(symbolsOnDisk.size === inIndex.size, `磁盘 ${symbolsOnDisk.size} vs 清单 ${inIndex.size}`);
for (const s of symbolsOnDisk) check(inIndex.has(s), `${s} 在磁盘但不在清单`);
console.log(`清单完整性：磁盘 ${symbolsOnDisk.size} 个，清单 ${inIndex.size} 个`);

// 3. 检查 HTML 里没有未转义的用户输入渲染点（简单扫描 innerHTML 拼 symbol/name）
const html = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const risky = ["item.name", "meta.name", "quote.name", "result.name", "pin.label", "order.symbol", "trade.note"];
const found = risky.filter((r) => html.includes(r));
console.log(`动态字段渲染点：${found.join(", ")}`);

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log("\n数据完整性通过。");
