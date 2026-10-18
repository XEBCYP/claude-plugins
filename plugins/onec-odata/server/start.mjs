// Запуск MCP-сервера @theyahia/aprovodka с зависимостями, закреплёнными в package-lock.json.
// Вместо `npx -y` (который подбирает транзитивные версии заново при каждой установке):
// `npm ci --ignore-scripts` по lock-файлу в отдельную папку, затем запуск пакета.
// stdout принадлежит протоколу MCP, поэтому весь вывод установки — в stderr.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lock = readFileSync(join(here, "package-lock.json"));
const key = createHash("sha256").update(lock).digest("hex").slice(0, 12);

// Постоянная папка плагина, если Claude Code её передал; иначе — рядом со скриптом.
const data = process.env.ONEC_ODATA_DATA_DIR;
const base = data && !data.includes("${") ? data : join(here, ".deps");
const target = join(base, key);
const entry = join(target, "node_modules", "@theyahia", "aprovodka", "dist", "index.js");

if (!existsSync(entry)) {
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  copyFileSync(join(here, "package.json"), join(tmp, "package.json"));
  copyFileSync(join(here, "package-lock.json"), join(tmp, "package-lock.json"));
  console.error(`onec-odata: устанавливаю зависимости по package-lock.json в ${target}`);
  const r = spawnSync("npm ci --ignore-scripts --omit=dev --no-audit --no-fund", {
    cwd: tmp,
    shell: true,
    stdio: ["ignore", 2, 2],
  });
  if (r.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    console.error(`onec-odata: npm ci завершился с кодом ${r.status}`);
    process.exit(1);
  }
  try {
    renameSync(tmp, target);
  } catch {
    // Другая сессия успела поставить ту же версию — пользуемся её папкой.
    rmSync(tmp, { recursive: true, force: true });
  }
}

await import(pathToFileURL(entry).href);
