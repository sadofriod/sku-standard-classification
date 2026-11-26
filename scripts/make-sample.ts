#!/usr/bin/env bun
/**
 * 生成公开仓库用的**合成样例数据**（不含任何客户数据）。
 * 结构与真实交付一致：6 个品名、24 条商品、6 位分类代码、属性模板含枚举/数值/必填。
 *
 *   bun scripts/make-sample.ts ./data/sample
 */
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const out = process.argv[2] ?? "./data/sample";
const write = (file: string, rows: Record<string, unknown>[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet0");
  XLSX.writeFile(wb, file);
};

// ---------- 品名分类（02） ----------
const catalog = [
  ["票夹", "办公用品", "文具", "夹类", "250805"],
  ["中性笔", "办公用品", "文具", "书写工具", "250801"],
  ["硒鼓", "办公用品", "耗材", "打印耗材", "250601"],
  ["插座", "办公用品", "电气", "电源转换", "250901"],
  ["文件夹", "办公用品", "文具", "文件管理", "250806"],
  ["订书机", "办公用品", "文具", "装订用品", "250807"],
].map(([品名, 大类, 中类, 小类, 代码], i) => ({
  序号: i + 1,
  商品品名: 品名,
  大类,
  中类,
  小类,
  分类代码: 代码,
  启停状态: "启用",
}));

// ---------- 属性模板（03） ----------
type Attr = [string, string, string, string, string, string];
const attrsByPin: Record<string, Attr[]> = {
  票夹: [
    ["产品名称", "关键属性", "是", "文本", "", ""],
    ["品牌", "关键属性", "是", "文本", "", ""],
    ["制造商型号", "关键属性", "是", "文本", "", ""],
    ["数量", "一般属性", "否", "文本", "", ""],
    ["颜色", "一般属性", "否", "文本", "", ""],
  ],
  中性笔: [
    ["产品名称", "关键属性", "是", "文本", "", ""],
    ["品牌", "关键属性", "是", "文本", "", ""],
    ["制造商型号", "关键属性", "是", "文本", "", ""],
    ["书写粗细", "销售属性", "是", "枚举", "", "0.5mm,0.7mm,0.38mm"],
    ["闭合方式", "销售属性", "是", "枚举", "", "按动,拔帽,旋转"],
    ["笔芯颜色", "一般属性", "否", "文本", "", ""],
  ],
  硒鼓: [
    ["产品名称", "关键属性", "是", "文本", "", ""],
    ["品牌", "关键属性", "是", "文本", "", ""],
    ["制造商型号", "关键属性", "是", "文本", "", ""],
    ["总打印页数", "销售属性", "是", "数值", "页", ""],
    ["是否带芯片", "销售属性", "是", "枚举", "", "带芯片,不带芯片"],
  ],
  插座: [
    ["产品名称", "关键属性", "是", "文本", "", ""],
    ["品牌", "关键属性", "是", "文本", "", ""],
    ["制造商型号", "关键属性", "是", "文本", "", ""],
    ["额定电压", "销售属性", "是", "文本", "", ""],
    ["极数", "销售属性", "否", "文本", "", ""],
  ],
  文件夹: [
    ["产品名称", "关键属性", "是", "文本", "", ""],
    ["品牌", "关键属性", "是", "文本", "", ""],
    ["制造商型号", "关键属性", "是", "文本", "", ""],
    ["规格", "销售属性", "是", "枚举", "", "A4,A3,A5"],
  ],
  订书机: [
    ["产品名称", "关键属性", "是", "文本", "", ""],
    ["品牌", "关键属性", "是", "文本", "", ""],
    ["制造商型号", "关键属性", "是", "文本", "", ""],
    ["装订张数", "销售属性", "是", "数值", "张", ""],
  ],
};
const attrRows = Object.entries(attrsByPin).flatMap(([pin, list]) =>
  list.map(([name, type, req, field, unit, enums]) => ({
    JN一级分类: "办公用品",
    JN二级分类: catalog.find((c) => c["商品品名"] === pin)!.中类,
    JN三级分类: catalog.find((c) => c["商品品名"] === pin)!.小类,
    分类代码: catalog.find((c) => c["商品品名"] === pin)!.分类代码,
    品名: pin,
    属性名称: name,
    属性类型: type,
    是否展示: "是",
    是否必填: req,
    字段类型: field,
    单位: unit,
    属性值: enums,
    启停状态: "启用",
  })),
);

// ---------- 复核对照表（1-4 级） ----------
const reviewed = catalog.map((c, i) => ({
  原目录编号: `C${String(i + 1).padStart(5, "0")}`,
  "原1级（大类）": c.大类,
  "调整后1级（大类）": c.大类,
  "原2级（中类）": c.中类,
  "调整后2级（中类）": c.中类,
  "原3级（小类）": c.小类,
  "调整后3级（小类）": c.小类,
  "原4级（品名）": c.商品品名,
  "调整后4级（品名）": c.商品品名,
  是否变动: "否",
  变动内容: "无变动",
}));

// ---------- 商品（24 条，示例品牌） ----------
const brands = ["示例甲", "示例乙", "示例丙"];
const specs: Record<string, { title: (b: string, m: string, i: number) => string; unit: string }> = {
  票夹: { title: (b, m, i) => `${b} ${m} 长尾票夹 ${[25, 32, 41][i % 3]}mm ${[48, 24, 12][i % 3]}只/筒`, unit: "筒" },
  中性笔: { title: (b, m, i) => `${b} ${m} ${[0.5, 0.7, 0.38][i % 3]}mm 按动中性笔 ${["黑色", "红色", "蓝色"][i % 3]} 12支/盒`, unit: "盒" },
  硒鼓: { title: (b, m, i) => `${b} ${m} 硒鼓 ${[1500, 2600, 3000][i % 3]}页 ${["带芯片", "不带芯片"][i % 2]}`, unit: "支" },
  插座: { title: (b, m, i) => `${b} ${m} 插座 ${[4, 6, 8][i % 3]}位 ${["1.8", "3", "5"][i % 3]}米`, unit: "个" },
  文件夹: { title: (b, m, i) => `${b} ${m} ${["A4", "A3", "A5"][i % 3]} 文件夹 双强力夹 ${["蓝色", "白色"][i % 2]}`, unit: "个" },
  订书机: { title: (b, m, i) => `${b} ${m} 订书机 可装订 ${[20, 50, 100][i % 3]}张`, unit: "台" },
};

const pins = Object.keys(specs);
const items = Array.from({ length: 24 }, (_, i) => {
  const pin = pins[i % pins.length]!;
  const c = catalog.find((x) => x["商品品名"] === pin)!;
  const brand = brands[i % brands.length]!;
  const model = `${pin.slice(0, 1).toUpperCase()}-${1000 + i}`;
  return {
    原表行号: 10 + i * 7,
    商品品名: pin,
    商品名称: pin,
    商品标题: specs[pin]!.title(brand, model, i),
    商品品牌: brand,
    制造商型号: model,
    销售单位: specs[pin]!.unit,
    属性参数: "{}",
    大类: c.大类,
    中类: c.中类,
    小类: c.小类,
    分类代码: c.分类代码,
  };
});

write(path.join(out, "待提取商品信息表_样例.xlsx"), items);
write(path.join(out, "分类与03模板/基础信息/02_品名分类汇总.xlsx"), catalog);
write(path.join(out, "分类与03模板/基础信息/03_品名属性表.xlsx"), attrRows);
write(path.join(out, "分类与03模板/过程/最终结果/1-4级完整最终对照表_复核调整版.xlsx"), reviewed);

fs.mkdirSync(path.join(out, "测试输入"), { recursive: true });
fs.writeFileSync(
  path.join(out, "测试输入/样例_24条.jsonl"),
  items
    .map((r) =>
      JSON.stringify({
        source_row: r.原表行号,
        大类: r.大类,
        中类: r.中类,
        小类: r.小类,
        分类代码: r.分类代码,
        商品品名: r.商品品名,
        商品名称: r.商品名称,
        商品标题: r.商品标题,
        制造商型号: r.制造商型号,
        商品品牌: r.商品品牌,
        销售单位: r.销售单位,
        属性参数: r.属性参数,
      }),
    )
    .join("\n") + "\n",
);

fs.writeFileSync(
  path.join(out, "运行配置.json"),
  JSON.stringify(
    {
      note: "样例运行配置：字段含义与真实交付一致，数值仅作示例",
      batch_size: 8,
      batch_workers: 2,
      model_concurrency: 4,
      max_output_tokens: 8192,
      explicit_unit_fields: true,
      standards_search: false,
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ items: items.length, pins: pins.length, attrs: attrRows.length, out }, null, 2));
