#!/usr/bin/env bun
/**
 * 词面基线（BM25，中文字符 bigram）：不依赖任何模型，测候选品名召回。
 * 与 recall-eval.ts 用同一折划分，便于直接对比"向量模型 vs 词面"。
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import path from "node:path";
import { Ontology } from "../src/ontology.ts";
import { readExcel } from "../src/ingest.ts";
import { normalizeText } from "../src/text.ts";

const dataRoot = process.argv[2] ?? "./data/dataset";
const onto = ontologyFrom(dataRoot);
const skus = readExcel(resolveDataset(dataRoot).excel);
const pins = [...onto.catalog.values()].filter((p) => p.level1 === "办公设备及耗材").map((p) => p.level4);
const level3 = new Map(pins.map((p) => [p, onto.catalog.get(p)!.level3]));

const foldA = skus.filter((s) => s.sourceRow % 2 === 0);
const foldB = skus.filter((s) => s.sourceRow % 2 === 1);
const titlesA = new Map<string, string[]>();
for (const s of foldA) {
  const a = titlesA.get(s.pinming) ?? titlesA.set(s.pinming, []).get(s.pinming)!;
  if (a.length < 3) a.push(s.title);
}

/** 中文字符 bigram + 字母数字词，去停用式噪声 */
function tokens(s: string): string[] {
  const t = normalizeText(s).toLowerCase().replace(/[()（）:：,，.。/、\-]/g, " ");
  const out: string[] = [];
  for (const part of t.split(/\s+/).filter(Boolean)) {
    const cjk = part.match(/[\u4e00-\u9fa5]+/g) ?? [];
    for (const run of cjk) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
    for (const w of part.match(/[a-z0-9]+/g) ?? []) out.push(w);
  }
  return out;
}

function docFor(pin: string, variant: "A" | "B" | "C"): string {
  const p = onto.catalog.get(pin)!;
  if (variant === "A") return pin;
  const attrs = onto.attrDefs(pin).map((d) => d.name).join(" ");
  const base = `${pin} ${p.level2} ${p.level3} ${attrs}`;
  return variant === "B" ? base : `${base} ${(titlesA.get(pin) ?? []).join(" ")}`;
}

function bm25Retrieve(docs: string[][], query: string[], k = 10) {
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const k1 = 1.2, b = 0.75;
  const scores = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const q of query) {
      const f = tf.get(q);
      if (!f) continue;
      s += idf(q) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
    }
    return s;
  });
  return scores.map((s, i) => ({ i, s })).sort((a, b2) => b2.s - a.s).slice(0, k);
}

const out: Record<string, unknown>[] = [];
for (const variant of ["A", "B", "C"] as const) {
  const docs = pins.map((p) => tokens(docFor(p, variant)));
  const queries = foldB.filter((s) => pins.includes(s.pinming));
  let r1 = 0, r5 = 0, r10 = 0, sameL3 = 0, expandedHit = 0;
  const expandSizes: number[] = [];
  const misses: unknown[] = [];
  for (const q of queries) {
    const top = bm25Retrieve(docs, tokens(q.title), 10);
    const names = top.map((x) => pins[x.i]!);
    const rank = names.indexOf(q.pinming);
    if (rank === 0) r1++;
    if (rank > -1 && rank < 5) r5++;
    if (rank > -1) r10++;
    if (top.some((x) => level3.get(pins[x.i]!) === level3.get(q.pinming))) sameL3++;

    // 图谱扩展：取 top5 的小类，展开该小类下全部品名 —— 这是"社区/小类边"能带来的召回增益
    const l3 = new Set(names.slice(0, 5).map((n) => level3.get(n)));
    const expanded = new Set(names.slice(0, 5));
    for (const p of pins) if (l3.has(level3.get(p))) expanded.add(p);
    if (expanded.has(q.pinming)) expandedHit++;
    expandSizes.push(expanded.size);

    if (rank !== 0 && misses.length < 5)
      misses.push({ row: q.sourceRow, truth: q.pinming, top1: names[0], title: q.title.slice(0, 40) });
  }
  const n = queries.length;
  out.push({
    variant,
    recallAt1: +(r1 / n).toFixed(4),
    recallAt5: +(r5 / n).toFixed(4),
    recallAt10: +(r10 / n).toFixed(4),
    sameLevel3At10: +(sameL3 / n).toFixed(4),
    expandedRecall: +(expandedHit / n).toFixed(4),
    expandedSetSizeMedian: expandSizes.sort((a, b) => a - b)[Math.floor(expandSizes.length / 2)],
    misses,
  });
  console.log(JSON.stringify(out.at(-1), null, 2));
}
await Bun.write("./report/lexical-eval.json", JSON.stringify({ pins: pins.length, queries: foldB.length, out }, null, 2));
