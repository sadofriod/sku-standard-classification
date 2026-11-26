/** 领域类型定义：SKU、标准分类、属性模板、抽取结果。 */

export interface SkuInput {
  /** 原表行号，与 JSONL 的 source_row 一致，是唯一对齐键 */
  sourceRow: number;
  pinming: string; // 商品品名（输入侧，可能本身需要更正）
  productName: string; // 商品名称
  title: string; // 商品标题
  brandRaw: string; // 商品品牌（常带英文后缀，如 得力DELI）
  modelRaw: string; // 制造商型号（可能含 &nbsp;）
  unit: string; // 销售单位
  attrParamsRaw: string; // 原表属性参数（本批 100% 为空 "{}"）
  daLei: string;
  zhongLei: string;
  xiaoLei: string;
  code: string;
}

export interface CategoryPath {
  level1: string;
  level2: string;
  level3: string;
  level4: string; // 品名 = 第 4 级
  code: string; // 6 位分类代码（02 表口径）
}

export interface AttrDef {
  pinming: string;
  name: string;
  attrType: "关键属性" | "销售属性" | "一般属性" | string;
  required: boolean;
  fieldType: "文本" | "数值" | "枚举" | string;
  unit: string;
  enumValues: string[];
  code: string;
}

export interface AttrValue {
  name: string;
  value: string;
  source: "column" | "title" | "llm" | "template" | "missing";
  confidence: number;
  valid: boolean;
  note?: string;
}

export interface SkuResult {
  sourceRow: number;
  inputPinming: string;
  finalPinming: string;
  path: CategoryPath;
  categorySource: "catalog" | "reviewed" | "llm" | "input";
  categoryChanged: boolean;
  categoryConfidence: number;
  categoryEvidence: string;
  attributes: AttrValue[];
  requiredTotal: number;
  requiredFilled: number;
  reviewFlags: string[];
}
