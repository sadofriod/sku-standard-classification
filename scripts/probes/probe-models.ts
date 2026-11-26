import OpenAI from "openai";
const base = "http://host.docker.internal:1234/v1";
const client = new OpenAI({ baseURL: base, apiKey: "lm-studio" });
const prompt = `从下面的商品标题里抽取实体，只输出 JSON，不要解释：
{"entities":[{"name":"","type":""}]}
标题：得力 8564 长尾夹 25mm 48只/筒 （单位：筒） 黑`;
for (const model of ["google/gemma-4-12b", "qwen2.5-0.5b-instruct-mlx", "altworld_hemmingway-1"]) {
  try {
    const t0 = Date.now();
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
      temperature: 0.1,
    });
    const c = r.choices[0]!;
    console.log(`\n== ${model} ${Date.now() - t0}ms finish=${c.finish_reason}`);
    console.log("content:", JSON.stringify(c.message.content)?.slice(0, 300));
    console.log("reasoning:", JSON.stringify((c.message as any).reasoning_content)?.slice(0, 150));
  } catch (e) {
    console.log(`== ${model} FAILED`, (e as Error).message.slice(0, 200));
  }
}
