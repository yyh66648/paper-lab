/* 一键跑完全部检查。任何一项失败就返回非零。 */
const { execFileSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const node = process.execPath;

const steps = [
  ["语法检查", ["--check", path.join(root, "docs", "engine.js")]],
  ["语法检查 app", ["--check", path.join(root, "docs", "app.js")]],
  ["语法检查 data", ["--check", path.join(root, "docs", "data.js")]],
  ["语法检查 bridge", ["--check", path.join(root, "docs", "bridge.js")]],
  ["引用检查", [path.join(root, "scripts", "lint_refs.js")]],
  ["Python 引擎自检", null],
  ["Python/JS 一致性", [path.join(root, "scripts", "parity.js")]],
  ["止损止盈", [path.join(root, "scripts", "risk_test.js")]],
  ["空头风控", [path.join(root, "scripts", "short_risk_test.js")]],
  ["整手与 T+1", [path.join(root, "scripts", "lot_test.js")]],
  ["二维扫描", [path.join(root, "scripts", "heatmap_test.js")]],
  ["批量稳健性", [path.join(root, "scripts", "batch_test.js")]],
  ["端到端", [path.join(root, "scripts", "smoke.js")]],
  ["全量审计", [path.join(root, "scripts", "audit.js")]],
];

let failed = 0;
const results = [];
for (const [name, args] of steps) {
  const started = Date.now();
  try {
    let output;
    if (args === null) {
      output = execFileSync("python", [path.join(root, "run.py"), "--selftest"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } else {
      output = execFileSync(node, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    }
    const took = ((Date.now() - started) / 1000).toFixed(1);
    const tail = output.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
    results.push(`ok   ${name.padEnd(16)} ${took}s  ${tail.slice(0, 70)}`);
  } catch (error) {
    failed++;
    const took = ((Date.now() - started) / 1000).toFixed(1);
    const msg = (error.stdout || "") + (error.stderr || "");
    results.push(`FAIL ${name.padEnd(16)} ${took}s`);
    results.push("     " + msg.trim().split("\n").slice(-6).join("\n     "));
  }
}

console.log(results.join("\n"));
console.log(failed ? `\n${failed} 项失败，共 ${steps.length} 项。` : `\n全部 ${steps.length} 项通过。`);
process.exit(failed ? 1 : 0);
