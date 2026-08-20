export async function sendWhatsAppNotification(phone, message) {
  if (!phone || !message) return false;

  const cleanPhone = String(phone).replace(/\D/g, "");
  if (cleanPhone.length < 8) {
    return false;
  }

  try {
    const botUrl = process.env.BOT_INTERNAL_URL || "https://zesty-youth-production-7a74.up.railway.app/send-message";

    const res = await fetch(botUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone, message }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("⚠️ [WA Helper] Gagal mengirim notifikasi WA:", errText);
      return false;
    }

    return true;
  } catch (err) {
    console.warn("⚠️ [WA Helper] Tidak dapat terhubung ke server WhatsApp bot:", err.message);
    return false;
  }
}
