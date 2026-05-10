// Pure helpers + message builders extracted from
// services-sms-notifications.mjs. Pinning these in tests catches
// regressions on the 10DLC compliance suffix ("Reply STOP to opt out.")
// and the message templates themselves — easy to accidentally drop
// when refactoring.
//
// What stays in the factory closure
// - resolveSmsEnabled (reads env.SMS_ENABLED)
// - buildMessageAttributes (reads env.SMS_TYPE / SMS_SENDER_ID / SMS_MAX_PRICE_USD)
// - sendPaymentLinkSms / sendPaymentLinkExpiredSms / sendCheckInPassSms
//   (use snsClient.send + httpError)

// 10DLC / TCPA / CTIA require an opt-out instruction in transactional SMS.
// Don't drop this from message templates without legal review.
export const OPT_OUT_SUFFIX = "Reply STOP to opt out.";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatEventDateLabel(eventDate) {
  const raw = String(eventDate ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const [, yyyy, mm, dd] = match;
  const month = MONTH_NAMES[Number(mm) - 1] ?? mm;
  return `${month} ${Number(dd)}, ${yyyy}`;
}

export function normalizeE164Phone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const hasPlusPrefix = raw.startsWith("+");
  const digitsOnly = raw.replace(/\D/g, "");
  if (!digitsOnly) return "";

  if (hasPlusPrefix) {
    return `+${digitsOnly}`;
  }

  // Best-effort normalization for US/MX legacy records.
  if (digitsOnly.length === 10) return `+1${digitsOnly}`;
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) return `+${digitsOnly}`;
  if (digitsOnly.length === 12 && digitsOnly.startsWith("52")) return `+${digitsOnly}`;
  if (digitsOnly.length === 13 && digitsOnly.startsWith("521")) return `+${digitsOnly}`;

  return `+${digitsOnly}`;
}

export function isValidSenderId(value) {
  return /^[A-Za-z0-9]{1,11}$/.test(String(value ?? "").trim());
}

export function formatTtlPhrase(ttlMinutes) {
  const minutes = Number(ttlMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Expires soon.";
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return days === 1 ? "Expires in 24 hours." : `Expires in ${days} days.`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return hours === 1 ? "Expires in 1 hour." : `Expires in ${hours} hours.`;
  }
  return `Expires in ${Math.round(minutes)} min.`;
}

export function buildPaymentLinkMessage({
  customerName,
  eventDate,
  tableId,
  paymentLinkUrl,
  ttlMinutes,
}) {
  const name = String(customerName ?? "").trim();
  const eventDateLabel = formatEventDateLabel(eventDate);
  const table = String(tableId ?? "").trim();
  const url = String(paymentLinkUrl ?? "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const dateAndTable = [eventDateLabel, table ? `Table ${table}` : ""]
    .filter(Boolean)
    .join(" ");
  const dateAndTableText = dateAndTable ? `${dateAndTable}: ` : "";
  const expiresPhrase = formatTtlPhrase(ttlMinutes);
  return `${greeting} pay ${dateAndTableText}${url}. ${expiresPhrase} Reservation confirms after payment. ${OPT_OUT_SUFFIX}`;
}

export function buildPaymentLinkExpiredMessage({ customerName, tableId }) {
  const name = String(customerName ?? "").trim();
  const table = String(tableId ?? "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const tableText = table ? ` for Table ${table}` : "";
  return `${greeting} your payment link${tableText} expired. Please call us to request a new link. ${OPT_OUT_SUFFIX}`;
}

export function buildCheckInPassMessage({ customerName, eventDate, tableId, passUrl }) {
  const name = String(customerName ?? "").trim();
  const eventDateLabel = formatEventDateLabel(eventDate);
  const table = String(tableId ?? "").trim();
  const url = String(passUrl ?? "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const dateAndTable = [eventDateLabel, table ? `Table ${table}` : ""]
    .filter(Boolean)
    .join(" ");
  const dateAndTableText = dateAndTable ? `${dateAndTable}: ` : "";
  return `${greeting} thank you for your reservation. Here is your confirmation for ${dateAndTableText}${url} ${OPT_OUT_SUFFIX}`;
}
