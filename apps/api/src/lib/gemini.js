import { GoogleGenAI } from "@google/genai";

// Parse multiple API keys if provided (comma-separated), fallback to GEMINI_API_KEY
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
const keys = rawKeys
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let currentKeyIndex = 0;

export function getGeminiClient() {
  if (keys.length === 0) {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  const selectedKey = keys[currentKeyIndex];
  // Round-robin index rotation for next request
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;

  return new GoogleGenAI({ apiKey: selectedKey });
}

export const SUPPORTED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-flash-latest"
];

/**
 * Robust execution with auto-retry and model fallback
 */
export async function executeGemini(callFn) {
  const errors = [];

  for (let i = 0; i < Math.max(keys.length, 1); i++) {
    const client = getGeminiClient();

    for (const model of SUPPORTED_MODELS) {
      try {
        const result = await callFn(client, model);
        return result;
      } catch (err) {
        errors.push(`${model}: ${err.message}`);
        console.warn(`⚠️ [Gemini Gateway] Model ${model} failed (${err.message}). Trying fallback...`);
      }
    }
  }

  throw new Error(`Semua model & API key Gemini gagal: ${errors.slice(-2).join(", ")}`);
}
