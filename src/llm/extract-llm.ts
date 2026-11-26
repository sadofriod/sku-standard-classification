#!/usr/bin/env bun
/**
 * LLM 属性抽取（DeepSeek，按品名分批）。
 * 输入：标准品名 → 03 模板；每批 8 个同品名 SKU 共用一张模板。
 * 输出：out-llm/llm-rows.json（逐行 attrs + 校验结果 + 用量/耗时），带内容 hash 缓存。
 *
 * 用法：
 *   bun src/llm/extract-llm.ts --data-root ./data/dataset --out ./out-llm [--limit 8] [--batch 8] [--concurrency 4]
 */
import { ontologyFrom } from "../../src/dataset.ts";
import { resolveDataset } from "../../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Ontology } from "../ontology.ts";
import { Classifier } from "../classify.ts";
import { readExcel } from "../ingest.ts";
import type { AttrDef, SkuInput } from "../types.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const dataRoot = arg("data-root", "./data/dataset")!;
const outDir = arg("out", "./out-llm")!;
const BATCH = Number(arg("batch", "8"));
const CONC = Number(arg("concurrency", "4"));
const LIMIT = Number(arg("limit", "0"));

// DeepSeek key：取自 gateway 进程环境（本机自有 key）
const API_KEY = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
if (!API_KEY) {
  console.error("no DEEPSEEK_API_KEY");
  process.exit(1);
}
const BASE = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

const onto = ontologyFrom(dataRoot);
const clf = new Classifier(onto, "catalog");
const skus = readExcel(resolveDataset(dataRoot).excel);

// 品名 → 该品名下的 SKU（按行号升序，保证可复现）
const groups = new Map<string, { sku: SkuInput; defs: AttrDef[] }[]>();
for (const s of skus) {
  const c = clf.classify(s);
  const defs = onto.attrDefs(c.finalPinming);
  if (!defs.length) continue;
  const g = groups.get(c.finalPinming) ?? groups.set(c.finalPinming, []).get(c.finalPinming)!;
  g.push({ sku: s, defs });
}

fs.mkdirSync(outDir, { recursive: true });
const cachePath = path.join(outDir, "llm-cache.json");
const cache: Record<string, unknown> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

const schemaText = (defs: AttrDef[]) =>
  defs
    .map((d) => {
      const en = d.enumValues.length ? ` 可选值[${d.enumValues.slice(0, 40).join("|")}]` : "";
      return `- ${d.name}（${d.required ? "必填" : "选填"}·${d.fieldType}${d.unit ? "·单位" + d.unit : ""}）${en}`;
    })
    .join("\n");

const SYSTEM = `你是商品属性抽取引擎。只输出 JSON，不要解释、不要 markdown 代码块。
规则：
1. 只填能从商品标题、品牌、制造商型号、销售单位中直接读出的信息；读不出就填 ""，严禁猜测或编造。
2. 枚举字段只能从「可选值」中选，多个值用英文逗号连接；没有匹配就填 ""。
3. 数值字段只填数字（不带单位），单位已在模板里。
4. 品牌填中文品牌名（去掉英文后缀）；制造商型号按原样填。
5. 输出格式：{"rows":[{"id":<行号>,"attrs":{"属性名":"值"}}]}，每行的 attrs 必须包含模板里的全部属性名。`;

async function callModel(user: string): Promise<{ text: string; tokens: number }> {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 4000,
    }),
  });
  if (!r.ok) throw new Error(`api ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  return { text: j.choices?.[0]?.message?.content ?? "", tokens: j.usage?.total_tokens ?? 0 };
}

function validate(row: { id: number; attrs: Record<string, string> }, defs: AttrDef[]) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const out: Record<string, string> = {};
  const issues: string[] = [];
  for (const [name, raw] of Object.entries(row.attrs ?? {})) {
    const d = byName.get(name);
    if (!d) {
      issues.push(`幻觉属性:${name}`);
      continue;
    }
    let v = String(raw ?? "").trim();
    if (!v || v === "null" || v === "无" || v === "未知") continue;
    if (d.fieldType === "枚举") {
      const parts = v.split(/[,，、;；/]+/).map((x) => x.trim()).filter(Boolean);
      const ok = parts.filter((p) => d.enumValues.includes(p));
      if (ok.length !== parts.length) issues.push(`枚举越界:${name}=${v}`);
      if (ok.length) out[name] = [...new Set(ok)].join(",");
      continue;
    }
    if (d.fieldType === "数值") {
      const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      if (!m) {
        issues.push(`数值非法:${name}=${v}`);
        continue;
      }
      out[name] = m[0];
      continue;
    }
    if (v.length > 100) v = v.slice(0, 100);
    out[name] = v;
  }
  return { attrs: out, issues };
}

const tasks: { pinming: string; rows: { sku: SkuInput; defs: AttrDef[] }[] }[] = [];
for (const [pinming, rows] of groups) {
  for (let i = 0; i < rows.length; i += BATCH) tasks.push({ pinming, rows: rows.slice(i, i + BATCH) });
}
const limited = LIMIT > 0 ? tasks.slice(0, LIMIT) : tasks;
const plannedRows = limited.reduce((a, t) => a + t.rows.length, 0);

let done = 0, tokens = 0, okRows = 0, badRows = 0;
const results: Record<number, { pinming: string; attrs: Record<string, string>; issues: string[] }> = {};
const t0 = Date.now();

async function runTask(t: (typeof tasks)[number]) {
  const defs = t.rows[0]!.defs;
  const schema = schemaText(defs);
  const list = t.rows
    .map(
      (r) =>
        `id=${r.sku.sourceRow} | 标题：${r.sku.title} | 品牌：${r.sku.brandRaw} | 型号：${r.sku.modelRaw} | 单位：${r.sku.unit} | 商品名称：${r.sku.productName}`,
    )
    .join("\n");
  const user = `品名：${t.pinming}\n属性模板：\n${schema}\n\n商品（共 ${t.rows.length} 条）：\n${list}\n\n按模板抽取并输出 {"rows":[...]}`;
  const key = crypto.createHash("sha256").update(`${MODEL}|${t.pinming}|${schema}|${list}`).digest("hex");

  let payload: any = cache[key];
  if (!payload) {
    try {
      const { text, tokens: tk } = await callModel(user);
      tokens += tk;
      payload = { text };
      cache[key] = payload;
    } catch (e) {
      console.error("call failed", t.pinming, (e as Error).message.slice(0, 120));
      badRows += t.rows.length;
      return;
    }
  }
  const text: string = payload.text;
  let parsed: any = null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      parsed = JSON.parse(m[0]);
    } catch {}
  }
  const rows = parsed?.rows;
  if (!Array.isArray(rows)) {
    badRows += t.rows.length;
    return;
  }
  const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
  for (const r of t.rows) {
    const got = byId.get(r.sku.sourceRow);
    if (!got) {
      badRows++;
      continue;
    }
    const v = validate(got, defs);
    results[r.sku.sourceRow] = { pinming: t.pinming, attrs: v.attrs, issues: v.issues };
    okRows++;
  }
}

const workers = Array.from({ length: Math.min(CONC, limited.length) }, async () => {
  for (;;) {
    const t = limited.shift();
    if (!t) break;
    await runTask(t);
    done++;
    if (done % 10 === 0)
      process.stderr.write(`\r${done} batches, ok=${okRows} bad=${badRows} tokens=${tokens} ${Math.round((Date.now() - t0) / 1000)}s   `);
  }
});
await Promise.all(workers);

fs.writeFileSync(cachePath, JSON.stringify(cache));
fs.writeFileSync(path.join(outDir, "llm-rows.json"), JSON.stringify(results, null, 1));
const filled = Object.values(results).reduce((a, r) => a + Object.values(r.attrs).filter(Boolean).length, 0);
const report = {
  model: MODEL,
  batches: done,
  rowsRequested: plannedRows,
  rowsWithResult: okRows,
  rowsFailed: badRows,
  attributeValuesFilled: filled,
  totalTokens: tokens,
  elapsedSec: Math.round((Date.now() - t0) / 1000),
};
fs.writeFileSync(path.join(outDir, "llm-report.json"), JSON.stringify(report, null, 2));
console.log("\n" + JSON.stringify(report, null, 2));
