import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// Service key: the server is the only writer to the shared nutrition database.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Free-tier request quotas are counted per model per day, and for
// gemini-3.6-flash that allowance is 20. Being able to point at another model
// without editing code makes it possible to develop against a roomier one.
export const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
});
export const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
