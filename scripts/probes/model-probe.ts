#!/usr/bin/env bun
/**
 * 模型强弱对比（判定 + 抽取，不跑全量建图）：
 * 给同一批 SKU、同一批候选品名、同一张属性模板，比较两个模型的
 *   JSON 合法率 / 选品名正确率 / 属性名合法率（幻觉属性）/ 必填覆盖 / 耗时。
 */
import { ontologyFrom } from "../../src/dataset.ts";
import { resolveDataset } from "../../src/dataset.ts";
import path from "node:path";
import { Ontology } from "../../src/ontology.ts";
import { readExcel } from "../../src/ingest.ts";

const BASE = process.env.RAG_SLICE_BASE_URL ?? "http://host.docker.internal:1234/v1";
const MODELS = (process.env.PROBE_MODELS ?? "qwen2.5-0.5b-instruct-mlx,google/gemma-4-12b").split(",");

const dataRoot = process.argv[2] ?? "./data/dataset";
const onto = ontologyFrom(dataRoot);
const skus = readExcel(resolveDataset(dataRoot).excel);

// 取 3 个不同品名的样本（覆盖不同属性数量）
const targets = ["硒鼓", "中性笔", "插座"];
const samples = targets
  .map((p) => skus.find((s) => s.pinming === p))
  .filter((s): s is NonNullable<typeof s> => !!s);

function candidates(truth: string, k = 8): string[] {
  const p = onto.catalog.get(truth)!;
  const same = onto.siblings(truth).slice(0, k - 2);
  const base = [...same, truth];
  while (base.length < k) base.push([...onto.pinsByLevel3.keys()][base.length % 50] ?? "其他");
  return [...new Set(base)];
}

function prompt(sku: (typeof samples)[number], cands: string[]) {
  return `你是商品分类与属性抽取引擎。只输出 JSON，不要解释。

商品标题：${sku.title}
品牌：${sku.brandRaw}
制造商型号：${sku.modelRaw}
销售单位：${sku.unit}

任务一：从候选品名中选出最适合这件商品的一个：
${cands.map((c, i) => `${i + 1}. ${c}`).join("\n")}

任务二：按该品名的属性模板抽取属性。模板（属性名 | 是否必填 | 字段类型 | 枚举值）：
${(onto.attrDefs(sku.pinming) ?? []).map((d) => `${d.name} | ${d.required ? "必填" : "选填"} | ${d.fieldType} | ${d.enumValues.join("/") || "-"}`).join("\n")}

输出格式：
{"pinming":"选中的品名","attributes":{"属性名":"值"}}`;
}

function extractJson(text: string): unknown | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const rows: Record<string, unknown>[] = [];
for (const model of MODELS) {
  for (const sku of samples) {
    const cands = candidates(sku.pinming);
    const t0 = Date.now();
    let content = "";
    let err = "";
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt(sku, cands) }],
          temperature: 0,
          max_tokens: 1200,
        }),
      });
      const j = (await r.json()) as { choices: { message: { content: string; reasoning_content?: string } }[] };
      content = j.choices[0]?.message?.content ?? "";
      if (!content) err = `empty content (reasoning ${j.choices[0]?.message?.reasoning_content?.length ?? 0} chars)`;
    } catch (e) {
      err = (e as Error).message.slice(0, 120);
    }
    const ms = Date.now() - t0;
    const parsed = extractJson(content) as { pinming?: string; attributes?: Record<string, string> } | null;
    const defs = onto.attrDefs(sku.pinming);
    const schemaNames = new Set(defs.map((d) => d.name));
    const got = Object.keys(parsed?.attributes ?? {});
    const hallucinated = got.filter((n) => !schemaNames.has(n));
    const required = defs.filter((d) => d.required).map((d) => d.name);
    const requiredFilled = required.filter((n) => parsed?.attributes?.[n]);
    rows.push({
      model,
      row: sku.sourceRow,
      truth: sku.pinming,
      picked: parsed?.pinming ?? null,
      pickedCorrect: parsed?.pinming === sku.pinming,
      jsonValid: !!parsed,
      attrCount: got.length,
      hallucinatedAttrs: hallucinated,
      requiredTotal: required.length,
      requiredFilled: requiredFilled.length,
      ms,
      err,
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
}

const summary = MODELS.map((m) => {
  const r = rows.filter((x) => x.model === m) as typeof rows as any[];
  const n = r.length || 1;
  return {
    model: m,
    runs: n,
    jsonValidRate: +(r.filter((x) => x.jsonValid).length / n).toFixed(3),
    pickAccuracy: +(r.filter((x) => x.pickedCorrect).length / n).toFixed(3),
    hallucinatedAttrs: r.reduce((a, x) => a + (x.hallucinatedAttrs?.length ?? 0), 0),
    requiredFillRate: +(r.reduce((a, x) => a + x.requiredFilled, 0) / Math.max(1, r.reduce((a, x) => a + x.requiredTotal, 0))).toFixed(3),
    medianMs: r.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(n / 2)],
  };
});
console.log("\n=== summary");
console.log(JSON.stringify(summary, null, 2));
await Bun.write("./report/model-probe.json", JSON.stringify({ rows, summary }, null, 2));
