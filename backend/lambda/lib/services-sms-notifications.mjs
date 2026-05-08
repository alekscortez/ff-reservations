import {
  PublishCommand,
} from "@aws-sdk/client-sns";

function formatEventDateLabel(eventDate) {
  const raw = String(eventDate ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const [, yyyy, mm, dd] = match;
  const monthNames = [
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
  const month = monthNames[Number(mm) - 1] ?? mm;
  return `${month} ${Number(dd)}, ${yyyy}`;
}

function normalizeE164Phone(value) {
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

function isValidSenderId(value) {
  return /^[A-Za-z0-9]{1,11}$/.test(String(value ?? "").trim());
}

export function createSmsNotificationsService({
  snsClient,
  env,
  httpError,
  nowEpoch,
}) {
  function resolveSmsEnabled() {
    const raw = String(env?.SMS_ENABLED ?? "true").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "disabled";
  }

  // 10DLC / TCPA / CTIA require an opt-out instruction in transactional SMS.
  const OPT_OUT_SUFFIX = "Reply STOP to opt out.";

  function formatTtlPhrase(ttlMinutes) {
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

  function buildPaymentLinkMessage({
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

  function buildPaymentLinkExpiredMessage({
    customerName,
    tableId,
  }) {
    const name = String(customerName ?? "").trim();
    const table = String(tableId ?? "").trim();
    const greeting = name ? `Hi ${name},` : "Hi,";
    const tableText = table ? ` for Table ${table}` : "";
    return `${greeting} your payment link${tableText} expired. Please call us to request a new link. ${OPT_OUT_SUFFIX}`;
  }

  function buildCheckInPassMessage({
    customerName,
    eventDate,
    tableId,
    passUrl,
  }) {
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

  function buildMessageAttributes() {
    const attributes = {};
    const smsType = String(env?.SMS_TYPE ?? "Transactional").trim();
    if (smsType) {
      attributes["AWS.SNS.SMS.SMSType"] = {
        DataType: "String",
        StringValue: smsType,
      };
    }

    const senderId = String(env?.SMS_SENDER_ID ?? "").trim();
    if (senderId && isValidSenderId(senderId)) {
      attributes["AWS.SNS.SMS.SenderID"] = {
        DataType: "String",
        StringValue: senderId,
      };
    }

    const maxPrice = Number(env?.SMS_MAX_PRICE_USD ?? "");
    if (Number.isFinite(maxPrice) && maxPrice > 0) {
      attributes["AWS.SNS.SMS.MaxPrice"] = {
        DataType: "Number",
        StringValue: maxPrice.toFixed(3),
      };
    }

    return Object.keys(attributes).length > 0 ? attributes : undefined;
  }

  async function sendPaymentLinkSms({
    phone,
    customerName,
    eventDate,
    tableId,
    paymentLinkUrl,
    ttlMinutes,
  }) {
    if (!resolveSmsEnabled()) {
      throw httpError(503, "SMS notifications are disabled");
    }

    const phoneE164 = normalizeE164Phone(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) {
      throw httpError(400, "Reservation phone is not a valid E.164 number");
    }

    const link = String(paymentLinkUrl ?? "").trim();
    if (!link) {
      throw httpError(400, "paymentLinkUrl is required");
    }

    const message = buildPaymentLinkMessage({
      customerName,
      eventDate,
      tableId,
      paymentLinkUrl: link,
      ttlMinutes: ttlMinutes ?? 10,
    });

    try {
      const response = await snsClient.send(
        new PublishCommand({
          PhoneNumber: phoneE164,
          Message: message,
          MessageAttributes: buildMessageAttributes(),
        })
      );
      const messageId = String(response?.MessageId ?? "").trim();
      if (!messageId) {
        throw httpError(502, "SMS provider did not return a message id");
      }
      return {
        sent: true,
        provider: "sns",
        messageId,
        to: phoneE164,
      sentAt: nowEpoch(),
      };
    } catch (err) {
      const providerStatus = Number(err?.$metadata?.httpStatusCode ?? err?.statusCode) || 502;
      const providerMessage = String(err?.message ?? "Failed to send SMS");
      const providerName = String(err?.name ?? "SNSPublishError");
      console.warn("sendPaymentLinkSms failed", {
        name: providerName,
        statusCode: providerStatus,
        message: providerMessage,
      });
      throw httpError(providerStatus, `SMS provider error (${providerName}): ${providerMessage}`);
    }
  }

  async function sendPaymentLinkExpiredSms({
    phone,
    customerName,
    tableId,
  }) {
    if (!resolveSmsEnabled()) {
      throw httpError(503, "SMS notifications are disabled");
    }

    const phoneE164 = normalizeE164Phone(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) {
      throw httpError(400, "Reservation phone is not a valid E.164 number");
    }

    const message = buildPaymentLinkExpiredMessage({
      customerName,
      tableId,
    });

    try {
      const response = await snsClient.send(
        new PublishCommand({
          PhoneNumber: phoneE164,
          Message: message,
          MessageAttributes: buildMessageAttributes(),
        })
      );
      const messageId = String(response?.MessageId ?? "").trim();
      if (!messageId) {
        throw httpError(502, "SMS provider did not return a message id");
      }
      return {
        sent: true,
        provider: "sns",
        messageId,
        to: phoneE164,
        sentAt: nowEpoch(),
      };
    } catch (err) {
      const providerStatus = Number(err?.$metadata?.httpStatusCode ?? err?.statusCode) || 502;
      const providerMessage = String(err?.message ?? "Failed to send SMS");
      const providerName = String(err?.name ?? "SNSPublishError");
      console.warn("sendPaymentLinkExpiredSms failed", {
        name: providerName,
        statusCode: providerStatus,
        message: providerMessage,
      });
      throw httpError(providerStatus, `SMS provider error (${providerName}): ${providerMessage}`);
    }
  }

  async function sendCheckInPassSms({
    phone,
    customerName,
    eventDate,
    tableId,
    passUrl,
  }) {
    if (!resolveSmsEnabled()) {
      throw httpError(503, "SMS notifications are disabled");
    }

    const phoneE164 = normalizeE164Phone(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) {
      throw httpError(400, "Reservation phone is not a valid E.164 number");
    }

    const url = String(passUrl ?? "").trim();
    if (!url) {
      throw httpError(400, "passUrl is required");
    }

    const message = buildCheckInPassMessage({
      customerName,
      eventDate,
      tableId,
      passUrl: url,
    });

    try {
      const response = await snsClient.send(
        new PublishCommand({
          PhoneNumber: phoneE164,
          Message: message,
          MessageAttributes: buildMessageAttributes(),
        })
      );
      const messageId = String(response?.MessageId ?? "").trim();
      if (!messageId) {
        throw httpError(502, "SMS provider did not return a message id");
      }
      return {
        sent: true,
        provider: "sns",
        messageId,
        to: phoneE164,
        sentAt: nowEpoch(),
      };
    } catch (err) {
      const providerStatus = Number(err?.$metadata?.httpStatusCode ?? err?.statusCode) || 502;
      const providerMessage = String(err?.message ?? "Failed to send SMS");
      const providerName = String(err?.name ?? "SNSPublishError");
      console.warn("sendCheckInPassSms failed", {
        name: providerName,
        statusCode: providerStatus,
        message: providerMessage,
      });
      throw httpError(providerStatus, `SMS provider error (${providerName}): ${providerMessage}`);
    }
  }

  return {
    sendPaymentLinkSms,
    sendPaymentLinkExpiredSms,
    sendCheckInPassSms,
  };
}
