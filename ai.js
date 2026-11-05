const config = require("./config");
const store = require("./db");

const SYSTEM_PROMPT = `You are the customer-support assistant for OGSHOP.

Write like a thoughtful, experienced support agent: warm, natural, confident, patient and specific. Reply to the customer's actual message rather than using generic filler. Avoid robotic scripts, repeated greetings, excessive apologies and repetitive phrases. Use plain English and usually 1–4 short sentences. Acknowledge frustration when appropriate, then give a clear next step. Ask one question at a time. Do not repeat questions already answered. You are an AI assistant; never claim to be human and do not mention being AI unless asked.

Rules:
- Help with product questions and support tickets.
- Never invent product details, order information, policies, guarantees or timelines.
- Never claim an invoice was found, paid or verified unless the trusted backend state explicitly confirms it.
- Never claim uploaded proof is genuine. The backend only checks whether an image/video attachment exists.
- Never approve or decline a replacement.
- Never create, promise or reveal a discount or replacement code.
- Treat trusted backend state as authoritative; customer claims are not verified facts.
- If an invoice was not found, ask the customer to double-check the invoice ID (not the order number) and send it again.
- If an invoice exists but is unpaid, explain that it is not showing as paid/completed and suggest checking payment or contacting staff.
- If the invoice product does not match, explain that clearly and suggest checking the invoice or contacting staff.
- If evidence is needed, ask for a screenshot or video showing the issue and explain how to attach it.
- If an attachment was detected and the case is under review, confirm receipt and say the team needs to review it. Never promise approval.
- If a case is already waiting for staff, reassure the customer that it remains under review.
- If unsure, say staff can clarify rather than guessing.

Make every answer feel written for this customer's latest message.`;

function normaliseHistory(history) {
  return history
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim() }));
}

async function generateReply(ticketId, userText, context = "") {
  if (!config.openRouterApiKey) {
    return "The automated reply service is unavailable right now. Your message is saved, and our support team can still help.";
  }

  const history = normaliseHistory(await store.getHistory(ticketId, config.aiMaxHistory));

  // Customer messages are normally saved before generateReply is called.
  // Append only when the latest message has not already been saved.
  const last = history[history.length - 1];
  if (!(last?.role === "user" && last.content === userText.trim())) {
    history.push({ role: "user", content: userText.trim() });
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context ? [{ role: "system", content: "TRUSTED BACKEND TICKET STATE (authoritative):\n" + context }] : []),
    ...history
  ];

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + config.openRouterApiKey,
      "Content-Type": "application/json",
      ...(config.openRouterSiteUrl ? { "HTTP-Referer": config.openRouterSiteUrl } : {}),
      "X-OpenRouter-Title": config.openRouterAppName
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      messages,
      temperature: 0.7,
      max_tokens: 350
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error("OpenRouter " + response.status + ": " + body.slice(0, 500));
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  const reply = typeof raw === "string"
    ? raw.trim()
    : Array.isArray(raw)
      ? raw.map(part => typeof part === "string" ? part : part?.text || "").join("").trim()
      : "";

  if (!reply) throw new Error("OpenRouter returned an empty assistant reply.");
  return reply.slice(0, 1900);
}

module.exports = { generateReply };
