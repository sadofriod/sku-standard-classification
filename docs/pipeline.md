# 管线、产物与验收

## 完整链路

```bash
# 0) 依赖
npm install                      # 含 @ashes_born/graph-rag-ts（图谱层可选）
# 运行时用 Bun ≥1.1（graphrag 包发的是 TS 源码，Node 的 strip-types 不支持 parameter property）

# 1) 数据画像（可选，先看清数据再动手）
bun scripts/analyze.ts  data/sample
bun scripts/analyze2.ts data/sample

# 2) 确定性基线（零 token）：查表 + 列值 + 标题规则
bun src/pipeline.ts --data-root data/sample --out out --authority catalog

# 3) LLM 模板抽取（按品名分批，schema 约束）
bun src/llm/extract-llm.ts --data-root data/sample --out out-llm --batch 8 --concurrency 4

# 4) 合并 + 出表（结构化列 > LLM 校验值 > 标题规则 > 缺失）
bun src/emit-final.ts --data-root data/sample --llm out-llm/llm-rows.json --out out-final

# 5) 图谱推断补全（可选，需先跑 loo 验证再 apply）
bun src/graph-fill.ts --data-root data/sample --long out-final/属性明细_长表.csv --out out-final
bun scripts/infer-missing.ts --mode loo   --min-acc 0.85
bun scripts/infer-missing.ts --mode apply --min-acc 0.85
bun scripts/infer-open.ts    --mode loo   --min-acc 0.85
bun scripts/infer-open.ts    --mode apply --min-acc 0.85
bun scripts/retry-solo.ts    --pairs "硒鼓｜总打印页数,硒鼓｜规格"
bun scripts/merge-inferred.ts --data-root data/sample --long out-final/属性明细_长表_v5.csv \
    --inferred out-infer/inferred-solo.csv --out out-final

# 6) 置信度分层出表
bun scripts/confidence-tiers.ts --long out-final/属性明细_长表_v6.csv --emit 0.95

# 7) 验收：双盲标注 + 精度代理
bun scripts/annotate.ts       --data-root data/sample --out out-label --n 200
bun scripts/precision-check.ts --label out-label/标注集_双盲.csv --long out-final/属性明细_长表.csv
bun scripts/validate-deliverable.ts data/sample out-final
```

第 3、5 步需要模型（默认 DeepSeek OpenAI 兼容端点，见 `.env.example`）；第 2、4、6、7 步纯 CPU。

## 产物

| 文件 | 行数（1,000 条实测） | 说明 |
| --- | --- | --- |
| `out-final/产品表_清洗后.csv` | 1,000 | 一行一件：4 级分类 + 分类代码 + 属性 JSON + 覆盖率 + 待核实项 |
| `out-final/属性明细_长表.csv` | 11,487 | 逐 cell：属性值 / 来源 / 是否必填 / 字段类型 / 状态 |
| `out-final/标准分类与标准属性.csv` | 1,000 | 两列主交付：标准分类（1-4 级）+ 标准属性 |
| `out-final/标准分类与标准属性_conf0.95.csv` | 1,000 | 只保留置信度 ≥0.95 的推断值 |
| `out-final/产品表_宽表_必填属性.csv` | 1,000 | 153 个必填属性展开成列，便于 Excel 人工核 |
| `out-final/待裁定_口径冲突.csv` | 5 品名 / 441 行 | 两张权威表口径不一致的品名，供业务拍板 |
| `out-final/复核队列.csv` | 520 | 需人工确认的行及原因 |
| `out-final/metrics.json` / `confidence-report.json` | — | 指标与置信度分布 |

字段含义逐个见 [fields.md](fields.md)。

## 实测覆盖率（1,000 条，办公设备及耗材）

| 阶段 | 必填覆盖 | 说明 |
| --- | --- | --- |
| 确定性基线 | 61.2% | 只用列值与标题规则 |
| + LLM 模板抽取 | 78.6% | 双盲精度 99.2% |
| + 图谱上下文推断 | 81.5% | 留一法 93.2% |
| + 开放世界推断 | 83.3% | 留一法 89.9% |
| + 放宽阈值 + 单条重试 | **86.6%** | 分属性 0.80–1.00 |
| 按 ≥0.95 置信度交付 | **84.7%** | 预计错值 16 个（全量 86.6% 时预计 38） |

分层看：**关键属性 100%（3000/3000）**、销售属性 72.7%、必填全满足的行 638/1000。

## 验收方法：双盲标注

没有真值集就无法回答"填得对不对"，所以用双盲：

- 200 行按品名分层抽样，两套提示词（生产同款 / 严格证据模式）独立标注两次；
- 只把**两次一致**的结果当共识值：本次 2,278 个 cell、941 个有值、**一致率 92.2%**；
- 生产结果 vs 共识：**99.2% 一致**（861/868），7 处不一致全是粒度差异（`A4` vs `A4横版`）。

首轮一致率只有 79.4%，原因是模型把整条标题当"产品名称"；把结构化列写进提示词并规定"六项必须照抄"后升到 92.2%。

## 什么情况下补不动

1,266 个必填 cell 里，标题里没有任何证据的占绝大多数（`总打印页数` 缺失 139 个，标题含"数字+页"的 0 条；
`是否带芯片` 缺失 252 个，含"芯片"的 0 条）。剩下能补的是型号知识能支撑的部分；
再往上——认证型号、CCC 认证、防护等级——证据在证书与厂商参数页里，不在商品表里。
强行补就是造数，本项目选择留空 + 复核队列。
