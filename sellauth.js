const config = require("./config");

/*
 * SellAuth API v1.
 * Coupon endpoint: POST /v1/shops/{shopId}/coupons
 */

function route(template, values = {}) {
  if (!template) throw new Error("SellAuth API route is not configured.");
  return template.replace(/\{(shopId|invoiceId)\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing value for SellAuth route parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
}

function apiBase() {
  const base = String(config.sellAuthApiBase || "https://api.sellauth.com").replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

async function request(method, path, body) {
  if (!config.sellAuthApiKey || !config.sellAuthShopId) {
    throw new Error("Set MYSELLAUTHAPI and SELLAUTH_SHOP_ID.");
  }
  if (!/^\d+$/.test(String(config.sellAuthShopId))) {
    throw new Error("SELLAUTH_SHOP_ID must be the numeric shop ID from SellAuth.");
  }

  const url = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${config.sellAuthApiKey}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });

  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) {
    const detail = typeof data?.message === "string" ? data.message
      : typeof data?.error === "string" ? data.error
      : raw;
    const err = new Error(`SellAuth API returned HTTP ${res.status}: ${String(detail || "No error details returned").slice(0, 700)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function unwrap(data) {
  return data?.data ?? data?.invoice ?? data?.result ?? data;
}

function invoiceStatus(invoice) {
  return String(invoice?.status ?? invoice?.payment_status ?? "").toLowerCase();
}

function isPaidInvoice(invoice) {
  return ["paid", "completed", "complete", "succeeded", "success"].includes(invoiceStatus(invoice)) ||
    invoice?.paid === true || invoice?.is_paid === true;
}

function invoiceContainsNetflix(invoice) {
  if (!config.netflixProductId) return false;
  const items = invoice?.items || invoice?.products || invoice?.invoice_items || invoice?.order_items || [];
  return Array.isArray(items) && items.some(item => {
    const id = item?.product_id ?? item?.product?.id ?? item?.productId ??
      item?.item_id ?? item?.id;
    return String(id ?? "") === String(config.netflixProductId);
  });
}

async function verifyInvoice(invoiceId) {
  const path = route(config.sellAuthInvoicePath, {
    shopId: config.sellAuthShopId,
    invoiceId
  });
  let raw;
  try {
    raw = await request("GET", path);
  } catch (err) {
    if ([400, 404, 422].includes(err.status)) return { found: false };
    throw err;
  }
  const invoice = unwrap(raw);
  if (!invoice || typeof invoice !== "object") return { found: false };

  const submittedId = String(invoiceId).trim().toLowerCase();
  const returnedIds = [invoice.id, invoice.invoice_id, invoice.identifier, invoice.unique_id]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).trim().toLowerCase());
  if (!returnedIds.includes(submittedId)) return { found: false };

  return {
    found: true,
    paid: isPaidInvoice(invoice),
    hasNetflix: invoiceContainsNetflix(invoice),
    invoice
  };
}

async function createNetflixCoupon(code) {
  if (!config.netflixProductId) throw new Error("Set NETFLIX_PRODUCT_ID to the SellAuth Netflix product ID.");
  if (!code || typeof code !== "string") throw new Error("A coupon code is required.");

  // Matches SellAuth's documented POST /v1/shops/{shopId}/coupons schema.
  // A non-global coupon must include the product ID in items.
  const payload = {
    code,
    global: false,
    discount: 100,
    type: "percentage",
    max_uses: 1,
    items: [{ product_id: String(config.netflixProductId) }]
  };

  const path = route(config.sellAuthCouponCreatePath || "/shops/{shopId}/coupons", {
    shopId: config.sellAuthShopId
  });
  return request("POST", path, payload);
}

module.exports = { verifyInvoice, createNetflixCoupon };
