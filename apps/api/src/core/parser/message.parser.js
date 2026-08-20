import { parseAmount, removeAmount } from "./amount.parser.js";
import { parseWallet, removeWallet } from "./wallet.parser.js";
import { parseCategory } from "./category.parser.js";
import { removeStopWords } from "./stopword.parser.js";

function splitMessage(message) {
  let cleaned = String(message || "")
    .replace(/^(?:bro\s+rinci|rinci|halo\s+rinci|bot)\s*,?\s*/i, "")
    .trim();

  // Insert standard delimiter before conjunctions, time markers, and income transitions
  cleaned = cleaned
    .replace(/\s+(?:sama|dan|terus|lalu|kemudian|habis\s+itu|abis\s+itu|juga|plus|\+)\s+/gi, " | ")
    .replace(/\s+(?:tadi\s+pagi|pagi\s+ini|siang\s+ini|tadi\s+siang|siang|sore\s+ini|tadi\s+sore|sore|malam\s+ini|tadi\s+malam|malam)\s+/gi, " | ")
    .replace(/\s+(?:dapat\s+transferan|transferan|dapat\s+gaji|terima\s+uang)\s+/gi, " | dapat transferan ");

  return cleaned
    .split(/\n|\r\n|,|\|/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 2);
}

function cleanNote(text) {
  const FILLERS = [
    "bro",
    "rinci",
    "tadi",
    "pagi",
    "siang",
    "sore",
    "malam",
    "beli",
    "bayar",
    "buat",
    "untuk",
    "pakai",
    "pake",
    "isi",
    "topup",
    "top up",
    "transfer",
    "ambil",
    "kirim",
    "kasih",
    "dapat",
    "terima",
    "qris",
    "ke"
  ];

  const regex = new RegExp(`\\b(${FILLERS.join("|")})\\b`, "gi");

  return String(text)
    .replace(regex, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSingleTransaction(rawText) {

  const text = removeStopWords(rawText);

  const amount = parseAmount(text);

  if (!amount) return null;

  const wallet = parseWallet(text);

  const category = parseCategory(text);

  let note = removeAmount(text);

  note = removeWallet(note);

  note = cleanNote(note);

  return {
    type: category.type,
    amount,
    wallet,
    categoryName: category.categoryName,
    subCategory: category.subCategory,
    note: note || category.subCategory,
    rawText
  };

}

export function parseMessage(message) {

  const parts = splitMessage(message);

  console.log("========== SPLIT ==========");
  console.log(parts);
  console.log("===========================");

  const transactions =
    parts
      .map((part) => {

        const result = parseSingleTransaction(part);

        console.log("TRANSACTION");
        console.log(result);

        return result;

      })
      .filter(Boolean);

  return {

    success: transactions.length > 0,

    count: transactions.length,

    transactions

  };

}