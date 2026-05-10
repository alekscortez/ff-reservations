import {
  PublishCommand,
} from "@aws-sdk/client-sns";

import {
  buildCheckInPassMessage,
  buildPaymentLinkExpiredMessage,
  buildPaymentLinkMessage,
  formatTtlPhrase,
  isValidSenderId,
  normalizeE164Phone,
} from "./services-sms-notifications-pure.mjs";

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
      // Internal log keeps the provider detail; client gets a generic message
      // so we don't leak SNS internals or imply staff misconfiguration.
      throw httpError(502, "SMS service is temporarily unavailable. Try again in a moment.");
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
      throw httpError(502, "SMS service is temporarily unavailable. Try again in a moment.");
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
      throw httpError(502, "SMS service is temporarily unavailable. Try again in a moment.");
    }
  }

  return {
    sendPaymentLinkSms,
    sendPaymentLinkExpiredSms,
    sendCheckInPassSms,
  };
}
