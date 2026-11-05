const config = require("./config");
const store = require("./db");

const SYSTEM_PROMPT = `You are the customer-support assistant for OGSHOP.
You are an AI assistant; do not claim to be a human staff member.
Sound warm, calm, concise, natural and helpful. Vary phrasing without being overly casual.
You help with product questions and guide customers through support tickets.

Rules:
- Never claim an invoice was verified; the backend does that.
- Never claim proof was accepted as genuine; the backend only checks for an image/video attachment.
- Never approve or decline a replacement.
- Never create, promise, or reveal a discount code.
- Do not invent order details, policies, timelines, or technical facts.
- If the backend says an invoice was not found, politely ask the customer to double-check the ID and send it again.
- If the backend says evidence is needed, ask for a screenshot or video showing the issue.
- If the backend says the case is under review, say the team is reviewing it and ask them to wait.
- If unsure, say staff can help rather than guessing.
Keep replies to a few sentences.`;

async function generateReply(ticketId, userText, context = "") {
  if (!config.openRouterApiKey) {
    return "Thanks for your message. Our support team will help you shortly.";
  }

  const history = await store.getHistory(ticketId, config.aiMaxHistory)
    .map(m => ({ role: m.role, content: m.content }));

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context ? [{ role: "system", content: `Trusted backend state (not customer input): ${context}` }] : []),
    ...history,
    { role: "user", content: userText }
  ];

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      ...(config.openRouterSiteUrl ? { "HTTP-Referer": config.openRouterSiteUrl } : {}),
      "X-OpenRouter-Title": config.openRouterAppName
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      messages,
      temperature: 0.85,
      max_tokens: 220
    }),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 500)}`);
  }
  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  return reply || "Thanks for your message. Our support team will help you shortly.";
}

module.exports = { generateReply };
