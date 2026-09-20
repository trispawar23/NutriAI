import express from "express";
import cors from "cors";
import { model, supabaseAdmin } from "./clients.js";
import { embedDish } from "./dish-embedding.js";
import { withGeminiRetry } from "./retry.js";

const app = express();
app.use(cors());
app.use(express.json());

const KNOWN_ALLERGENS = ["gluten", "dairy", "soy", "nuts", "egg", "fish"];

// Tell the user the model was busy rather than blaming their input.
function sendModelError(res, err, fallback) {
  console.error(err);
  const status = err?.status === 503 ? 503 : 500;
  res.status(status).json({ error: status === 503 ? err.message : fallback });
}

function generate(prompt) {
  return withGeminiRetry(() => model.generateContent(prompt));
}

app.post("/extract", async (req, res) => {
  const { rawText } = req.body;

  const prompt = `You are extracting nutrition data for a restaurant dish tracking app.
Given the raw text below, extract:
- dish_name
- restaurant_name
- is_veg (true/false, best guess if not stated)
- allergens (array from: gluten, dairy, soy, nuts, egg, fish — only if clearly indicated)
- protein_g, carbs_g, fibre_g (numbers, per single serving as described)
- confidence ("high" if numbers are explicitly stated, "low" if estimated/inferred)
- source_note (one sentence on where these numbers came from)

Return ONLY valid JSON, no other text:
{"dish_name": "", "restaurant_name": "", "is_veg": true, "allergens": [], "protein_g": 0, "carbs_g": 0, "fibre_g": 0, "confidence": "", "source_note": ""}

Raw text:
${rawText}`;

  try {
    const result = await generate(prompt);
    const text = result.response.text().trim();
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (err) {
    sendModelError(res, err, "extraction failed");
  }
});

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ilike treats % and _ as wildcards, and these names come from user input.
function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function findOrCreateRestaurant(name) {
  // Match case-insensitively so "Sweetgreen" and "sweetgreen" do not become
  // two entries.
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("restaurants")
    .select("id")
    .ilike("name", escapeLikePattern(name))
    .limit(1)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabaseAdmin
    .from("restaurants")
    .insert({ name })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return created.id;
}

app.post("/dishes", async (req, res) => {
  const { dish_name, restaurant_name, is_veg, allergens, protein_g, carbs_g, fibre_g, confidence } = req.body;

  const name = String(dish_name ?? "").trim();
  const restaurantName = String(restaurant_name ?? "").trim();
  if (!name || !restaurantName) {
    return res.status(400).json({ error: "dish_name and restaurant_name are required" });
  }

  const protein = nonNegativeNumber(protein_g);
  const carbs = nonNegativeNumber(carbs_g);
  if (protein === null || carbs === null) {
    return res.status(400).json({ error: "protein_g and carbs_g must be non-negative numbers" });
  }
  const fibre = nonNegativeNumber(fibre_g);

  try {
    const restaurantId = await findOrCreateRestaurant(restaurantName);

    // schema.sql declares unique (restaurant_id, name), but the constraint may
    // not exist on an older database, so check rather than rely on it. The
    // 23505 branch below still covers two writers racing here.
    const { data: duplicate } = await supabaseAdmin
      .from("dishes")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .ilike("name", escapeLikePattern(name))
      .limit(1)
      .maybeSingle();
    if (duplicate) {
      return res.status(409).json({ error: `${name} is already listed for ${restaurantName}` });
    }

    const { data: dish, error } = await supabaseAdmin
      .from("dishes")
      .insert({
        restaurant_id: restaurantId,
        name,
        is_veg: Boolean(is_veg),
        allergens: (Array.isArray(allergens) ? allergens : []).filter((a) => KNOWN_ALLERGENS.includes(a)),
        protein_g: protein,
        carbs_g: carbs,
        fibre_g: fibre,
        // Only let fibre count towards the ranking when the source stated it
        // outright rather than the model guessing a plausible number.
        fibre_verified: fibre !== null && confidence === "high",
        // Anything pulled out of pasted text is unreviewed. The seeded dishes
        // are 'verified'; these stay apart from them until someone says so.
        status: "pending",
      })
      .select("id, name, is_veg, allergens, protein_g, carbs_g, fibre_g, fibre_verified, status")
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `${name} is already listed for ${restaurantName}` });
      }
      throw error;
    }

    // Swap suggestions need the embedding, but a dish without one is still
    // worth keeping — the backfill script can pick it up later.
    try {
      const embedding = await embedDish({ ...dish, restaurant_name: restaurantName });
      await supabaseAdmin.from("dishes").update({ embedding }).eq("id", dish.id);
    } catch (embedErr) {
      console.error(`embedding failed for dish ${dish.id}:`, embedErr);
    }

    res.status(201).json({ ...dish, restaurants: { name: restaurantName } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "could not save dish" });
  }
});

app.post("/swap", async (req, res) => {
  const { currentDish, alternative, remaining } = req.body;

  const prompt = `A user is picking a meal to hit their remaining daily macro goals.
Remaining goals: ${remaining.protein}g protein, ${remaining.fibre}g fibre, ${remaining.carbs}g carbs.
They currently have: ${currentDish.name} (${currentDish.protein_g}g protein, ${currentDish.fibre_g}g fibre, ${currentDish.carbs_g}g carbs).
A similar alternative is available: ${alternative.name} (${alternative.protein_g}g protein, ${alternative.fibre_g}g fibre, ${alternative.carbs_g}g carbs).

In one short, casual sentence, tell the user whether swapping to the alternative helps them hit their goals better, and why. Be direct and specific with numbers.`;

  try {
    const result = await generate(prompt);
    res.json({ explanation: result.response.text().trim() });
  } catch (err) {
    sendModelError(res, err, "swap generation failed");
  }
});

app.post("/recipe", async (req, res) => {
  const { remaining, equipment, skill } = req.body;

  const prompt = `A gym-goer wants to cook a meal at home to hit their remaining daily macros.
Remaining today: ${remaining.protein}g protein, ${remaining.fibre}g fibre, ${remaining.carbs}g carbs.
Equipment available: ${equipment}.
Cooking skill: ${skill}.

Create ONE simple recipe suited to their equipment and skill that gets reasonably close to those remaining macros without wildly overshooting.

Return ONLY valid JSON, no other text, in this exact shape:
{
  "recipe_name": "",
  "steps": ["short step 1", "short step 2"],
  "ingredients": [
    {"name": "", "quantity": "", "protein_g": 0, "carbs_g": 0, "fibre_g": 0}
  ]
}

Give per-ingredient macro estimates for the actual quantity listed (not per 100g) so they can be summed into a total.`;

  try {
    const result = await generate(prompt);
    const text = result.response.text().trim();
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (err) {
    sendModelError(res, err, "recipe generation failed");
  }
});

app.listen(3001, () => console.log("Server running on port 3001"));