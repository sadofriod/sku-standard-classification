/**
 * 图谱语料生成：一条标准品名 = 一个文档，文档里显式写出它的分类路径、属性模板、
 * 同小类易混品名、以及本批抽样的典型标题。
 *
 * 为什么不是「一个 SKU 一个文档」：
 *  - SKU 是查询侧，不是知识侧；把 30W 条商品塞进图谱只会把社区打散、把成本放大。
 *  - 品名是分类的第 4 级，天然是图谱里的实体节点；小类/中类是它的社区归属。
 *  - 标题样例作为「证据句」进入文档，模型才能在检索时看到真实写法（含型号、单位、别名）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Ontology } from "../ontology.ts";
import type { SkuInput } from "../types.ts";

export interface CorpusDoc {
  title: string;
  content: string;
}

export interface CorpusOptions {
  /** 只给这些 1 级大类建图（默认办公设备及耗材） */
  level1?: string;
  /** 每个品名最多放几条标题样例 */
  sampleTitles?: number;
}

export function buildCorpus(
  onto: Ontology,
  skus: SkuInput[],
  opts: CorpusOptions = {},
): { docs: CorpusDoc[]; stats: Record<string, number> } {
  const level1 = opts.level1 ?? "办公设备及耗材";
  const sampleN = opts.sampleTitles ?? 3;

  const titlesByPin = new Map<string, string[]>();
  for (const s of skus) {
    const arr = titlesByPin.get(s.pinming) ?? titlesByPin.set(s.pinming, []).get(s.pinming)!;
    if (arr.length < sampleN * 3 && !arr.includes(s.title)) arr.push(s.title);
  }

  const pins = [...onto.catalog.values()].filter((p) => p.level1 === level1);
  const docs: CorpusDoc[] = [];
  let withAttrs = 0;

  for (const p of pins) {
    const defs = onto.attrDefs(p.level4);
    if (defs.length) withAttrs++;
    const reviewed = onto.reviewed.get(p.level4);
    const conflict =
      reviewed && `${reviewed.level1}/${reviewed.level2}/${reviewed.level3}` !== `${p.level1}/${p.level2}/${p.level3}`;

    const lines: string[] = [];
    lines.push(`# 品名：${p.level4}`, "");
    lines.push("## 分类路径", "");
    lines.push(`${p.level1} / ${p.level2} / ${p.level3} ，分类代码 ${p.code}`, "");
    if (conflict) {
      lines.push(`人工复核口径：${reviewed!.level1} / ${reviewed!.level2} / ${reviewed!.level3}`, "");
      lines.push("两张权威表在本品名上口径不一致，回答时必须同时给出两种口径并标记待确认。", "");
    }

    lines.push("## 属性定义", "");
    if (!defs.length) lines.push("（暂无启用属性模板）", "");
    for (const d of defs) {
      const parts = [d.attrType, d.required ? "必填" : "选填", d.fieldType];
      if (d.unit) parts.push(`单位：${d.unit}`);
      const enums = d.enumValues.length ? `：${d.enumValues.join(" / ")}` : "";
      lines.push(`- ${d.name}（${parts.join("，")}）${enums}`);
    }
    lines.push("");

    const sib = onto.siblings(p.level4).slice(0, 12);
    if (sib.length) {
      lines.push("## 同小类易混品名", "");
      lines.push(sib.join("、"), "");
    }

    const t = (titlesByPin.get(p.level4) ?? []).slice(0, sampleN);
    if (t.length) {
      lines.push("## 典型商品标题", "");
      for (const x of t) lines.push(`- ${x}`);
      lines.push("");
    }

    docs.push({ title: `${safeFileName(p.level4)}.md`, content: lines.join("\n") });
  }

  return {
    docs,
    stats: {
      level1Pins: pins.length,
      docs: docs.length,
      withAttrs,
      withoutAttrs: pins.length - withAttrs,
      avgChars: Math.round(docs.reduce((a, d) => a + d.content.length, 0) / Math.max(1, docs.length)),
    },
  };
}

export function writeCorpus(dir: string, docs: CorpusDoc[]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const d of docs) fs.writeFileSync(path.join(dir, d.title), d.content, "utf8");
}

/** 品名里带 / 或 * 这类字符（如「触控笔/电容笔」），文件名需要净化；标题仍保留原名 */
export function safeFileName(pinming: string): string {
  return pinming.replace(/[\/\\:*?"<>|\s]+/g, "_").slice(0, 80);
}
