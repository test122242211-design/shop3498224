const config = require("./config");

/*
 * SellAuth API v1.
 * Routes and coupon payload are based on the SellAuth API wrapper implementation:
 * GET  /shops/{shopId}/invoices/{invoiceId}
 * POST /shops/{shopId}/coupons
 *
 * The official API dashboard is account-authenticated; verify your account's
 * API permissions and response fields before enabling automatic coupon issuance.
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

async function request(method, path, body) {
  if (!config.sellAuthApiKey || !config.sellAuthShopId) {
    throw new Error("Set MYSELLAUTHAPI and SELLAUTH_SHOP_ID.");
  }
  const res = await fetch(`${config.sellAuthApiBase}${path}`, {
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
    const err = new Error(`SellAuth API ${method} ${path} returned ${res.status}: ${raw.slice(0, 500)}`);
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
  // SellAuth invoice list examples use "completed" for paid orders.
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
  const raw = await request("GET", path);
  const invoice = unwrap(raw);
  if (!invoice || typeof invoice !== "object") return { found: false };

  // SellAuth accepts either the numeric invoice id or its public unique_id.
  // Its response includes both fields, so compare against both rather than
  // rejecting valid IDs that customers copy from their invoice page.
  const submittedId = String(invoiceId).trim().toLowerCase();
  const returnedIds = [invoice.id, invoice.invoice_id, invoice.identifier, invoice.unique_id]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).trim().toLowerCase());
  if (!returnedIds.includes(submittedId)) {
    return { found: false };
  }

  return {
    found: true,
    paid: isPaidInvoice(invoice),
    hasNetflix: invoiceContainsNetflix(invoice),
    invoice
  };
}

async function createNetflixCoupon(code) {
  if (!config.netflixProductId) throw new Error("Set NETFLIX_PRODUCT_ID.");

  // SellAuth coupon create schema shown in a public API wrapper:
  // code, discount, type, global, items, max_uses, expiration_date, allowed_emails.
  // global:false + items:[Netflix product ID] restricts the coupon to that product.
  const payload = {
    code,
    discount: 100,
    type: "percentage",
    global: false,
    items: [String(config.netflixProductId)],
    max_uses: 1
  };

  const path = route(config.sellAuthCouponCreatePath, { shopId: config.sellAuthShopId });
  return request("POST", path, payload);
}

module.exports = { verifyInvoice, createNetflixCoupon };
