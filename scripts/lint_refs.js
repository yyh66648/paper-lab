/* 静态检查：app.js 里调用的函数是否都有定义。 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");

const defined = new Set();
for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) defined.add(m[1]);
for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(m[1]);
for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm)) defined.add(m[1]);
// 解构与对象字面量里的方法
for (const m of src.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) defined.add(m[1]);

const builtins = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new", "await", "async",
  "rgba", "rgb", "hsl", "hsla",
  "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Map", "Set",
  "Promise", "Error", "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "setTimeout", "clearTimeout", "requestAnimationFrame", "localStorage",
  "fetch", "Blob", "URL", "crypto", "ResizeObserver", "performance", "console", "alert",
  "confirm", "Number", "Intl", "structuredClone",
]);

// 全局对象（来自 engine.js / data.js / bridge.js）
const otherFiles = ["engine.js", "data.js", "bridge.js"].map((f) => fs.readFileSync(path.join(root, "docs", f), "utf8")).join("\n");
const globals = new Set();
for (const m of otherFiles.matchAll(/(?:^|\n)(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g)) globals.add(m[1]);
for (const m of otherFiles.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*[:(]/gm)) globals.add(m[1]);

const called = new Set();
for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);

// 局部箭头函数和回调参数不算未定义
const localArrows = new Set();
for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) localArrows.add(m[1]);
for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>/g)) localArrows.add(m[1]);
// 参数名
for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
  for (const part of m[1].split(",")) {
    const name = part.trim().split(/[=:\s]/)[0];
    if (name) localArrows.add(name);
  }
}
for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
  for (const part of m[1].split(",")) {
    const name = part.trim().split(/[=:\s]/)[0];
    if (name) localArrows.add(name);
  }
}
for (const m of src.matchAll(/(?:for\s*\(\s*(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g)) localArrows.add(m[1]);
for (const m of src.matchAll(/\.(?:map|filter|forEach|find|some|every|sort|reduce)\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)) localArrows.add(m[1]);

const missing = [...called]
  .filter((name) => !defined.has(name) && !builtins.has(name) && !globals.has(name) && !localArrows.has(name))
  .sort();
console.log("调用的函数名", called.size);
if (missing.length) {
  console.log("疑似未定义：" + missing.join(", "));
} else {
  console.log("所有调用都有对应定义。");
}

// 检查 $("id") 是否都在 HTML
const html = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
const missingIds = [...used].filter((id) => !ids.has(id));
if (missingIds.length) {
  console.log("HTML 缺失 id：" + missingIds.join(", "));
  process.exit(1);
}
console.log(`DOM id 检查通过（${used.size} 个）。`);
if (missing.length) process.exit(1);
