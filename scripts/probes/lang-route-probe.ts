#!/usr/bin/env bun
/**
 * 语言路由是否值得做：先量化数据本身的语种构成，再看单语模型对混合文本的行为。
 *
 * 1) 1000 条标题按 CJK 字符占比分类：纯中文 / 混排 / 纯拉丁
 * 2) 抽 60 条混排标题：分别嵌入「整条」「仅中文段」「仅拉丁段」，
 *    看英文模型(nomic)的向量到底由哪一段决定 —— 若 cos(整条,拉丁段) > cos(整条,中文段)，
 *    说明中文在向量里几乎没有贡献，按语言路由会把这类行全部送错。
 */
import { resolveDataset } from "../../src/dataset.ts";
import path from "node:path";
import { readExcel } from "../../src/ingest.ts";
import { normalizeText } from "../../src/text.ts";

const dataRoot = process.argv[2] ?? "./data/dataset";
const skus = readExcel(resolveDataset(dataRoot).excel);

const cjkCount = (s: string) => (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
const latinCount = (s: string) => (s.match(/[A-Za-z0-9]/g) ?? []).length;
const cjkRatio = (s: string) => {
  const c = cjkCount(s), l = latinCount(s);
  return c + l === 0 ? 0 : c / (c + l);
};

const buckets = { pureZh: 0, mixed: 0, pureLatin: 0, empty: 0 };
for (const s of skus) {
  const t = normalizeText(s.title);
  if (!t) { buckets.empty++; continue; }
  const r = cjkRatio(t);
  if (r >= 0.9) buckets.pureZh++;
  else if (r <= 0.1) buckets.pureLatin++;
  else buckets.mixed++;
}
const n = skus.length;
console.log("语种构成:", JSON.stringify({
  pureZh: `${buckets.pureZh} (${(buckets.pureZh / n * 100).toFixed(1)}%)`,
  mixed: `${buckets.mixed} (${(buckets.mixed / n * 100).toFixed(1)}%)`,
  pureLatin: `${buckets.pureLatin} (${(buckets.pureLatin / n * 100).toFixed(1)}%)`,
  empty: buckets.empty,
}, null, 1));

// 混排比例分布的百分位
const ratios = skus.map((s) => cjkRatio(normalizeText(s.title))).sort((a, b) => a - b);
const pct = (p: number) => +ratios[Math.floor(p * (ratios.length - 1))]!.toFixed(3);
console.log("CJK 占比分位: p10", pct(0.1), "p25", pct(0.25), "p50", pct(0.5), "p75", pct(0.75), "p90", pct(0.9));

const BASE = process.env.RAG_EMBED_BASE_URL ?? "http://host.docker.internal:1234/v1";
const MODEL = process.env.RAG_EMBED_MODEL ?? "text-embedding-nomic-embed-text-v1.5";
async function embed(inputs: string[]): Promise<number[][]> {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  const j = (await r.json()) as { data?: { embedding: number[] }[] };
  if (!j.data) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.data.map((d) => d.embedding);
}
const cos = (a: number[], b: number[]) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return s / Math.sqrt(na * nb);
};

const sample = skus
  .map((s) => ({ s, t: normalizeText(s.title) }))
  .filter((x) => cjkRatio(x.t) > 0.1 && cjkRatio(x.t) < 0.9)
  .slice(0, 60);

const zhPart = (t: string) => (t.match(/[\u4e00-\u9fa5]+/g) ?? []).join(" ");
const latPart = (t: string) => (t.match(/[A-Za-z0-9][A-Za-z0-9.\-/]*/g) ?? []).join(" ");

const full = await embed(sample.map((x) => x.t));
const zh = await embed(sample.map((x) => zhPart(x.t) || "空"));
const lat = await embed(sample.map((x) => latPart(x.t) || "空"));

let zhCloser = 0, latCloser = 0;
const samples: unknown[] = [];
sample.forEach((x, i) => {
  const dz = cos(full[i]!, zh[i]!);
  const dl = cos(full[i]!, lat[i]!);
  if (dz > dl) zhCloser++; else latCloser++;
  if (samples.length < 5)
    samples.push({ title: x.t.slice(0, 46), cos_full_zh: +dz.toFixed(3), cos_full_lat: +dl.toFixed(3), driver: dz > dl ? "中文段" : "拉丁段" });
});
console.log(`\n混排样本 ${sample.length} 条，整条向量更接近：中文段 ${zhCloser} 条 / 拉丁段 ${latCloser} 条`);
console.log(JSON.stringify(samples, null, 1));
await Bun.write("./report/lang-route.json", JSON.stringify({ buckets, ratios: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) }, zhCloser, latCloser, samples }, null, 2));
