// GitHub Pagesはリポジトリ直下から配信するため、直下のファイル配置は変えない。
// Capacitor(ネイティブアプリ)用に、同じ内容を www/ へコピーするだけの同期スクリプト。
const fs = require("fs");
const path = require("path");

const root = __dirname;
const dest = path.join(root, "www");

const items = ["index.html", "quickadd.html", "overlaybridge.html", "styles.css", "sw.js", "manifest.webmanifest", "src", "icons"];

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const item of items) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) copyRecursive(src, path.join(dest, item));
}
console.log("synced to www/");
