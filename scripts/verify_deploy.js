/* 确认线上部署包含最新功能。 */
const base = "https://yyh66648.github.io/paper-lab/";

(async () => {
  const checks = [
    ["app.js", ["stopLoss", "runRobust", "renderHeatmap", "applySweepMode"]],
    ["engine.js", ["stopLossPct", "takeProfitPct", "止盈", "止损"]],
    ["bridge.js", ["heatmap", "batch(", "stopLossPct"]],
    ["index.html", ["stopLoss", "robustBtn", "sweepMode"]],
  ];
  let bad = 0;
  for (const [file, needles] of checks) {
    const text = await (await fetch(base + file, { cache: "no-store" })).text();
    const missing = needles.filter((needle) => !text.includes(needle));
    if (missing.length) {
      bad++;
      console.log(`FAIL ${file} 缺少 ${missing.join(", ")}`);
    } else {
      console.log(`ok   ${file} 含 ${needles.join(", ")}`);
    }
  }
  if (bad) process.exit(1);
  console.log("\n线上已是最新版本。");
})();
