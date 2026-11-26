#!/usr/bin/env bun
/**
 * 单条重试：对仍然缺失的 (行,属性) 逐条提问，只给这一条商品 + 同品牌同品名已确认的型号-值对照。
 * 目的：批量提问时模型容易"看不见"某一条；逐条问能显著提高作答率。
 *
 *   bun scripts/retry-solo.ts --pairs 硒鼓｜总打印页数,硒鼓｜规格,硒鼓｜是否带芯片 --limit 400
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
const longPath = arg("long", "./out-final/属性明细_长表_v5.csv")!;
const outDir = arg("out", "./out-infer")!;
const pairsArg = arg("pairs", "硒鼓｜总打印页数,硒鼓｜规格,硒鼓｜是否带芯片")!;
const LIMIT = Number(arg("limit", "400"));
const CONC = Number(arg("concurrency", "6"));

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
const iRow = I("原表行号"), iPin = I("品名_标准"), iName = I("属性名称"), iVal = I("属性值");

const values = new Map<string, string>();
const byPair = new Map<string, { row: number; attr: string; pin: string }[]>();
for (const r of long.slice(1)) {
  values.set(`${r[iRow]}::${r[iName]}`, r[iVal] ?? "");
  if (r[I("是否必填")] !== "是") continue;
  const key = `${r[iPin]}｜${r[iName]}`;
  (byPair.get(key) ?? byPair.set(key, []).get(key)!).push({ row: Number(r[iRow]), attr: r[iName]!, pin: r[iPin]! });
}

/** 同品牌同品名已确认的「型号=值」，作为给模型的对照表 */
function knownTable(pin: string, attr: string, exclude: number) {
  const rows = byPair.get(`${pin}｜${attr}`) ?? [];
  const out: string[] = [];
  for (const c of rows) {
    if (c.row === exclude) continue;
    const v = values.get(`${c.row}::${attr}`);
    if (!v) continue;
    const s = skus.find((x) => x.sourceRow === c.row);
    if (!s) continue;
    out.push(`${s.modelRaw}=${v}`);
    if (out.length >= 25) break;
  }
  return out.join("；");
}

const tasks: { row: number; attr: string; pin: string; def: any; user: string }[] = [];
for (const key of pairsArg.split(",")) {
  const cells = byPair.get(key.trim()) ?? [];
  for (const c of cells) {
    if (values.get(`${c.row}::${c.attr}`)) continue;
    const s = skus.find((x) => x.sourceRow === c.row)!;
    const def = onto.attrDefs(c.pin).find((d) => d.name === c.attr)!;
    const ref = knownTable(c.pin, c.attr, c.row);
    const user = `品名：${c.pin}
属性：${c.attr}（${def.fieldType}${def.unit ? "，单位" + def.unit : ""}${def.enumValues.length ? "，可选值[" + def.enumValues.join("|") + "]" : ""}）
同品名已确认的型号对照：${ref || "（无）"}

这一条商品：
型号：${s.modelRaw}
品牌：${s.brandRaw}
标题：${s.title}

请判断这个具体型号的该属性。你可以使用该型号系列的公开规格知识（对照表里同系列型号的值可类比，但必须确认是同一系列）。
只有当你能识别型号所属系列并确定取值时才填；basis 写依据（≤24字）。不确定就留空。
输出 {"value":"","basis":""}`;
    tasks.push({ row: c.row, attr: c.attr, pin: c.pin, def, user });
    if (tasks.length >= LIMIT) break;
  }
  if (tasks.length >= LIMIT) break;
}

const cachePath = path.join(outDir, "solo-cache.json");
const cache: Record<string, string> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

const applied: string[][] = [];
let answered = 0, done = 0;
await Promise.all(
  Array.from({ length: Math.min(CONC, tasks.length) }, async () => {
    for (;;) {
      const t = tasks.shift();
      if (!t) break;
      const key = crypto.createHash("sha256").update(t.user).digest("hex");
      let text = cache[key];
      if (!text) {
        try {
          const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({
              model: process.env.LLM_MODEL ?? "deepseek-chat",
              messages: [
                { role: "system", content: "只输出 JSON。没有依据就留空。" },
                { role: "user", content: t.user },
              ],
              temperature: 0,
              response_format: { type: "json_object" },
              max_tokens: 300,
            }),
          });
          const j = (await r.json()) as any;
          text = j.choices?.[0]?.message?.content ?? "{}";
          cache[key] = text;
        } catch {
          continue;
        }
      }
      done++;
      if (done % 20 === 0) process.stderr.write(`\r${done}/${done + tasks.length}   `);
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      let v: any;
      try {
        v = JSON.parse(m[0]);
      } catch {
        continue;
      }
      const val = String(v.value ?? "").trim();
      const basis = String(v.basis ?? "").trim();
      if (!val || !basis) continue;
      if (t.def.fieldType === "枚举" && !t.def.enumValues.includes(val)) continue;
      if (t.def.fieldType === "数值" && !/^-?\d+(\.\d+)?$/.test(val)) continue;
      answered++;
      applied.push([String(t.row), t.pin, t.attr, val, `单条推断:${basis}`]);
    }
  }),
);
fs.writeFileSync(cachePath, JSON.stringify(cache));
fs.writeFileSync(
  path.join(outDir, "inferred-solo.csv"),
  ["原表行号", "品名", "属性", "值", "依据"].map((x) => `"${x}"`).join(",") +
    "\n" +
    applied.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n"),
  "utf8",
);
console.log(JSON.stringify({ attempted: done, answered, byAttribute: Object.entries(applied.reduce<Record<string, number>>((a, r) => ((a[r[2]!] = (a[r[2]!] ?? 0) + 1), a), {})) }, null, 2));
