#!/usr/bin/env bun
/**
 * 标注：200 行分层抽样，双盲标注（两套提示词/两次独立调用），
 * 逐属性比对一致率，并给出「生产管线 vs 双盲共识」的一致率（精度代理）。
 *
 *   bun scripts/annotate.ts --data-root ./data/dataset --out ./out-label --n 200
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Ontology } from "../src/ontology.ts";
import { Classifier } from "../src/classify.ts";
import { readExcel } from "../src/ingest.ts";
import { normalizeText } from "../src/text.ts";
import type { AttrDef } from "../src/types.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const dataRoot = arg("data-root", "./data/dataset")!;
const outDir = arg("out", "./out-label")!;
const N = Number(arg("n", "200"));
const BATCH = Number(arg("batch", "6"));
const CONC = Number(arg("concurrency", "4"));

const API_KEY = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
const BASE = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat";

const onto = ontologyFrom(dataRoot);
const clf = new Classifier(onto, "catalog");
const skus = readExcel(resolveDataset(dataRoot).excel);

// ---- 分层抽样：按品名，先每品名 1 条，再按剩余数量轮转补足，固定哈希序保证可复现 ----
const byPin = new Map<string, typeof skus>();
for (const s of skus) {
  const pin = clf.classify(s).finalPinming;
  (byPin.get(pin) ?? byPin.set(pin, []).get(pin)!).push(s);
}
const ordered = [...byPin.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));
for (const [, arr] of ordered) arr.sort((a, b) => a.sourceRow - b.sourceRow);
const picked: typeof skus = [];
let round = 0;
while (picked.length < N) {
  let added = 0;
  for (const [, arr] of ordered) {
    const x = arr[round];
    if (x) {
      picked.push(x);
      added++;
      if (picked.length >= N) break;
    }
  }
  if (!added) break;
  round++;
}
picked.sort((a, b) => a.sourceRow - b.sourceRow);

const PROMPTS = {
  A: (pin: string, schema: string, list: string) =>
    `品名：${pin}\n属性模板：\n${schema}\n\n商品：\n${list}\n\n按模板抽取并输出 {"rows":[{"id":..,"attrs":{...}}]}`,
  B: (pin: string, schema: string, list: string) =>
    `品名：${pin}\n属性模板：\n${schema}\n\n商品：\n${list}\n\n` +
    `严格模式：对每个属性，先在标题中找到能逐字支撑它的片段；找不到就留空（""）。` +
    `枚举只能取模板候选值；数值只填数字。不要依据常识补全。\n输出 {"rows":[{"id":..,"attrs":{...}}]}`,
};
const SYSTEM = `只输出 JSON，不要解释。attrs 必须包含模板全部属性名；无证据填 ""。
硬约束：产品名称/商品名称/品牌/制造商型号/型号 五项必须原样照抄输入行里对应的列值（产品名称取「商品名称」列），不得改写、不得拼接标题、不得截断。`;

const schemaText = (defs: AttrDef[]) =>
  defs.map((d) => `- ${d.name}（${d.required ? "必填" : "选填"}·${d.fieldType}${d.unit ? "·" + d.unit : ""}）${d.enumValues.length ? " 可选值[" + d.enumValues.slice(0, 40).join("|") + "]" : ""}`).join("\n");

async function call(user: string) {
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
      max_tokens: 3000,
    }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 150));
  const j = (await r.json()) as any;
  return { text: j.choices?.[0]?.message?.content ?? "", tokens: j.usage?.total_tokens ?? 0 };
}

const cachePath = path.join(outDir, "annot-cache.json");
fs.mkdirSync(outDir, { recursive: true });
const cache: Record<string, string> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

type Task = { variant: "A" | "B"; pin: string; rows: typeof skus; defs: AttrDef[] };
const tasks: Task[] = [];
for (const [pin, rows] of byPin) {
  const sel = rows.filter((r) => picked.includes(r));
  if (!sel.length) continue;
  const defs = onto.attrDefs(pin);
  for (let i = 0; i < sel.length; i += BATCH)
    for (const variant of ["A", "B"] as const) tasks.push({ variant, pin, rows: sel.slice(i, i + BATCH), defs });
}

let done = 0, tokens = 0;
const answers: Record<string, Record<string, Record<string, string>>> = { A: {}, B: {} };

async function runTask(t: Task) {
  const schema = schemaText(t.defs);
  const list = t.rows
    .map((r) => `id=${r.sourceRow} | 标题：${r.title} | 商品名称：${r.productName} | 品牌：${r.brandRaw} | 型号：${r.modelRaw} | 单位：${r.unit}`)
    .join("\n");
  const user = PROMPTS[t.variant](t.pin, schema, list);
  const key = crypto.createHash("sha256").update(`${t.variant}|${user}`).digest("hex");
  let text = cache[key];
  if (!text) {
    const r = await call(user);
    text = r.text;
    tokens += r.tokens;
    cache[key] = text;
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return;
  let parsed: any;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return;
  }
  for (const row of parsed.rows ?? []) {
    const id = String(row.id);
    answers[t.variant]![id] ??= {};
    for (const [k, v] of Object.entries(row.attrs ?? {}))
      answers[t.variant]![id]![k] = normalizeText(String(v ?? ""));
  }
  done++;
}

const queue = tasks.slice();
await Promise.all(
  Array.from({ length: Math.min(CONC, queue.length) }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) break;
      try {
        await runTask(t);
      } catch (e) {
        console.error("fail", t.pin, (e as Error).message.slice(0, 80));
      }
      if (done % 20 === 0) process.stderr.write(`\r${done}/${tasks.length} tokens=${tokens}   `);
    }
  }),
);

// ---- 比对 ----
const rowsOut: string[][] = [];
let cmpCells = 0, agree = 0, bothEmpty = 0;
const perAttr = new Map<string, { n: number; agree: number; filled: number }>();

for (const s of picked) {
  const pin = clf.classify(s).finalPinming;
  const defs = onto.attrDefs(pin);
  for (const d of defs) {
    const a = answers.A[String(s.sourceRow)]?.[d.name] ?? "";
    const b = answers.B[String(s.sourceRow)]?.[d.name] ?? "";
    const norm = (v: string) => normalizeText(v).replace(/[,，、;；/]+/g, ",");
    const same = norm(a) === norm(b);
    cmpCells++;
    if (same) agree++;
    if (!a && !b) bothEmpty++;
    const st = perAttr.get(`${pin}｜${d.name}`) ?? { n: 0, agree: 0, filled: 0 };
    st.n++;
    if (same) st.agree++;
    if (a || b) st.filled++;
    perAttr.set(`${pin}｜${d.name}`, st);
    rowsOut.push([String(s.sourceRow), pin, s.title, d.name, a, b, same ? "一致" : "分歧", same ? a || "" : ""]);
  }
}

fs.writeFileSync(path.join(outDir, "标注集_双盲.csv"), ["原表行号", "品名_标准", "商品标题", "属性名称", "标注A", "标注B", "一致性", "共识值"].map((h) => `"${h}"`).join(",") + "\n" + rowsOut.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n"), "utf8");
fs.writeFileSync(cachePath, JSON.stringify(cache));

const filledCells = rowsOut.filter((r) => r[4] || r[5]).length;
const report = {
  model: MODEL,
  sampledRows: picked.length,
  cells: cmpCells,
  filledCells,
  agreementAllCells: +(agree / cmpCells).toFixed(4),
  agreementOnFilled: +((agree - bothEmpty) / Math.max(1, filledCells)).toFixed(4),
  bothEmpty,
  totalTokens: tokens,
  topDisagreements: [...perAttr.entries()]
    .filter(([, v]) => v.filled > 0)
    .map(([k, v]) => ({ attr: k, n: v.n, agreement: +(v.agree / v.n).toFixed(2) }))
    .filter((x) => x.agreement < 0.95)
    .sort((a, b) => a.agreement - b.agreement)
    .slice(0, 12),
};
fs.writeFileSync(path.join(outDir, "annot-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
