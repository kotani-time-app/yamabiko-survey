import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const LABELS: Record<string, string> = {
  service: "スタッフの接客",
  explain: "お肉の焼き方説明",
  meat: "お肉の味・質",
  speed: "提供スピード",
  clean: "店内の雰囲気・清潔さ",
  best: "一番美味しかったメニュー",
};
const STYLES = [
  "短めでさっぱりした口調",
  "丁寧で落ち着いた口調",
  "友人に話すような親しみやすい口調",
  "具体的なポイントを順に挙げる口調",
  "感想を素直に書いた自然な口調",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { id?: string; token?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!body.id || !body.token || !uuid.test(body.id) || !uuid.test(body.token)) return json({ error: "bad input" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${url}/rest/v1/rpc/draft_input`, {
    method: "POST",
    headers: { apikey: srk, Authorization: `Bearer ${srk}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_id: body.id, p_token: body.token }),
  });
  if (!r.ok) return json({ error: "lookup failed" }, 500);
  const input = await r.json();
  if (!input) return json({ error: "limit" }, 429);

  const key = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!key) return json({ error: "no key" }, 500);

  const answers = input.answers || {};
  const lines = Object.keys(LABELS).filter((k) => answers[k]).map((k) => `- ${LABELS[k]}：${answers[k]}`).join("\n");
  const style = STYLES[Math.floor(Math.random() * STYLES.length)];
  const prompt = `焼肉店「焼肉ホルモン やまびこ畜産 京橋店」に来店したお客様が、Googleクチコミを書くときの「たたき台」を作ってください。お客様はこの文章を自分で読み、自由に書き直してから投稿します。

お客様がアンケートで選んだ回答：
総合満足度：5段階中${input.stars}
${lines}

条件：
- 回答に書かれている内容だけを使う。回答にない体験・人物・メニュー・値段・感情を付け足さない
- 「普通」の項目は触れないか、さらっと触れる程度にする
- 不満の回答があれば、角を立てずに正直に書く
- お客様本人の一人称の感想として、${style}で書く
- 日本語で80〜160文字。絵文字・ハッシュタグ・星の数・店名の連呼は使わない
- 文章だけを出力する（前置きや説明は不要）`;

  const ai = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 2000, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
  });
  if (!ai.ok) {
    const t = await ai.text();
    console.error("anthropic error", ai.status, t.slice(0, 500));
    return json({ error: "ai failed", status: ai.status, detail: t.slice(0, 300) }, 502);
  }
  const out = await ai.json();
  const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
  if (!text) {
    console.error("empty", JSON.stringify(out).slice(0, 800));
    return json({ error: "empty", stop: out.stop_reason, types: (out.content || []).map((c: { type: string }) => c.type) }, 502);
  }
  return json({ text, left: Math.max(0, 6 - input.n) });
});
