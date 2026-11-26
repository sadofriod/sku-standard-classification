#!/usr/bin/env bun
/**
 * 图谱上下文推断补全（LLM）：针对"必填但标题无证据"的 cell，
 * 用品名文档（分类+属性模板+典型标题）+ 同品名已确认取值分布 作为图谱上下文，让模型判断能否确定该值。
 *
 * 关键：先跑留一法（LOO）测准确率，只有达到阈值的 (品名,属性) 才允许补全。
 *
 *   bun scripts/infer-missing.ts --mode loo   --min-acc 0.8
 *   bun scripts/infer-missing.ts --mode apply --min-acc 0.8
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
const longPath = arg("long", "./out-final/属性明细_长表_v3.csv")!;
const outDir = arg("out", "./out-infer")!;
const mode = (arg("mode", "loo") as "loo" | "apply");
const MIN_ACC = Number(arg("min-acc", "0.8"));
const CONC = Number(arg("concurrency", "4"));

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

const NEVER_INFER = new Set(["产品名称", "商品名称", "品牌", "制造商型号", "型号", "销售单位"]);
const values = new Map<string, string>();
for (const r of long.slice(1)) values.set(`${r[iRow]}::${r[iName]}`, r[iVal] ?? "");

const pinOf = new Map<number, string>();
for (const s of skus) pinOf.set(s.sourceRow, clf.classify(s).finalPinming);
const skuByRow = new Map(skus.map((s) => [s.sourceRow, s]));

// 建 (品名,属性) → 行列表
type Cell = { row: number; attr: string; pin: string };
const byPinAttr = new Map<string, Cell[]>();
for (const r of long.slice(1)) {
  if (r[iReq] !== "是") continue;
  if (NEVER_INFER.has(r[iName]!)) continue;
  const key = `${r[iPin]}｜${r[iName]}`;
  (byPinAttr.get(key) ?? byPinAttr.set(key, []).get(key)!).push({ row: Number(r[iRow]), attr: r[iName]!, pin: r[iPin]! });
}

const cachePath = path.join(outDir, "infer-cache.json");
fs.mkdirSync(outDir, { recursive: true });
const cache: Record<string, string> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

async function ask(pin: string, attr: string, def: any, rows: number[], dist: string, hide: Set<number>) {
  const lines = rows
    .map((row) => {
      const s = skuByRow.get(row)!;
      return `id=${row} | 型号：${s.modelRaw} | 品牌：${s.brandRaw} | 标题：${s.title}`;
    })
    .join("\n");
  const user = `品名：${pin}
属性：${attr}（${def.fieldType}${def.unit ? "，单位" + def.unit : ""}${def.enumValues.length ? "，可选值[" + def.enumValues.join("|") + "]" : ""}）
同品名已确认取值分布：${dist || "（无）"}

商品：
${lines}

要求：
1. 只有当该型号是标准化在售商品、且你能确定这个属性值时才填；否则 value 留空。
2. 填了就必须给 basis（≤20 字，说明依据，例如"TN-289 系列原装粉盒标称 2300 页"）。
3. 不要根据"同品名大多数值"去猜；只做型号级判断。
4. 枚举只能取可选值；数值只填数字。
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
          { role: "system", content: "只输出 JSON。不确定就留空，不要猜。" },
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
      (parsed.rows ?? []).map((x: any) => [Number(x.id), { value: String(x.value ?? "").trim(), basis: String(x.basis ?? "") }]),
    );
  } catch {
    return new Map<number, { value: string; basis: string }>();
  }
}

const canon = (attr: string, v: string) => {
  let s = v.trim().replace(/\s+/g, "");
  if (/颜色/.test(attr)) s = s.replace(/色$/, "");
  if (/页数|数量|净重|功率|速度|克重/.test(attr)) {
    const m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? String(Number(m[0])) : s;
  }
  return s;
};

const tasks: { key: string; pin: string; attr: string; def: any; rows: number[]; dist: string; answers: Map<number, { value: string; basis: string }> }[] = [];

if (mode === "loo") {
  for (const [key, cells] of byPinAttr) {
    const known = cells.filter((c) => values.get(`${c.row}::${c.attr}`));
    if (known.length < 3) continue;
    const pick = known.slice(0, 12);
    const counts = new Map<string, number>();
    for (const c of known) {
      if (pick.some((p) => p.row === c.row)) continue;
      const v = values.get(`${c.row}::${c.attr}`)!;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const dist = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}(${n})`).join("、");
    const def = onto.attrDefs(cells[0]!.pin).find((d) => d.name === cells[0]!.attr)!;
    tasks.push({ key, pin: cells[0]!.pin, attr: cells[0]!.attr, def, rows: pick.map((c) => c.row), dist, answers: new Map() });
  }
} else {
  const looFile = path.join(outDir, "loo-report.json");
  if (!fs.existsSync(looFile)) {
    console.error("先跑 --mode loo 生成 out-infer/loo-report.json");
    process.exit(1);
  }
  const loo = JSON.parse(fs.readFileSync(looFile, "utf8")) as { all: { key: string; precision: number | null; filled: number }[] };
  const eligible = new Set(loo.all.filter((x) => x.filled >= 3 && (x.precision ?? 0) >= MIN_ACC).map((x) => x.key));
  console.error(`LOO 合格 (品名｜属性) 组合：${eligible.size}`);
  for (const [key, cells] of byPinAttr) {
    if (!eligible.has(key)) continue;
    const missing = cells.filter((c) => !values.get(`${c.row}::${c.attr}`));
    if (!missing.length) continue;
    const counts = new Map<string, number>();
    for (const c of cells) {
      const v = values.get(`${c.row}::${c.attr}`);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const dist = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}(${n})`).join("、");
    const def = onto.attrDefs(cells[0]!.pin).find((d) => d.name === cells[0]!.attr)!;
    for (let i = 0; i < missing.length; i += 12)
      tasks.push({ key, pin: cells[0]!.pin, attr: cells[0]!.attr, def, rows: missing.slice(i, i + 12).map((c) => c.row), dist, answers: new Map() });
  }
}

const results: typeof tasks = [];
let done = 0;
await Promise.all(
  Array.from({ length: Math.min(CONC, tasks.length) }, async () => {
    for (;;) {
      const t = tasks.shift();
      if (!t) break;
      try {
        t.answers = await ask(t.pin, t.attr, t.def, t.rows, t.dist, new Set());
      } catch (e) {
        console.error("fail", t.key, (e as Error).message.slice(0, 80));
      }
      results.push(t);
      done++;
      if (done % 10 === 0) process.stderr.write(`\r${done}   `);
    }
  }),
);
fs.writeFileSync(cachePath, JSON.stringify(cache));

// ---------- 评估 / 应用 ----------
const perKey = new Map<string, { tried: number; hit: number; filled: number }>();
const appliedRows: string[][] = [];

for (const t of results) {
  const st = perKey.get(t.key) ?? { tried: 0, hit: 0, filled: 0 };
  for (const row of t.rows) {
    const got = t.answers.get(row);
    const truth = values.get(`${row}::${t.attr}`) ?? "";
    if (mode === "loo") {
      st.tried++;
      if (!got?.value) continue;
      st.filled++;
      if (canon(t.attr, got.value) === canon(t.attr, truth)) st.hit++;
    } else {
      st.tried++;
      if (!got?.value || !got.basis) continue;
      // 枚举/数值合法性
      if (t.def.fieldType === "枚举" && !t.def.enumValues.includes(got.value)) continue;
      if (t.def.fieldType === "数值" && !/^-?\d+(\.\d+)?$/.test(got.value)) continue;
      st.filled++;
      appliedRows.push([String(row), t.pin, t.attr, got.value, got.basis]);
    }
  }
  perKey.set(t.key, st);
}

if (mode === "loo") {
  const rows = [...perKey.entries()]
    .map(([k, v]) => ({
      key: k,
      tried: v.tried,
      filled: v.filled,
      precision: v.filled ? +(v.hit / v.filled).toFixed(2) : null,
      coverage: v.tried ? +(v.filled / v.tried).toFixed(2) : 0,
    }))
    .filter((x) => x.tried >= 3)
    .sort((a, b) => (b.precision ?? -1) - (a.precision ?? -1));
  const eligible = rows.filter((x) => x.filled >= 3 && (x.precision ?? 0) >= MIN_ACC);
  const overall = rows.reduce((a, x) => a + x.tried, 0);
  const overallHit = [...perKey.values()].reduce((a, v) => a + v.hit, 0);
  const report = {
    mode,
    minAcc: MIN_ACC,
    pinAttrPairs: rows.length,
    eligiblePairs: eligible.length,
    looAttempts: overall,
    looAnswered: [...perKey.values()].reduce((a, v) => a + v.filled, 0),
    looHits: overallHit,
    looPrecision: [...perKey.values()].reduce((a, v) => a + v.filled, 0)
      ? +([...perKey.values()].reduce((a, v) => a + v.hit, 0) / [...perKey.values()].reduce((a, v) => a + v.filled, 0)).toFixed(3)
      : null,
    top: rows.slice(0, 10),
  };
  fs.writeFileSync(path.join(outDir, "loo-report.json"), JSON.stringify({ ...report, all: rows }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} else {
  fs.writeFileSync(path.join(outDir, "inferred.csv"), ["原表行号","品名","属性","值","依据"].map(h=>`"${h}"`).join(",")+"\n"+appliedRows.map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n"), "utf8");
  const report = {
    mode,
    pairs: perKey.size,
    inferredCells: appliedRows.length,
    byAttribute: Object.entries(appliedRows.reduce<Record<string, number>>((a, r) => ((a[r[2]!] = (a[r[2]!] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 12),
    samples: appliedRows.slice(0, 12),
  };
  fs.writeFileSync(path.join(outDir, "infer-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
