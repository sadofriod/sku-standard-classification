/**
 * 分类层：以标准品名表为图谱骨架，用标题证据做「是否需要更正」判定。
 *
 * 关键事实（来自 1000 条实测）：输入行的 大类/中类/小类/分类代码 与 02 表 100% 一致，
 * 也就是说「查表」这一步恒等命中，真正需要判断的是 —— 输入的商品品名是否被放在了
 * 语义正确的第 4 级，以及两张权威表冲突时用哪一张。
 *
 * 因此这一层输出三件事：
 *  1. 最终 4 级路径（authority 显式指定）
 *  2. 标题中出现的其他标准品名（长匹配优先）→ 候选更正 + 置信度
 *  3. 冲突/不确定标记 → 进人工复核队列，而不是硬猜
 */
import type { CategoryPath, SkuInput } from "./types.ts";
import type { Ontology } from "./ontology.ts";
import { normalizeText } from "./text.ts";

export interface TitleMatch {
  pinming: string;
  matched: string;
  length: number;
  sameLevel3: boolean;
}

export interface ClassifyResult {
  finalPinming: string;
  path: CategoryPath;
  source: "catalog" | "reviewed" | "llm" | "input";
  changed: boolean;
  confidence: number;
  evidence: string;
  candidates: TitleMatch[];
  reviewFlags: string[];
}

export class Classifier {
  /** 标准品名，按长度降序 —— 长匹配优先，避免「胶水」压过「固持胶」 */
  private readonly pinmingByLen: string[];

  constructor(
    private readonly onto: Ontology,
    private readonly authority: "catalog" | "reviewed" = "catalog",
  ) {
    this.pinmingByLen = [...onto.catalog.keys()]
      .filter((p) => p.length >= 2)
      .sort((a, b) => b.length - a.length);
  }

  /** 标题里出现的标准品名（最长匹配，去重，限定同中类，排掉输入品名本身和同小类） */
  matches(sku: SkuInput): TitleMatch[] {
    const t = normalizeText(sku.title);
    const cur = this.onto.catalog.get(sku.pinming);
    const out: TitleMatch[] = [];
    const seen = new Set<string>();
    for (const pin of this.pinmingByLen) {
      if (seen.has(pin)) continue;
      if (!t.includes(pin)) continue;
      const p = this.onto.catalog.get(pin);
      if (!p) continue;
      // 只在同一中类内比较：跨中类的字符串命中绝大多数是词片段（如「转子」「接线」），
      // 交给图谱/模型层判断，不进入确定性判定。
      if (!cur || p.level2 !== cur.level2) continue;
      seen.add(pin);
      out.push({
        pinming: pin,
        matched: pin,
        length: pin.length,
        sameLevel3: p.level3 === cur.level3,
      });
      if (out.length >= 8) break;
    }
    return out;
  }

  classify(sku: SkuInput): ClassifyResult {
    const path = this.onto.pathFor(sku.pinming, this.authority) ?? {
      level1: sku.daLei,
      level2: sku.zhongLei,
      level3: sku.xiaoLei,
      level4: sku.pinming,
      code: sku.code,
    };
    const flags: string[] = [];
    if (!this.onto.catalog.has(sku.pinming)) flags.push("品名未收录于02表");
    if (!path.code) flags.push("复核口径缺分类代码");
    const conflict = this.onto.conflicts.find((c) => c.pinming === sku.pinming);
    if (conflict) flags.push("两表口径冲突");

    const cands = this.matches(sku).filter((m) => m.pinming !== sku.pinming);
    // 只在「非同小类 + 匹配长度 >= 3」时认定为疑似错分，避免把同义词当错分
    const strong = cands.filter((m) => !m.sameLevel3 && m.length >= 3);

    let confidence = 1;
    if (conflict) confidence = 0.6;
    if (strong.length) confidence = Math.min(confidence, 0.45);
    if (!this.onto.catalog.has(sku.pinming)) confidence = Math.min(confidence, 0.2);
    if (strong.length) flags.push(`标题命中其他标准品名:${strong.map((s) => s.pinming).join("|")}`);

    return {
      finalPinming: path.level4,
      path,
      source: this.authority === "catalog" ? "catalog" : "reviewed",
      changed: path.level4 !== sku.pinming || path.level3 !== sku.xiaoLei,
      confidence,
      evidence: `02表命中=${this.onto.catalog.has(sku.pinming)}; 标题最长匹配=${cands[0]?.pinming ?? "无"}`,
      candidates: cands,
      reviewFlags: flags,
    };
  }
}
