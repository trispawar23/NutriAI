import { supabaseAdmin } from "./clients.js";
import { embedDish } from "./dish-embedding.js";

async function run() {
  const { data: dishes, error } = await supabaseAdmin
    .from("dishes")
    .select("id, name, is_veg, protein_g, carbs_g, fibre_g, restaurants(name)");

  if (error) {
    console.error("Supabase error:", error);
    return;
  }

  if (!dishes || dishes.length === 0) {
    console.log("No dishes found — check your SUPABASE_URL and SUPABASE_SERVICE_KEY in .env");
    return;
  }

  console.log(`Found ${dishes.length} dishes`);

  for (const dish of dishes) {
    const embedding = await embedDish({ ...dish, restaurant_name: dish.restaurants.name });

    await supabaseAdmin.from("dishes").update({ embedding }).eq("id", dish.id);
    console.log(`Embedded: ${dish.name}`);
  }

  console.log("Done!");
}

run();