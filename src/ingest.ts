/** 输入读取：Excel（交付给人看的）与 JSONL（程序输入）双通道，按原表行号对齐。 */
import XLSX from "xlsx";
import fs from "node:fs";
import type { SkuInput } from "./types.ts";
import { cleanModel, normalizeText } from "./text.ts";

const n = (v: unknown) => normalizeText(String(v ?? ""));

export function readExcel(file: string): SkuInput[] {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], {
    defval: "",
    raw: false,
  });
  return rows.map((r) => ({
    sourceRow: Number(n(r["原表行号"])),
    pinming: n(r["商品品名"]),
    productName: n(r["商品名称"]),
    title: n(r["商品标题"]),
    brandRaw: n(r["商品品牌"]),
    modelRaw: cleanModel(String(r["制造商型号"] ?? "")),
    unit: n(r["销售单位"]),
    attrParamsRaw: String(r["属性参数"] ?? "{}"),
    daLei: n(r["大类"]),
    zhongLei: n(r["中类"]),
    xiaoLei: n(r["小类"]),
    code: n(r["分类代码"]),
  }));
}

export function readJsonl(file: string): SkuInput[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .map((r: Record<string, unknown>) => ({
      sourceRow: Number(r["source_row"]),
      pinming: n(r["商品品名"]),
      productName: n(r["商品名称"]),
      title: n(r["商品标题"]),
      brandRaw: n(r["商品品牌"]),
      modelRaw: cleanModel(String(r["制造商型号"] ?? "")),
      unit: n(r["销售单位"]),
      attrParamsRaw: String(r["属性参数"] ?? "{}"),
      daLei: n(r["大类"]),
      zhongLei: n(r["中类"]),
      xiaoLei: n(r["小类"]),
      code: n(r["分类代码"]),
    }));
}

/** 两路输入一致性校验：行数、原表行号集合、标题与型号必须逐字一致 */
export function assertAligned(a: SkuInput[], b: SkuInput[]) {
  const errs: string[] = [];
  if (a.length !== b.length) errs.push(`行数不一致 excel=${a.length} jsonl=${b.length}`);
  const bm = new Map(b.map((x) => [x.sourceRow, x]));
  for (const x of a) {
    const y = bm.get(x.sourceRow);
    if (!y) {
      errs.push(`原表行号 ${x.sourceRow} 只存在于 Excel`);
      continue;
    }
    if (y.title !== x.title) errs.push(`原表行号 ${x.sourceRow} 标题不一致`);
    if (y.modelRaw !== x.modelRaw) errs.push(`原表行号 ${x.sourceRow} 型号不一致`);
    if (y.pinming !== x.pinming) errs.push(`原表行号 ${x.sourceRow} 品名不一致`);
  }
  return errs;
}
