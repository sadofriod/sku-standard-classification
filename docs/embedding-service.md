# 本地 embedding 服务：把 qwen3 架构的 embedding 模型真正挂起来

## 问题

LM Studio 按 **GGUF 架构**判定模型 domain：

| 模型 | 架构 | LM Studio 归类 | /v1/embeddings |
| --- | --- | --- | --- |
| nomic-embed-text-v1.5 | `nomic-bert` | embedding ✅ | 可用（但只支持英文） |
| jina-embeddings-v5-text-small-retrieval | `qwen3` | llm ❌ | 拒绝：No models loaded |
| Qwen3-Embedding-4B-4bit-DWQ | `qwen3`（MLX safetensors） | llm ❌ | 拒绝 |

改 `~/.lmstudio/.internal/model-index-cache.json` 的 `domain` 字段并重启 server **无效**：
`lms ls --embedding` 与 `/v1/embeddings` 都从磁盘元数据重新推导，缓存改动不被采信。
brew 安装 llama.cpp 也被 ghcr.io 的 TLS 阻断（`SSL_ERROR_SYSCALL`）。

## 解决

用 **node-llama-cpp 3.22.4**（npm 包自带 `@node-llama-cpp/mac-arm64-metal` 预编译二进制，
走 npmmirror 16 秒装完）起一个最小 OpenAI 兼容 embedding 服务：

```bash
# 主机侧
cd hermes-data/work/embedding-server
npm install --registry=https://registry.npmmirror.com
MODEL_PATH=~/.lmstudio/models/jinaai/.../v5-small-retrieval-Q8_0.gguf \
MODEL_ID=jina-embeddings-v5-text-small-retrieval PORT=1235 GPU=metal node server.mjs
```

常驻：`~/Library/LaunchAgents/cloud.ashesborn.embedding-jina.plist`（RunAtLoad + KeepAlive），
容器内访问 `http://host.docker.internal:1235/v1`。

## 验证

| 检查 | 结果 |
| --- | --- |
| `/health` | `{"ok":true,...}`（launchd pid 运行中） |
| 维度 | **1024**（graphrag schema 的 `vector(768)` 已改为 `vector(1024)` 并 `db push`） |
| 中文判别 | `激光打印机` vs 打印机 **1.000** / 订书机 0.339 / 拖拉机 0.145 / 螺丝刀 0.140 |
| 对比 nomic | 同一组中文文本 nomic 全部 0.741（无区分度） |

## 召回对照（同一折：469 查询 / 385 候选）

| 索引 | nomic R@1 | R@5 | R@10 | **jina R@1** | **R@5** | **R@10** | BM25 R@10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A 仅品名 | 2.4% | 4.5% | 6.8% | **29.4%** | 54.4% | 64.0% | 66.7% |
| B +小类+属性名 | 0.2% | 3.2% | 6.0% | **47.8%** | 77.0% | 84.9% | 82.3% |
| C +典型标题 | 18.1% | 46.3% | 59.5% | **52.9%** | **87.0%** | **91.7%** | 88.1% |

- 换成语种正确的 embedding：R@10 **59.5% → 91.7%（+32.2pp）**；
- 索引设计（A→C）在 jina 上仍有 **+27.7pp**，两者不互相替代；
- jina 的 C 变体已超过词面 BM25（88.1%），同小类@10 达 **96.2%**。

## 已知限制

- Qwen3-Embedding-4B 是 MLX safetensors，llama.cpp 读不了；要挂它需要对应的 GGUF 版本
  （本机没有，HF 直连不稳定）。当前用 jina-v5（多语、1024 维）已满足中文需求。
- 该服务是单进程顺序编码，批量 32 条/请求时约 1.5k 文本/2 分钟；生产上要按 QPS 加副本。
