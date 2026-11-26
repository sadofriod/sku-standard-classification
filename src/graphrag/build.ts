#!/usr/bin/env bun
/**
 * 图谱构建（Bun 运行）：语料 → graphrag-ts → PostgreSQL/pgvector → 社区摘要。
 *
 *   bun src/graphrag/build.ts --corpus ./out/corpus --namespace sku-sample --limit 20
 *
 * 依赖：
 *  - DATABASE_URL 指向已执行 prisma db push 的库（vector(768)）
 *  - RAG_* 三个模型：slice（切块/实体抽取）、judge（社区摘要/判定）、embedding（768 维）
 *
 * 注意：这个包把 TS 源码发到 npm，只能由 Bun 或带 TS loader 的运行时导入；
 * 用 npx tsc 编译本项目时要把 node_modules/@ashes_born 排除（见 tsconfig）。
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  injectGraphRAG,
  createBuildRegistry,
  startBuild,
  type BuildInputFile,
} from "@ashes_born/graph-rag-ts";
import { envModelConfigs } from "@ashes_born/graph-rag-ts/model-loader";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const corpusDir = arg("corpus", "./out/corpus")!;
const namespace = arg("namespace", "sku-sample")!;
const limit = Number(arg("limit", "0"));

const files: BuildInputFile[] = fs
  .readdirSync(corpusDir)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .slice(0, limit > 0 ? limit : undefined)
  .map((f) => ({ title: f, content: fs.readFileSync(path.join(corpusDir, f), "utf8") }));

if (!files.length) {
  console.error(`语料目录为空：${corpusDir}`);
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await injectGraphRAG({
  database: { client: prisma as never },
  models: envModelConfigs(),
});

const registry = createBuildRegistry();
const t0 = Date.now();
const buildId = startBuild(files, registry, namespace);
console.log(JSON.stringify({ buildId, namespace, files: files.length, startedAt: new Date(t0).toISOString() }));

// 轮询 registry 直到结束（startBuild 是异步的，返回的是 id）
for (;;) {
  const state = registry.get(buildId);
  if (!state) break;
  if (state.status === "succeeded" || state.status === "failed") {
    console.log(
      JSON.stringify(
        { ...state, elapsedMs: Date.now() - t0 },
        null,
        2,
      ),
    );
    process.exit(state.status === "succeeded" ? 0 : 1);
  }
  await Bun.sleep(1500);
}
