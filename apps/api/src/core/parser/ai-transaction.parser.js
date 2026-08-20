import { executeGemini } from "../../lib/gemini.js";
import { parseMessage as parseMessageRegex } from "./message.parser.js";

/**
 * Intelligent Multi-Transaction AI Parser using Gemini.
 * Extracts multiple expenses/incomes from natural conversational Indonesian text / voice notes.
 *
 * @param {string} rawMessage - Natural speech or text input
 * @returns {Promise<{ success: boolean, count: number, transactions: Array, source: string }>}
 */
export async function parseTransactionsWithAI(rawMessage) {
  const message = String(rawMessage || "").trim();
  if (!message) {
    return { success: false, count: 0, transactions: [], source: "empty" };
  }

  // Check if message is a simple single-line deterministic pattern (e.g., "makan 20rb gopay")
  // If it's very short and regex parser succeeds with 1 transaction, we can return quickly or use AI for precision
  const wordCount = message.split(/\s+/).length;
  const hasMultipleNumbers = (message.match(/\d+(?:[.,]\d+)?\s*(?:rb|ribu|k|jt|juta|m)?/gi) || []).length > 1;
  const hasComplexConjunctions = /\b(tadi pagi|siang|sore|malam|terus|lalu|kemudian|sama|dan|habis itu|abis itu|plus|transferan|dapat|gaji)\b/i.test(message);

  // If simple and short single command without conversational fillers, try fast regex first
  if (!hasMultipleNumbers && !hasComplexConjunctions && wordCount <= 5) {
    const fastRegex = parseMessageRegex(message);
    if (fastRegex.success && fastRegex.transactions.length === 1) {
      return {
        ...fastRegex,
        source: "regex_fast"
      };
    }
  }

  const prompt = `
Kamu adalah AI Parser Keuangan Ahli untuk aplikasi pencatatan keuangan "Rinci.in" di Indonesia.
Tugasmu adalah menganalisis dan mengekstrak SEMUA transaksi keuangan (pemasukan & pengeluaran) dari teks percakapan / transkripsi voice note bahasa Indonesia santai berikut:

"${message}"

ATURAN EKSTRAKSI:
1. PECAH SEMUA TRANSAKSI: Jika pengguna menyebutkan beberapa transaksi sekaligus (misal: sarapan, beli kopi, isi bensin, dapat transferan gaji/freelance), pisahkan masing-masing menjadi objek transaksi tersendiri.
2. TIPE ("type"):
   - "EXPENSE" untuk pengeluaran (beli, makan, jajan, ngopi, bensin, bayar, langganan, checkout, transfer keluar).
   - "INCOME" untuk pemasukan (dapat transferan, gaji, freelance, bonus, cashback, dividen, omset, penjualan, terima uang).
3. NOMINAL ("amount"):
   - Konversi nominal ke angka integer bulat murni (contoh: 18.000 -> 18000, 30.000 / 30k / 30rb -> 30000, 50.000 / 50rb -> 50000, 50 juta / 50jt -> 50000000, 1.5 jt -> 1500000, goceng -> 5000, ceban -> 10000, noban -> 20000, goban -> 50000, cepek -> 100000).
4. DOMPET / METODE BAYAR ("wallet"):
   - Cari metode pembayaran atau dompet yang dimaksud:
     - E-Wallet: "GoPay", "DANA", "OVO", "ShopeePay", "LinkAja"
     - Bank: "BCA", "Mandiri", "BRI", "BNI", "CIMB", "BSI", "Permata", "Danamon", "BTN", "SeaBank", "Jago", "Jenius"
     - Tunai: "Cash"
   - Jika pengguna menyebut "QRIS GoPay" -> pilih "GoPay". Jika "QRIS BCA" -> pilih "BCA".
   - Jika pengguna menyebut "QRIS" tanpa nama bank/ewallet -> default "GoPay" atau "Cash".
   - Jika pengguna TIDAK menyebut metode pembayaran sama sekali -> default "Cash".
5. KATEGORI UTAMA ("categoryName"):
   - Pilih SATU kategori dari daftar resmi berikut:
     - "Food" (Makanan, Minuman, Sarapan, Makan Siang, Makan Malam, Kopi, Cafe, Resto, Jajan, Snack)
     - "Transportation" (Bensin, BBM, V-Power, Pertalite, Pertamax, Ojek Online, Grab, Gojek, Parkir, Tol, Kereta)
     - "Shopping" (Belanja, Minimarket, Indomaret, Alfamart, Baju, Barang Elektronik, Kebutuhan Rumah, Belanja Online)
     - "Bills" (Listrik, Pulsa, Paket Data, Internet, Wifi, Air, PDAM, BPJS, Pajak, Iuran)
     - "Salary" (Gaji, Freelance, Fee, Bonus, Omset, Pendapatan, Uang Saku)
     - "Investment" (Saham, Kripto, Reksadana, Tabungan, Emas)
     - "Entertainment" (Nonton, Bioskop, Game, Top Up Game, Netflix, Spotify, Liburan)
     - "Health" (Obat, Apotek, Dokter, Vitamin, Skincare, Rumah Sakit, Gym)
     - "Education" (Kursus, Buku, Kuliah, Sekolah)
     - "Other" (Lainnya, Sedekah, Zakat, Donasi, Hadiah)
6. SUB KATEGORI ("subCategory"):
   - Tentukan subkategori yang ringkas & spesifik (contoh: "Sarapan", "Kopi", "Bensin", "Freelance", "Ojol", "Minimarket").
7. CATATAN / DESKRIPSI ("note"):
   - Tulis deskripsi bersih tanpa kata sambung atau filler words (contoh: "Sarapan bubur ayam", "Kopi Kenangan", "Bensin V-Power", "Transferan freelance").
   - Hapus kata seperti "bro", "rinci", "tadi pagi", "siang", "sore", "terus", "sama", "pakai", "ke".

KEMBALIKAN HANYA JSON VALID BERIKUT (tanpa pembungkus markdown apapun):
{
  "transactions": [
    {
      "type": "EXPENSE",
      "amount": 18000,
      "wallet": "Cash",
      "categoryName": "Food",
      "subCategory": "Sarapan",
      "note": "Sarapan bubur ayam"
    },
    {
      "type": "EXPENSE",
      "amount": 30000,
      "wallet": "GoPay",
      "categoryName": "Food",
      "subCategory": "Kopi",
      "note": "Kopi Kenangan"
    },
    {
      "type": "EXPENSE",
      "amount": 50000,
      "wallet": "DANA",
      "categoryName": "Transportation",
      "subCategory": "Bensin",
      "note": "Bensin V-Power"
    },
    {
      "type": "INCOME",
      "amount": 50000000,
      "wallet": "BCA",
      "categoryName": "Salary",
      "subCategory": "Freelance",
      "note": "Transferan freelance"
    }
  ]
}
`;

  try {
    const response = await executeGemini(async (client, model) => {
      return client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      });
    });

    let rawText = response.text || "";
    // Clean potential markdown blocks ```json ... ```
    rawText = rawText.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

    const parsed = JSON.parse(rawText);

    if (Array.isArray(parsed.transactions) && parsed.transactions.length > 0) {
      const validTransactions = parsed.transactions
        .map((t) => {
          const numAmount = Math.abs(Number(t.amount || 0));
          if (!numAmount || Number.isNaN(numAmount)) return null;

          const type = String(t.type || "EXPENSE").toUpperCase() === "INCOME" ? "INCOME" : "EXPENSE";
          const wallet = String(t.wallet || "Cash").trim();
          const categoryName = String(t.categoryName || (type === "INCOME" ? "Salary" : "Food")).trim();
          const subCategory = String(t.subCategory || t.categoryName || "Lainnya").trim();
          const note = String(t.note || subCategory || "Transaksi").trim();

          return {
            type,
            amount: numAmount,
            wallet: wallet || "Cash",
            categoryName: categoryName || "Other",
            subCategory: subCategory || "Lainnya",
            note: note || "Transaksi",
            rawText: message
          };
        })
        .filter(Boolean);

      if (validTransactions.length > 0) {
        console.log(`🤖 [AI Parser] Successfully parsed ${validTransactions.length} transactions with Gemini!`);
        return {
          success: true,
          count: validTransactions.length,
          transactions: validTransactions,
          source: "gemini_ai"
        };
      }
    }
  } catch (aiErr) {
    console.warn("⚠️ [AI Parser] Gemini transaction parsing failed or offline, falling back to regex parser:", aiErr.message);
  }

  // Fallback to deterministic regex parser
  const fallback = parseMessageRegex(message);
  return {
    ...fallback,
    source: "regex_fallback"
  };
}
