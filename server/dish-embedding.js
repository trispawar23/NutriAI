import { embedModel } from "./clients.js";

// Newly added dishes have to be described exactly the way the backfill script
// describes them, or their embeddings land in a different part of the space
// and swap suggestions get worse.
export function dishDescription({ name, is_veg, restaurant_name, protein_g, carbs_g, fibre_g }) {
  return `${name}, ${is_veg ? "vegetarian" : "non-vegetarian"}, from ${restaurant_name}, ${protein_g}g protein, ${carbs_g}g carbs, ${fibre_g}g fibre`;
}

export async function embedDish(dish) {
  const result = await embedModel.embedContent(dishDescription(dish));
  return result.embedding.values;
}
