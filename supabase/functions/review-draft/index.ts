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
const STYLES: { name: string; desc: string }[] = [
  { name: "熱烈", desc: "感動が抑えきれない、ややオーバーなテンション。「！」や大げさな比喩（例：とろける、箸が止まらない）を使ってよい" },
  { name: "真面目", desc: "落ち着いた丁寧語のきちんとしたレビュー調。良かった点と気になった点を整理して書く" },
  { name: "詩的", desc: "少し文学的で情緒のある表現。炭火や煙、余韻などの比喩を一つ二つ使い、短い文でリズムよく" },
  { name: "チャラめ", desc: "ノリの軽いくだけた口調（例：マジで、ガチで、〜すぎた、最高かよ）。下品な言葉や悪口は使わない" },
  { name: "食レポ", desc: "テレビの食レポ風。味や食感を五感で生き生きと描写する" },
  { name: "関西弁", desc: "大阪のお客さんらしい親しみやすい関西弁（例：めっちゃ、ほんま、〜やった）" },
  { name: "一言キレ味", desc: "短くキレのある文を2〜3つ並べる簡潔なレビュー。体言止めも使ってよい" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { id?: string; token?: string; exclude?: string };
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
  const pool = STYLES.filter((x) => x.name !== body.exclude);
  const style = pool[Math.floor(Math.random() * pool.length)];
  const prompt = `焼肉店に来店したお客様が、Googleクチコミを書くときの「たたき台」を作ってください。お客様はこの文章を読み、自由に書き直してから自分で投稿します。

お客様がアンケートで選んだ回答：
総合満足度：5段階中${input.stars}
${lines}

テイスト：「${style.name}」
${style.desc}

ルール：
- 事実は回答の内容だけ。回答にない事実は付け足さない（例：肉の厚さや部位の特徴、量、値段、初めて来た／常連、誰と来たか、焼肉デビュー、記念日など）
- そのかわり「表現」は自由に脚色してよい。感想の強さや言い回し、比喩、テンションでテイストをはっきり出す
- 全項目を順番に並べる必要はない。印象的な点を中心に組み立て、「普通」の項目は省いてよい
- 不満の回答があれば、テイストを保ったまま正直に一言入れる（大げさに盛らない）
- 満足度が低い場合は、褒めすぎず回答に合ったトーンにする
- 日本語で60〜180文字。絵文字・ハッシュタグ・星の数は使わない。店名は書かない
- 「食レポ風に言うと」のようにテイスト名や指示に触れない
- 文章だけを出力する（前置き・説明・カギカッコ不要）`;

  const ai = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 2000, temperature: 1, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
  });
  if (!ai.ok) {
    const t = await ai.text();
    console.error("anthropic error", ai.status, t.slice(0, 500));
    return json({ error: "ai failed", status: ai.status }, 502);
  }
  const out = await ai.json();
  const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
  if (!text) {
    console.error("empty", JSON.stringify(out).slice(0, 800));
    return json({ error: "empty", stop: out.stop_reason, types: (out.content || []).map((c: { type: string }) => c.type) }, 502);
  }
  return json({ text, style: style.name, left: Math.max(0, 6 - input.n) });
});
