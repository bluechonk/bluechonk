#!/usr/bin/env node
/**
 * 拉取 README 引用的外部统计卡片，落成静态 SVG。
 *
 * 为什么要静态化：这些卡片服务跑在共享出口上，没有自己的 GitHub token，
 * 每次渲染都要打几十次 GitHub API（尤其 include_all_commits），很容易被限流。
 * 表现就是 README 里某张卡突然变成 "Something went wrong!"，而同一页其他卡正常。
 * 静态化后，渲染不再依赖上游实时可用性；卡片内容由定时 workflow 刷新。
 *
 * 零依赖，只用 Node 内置 fetch（>= 18）。
 * 用法：node scripts/fetch-stats.mjs [--out <目录>]
 *
 * 本机需要代理时：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/fetch-stats.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 卡片清单：name 决定输出文件名，theme 只是给日志与人看 */
const ASSETS = [
  { name: "banner-dark", theme: "dark", url: "https://capsule-render.vercel.app/api?type=waving&color=4f6ef7&height=110&section=header&text=Hi%20there%2C%20I%27m%20bluechonk&fontSize=40&fontColor=ffffff&animation=fadeIn" },
  { name: "banner-light", theme: "light", url: "https://capsule-render.vercel.app/api?type=waving&color=4f6ef7&height=110&section=header&text=Hi%20there%2C%20I%27m%20bluechonk&fontSize=40&fontColor=1f3f73&theme=light&animation=fadeIn" },
  { name: "views", theme: "flat", url: "https://komarev.com/ghpvc/?username=bluechonk&color=4f6ef7&style=flat-square&label=Profile+Views" },
  { name: "followers", theme: "flat", url: "https://img.shields.io/github/followers/bluechonk?label=Followers&style=flat-square&color=4f6ef7" },
  { name: "stars", theme: "flat", url: "https://img.shields.io/github/stars/bluechonk?label=Profile+Stars&style=flat-square&color=4f6ef7" },
  // 刻意不带 count_private：统计私有提交需要 GitHub token，该服务没有，
  // 带上必然返回错误卡（实测 3/3 报错，去掉后 3/3 正常）。
  { name: "stats-dark", theme: "dark", url: "https://github-stats-extended.vercel.app/api?username=bluechonk&show_icons=true&theme=dark&include_all_commits=true&hide_border=true&icon_color=4c7fc9" },
  { name: "stats-light", theme: "default", url: "https://github-stats-extended.vercel.app/api?username=bluechonk&show_icons=true&theme=default&include_all_commits=true&hide_border=true&icon_color=1f3f73" },
  { name: "langs-dark", theme: "dark", url: "https://github-stats-extended.vercel.app/api/top-langs/?username=bluechonk&layout=compact&langs_count=8&theme=dark&hide_border=true" },
  { name: "langs-light", theme: "default", url: "https://github-stats-extended.vercel.app/api/top-langs/?username=bluechonk&layout=compact&langs_count=8&theme=default&hide_border=true" },
  { name: "streak-dark", theme: "dark", url: "https://github-readme-streak-stats.herokuapp.com/?user=bluechonk&theme=dark&hide_border=true&card_width=810" },
  { name: "streak-light", theme: "light", url: "https://github-readme-streak-stats.herokuapp.com/?user=bluechonk&theme=light&hide_border=true&card_width=810" },
];

const TIMEOUT_MS = 45_000;
const RETRIES = 3;

/**
 * 判定响应体是不是一张真卡片。
 *
 * 两道检查缺一不可：
 *   1. 必须是 SVG——上游出错时返回的同样是 200 + SVG（就是那张 "Something went
 *      wrong!" 错误卡），只看状态码会把错误卡当成功写进仓库。
 *   2. 不能是错误卡——错误卡体积只有几百字节，但内容特征更明确，直接认文案。
 */
function looksLikeCard(text) {
  const body = text.replace(/^﻿/u, "").trimStart();
  const head = body.slice(0, 200).toLowerCase();
  if (!head.startsWith("<")) return { ok: false, reason: "响应不是 XML/SVG" };
  if (!head.startsWith("<svg") && !head.startsWith("<?xml")) {
    return { ok: false, reason: "响应不是 SVG" };
  }
  if (/something went wrong|data-testid="message"/u.test(body)) {
    return { ok: false, reason: "上游返回的是错误卡" };
  }
  return { ok: true };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function download(asset) {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(asset.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "bluechonk-profile-stats/1.0" },
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
      } else {
        const text = await res.text();
        const card = looksLikeCard(text);
        if (!card.ok) {
          // 内容不对（错误卡、HTML 错误页等）：重试同样无望，直接放弃这张
          lastError = `${card.reason}（前 60 字符：${text.slice(0, 60).replace(/\s+/gu, " ")}）`;
          break;
        }
        return { ok: true, text, bytes: Buffer.byteLength(text, "utf8") };
      }
    } catch (error) {
      lastError = error?.cause?.code ?? error?.name ?? error?.message ?? String(error);
    }
    if (attempt < RETRIES) await sleep(1000 * attempt);
  }
  return { ok: false, error: lastError };
}

function parseArgs(argv) {
  const out = { outDir: "dist/stats" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.outDir = argv[i + 1];
  }
  return out;
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const absOut = resolve(outDir);
  mkdirSync(absOut, { recursive: true });

  let failed = 0;
  for (const asset of ASSETS) {
    const result = await download(asset);
    if (!result.ok) {
      failed += 1;
      console.error(`✗ ${asset.name}（${asset.theme}）：${result.error}`);
      continue;
    }
    writeFileSync(join(absOut, `${asset.name}.svg`), result.text, "utf8");
    console.log(`✓ ${asset.name}（${asset.theme}）：${result.bytes} bytes`);
  }

  if (failed > 0) {
    console.error(`\n${failed} 张卡片拉取失败，未写入。`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n已写入 ${ASSETS.length} 张卡片到 ${absOut}`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
