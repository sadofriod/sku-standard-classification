#!/usr/bin/env bun
/**
 * 开放世界推断（允许使用型号的公开规格知识）+ 留一法评估。
 * 与 infer-missing.ts 的区别：提示词明确允许"已知型号的公开参数"，但要求 basis 说明依据来源，
 * 并仍然禁止"按同品名大多数猜"。
 *
 *   bun scripts/infer-open.ts --mode loo   --min-acc 0.85
 *   bun scripts/infer-open.ts --mode apply --min-acc 0.85
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Ontology } from "../src/ontology.ts";
import { Classifier } from "../src/classify.ts";
import { readExcel } from "../src/ingest.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const dataRoot = arg("data-root", "./data/dataset")!;
const longPath = arg("long", "./out-final/属性明细_长表_v4.csv")!;
const outDir = arg("out", "./out-infer")!;
const mode = arg("mode", "loo") as "loo" | "apply";
const MIN_ACC = Number(arg("min-acc", "0.85"));
const CONC = Number(arg("concurrency", "4"));
const MIN_SAMPLE = Number(arg("min-sample", "3"));

const API_KEY = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";

const onto = ontologyFrom(dataRoot);
const clf = new Classifier(onto, "catalog");
const skus = readExcel(resolveDataset(dataRoot).excel);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const long = parseCsv(fs.readFileSync(longPath, "utf8").replace(/^\uFEFF/, ""));
const h = long[0]!;
const I = (n: string) => h.indexOf(n);
const iRow = I("原表行号"), iPin = I("品名_标准"), iName = I("属性名称"), iVal = I("属性值"), iReq = I("是否必填");

const NEVER = new Set(["产品名称", "商品名称", "品牌", "制造商型号", "型号", "销售单位"]);
const values = new Map<string, string>();
for (const r of long.slice(1)) values.set(`${r[iRow]}::${r[iName]}`, r[iVal] ?? "");

const skuByRow = new Map(skus.map((s) => [s.sourceRow, s]));
const pinByRow = new Map(skus.map((s) => [s.sourceRow, clf.classify(s).finalPinming]));

const byPair = new Map<string, { row: number; attr: string; pin: string }[]>();
for (const r of long.slice(1)) {
  if (r[iReq] !== "是" || NEVER.has(r[iName]!)) continue;
  const key = `${r[iPin]}｜${r[iName]}`;
  (byPair.get(key) ?? byPair.set(key, []).get(key)!).push({ row: Number(r[iRow]), attr: r[iName]!, pin: r[iPin]! });
}

const cachePath = path.join(outDir, "open-cache.json");
fs.mkdirSync(outDir, { recursive: true });
const cache: Record<string, string> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

async function ask(pin: string, attr: string, def: any, rows: number[], dist: string) {
  const lines = rows
    .map((row) => {
      const s = skuByRow.get(row)!;
      return `id=${row} | 型号：${s.modelRaw} | 品牌：${s.brandRaw} | 标题：${s.title}`;
    })
    .join("\n");
  const user = `品名：${pin}
属性：${attr}（${def.fieldType}${def.unit ? "，单位" + def.unit : ""}${def.enumValues.length ? "，可选值[" + def.enumValues.join("|") + "]" : ""}）

你可以使用对该制造商型号的公开规格知识（例如某型号粉盒的标称页数、是否带芯片、容量档位）。
禁止：按"同品名大多数值"猜、按品牌猜、按价格/销量猜。

商品：
${lines}

要求：
1. 只有当你能识别这个具体型号、并知道它的公开规格时才填；否则 value 留空。
2. basis 必须写明依据（≤24 字，例如 "HP W1370A 标称1500页"、"DR-2350 鼓架无芯片"）；写不出依据就不要填。
3. 枚举只能取可选值；数值只填数字。
输出 {"rows":[{"id":..,"value":"","basis":""}]}`;
  const key = crypto.createHash("sha256").update(user).digest("hex");
  let text = cache[key];
  if (!text) {
    const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? "deepseek-chat",
        messages: [
          { role: "system", content: "只输出 JSON。没有依据就留空，绝不猜测。" },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 2000,
      }),
    });
    const j = (await r.json()) as any;
    text = j.choices?.[0]?.message?.content ?? "";
    cache[key] = text;
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return new Map<number, { value: string; basis: string }>();
  try {
    const parsed = JSON.parse(m[0]);
    return new Map<number, { value: string; basis: string }>(
      (parsed.rows ?? []).map((x: any) => [Number(x.id), { value: String(x.value ?? "").trim(), basis: String(x.basis ?? "").trim() }]),
    );
  } catch {
    return new Map<number, { value: string; basis: string }>();
  }
}

const canon = (attr: string, v: string) => {
  let s = v.trim().replace(/\s+/g, "");
  if (/颜色/.test(attr)) s = s.replace(/色$/, "");
  if (/页数|数量|净重|功率|速度|克重|容量/.test(attr)) {
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (m) return String(Number(m[0]));
  }
  return s;
};

type Task = { key: string; pin: string; attr: string; def: any; rows: number[]; answers: Map<number, { value: string; basis: string }> };
const tasks: Task[] = [];

const looFile = path.join(outDir, "open-loo.json");
let eligibleKeys: Set<string> | null = null;
if (mode === "apply") {
  if (!fs.existsSync(looFile)) {
    console.error("先跑 --mode loo");
    process.exit(1);
  }
  const loo = JSON.parse(fs.readFileSync(looFile, "utf8")) as { all: { key: string; precision: number | null; filled: number }[] };
  eligibleKeys = new Set(loo.all.filter((x) => x.filled >= MIN_SAMPLE && (x.precision ?? 0) >= MIN_ACC).map((x) => x.key));
  console.error(`LOO 合格组合：${eligibleKeys.size}（阈值 ${MIN_ACC}）`);
}

for (const [key, cells] of byPair) {
  if (eligibleKeys && !eligibleKeys.has(key)) continue;
  const def = onto.attrDefs(cells[0]!.pin).find((d) => d.name === cells[0]!.attr)!;
  if (mode === "loo") {
    const known = cells.filter((c) => values.get(`${c.row}::${c.attr}`));
    if (known.length < MIN_SAMPLE) continue;
    for (let i = 0; i < Math.min(known.length, 12); i += 6) {
      const batch = known.slice(i, i + 6);
      tasks.push({ key, pin: cells[0]!.pin, attr: cells[0]!.attr, def, rows: batch.map((c) => c.row), answers: new Map() });
    }
  } else {
    const missing = cells.filter((c) => !values.get(`${c.row}::${c.attr}`));
    for (let i = 0; i < missing.length; i += 8)
      tasks.push({ key, pin: cells[0]!.pin, attr: cells[0]!.attr, def, rows: missing.slice(i, i + 8).map((c) => c.row), answers: new Map() });
  }
}

const results: Task[] = [];
let done = 0;
await Promise.all(
  Array.from({ length: Math.min(CONC, tasks.length) }, async () => {
    for (;;) {
      const t = tasks.shift();
      if (!t) break;
      try {
        t.answers = await ask(t.pin, t.attr, t.def, t.rows, "");
      } catch (e) {
        console.error("fail", t.key, (e as Error).message.slice(0, 60));
      }
      results.push(t);
      done++;
      if (done % 10 === 0) process.stderr.write(`\r${done}/${done + tasks.length}   `);
    }
  }),
);
fs.writeFileSync(cachePath, JSON.stringify(cache));

const perKey = new Map<string, { tried: number; filled: number; hit: number }>();
const applied: string[][] = [];
for (const t of results) {
  const st = perKey.get(t.key) ?? { tried: 0, filled: 0, hit: 0 };
  for (const row of t.rows) {
    const got = t.answers.get(row);
    st.tried++;
    if (!got?.value || !got.basis) {
      perKey.set(t.key, st);
      continue;
    }
    if (t.def.fieldType === "枚举" && !t.def.enumValues.includes(got.value)) { perKey.set(t.key, st); continue; }
    if (t.def.fieldType === "数值" && !/^-?\d+(\.\d+)?$/.test(got.value)) { perKey.set(t.key, st); continue; }
    st.filled++;
    if (mode === "loo") {
      if (canon(t.attr, got.value) === canon(t.attr, values.get(`${row}::${t.attr}`) ?? "")) st.hit++;
    } else {
      applied.push([String(row), t.pin, t.attr, got.value, got.basis]);
    }
  }
  perKey.set(t.key, st);
}

if (mode === "loo") {
  const all = [...perKey.entries()].map(([key, v]) => ({
    key,
    tried: v.tried,
    filled: v.filled,
    precision: v.filled ? +(v.hit / v.filled).toFixed(2) : null,
  }));
  const eligible = all.filter((x) => x.filled >= MIN_SAMPLE && (x.precision ?? 0) >= MIN_ACC);
  const answered = all.reduce((a, x) => a + x.filled, 0);
  const hits = all.reduce((a, x) => a + Math.round((x.precision ?? 0) * x.filled), 0);
  const report = {
    mode,
    minAcc: MIN_ACC,
    pairs: all.length,
    eligiblePairs: eligible.length,
    answered,
    precision: answered ? +(hits / answered).toFixed(3) : null,
    eligible: eligible.sort((a, b) => (b.precision ?? 0) - (a.precision ?? 0)),
    all: all.sort((a, b) => (b.precision ?? -1) - (a.precision ?? -1)),
  };
  fs.writeFileSync(path.join(outDir, "open-loo.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, eligible: report.eligible.slice(0, 12), all: undefined }, null, 2));
} else {
  fs.writeFileSync(
    path.join(outDir, "inferred-open.csv"),
    ["原表行号", "品名", "属性", "值", "依据"].map((x) => `"${x}"`).join(",") +
      "\n" +
      applied.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n"),
    "utf8",
  );
  const report = {
    mode,
    pairs: perKey.size,
    inferredCells: applied.length,
    byAttribute: Object.entries(applied.reduce<Record<string, number>>((a, r) => ((a[r[2]!] = (a[r[2]!] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]),
  };
  fs.writeFileSync(path.join(outDir, "open-apply.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
