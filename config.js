require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

module.exports = {
  discordToken: required("DISCORD_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  guildId: process.env.DISCORD_GUILD_ID || "",
  ticketCategoryId: process.env.TICKET_CATEGORY_ID || "",
  staffRoleId: process.env.STAFF_ROLE_ID || "",
  staffLogChannelId: process.env.STAFF_LOG_CHANNEL_ID || "",

  sellAuthApiKey: process.env.MYSELLAUTHAPI || "",
  sellAuthShopId: process.env.SELLAUTH_SHOP_ID || "",
  sellAuthApiBase: (process.env.SELLAUTH_API_BASE || "https://api.sellauth.com/v1").replace(/\/$/, ""),
  sellAuthInvoicePath: process.env.SELLAUTH_INVOICE_PATH || "/shops/{shopId}/invoices/{invoiceId}",
  sellAuthCouponCreatePath: process.env.SELLAUTH_COUPON_CREATE_PATH || "/shops/{shopId}/coupons",
  netflixProductId: process.env.NETFLIX_PRODUCT_ID || "",

  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openrouter/free",
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || "",
  openRouterAppName: process.env.OPENROUTER_APP_NAME || "OGSHOP Support",

  port: Number(process.env.PORT || 10000),
  pingUrl: process.env.PING_URL || "",
  autoApproveMinutes: Math.max(1, Number(process.env.AUTO_APPROVE_MINUTES || 60)),
  databasePath: process.env.DATABASE_PATH || "./data/ogshop.sqlite",
  aiMaxHistory: Math.max(2, Number(process.env.AI_MAX_HISTORY || 12))
};
