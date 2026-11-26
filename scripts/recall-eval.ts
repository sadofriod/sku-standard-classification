#!/usr/bin/env bun
/**
 * 召回率实验：模型强弱 vs 检索设计，谁决定候选品名召回。
 *
 * 任务：给一条商品标题，从 385 个标准品名里召回正确的那个（k=1/5/10）。
 * 真值：输入行的「商品品名」（已知有噪声：24 行标题反证、441 行口径冲突不影响品名；按折分开验证）。
 * 防泄漏：文档里的「典型标题」只取 A 折（sourceRow 偶数），召回只在 B 折（奇数）上算。
 *
 * 三个索引变体：
 *   A 仅品名
 *   B 品名 + 小类 + 属性名列表
 *   C B + 3 条 A 折典型标题（= 本项目图谱语料的实际内容）
 * 另加两个零成本基线：词面命中（标题是否含该品名）、同小类扩展（top1 与真值同小类即可由图谱边救回）。
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import path from "node:path";
import { Ontology } from "../src/ontology.ts";
import { readExcel } from "../src/ingest.ts";
import { normalizeText } from "../src/text.ts";

const dataRoot = process.argv[2] ?? "./data/dataset";
const BASE = process.env.RAG_EMBED_BASE_URL ?? "http://host.docker.internal:1234/v1";
const MODEL = process.env.RAG_EMBED_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

const onto = ontologyFrom(dataRoot);
const skus = readExcel(resolveDataset(dataRoot).excel);

const level1 = "办公设备及耗材";
const pins = [...onto.catalog.values()].filter((p) => p.level1 === level1).map((p) => p.level4);
const pinIndex = new Map(pins.map((p, i) => [p, i]));
const pinLevel3 = new Map(pins.map((p) => [p, onto.catalog.get(p)!.level3]));

const foldA = skus.filter((s) => s.sourceRow % 2 === 0); // 提供样例标题
const foldB = skus.filter((s) => s.sourceRow % 2 === 1); // 只在 B 上评估

const titlesA = new Map<string, string[]>();
for (const s of foldA) {
  const arr = titlesA.get(s.pinming) ?? titlesA.set(s.pinming, []).get(s.pinming)!;
  if (arr.length < 3) arr.push(s.title);
}

function docText(pin: string, variant: "A" | "B" | "C"): string {
  const p = onto.catalog.get(pin)!;
  if (variant === "A") return pin;
  const attrs = onto.attrDefs(pin).map((d) => d.name).join(" ");
  const base = `${pin} 属于 ${p.level2} / ${p.level3}，属性包括：${attrs}`;
  if (variant === "B") return base;
  return `${base}。典型商品标题：${(titlesA.get(pin) ?? []).join(" ； ")}`;
}

async function embed(inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  const B = 32;
  for (let i = 0; i < inputs.length; i += B) {
    const chunk = inputs.slice(i, i + B);
    const r = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: chunk }),
    });
    if (!r.ok) throw new Error(`embed ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    for (const d of j.data) out.push(d.embedding);
    process.stderr.write(`\rembedded ${Math.min(i + B, inputs.length)}/${inputs.length}   `);
  }
  process.stderr.write("\n");
  return out;
}

const cos = (a: number[], b: number[]) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return s / Math.sqrt(na * nb);
};

const queries = foldB.filter((s) => pinIndex.has(s.pinming));
console.log(`候选品名 ${pins.length}，A 折 ${foldA.length} 行，B 折评估 ${queries.length} 行，模型 ${MODEL}`);

const qVecs = await embed(queries.map((q) => normalizeText(q.title)));

const results: Record<string, unknown>[] = [];
for (const variant of ["A", "B", "C"] as const) {
  const dVecs = await embed(pins.map((p) => docText(p, variant)));
  let r1 = 0, r5 = 0, r10 = 0, sameL3 = 0;
  const misses: { row: number; truth: string; top1: string; title: string }[] = [];
  queries.forEach((q, i) => {
    const scored = dVecs
      .map((v, idx) => ({ pin: pins[idx]!, s: cos(qVecs[i]!, v) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10);
    const rank = scored.findIndex((x) => x.pin === q.pinming);
    if (rank === 0) r1++;
    if (rank > -1 && rank < 5) r5++;
    if (rank > -1) r10++;
    const hitL3 = scored.some((x) => pinLevel3.get(x.pin) === pinLevel3.get(q.pinming));
    if (hitL3) sameL3++;
    if (rank !== 0 && misses.length < 12)
      misses.push({ row: q.sourceRow, truth: q.pinming, top1: scored[0]!.pin, title: q.title.slice(0, 40) });
  });
  const n = queries.length;
  results.push({
    variant,
    recallAt1: +(r1 / n).toFixed(4),
    recallAt5: +(r5 / n).toFixed(4),
    recallAt10: +(r10 / n).toFixed(4),
    sameLevel3At10: +(sameL3 / n).toFixed(4),
    misses: misses.slice(0, 6),
  });
  console.log(JSON.stringify(results.at(-1), null, 2));
}

// 零成本基线：标题里是否字面含正确品名
let lexical = 0;
for (const q of queries) if (normalizeText(q.title).includes(q.pinming)) lexical++;
console.log(`词面命中（标题含正确品名）：${lexical}/${queries.length} = ${(lexical / queries.length).toFixed(4)}`);
console.log(`正确品名在小类层面可接受的比率上限（同小类扩展）：见各变体 sameLevel3At10`);

await Bun.write("./report/recall-eval.json", JSON.stringify({ model: MODEL, pins: pins.length, queries: queries.length, results, lexical: +(lexical / queries.length).toFixed(4) }, null, 2));
