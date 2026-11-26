/**
 * 最小 OpenAI 兼容 embedding 服务（node-llama-cpp，无外部依赖）。
 * 为什么要有它：LM Studio 按 GGUF 架构判 domain，qwen3 架构的 embedding 模型
 * （jina-v5、Qwen3-Embedding）一律被当成 llm，/v1/embeddings 直接拒绝；
 * 而 llama.cpp 的 embedding 模式对任意 GGUF 都成立。
 *
 * 启动：MODEL_PATH=/path/to/model.gguf PORT=1235 node server.mjs
 */
import http from "node:http";
import { getLlama, LlamaChatSession } from "node-llama-cpp";

const MODEL_PATH = process.env.MODEL_PATH;
const PORT = Number(process.env.PORT ?? 1235);
const ID = process.env.MODEL_ID ?? "embedding";
if (!MODEL_PATH) {
  console.error("MODEL_PATH required");
  process.exit(1);
}

const llama = await getLlama({ gpu: process.env.GPU ?? "auto" });
const model = await llama.loadModel({ modelPath: MODEL_PATH });
const ctx = await model.createEmbeddingContext({
  contextSize: Number(process.env.CTX ?? 2048),
  batchSize: Number(process.env.BATCH ?? 64),
});
console.log(JSON.stringify({ ready: true, id: ID, model: MODEL_PATH, gpu: process.env.GPU ?? "auto" }));

const body = (req) =>
  new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });

const vec = (e) => (typeof e === "object" && e ? [...e.vector] : [...e]);

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) return send(200, { ok: true, id: ID });
    if (req.method === "GET" && req.url?.startsWith("/v1/models"))
      return send(200, { object: "list", data: [{ id: ID, object: "model", owned_by: "local" }] });
    if (req.method === "POST" && req.url?.startsWith("/v1/embeddings")) {
      const j = JSON.parse((await body(req)) || "{}");
      const inputs = Array.isArray(j.input) ? j.input : [j.input ?? ""];
      const data = [];
      for (let i = 0; i < inputs.length; i++) {
        const e = await ctx.getEmbeddingFor(String(inputs[i]));
        data.push({ object: "embedding", index: i, embedding: vec(e) });
      }
      return send(200, {
        object: "list",
        model: j.model ?? ID,
        data,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    }
    return send(404, { error: { message: "not found" } });
  } catch (err) {
    return send(500, { error: { message: String(err?.message ?? err).slice(0, 400) } });
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ listening: PORT })));
