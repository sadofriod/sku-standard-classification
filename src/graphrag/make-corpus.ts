#!/usr/bin/env bun
/** 生成图谱语料并落盘：out/corpus/*.md */
import { ontologyFrom } from "../../src/dataset.ts";
import { resolveDataset } from "../../src/dataset.ts";
import path from "node:path";
import { Ontology } from "../ontology.ts";
import { readExcel } from "../ingest.ts";
import { buildCorpus, writeCorpus } from "./corpus.ts";

const dataRoot = process.argv[2] ?? "./data/dataset";
const outDir = process.argv[3] ?? "./out/corpus";

const onto = ontologyFrom(dataRoot);
const skus = readExcel(resolveDataset(dataRoot).excel);

const { docs, stats } = buildCorpus(onto, skus, { level1: "办公设备及耗材", sampleTitles: 3 });
writeCorpus(outDir, docs);
console.log(JSON.stringify(stats, null, 2));
console.log(docs[0]!.content.slice(0, 900));
