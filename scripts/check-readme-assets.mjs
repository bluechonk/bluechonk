#!/usr/bin/env node
/**
 * 校验 README 的图片引用，挡住两类回退：
 *
 *   1. 引用了本地文件却不存在——多半是改名或删文件后忘了改 README；
 *   2. 又把图片指回实时图床——这正是本次静态化要消除的故障源
 *      （上游返回 200 + 错误卡，页面就显示 "Something went wrong!"）。
 *
 * @stats 分支的文件不在本仓库工作区里，需要从 git ref 读，所以 CI 会先
 * fetch 该分支；本地直接跑时若没有该 ref 会明确报错而不是静默放过。
 *
 * 零依赖。用法：node scripts/check-readme-assets.mjs [--stats-ref <ref>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** 这些实时图床已经静态化，README 里再出现就是回退 */
const REMOTE_IMAGE_HOSTS = [
  "vercel.app",
  "herokuapp.com",
  "komarev.com",
  "shields.io",
  "raw.githubusercontent.com",
];

/** 由各自 workflow 维护的 jsdelivr 分支，允许直接引用 */
const ALLOWED_JSDELIVR_BRANCHES = new Set(["github-snake"]);

function parseArgs(argv) {
  const out = { statsRef: "origin/stats" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--stats-ref") out.statsRef = argv[i + 1];
  }
  return out;
}

function statsFiles(ref) {
  try {
    const out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { encoding: "utf8" });
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/** 取出 README 里所有 src / srcset 属性值（srcset 可能有逗号分隔的多项） */
function imageRefs(markdown) {
  const refs = [];
  for (const [, value] of markdown.matchAll(/\b(?:src|srcset)="([^"]*)"/gu)) {
    for (const part of value.split(",")) {
      const url = part.trim().split(/\s+/u)[0] ?? "";
      if (url) refs.push(url);
    }
  }
  return [...new Set(refs)];
}

function main() {
  const { statsRef } = parseArgs(process.argv.slice(2));
  const markdown = readFileSync("README.md", "utf8");
  const refs = imageRefs(markdown);

  const stats = statsFiles(statsRef);
  if (stats === null) {
    console.error(`读不到 git ref \`${statsRef}\`：先 fetch 它（CI 里已自动做，本地跑请先 fetch）`);
    process.exit(2);
  }

  const errors = [];

  for (const ref of refs) {
    if (!/^https?:\/\//u.test(ref)) {
      // 相对路径：必须是仓库里真实存在的文件
      if (!existsSync(ref)) errors.push(`本地引用不存在：${ref}`);
      continue;
    }

    const url = new URL(ref);
    if (url.host === "cdn.jsdelivr.net") {
      const m = /^\/gh\/[^/]+\/[^/]+@([^/]+)\/(.+)$/u.exec(url.pathname);
      if (!m) {
        errors.push(`jsdelivr 引用格式无法解析：${ref}`);
        continue;
      }
      const [, branch, path] = m;
      if (ALLOWED_JSDELIVR_BRANCHES.has(branch)) continue;
      if (branch !== "stats") {
        errors.push(`非预期分支 \`@${branch}\`：${ref}`);
        continue;
      }
      if (!stats.has(path)) errors.push(`stats 分支上没有该文件：${path}`);
      continue;
    }

    if (REMOTE_IMAGE_HOSTS.some((host) => url.host === host || url.host.endsWith(`.${host}`))) {
      errors.push(`图片指回了实时图床 ${url.host}：${ref}`);
      continue;
    }

    // 其余外部地址（如纯链接）不在本检查范围
  }

  if (errors.length > 0) {
    console.error(`README 图片引用有 ${errors.length} 处不合规：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(`README 图片引用合规：${refs.length} 条，stats 分支 ${stats.size} 个文件。`);
}

main();
