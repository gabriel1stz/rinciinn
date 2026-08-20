import prisma from "../../lib/prisma.js";
import { createPayment, updatePaymentStatus, findPaymentByOrderId } from "./repositories/payment.repository.js";
import { findByPhone, createUser, updateUserTier } from "../user/repositories/user.repository.js";
import { createOrUpdateSubscription } from "../subscription/repositories/subscription.repository.js";
import { sendWhatsAppNotification } from "../../helpers/whatsapp.helper.js";
import { sendOwnerPaymentAlert } from "../../helpers/owner-alert.helper.js";

// Sinkron dengan Enum Tier di Prisma / Sistem
const PLAN_ENUM = {
  free: "TRIAL",
  trial: "TRIAL",
  lite: "LITE",
  pro: "PRO",
  personal: "PRO",
  premium: "FAMILY",
  family: "FAMILY",
  business: "BUSINESS"
};

const VALID_PAYMENT_METHODS = [
  "qris",
  "cimb_niaga_va",
  "bni_va",
  "sampoerna_va",
  "bnc_va",
  "maybank_va",
  "permata_va",
  "atm_bersama_va",
  "artha_graha_va",
  "bri_va"
];

function getPlanAmount(plan) {
  const normalized = String(plan || "").toLowerCase();
  const plans = {
    free: 0,
    trial: 0,
    lite: 9900,
    pro: 9900,
    personal: 9900,
    premium: 24900,
    family: 24900,
    business: 99000
  };
  return plans[normalized] ?? 9900;
}

function createOrderId(phone, plan) {
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const suffix = cleanPhone.length >= 4 ? cleanPhone.slice(-4) : "USER";
  return `RNC-${suffix}-${Date.now()}`;
}

function getSubscriptionDurationDays(plan, amount, customDays = null) {
  if (customDays && Number(customDays) > 0) {
    return Number(customDays);
  }
  const normalizedPlan = String(plan || "").toLowerCase();
  const numAmount = Number(amount || 0);

  if (normalizedPlan === "trial" || normalizedPlan === "free" || numAmount === 0) {
    return 7;
  }

  // PRO / PERSONAL duration based on amount
  // 1m: 9.900, 6m: 45.000, 1y: 69.000, Lifetime: 99.000+
  if (normalizedPlan === "pro" || normalizedPlan === "personal") {
    if (numAmount >= 90000) return 26645; // Lifetime (s/d 2099)
    if (numAmount >= 60000) return 365;   // 1 Tahun
    if (numAmount >= 40000) return 180;   // 6 Bulan
    return 30;                            // 1 Bulan
  }

  // FAMILY / PREMIUM duration based on amount
  // 1m: 24.900, 6m: 99.000, 1y: 129.000, Lifetime: 199.000+
  if (normalizedPlan === "family" || normalizedPlan === "premium") {
    if (numAmount >= 180000) return 26645; // Lifetime
    if (numAmount >= 120000) return 365;   // 1 Tahun
    if (numAmount >= 80000) return 180;    // 6 Bulan
    return 30;                             // 1 Bulan
  }

  return 30; // default 30 hari
}

export async function createPaymentInvoice({
  phone,
  plan,
  amount: customAmount,
  method = "qris",
  userId = null,
  redirectUrl = null
}) {
  const project = process.env.PAKASIR_SLUG || "rinci-in";
  const apiKey = process.env.PAKASIR_API_KEY;
  const baseUrl = process.env.PAKASIR_BASE_URL || "https://app.pakasir.com";

  const normalizedPlan = String(plan || "").toLowerCase();
  const amount = customAmount !== undefined ? Number(customAmount) : getPlanAmount(normalizedPlan);

  if (amount === undefined || isNaN(amount)) {
    throw new Error("Plan atau nominal pembayaran tidak valid");
  }

  const selectedMethod = VALID_PAYMENT_METHODS.includes(method.toLowerCase())
    ? method.toLowerCase()
    : "qris";

  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const orderId = createOrderId(cleanPhone, normalizedPlan);

  // AUTO-REGISTER / AKTIVASI LANGSUNG UNTUK FREE / TRIAL PLAN
  if (normalizedPlan === "free" || normalizedPlan === "trial" || amount === 0) {
    let user = null;
    if (cleanPhone) {
      user = await findByPhone(cleanPhone);
    }

    const withoutZero = cleanPhone.startsWith("0") ? cleanPhone.slice(1) : cleanPhone.startsWith("62") ? cleanPhone.slice(2) : cleanPhone;
    const phoneVariations = [cleanPhone, "0" + withoutZero, "62" + withoutZero];

    // Cek apakah nomor ini sudah pernah mengaktifkan trial sebelumnya
    const existingTrialPayment = await prisma.payment.findFirst({
      where: {
        phone: { in: phoneVariations },
        plan: { in: ["TRIAL", "trial", "free", "FREE"] },
        status: "PAID"
      }
    });

    const existingTrialSub = user
      ? await prisma.subscription.findFirst({
          where: {
            userId: user.id,
            plan: { in: ["TRIAL", "trial", "free", "FREE"] }
          }
        })
      : null;

    if (existingTrialPayment || existingTrialSub) {
      throw new Error(
        "Nomor WhatsApp ini sudah pernah mengaktifkan masa Trial gratis. Silakan pilih paket PRO atau Family untuk melanjutkan."
      );
    }

    if (!user && cleanPhone) {
      user = await createUser({
        phone: cleanPhone,
        name: "User Baru",
        tier: "TRIAL"
      });
    }

    const targetUserId = userId || user?.id;

    if (targetUserId) {
      await updateUserTier(targetUserId, "TRIAL");

      const expiredAt = new Date();
      expiredAt.setDate(expiredAt.getDate() + 7); // 7 Hari

      await createOrUpdateSubscription({
        userId: targetUserId,
        plan: "TRIAL",
        status: "ACTIVE",
        amount: 0,
        orderId,
        paymentMethod: "free",
        expiredAt
      });

      // Kirim notifikasi WA trial
      try {
        const webUrl = process.env.WEB_URL || process.env.FRONTEND_URL || "https://rinciin.my.id";
        const expiredStr = expiredAt.toLocaleDateString("id-ID", {
          day: "numeric",
          month: "long",
          year: "numeric"
        });
        const notifMsg = `🎉 *TRIAL 7 HARI DIAKTIFKAN!*\n━━━━━━━━━━━━━━\nSelamat datang di *Rinci.in*!\n\n✨ *Masa Aktif:* 7 Hari Gratis (s/d ${expiredStr})\n🚀 *Fitur:* Akses penuh pencatatan via WhatsApp Bot & Web Dashboard.\n\n🌐 *Link Akses Web Dashboard:*\n👉 ${webUrl}/login\n*(Gunakan nomor WhatsApp ini untuk verifikasi OTP)*\n\nSilakan ketik *menu* atau langsung mulai catat transaksi keuanganmu sekarang! 🧑‍💻`;
        sendWhatsAppNotification(cleanPhone, notifMsg);
      } catch (e) {}
    }


    return createPayment({
      orderId,
      phone: cleanPhone,
      plan: PLAN_ENUM[normalizedPlan] || "TRIAL",
      amount: 0,
      status: "PAID",
      method: "free",
      userId: targetUserId || null,
      paidAt: new Date()
    });
  }



  // INVOICE BERBAYAR VIA PAKASIR API (Transaction create)
  const response = await fetch(`${baseUrl}/api/transactioncreate/${selectedMethod}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project,
      api_key: apiKey,
      amount,
      order_id: orderId
    })
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || !json.payment) {
    throw new Error(json.message || "Gagal membuat invoice pembayaran ke Pakasir");
  }

  const payment = json.payment;

  // Bangun URL Pembayaran Direct Pakasir (sesuai docs B. Integrasi Via URL)
  let directPayUrl = `${baseUrl}/pay/${project}/${amount}?order_id=${orderId}`;
  if (selectedMethod === "qris") {
    directPayUrl += "&qris_only=1";
  }
  if (redirectUrl) {
    directPayUrl += `&redirect=${encodeURIComponent(redirectUrl)}`;
  }

  return createPayment({
    orderId,
    phone: cleanPhone,
    plan: PLAN_ENUM[normalizedPlan] || normalizedPlan.toUpperCase(),
    amount,
    status: "PENDING",
    paymentUrl: directPayUrl,
    method: payment.payment_method || selectedMethod,
    fee: payment.fee !== undefined ? payment.fee : null,
    totalPayment: payment.total_payment !== undefined ? payment.total_payment : amount,
    paymentNumber: payment.payment_number || null,
    expiredAt: payment.expired_at ? new Date(payment.expired_at) : null,
    userId: userId || null
  });
}

/**
 * Fulfill payment: update status to PAID and activate user subscription & tier
 */
async function fulfillPayment(payment, paidAtDate = null) {
  const paidAt = paidAtDate ? new Date(paidAtDate) : new Date();
  const updatedPayment = await updatePaymentStatus(payment.orderId, "PAID", paidAt);

  let user = null;
  if (payment.userId) {
    user = await findByPhone(payment.phone).catch(() => null);
  }
  if (!user && payment.phone) {
    user = await findByPhone(payment.phone);
    if (!user) {
      user = await createUser({
        phone: payment.phone,
        name: "User Baru",
        tier: payment.plan || "PRO"
      });
    }
  }

  if (user) {
    await updateUserTier(user.id, payment.plan || "PRO");

    const durationDays = getSubscriptionDurationDays(payment.plan, payment.amount);
    const expiredAt = new Date();
    expiredAt.setDate(expiredAt.getDate() + durationDays);

    await createOrUpdateSubscription({
      userId: user.id,
      plan: payment.plan || "PRO",
      status: "active",
      amount: Number(payment.amount || 0),
      orderId: payment.orderId,
      paymentMethod: payment.method || "qris",
      expiresAt: expiredAt,
      expiredAt: expiredAt
    });

    // Kirim notifikasi WA otomatis
    try {
      const planName = String(payment.plan || "PRO").toUpperCase();
      const expiredStr = expiredAt.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric"
      });
      const notifMsg = `🎉 *PEMBAYARAN BERHASIL!*\n━━━━━━━━━━━━━━\nTerima kasih! Pembayaran untuk paket *Rinci.in ${planName}* telah kami terima.\n\n✨ *Masa Aktif:* ${durationDays} Hari (s/d ${expiredStr})\n🚀 *Status Akun:* ${planName} (Unlimited Access)\n\nSilakan ketik *menu* atau langsung mulai catat pengeluaranmu (contoh: *makan siang 35rb gopay*) sekarang! 🧑‍💻`;

      sendWhatsAppNotification(payment.phone || user.phone, notifMsg);
      
      // Kirim notifikasi cuan ke WhatsApp Owner
      sendOwnerPaymentAlert({ user, payment, durationDays }).catch(() => {});
    } catch (e) {
      console.warn("⚠️ Failed to trigger WA notification on payment:", e.message);
    }
  }

  return updatedPayment;
}


/**
 * Pakasir Transaction Detail API (docs E)
 * GET https://app.pakasir.com/api/transactiondetail?project={slug}&amount={amount}&order_id={order_id}&api_key={api_key}
 */
export async function fetchPakasirTransactionDetail({ orderId, amount }) {
  const project = process.env.PAKASIR_SLUG || "rinci-in";
  const apiKey = process.env.PAKASIR_API_KEY;
  const baseUrl = process.env.PAKASIR_BASE_URL || "https://app.pakasir.com";

  try {
    const url = `${baseUrl}/api/transactiondetail?project=${encodeURIComponent(project)}&amount=${encodeURIComponent(amount)}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const json = await response.json();
    return json?.transaction || null;
  } catch (err) {
    console.error("[Pakasir] Error fetching transaction detail:", err.message);
    return null;
  }
}

/**
 * Handle incoming Webhook from Pakasir (docs D)
 */
export async function processPaymentCallback(data) {
  const orderId = data?.order_id;
  if (!orderId) {
    throw new Error("Order ID tidak ditemukan dalam payload webhook");
  }

  const payment = await findPaymentByOrderId(orderId);
  if (!payment) {
    throw new Error(`Payment dengan Order ID ${orderId} tidak ditemukan`);
  }

  // Proteksi jika sudah dibayar sebelumnya (idempotency)
  if (payment.status === "PAID") {
    return payment;
  }

  const rawStatus = String(data.status || "").trim().toLowerCase();
  let targetStatus = "PENDING";
  let paidAt = null;

  if (["completed", "paid", "success", "sukses"].includes(rawStatus)) {
    targetStatus = "PAID";
    paidAt = data.completed_at ? new Date(data.completed_at) : new Date();
  } else if (["expired", "expire"].includes(rawStatus)) {
    targetStatus = "EXPIRED";
  } else if (["failed", "canceled", "cancelled"].includes(rawStatus)) {
    targetStatus = "FAILED";
  }

  if (targetStatus === "PAID") {
    // ANTI-FRAUD VERIFICATION: Double check directly with Pakasir Transaction Detail API
    if (Number(payment.amount || 0) > 0 && process.env.PAKASIR_API_KEY) {
      try {
        const verifiedDetail = await fetchPakasirTransactionDetail({
          orderId: payment.orderId,
          amount: Number(payment.amount)
        });

        if (verifiedDetail && verifiedDetail.status) {
          const vStatus = String(verifiedDetail.status).toLowerCase();
          if (!["completed", "paid", "success", "sukses"].includes(vStatus)) {
            console.warn(`🚨 [Anti-Fraud] Webhook status PAID rejected for order ${orderId}: gateway reported ${vStatus}`);
            throw new Error("Verifikasi transaksi ke payment gateway tidak valid.");
          }
          if (verifiedDetail.completed_at) {
            paidAt = new Date(verifiedDetail.completed_at);
          }
        }
      } catch (verErr) {
        if (verErr.message.includes("tidak valid")) {
          throw verErr;
        }
        console.warn("⚠️ [Anti-Fraud] Gateway verify query network warning:", verErr.message);
      }
    }

    return fulfillPayment(payment, paidAt);
  }

  return updatePaymentStatus(orderId, targetStatus, null);
}

/**
 * Check payment status by orderId.
 * Auto-syncs with Pakasir Transaction Detail API if still PENDING.
 */
export async function checkPaymentStatus(orderId) {
  const payment = await findPaymentByOrderId(orderId);
  if (!payment) {
    throw new Error("Payment tidak ditemukan");
  }

  // Jika masih PENDING, sinkronkan langsung dengan Pakasir Transaction Detail API
  if (payment.status === "PENDING" && payment.amount > 0) {
    const detail = await fetchPakasirTransactionDetail({
      orderId: payment.orderId,
      amount: Number(payment.amount)
    });

    if (detail && detail.status) {
      const status = String(detail.status).toLowerCase();
      if (["completed", "paid", "success", "sukses"].includes(status)) {
        return fulfillPayment(payment, detail.completed_at);
      } else if (["expired", "expire"].includes(status)) {
        return updatePaymentStatus(payment.orderId, "EXPIRED", null);
      } else if (["failed", "canceled", "cancelled"].includes(status)) {
        return updatePaymentStatus(payment.orderId, "FAILED", null);
      }
    }
  }

  return payment;
}

/**
 * Cancel Transaction API (docs C.5)
 * POST https://app.pakasir.com/api/transactioncancel
 */
export async function cancelPaymentInvoice(orderId) {
  const project = process.env.PAKASIR_SLUG || "rinci-in";
  const apiKey = process.env.PAKASIR_API_KEY;
  const baseUrl = process.env.PAKASIR_BASE_URL || "https://app.pakasir.com";

  const payment = await findPaymentByOrderId(orderId);
  if (!payment) {
    throw new Error("Payment tidak ditemukan");
  }

  if (payment.status === "PAID") {
    throw new Error("Transaksi yang sudah terbayar tidak dapat dibatalkan");
  }

  const response = await fetch(`${baseUrl}/api/transactioncancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project,
      api_key: apiKey,
      amount: Number(payment.amount),
      order_id: orderId
    })
  });

  const json = await response.json().catch(() => ({}));
  await updatePaymentStatus(orderId, "CANCELLED", null);

  return {
    success: true,
    message: json.message || "Transaksi berhasil dibatalkan",
    orderId
  };
}

/**
 * Payment Simulation API for Sandbox testing (docs C.4)
 * POST https://app.pakasir.com/api/paymentsimulation
 */
export async function simulatePaymentInvoice(orderId) {
  const project = process.env.PAKASIR_SLUG || "rinci-in";
  const apiKey = process.env.PAKASIR_API_KEY;
  const baseUrl = process.env.PAKASIR_BASE_URL || "https://app.pakasir.com";

  const payment = await findPaymentByOrderId(orderId);
  if (!payment) {
    throw new Error("Payment tidak ditemukan");
  }

  const response = await fetch(`${baseUrl}/api/paymentsimulation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project,
      api_key: apiKey,
      amount: Number(payment.amount),
      order_id: orderId
    })
  });

  const json = await response.json().catch(() => ({}));

  // Jika simulasi berhasil atau di mock mode, auto-fulfill lokal untuk dev testing yang lancar
  await fulfillPayment(payment, new Date());

  return {
    success: true,
    message: json.message || "Simulasi pembayaran berhasil dieksekusi",
    orderId,
    pakasirResponse: json
  };
}