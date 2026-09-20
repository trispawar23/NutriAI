import { useState, useMemo, useEffect } from "react";
import { supabase } from "./supabase";
import { postJSON } from "./api";

const ALLERGENS = ["gluten", "dairy", "soy", "nuts", "egg"];

const WEIGHTS = { protein: 1.5, fibre: 1.1, carbs: 0.6 };
const COLORS = { protein: "#C6FF3D", fibre: "#34E4A0", carbs: "#FF6B4A" };

function toDish(row) {
  return {
    id: row.id,
    name: row.name,
    restaurant: row.restaurants.name,
    isVeg: row.is_veg,
    allergens: row.allergens ?? [],
    protein: row.protein_g,
    carbs: row.carbs_g,
    fibre: row.fibre_g,
    fibreVerified: row.fibre_verified,
    status: row.status,
  };
}

function getDeviceId() {
  let id = localStorage.getItem("nutrition_app_device_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("nutrition_app_device_id", id);
  }
  return id;
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function computeMacros({ weight, height, age, sex, activity, goal }) {
  const bmr = sex === "male"
    ? 10 * weight + 6.25 * height - 5 * age + 5
    : 10 * weight + 6.25 * height - 5 * age - 161;

  const activityMultipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const tdee = bmr * activityMultipliers[activity];

  const goalAdjust = { cut: 0.8, maintain: 1.0, bulk: 1.15 };
  const targetCalories = tdee * goalAdjust[goal];

  const proteinPerKg = { cut: 2.0, maintain: 1.8, bulk: 1.6 };
  const proteinG = Math.round(weight * proteinPerKg[goal]);
  const proteinKcal = proteinG * 4;

  const fatKcal = targetCalories * 0.25;
  const carbsG = Math.round((targetCalories - proteinKcal - fatKcal) / 4);
  const fibreG = Math.round((targetCalories / 1000) * 14);

  return { protein: proteinG, carbs: Math.max(0, carbsG), fibre: fibreG, calories: Math.round(targetCalories) };
}

function scoreDish(dish, remaining) {
  let score = 0;
  const macros = dish.fibre === null ? ["protein", "carbs"] : ["protein", "fibre", "carbs"];
  for (const macro of macros) {
    const target = remaining[macro];
    const value = dish[macro];
    const w = WEIGHTS[macro];
    if (target <= 0) {
      score -= value * w * 0.4;
      continue;
    }
    const ratio = value / target;
    score += ratio <= 1 ? ratio * w : w * Math.max(0, 2 - ratio);
  }
  return score;
}

function passesFilters(dish, diet, allergies) {
  if (diet === "veg" && !dish.isVeg) return false;
  if (allergies.some((a) => dish.allergens.includes(a))) return false;
  return true;
}

function App() {
  const deviceId = useMemo(() => getDeviceId(), []);
  const today = todayStr();

  const [calories, setCalories] = useState(2000);
  const [protein, setProtein] = useState(120);
  const [fibre, setFibre] = useState(30);
  const [carbs, setCarbs] = useState(200);
  const [diet, setDiet] = useState("any");
  const [allergies, setAllergies] = useState([]);
  const [cart, setCart] = useState([]);
  const [screen, setScreen] = useState("onboarding");
  const [dishes, setDishes] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function loadEverything() {
      try {
        await loadFromSupabase();
      } catch (err) {
        // An unreachable backend should not leave the app on the splash.
        console.error(err);
      }
      setLoaded(true);
    }

    async function loadFromSupabase() {
      const { data: dishData, error: dishError } = await supabase
        .from("dishes")
        .select("id, name, is_veg, allergens, protein_g, carbs_g, fibre_g, fibre_verified, status, restaurants(name)");
      if (dishError) console.error(dishError);
      else setDishes(dishData.map(toDish));

      const { data: goalRow } = await supabase
        .from("user_goals").select("*").eq("device_id", deviceId).eq("date", today).maybeSingle();
      if (goalRow) {
        setCalories(goalRow.calories_g); setProtein(goalRow.protein_g);
        setFibre(goalRow.fibre_g); setCarbs(goalRow.carbs_g);
        setScreen("picks");
      }

      const { data: mealRows } = await supabase
        .from("logged_meals").select("*").eq("device_id", deviceId).eq("date", today);
      if (mealRows && mealRows.length > 0) {
        setCart(mealRows.map((m) => ({
          name: m.name, restaurant: m.restaurant, protein: m.protein_g,
          carbs: m.carbs_g, fibre: m.fibre_g,
          estimated: m.source === "estimated", selfLogged: m.source === "self_logged",
        })));
      }
    }

    loadEverything();
  }, [deviceId, today]);

  function toggleAllergen(name) {
    setAllergies((prev) => prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]);
  }

  const remaining = useMemo(() => {
    const eaten = cart.reduce((acc, d) => ({
      protein: acc.protein + d.protein, fibre: acc.fibre + (d.fibre || 0), carbs: acc.carbs + d.carbs,
    }), { protein: 0, fibre: 0, carbs: 0 });
    return { protein: protein - eaten.protein, fibre: fibre - eaten.fibre, carbs: carbs - eaten.carbs };
  }, [cart, protein, fibre, carbs]);

  const ranked = useMemo(() => {
    return dishes.filter((d) => passesFilters(d, diet, allergies))
      .map((d) => ({ ...d, _score: scoreDish(d, remaining) }))
      .sort((a, b) => b._score - a._score);
  }, [dishes, remaining, diet, allergies]);

  if (!loaded) {
    return (
      <div className="min-h-screen bg-[#0F0F13] flex items-center justify-center">
        <p className="text-white/30 text-sm font-mono">loading today…</p>
      </div>
    );
  }

  if (screen === "onboarding") {
    return <Onboarding {...{ calories, setCalories, protein, setProtein, fibre, setFibre, carbs, setCarbs, diet, setDiet, allergies, toggleAllergen }}
      onDone={async () => {
        await supabase.from("user_goals").upsert({
          device_id: deviceId, date: today,
          calories_g: calories, protein_g: protein, fibre_g: fibre, carbs_g: carbs,
        });
        setScreen("picks");
      }} />;
  }

  return <Picks {...{ deviceId, today, protein, fibre, carbs, remaining, ranked, cart, setCart, setDishes }}
    onBack={() => setScreen("onboarding")} />;
}

function Stepper({ label, value, onChange, color, step = 5 }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/10">
      <span style={{ color }} className="font-['Space_Grotesk'] font-bold text-lg">{label}</span>
      <div className="flex items-center gap-3">
        <button onClick={() => onChange(Math.max(0, value - step))}
          className="w-9 h-9 rounded-full bg-white/10 text-white text-xl font-bold active:scale-90 transition-transform">–</button>
        <span className="font-mono font-bold text-xl w-14 text-center text-white">{value}<span className="text-white/40 text-sm">g</span></span>
        <button onClick={() => onChange(value + step)} style={{ backgroundColor: color }}
          className="w-9 h-9 rounded-full text-black text-xl font-bold active:scale-90 transition-transform">+</button>
      </div>
    </div>
  );
}

function CalculatorForm({ onCalculated }) {
  const [weight, setWeight] = useState(70);
  const [height, setHeight] = useState(170);
  const [age, setAge] = useState(25);
  const [sex, setSex] = useState("male");
  const [activity, setActivity] = useState("moderate");
  const [goal, setGoal] = useState("maintain");

  function field(label, value, setValue, unit) {
    return (
      <div className="flex items-center justify-between py-2.5 border-b border-white/10">
        <span className="text-white/70 text-sm">{label}</span>
        <div className="flex items-center gap-1">
          <input type="number" value={value} onChange={(e) => setValue(Number(e.target.value))}
            className="bg-white/5 text-white font-mono font-bold text-right w-16 px-2 py-1 rounded outline-none" />
          <span className="text-white/30 text-xs font-mono">{unit}</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {field("Weight", weight, setWeight, "kg")}
      {field("Height", height, setHeight, "cm")}
      {field("Age", age, setAge, "yrs")}

      <div className="py-3">
        <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Sex</p>
        <div className="flex gap-2">
          {["male", "female"].map((s) => (
            <button key={s} onClick={() => setSex(s)}
              className={`flex-1 py-2 rounded-xl text-sm font-bold capitalize ${sex === s ? "bg-[#C6FF3D] text-black" : "bg-white/5 text-white/60"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="py-3">
        <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Activity level</p>
        <div className="flex flex-col gap-2">
          {[
            ["sedentary", "Desk job, little exercise"],
            ["light", "Light exercise 1–3x/week"],
            ["moderate", "Gym 3–5x/week"],
            ["active", "Gym 6–7x/week"],
            ["very_active", "Physical job + daily training"],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setActivity(id)}
              className={`text-left px-3 py-2 rounded-xl text-sm ${activity === id ? "bg-[#34E4A0] text-black font-bold" : "bg-white/5 text-white/60"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="py-3">
        <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Goal</p>
        <div className="flex gap-2">
          {[["cut", "Lose fat"], ["maintain", "Maintain"], ["bulk", "Build muscle"]].map(([id, label]) => (
            <button key={id} onClick={() => setGoal(id)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold ${goal === id ? "bg-[#FF6B4A] text-black" : "bg-white/5 text-white/60"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => onCalculated(computeMacros({ weight, height, age, sex, activity, goal }))}
        className="mt-6 w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg active:scale-[0.98] transition-transform">
        Calculate my targets →
      </button>
    </div>
  );
}

function Onboarding({ calories, setCalories, protein, setProtein, fibre, setFibre, carbs, setCarbs, diet, setDiet, allergies, toggleAllergen, onDone }) {
  const [mode, setMode] = useState("choose");

  if (mode === "choose") {
    return (
      <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] flex flex-col justify-center px-6 py-10 font-['Space_Grotesk']">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="text-4xl font-extrabold leading-none mb-1">Today's<br/>targets.</h1>
          <p className="text-white/40 text-sm mb-8">How do you want to set these?</p>
          <button onClick={() => setMode("calculate")}
            className="w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg mb-3 active:scale-[0.98] transition-transform">
            Calculate for me
          </button>
          <button onClick={() => setMode("manual")}
            className="w-full bg-white/5 text-white/70 py-4 rounded-2xl font-bold text-lg active:scale-[0.98] transition-transform">
            I'll enter manually
          </button>
        </div>
      </div>
    );
  }

  if (mode === "calculate") {
    return (
      <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] px-6 py-10 font-['Space_Grotesk']">
        <div className="max-w-sm mx-auto w-full">
          <button onClick={() => setMode("choose")} className="text-white/40 text-sm mb-4 font-mono">← back</button>
          <h1 className="text-2xl font-extrabold mb-6">Tell us about you</h1>
          <CalculatorForm onCalculated={(result) => {
            setProtein(result.protein); setFibre(result.fibre); setCarbs(result.carbs);
            setCalories(result.calories);
            setMode("manual");
          }} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] flex flex-col justify-center px-6 py-10 font-['Space_Grotesk']">
      <div className="max-w-sm mx-auto w-full">
        <button onClick={() => setMode("choose")} className="text-white/40 text-sm mb-4 font-mono">← back</button>
        <h1 className="text-2xl font-extrabold mb-1">Your targets</h1>
        <p className="text-white/40 text-sm mb-6">Adjust anything before continuing.</p>

        <Stepper label="Calories" value={calories} onChange={setCalories} color="#F5F5F0" step={50} />
        <Stepper label="Protein" value={protein} onChange={setProtein} color={COLORS.protein} />
        <Stepper label="Fibre" value={fibre} onChange={setFibre} color={COLORS.fibre} step={2} />
        <Stepper label="Carbs" value={carbs} onChange={setCarbs} color={COLORS.carbs} step={10} />

        <div className="mt-6">
          <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Diet</p>
          <div className="flex gap-2">
            {[{ id: "any", l: "No restriction" }, { id: "veg", l: "Vegetarian" }].map((o) => (
              <button key={o.id} onClick={() => setDiet(o.id)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${diet === o.id ? "bg-[#C6FF3D] text-black" : "bg-white/5 text-white/60"}`}>
                {o.l}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Allergies</p>
          <div className="flex flex-wrap gap-2">
            {ALLERGENS.map((a) => (
              <button key={a} onClick={() => toggleAllergen(a)}
                className={`px-3 py-1.5 rounded-full text-sm font-bold transition-colors ${allergies.includes(a) ? "bg-[#FF6B4A] text-black" : "bg-white/5 text-white/60"}`}>
                {a}
              </button>
            ))}
          </div>
        </div>

        <button onClick={onDone}
          className="mt-10 w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg active:scale-[0.98] transition-transform">
          See today's picks →
        </button>
      </div>
    </div>
  );
}

function Ring({ pct, color, size = 84, stroke = 9 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="#ffffff1a" strokeWidth={stroke} fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
        strokeDasharray={c} strokeDashoffset={c - (clamped / 100) * c} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.4,0,.2,1)" }} />
    </svg>
  );
}

function MacroRing({ label, remaining, goal, color }) {
  const eaten = goal - remaining;
  const pct = goal > 0 ? (eaten / goal) * 100 : 0;
  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <Ring pct={pct} color={color} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono font-bold text-lg text-white">{Math.max(0, remaining)}</span>
          <span className="text-white/30 text-[10px] font-mono">left</span>
        </div>
      </div>
      <span style={{ color }} className="mt-2 text-xs font-bold font-['Space_Grotesk']">{label}</span>
    </div>
  );
}

function DishCard({ dish, onAdd, index }) {
  return (
    <div
      className="flex items-stretch bg-[#1B1B22] rounded-xl mb-2.5 overflow-hidden opacity-0 animate-[fadeSlide_0.4s_ease_forwards]"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div style={{ backgroundColor: COLORS.protein }} className="w-1.5 shrink-0" />
      <div className="flex-1 flex justify-between items-center p-3.5">
        <div>
          <p className="font-['Space_Grotesk'] font-bold text-white text-[15px]">{dish.name}</p>
          <p className="text-white/40 text-xs mb-1">
            {dish.restaurant}
            {dish.status && dish.status !== "verified" && (
              <span className="ml-2 bg-white/10 text-white/50 text-[10px] font-mono px-1.5 py-0.5 rounded-full">unreviewed</span>
            )}
          </p>
          <div className="flex gap-3 font-mono text-xs">
            <span style={{ color: COLORS.protein }}>P{dish.protein}</span>
            {dish.fibreVerified ? <span style={{ color: COLORS.fibre }}>F{dish.fibre}</span> : <span className="text-white/30">F —</span>}
            <span style={{ color: COLORS.carbs }}>C{dish.carbs}</span>
          </div>
        </div>
        <button onClick={() => onAdd(dish)}
          className="shrink-0 bg-white text-black font-bold text-sm px-4 py-2 rounded-lg active:scale-90 transition-transform">
          Add
        </button>
      </div>
    </div>
  );
}

function CartItem({ dish, remaining }) {
  const [swap, setSwap] = useState(null);
  const [loading, setLoading] = useState(false);

  async function findSwap() {
    setLoading(true);
    setSwap(null);

    const { data: dishRow } = await supabase
      .from("dishes")
      .select("embedding")
      .eq("id", dish.id)
      .single();

    const { data: matches } = await supabase.rpc("match_dishes", {
      query_embedding: dishRow.embedding,
      match_count: 1,
      exclude_id: dish.id,
    });

    if (!matches || matches.length === 0) {
      setSwap({ explanation: "No similar dish found to compare." });
      setLoading(false);
      return;
    }

    const alternative = matches[0];

    try {
      const data = await postJSON("/swap", {
        currentDish: { name: dish.name, protein_g: dish.protein, fibre_g: dish.fibre, carbs_g: dish.carbs },
        alternative: { name: alternative.name, protein_g: alternative.protein_g, fibre_g: alternative.fibre_g, carbs_g: alternative.carbs_g },
        remaining,
      });
      setSwap({ name: alternative.name, explanation: data.explanation });
    } catch (err) {
      setSwap({ explanation: err.message });
    }
    setLoading(false);
  }

  return (
    <div className="bg-[#1B1B22] rounded-xl p-3 mb-2">
      <p className="text-white/80 text-sm font-medium">{dish.name} — <span className="text-white/40">{dish.restaurant}</span></p>
      <button onClick={findSwap} disabled={loading} className="text-xs font-bold mt-1.5" style={{ color: COLORS.fibre }}>
        {loading ? "checking swaps…" : "see a better swap"}
      </button>
      {swap && (
        <p className="text-xs text-white/50 mt-1.5 leading-relaxed">
          {swap.name ? <b className="text-white/70">{swap.name}:</b> : null} {swap.explanation}
        </p>
      )}
    </div>
  );
}

function Picks({ deviceId, today, protein, fibre, carbs, remaining, ranked, cart, setCart, setDishes, onBack }) {
  const [view, setView] = useState("choose"); // choose | order | cook | manual | add
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ranked;
    return ranked.filter((d) => `${d.name} ${d.restaurant}`.toLowerCase().includes(q));
  }, [ranked, query]);

  async function logItem(item) {
    // A dish someone pasted in has not been reviewed, so its numbers are no
    // more trustworthy than an AI estimate.
    const unreviewed = item.status && item.status !== "verified";
    const source = item.estimated || unreviewed ? "estimated" : item.selfLogged ? "self_logged" : "verified";
    await supabase.from("logged_meals").insert({
      device_id: deviceId, date: today,
      name: item.name, restaurant: item.restaurant || null,
      protein_g: item.protein, carbs_g: item.carbs || null, fibre_g: item.fibre || null,
      source,
    });
    setCart([...cart, item]);
    setView("choose");
  }

  const rings = (
    <div className="flex justify-around mb-8">
      <MacroRing label="Protein" remaining={remaining.protein} goal={protein} color={COLORS.protein} />
      <MacroRing label="Fibre" remaining={remaining.fibre} goal={fibre} color={COLORS.fibre} />
      <MacroRing label="Carbs" remaining={remaining.carbs} goal={carbs} color={COLORS.carbs} />
    </div>
  );

  const cartSection = cart.length > 0 && (
    <div className="mt-6 pt-4 border-t border-white/10">
      <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">In cart ({cart.length})</p>
      {cart.map((d, i) => {
        if (d.estimated || d.selfLogged) {
          return (
            <div key={i} className="bg-[#1B1B22] rounded-xl p-3 mb-2">
              <p className="text-white/80 text-sm font-medium">{d.name}</p>
              <span className="inline-block bg-white/10 text-white/50 text-[10px] font-mono px-2 py-0.5 rounded-full mt-1">
                {d.estimated ? "estimated" : "self-logged"}
              </span>
            </div>
          );
        }
        return <CartItem key={i} dish={d} remaining={remaining} />;
      })}
    </div>
  );

  if (view === "cook") return <NutriAI remaining={remaining} onBack={() => setView("choose")} onLog={(item) => logItem({ ...item, estimated: true })} />;
  if (view === "manual") return <ManualLog onBack={() => setView("choose")} onLog={(item) => logItem(item)} />;

  if (view === "add") {
    return (
      <AddDish
        onBack={() => setView("order")}
        onAdded={(dish) => {
          setDishes((prev) => [...prev, dish]);
          setView("order");
        }}
      />
    );
  }

  if (view === "order") {
    return (
      <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] px-5 py-8 font-['Space_Grotesk']">
        <style>{`@keyframes fadeSlide { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }`}</style>
        <button onClick={() => setView("choose")} className="text-white/40 text-sm mb-6 font-mono">← back</button>
        {rings}

        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search dishes or restaurants"
          className="w-full bg-white/5 text-white text-sm px-4 py-2.5 rounded-xl mb-4 outline-none placeholder:text-white/30"
        />

        <p className="text-white/40 text-xs uppercase tracking-wide mb-3 font-mono">
          {query.trim() ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : "Best fit right now"}
        </p>
        {matches.map((d, i) => (
          <DishCard key={d.id} dish={d} onAdd={(dish) => logItem(dish)} index={i} />
        ))}

        <button onClick={() => setView("add")}
          className="w-full mt-2 border border-dashed border-white/15 text-white/50 py-3.5 rounded-xl text-sm font-bold active:scale-[0.98] transition-transform">
          {query.trim() && matches.length === 0 ? `Can't find "${query.trim()}" — add it` : "+ Add a dish to the database"}
        </button>

        {cartSection}
      </div>
    );
  }

  // choose (default)
  return (
    <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] px-5 py-8 font-['Space_Grotesk']">
      <button onClick={onBack} className="text-white/40 text-sm mb-6 font-mono">← edit targets</button>
      {rings}

      <p className="text-white/40 text-xs uppercase tracking-wide mb-3 font-mono">What are you eating?</p>
      <button onClick={() => setView("order")}
        className="w-full bg-[#1B1B22] text-left px-4 py-4 rounded-xl mb-2.5 flex items-center justify-between active:scale-[0.98] transition-transform">
        <span className="font-bold">🍔 Order something</span>
        <span className="text-white/30 text-sm">from {ranked.length} dishes</span>
      </button>
      <button onClick={() => setView("cook")}
        className="w-full bg-[#1B1B22] text-left px-4 py-4 rounded-xl mb-2.5 flex items-center justify-between active:scale-[0.98] transition-transform">
        <span className="font-bold">🍳 Cook something</span>
        <span className="text-white/30 text-sm">AI recipe from what's left</span>
      </button>
      <button onClick={() => setView("manual")}
        className="w-full bg-[#1B1B22] text-left px-4 py-4 rounded-xl mb-2.5 flex items-center justify-between active:scale-[0.98] transition-transform">
        <span className="font-bold">✍️ Log it myself</span>
        <span className="text-white/30 text-sm">anything else</span>
      </button>

      {cartSection}
    </div>
  );
}

function NutriAI({ remaining, onLog, onBack }) {
  const [equipment, setEquipment] = useState("stovetop");
  const [skill, setSkill] = useState("beginner");
  const [recipe, setRecipe] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generate() {
    setLoading(true);
    setRecipe(null);
    setError(null);
    try {
      setRecipe(await postJSON("/recipe", { remaining, equipment, skill }));
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  const totals = recipe
    ? recipe.ingredients.reduce((acc, i) => ({
        protein: acc.protein + i.protein_g,
        carbs: acc.carbs + i.carbs_g,
        fibre: acc.fibre + i.fibre_g,
      }), { protein: 0, carbs: 0, fibre: 0 })
    : null;

  return (
    <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] px-6 py-8 font-['Space_Grotesk']">
      <button onClick={onBack} className="text-white/40 text-sm mb-6 font-mono">← back</button>
      <h1 className="text-2xl font-extrabold mb-6">NutriAI</h1>

      {!recipe && (
        <>
          <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Equipment</p>
          <div className="flex flex-wrap gap-2 mb-6">
            {["stovetop", "air fryer", "oven", "microwave only"].map((e) => (
              <button key={e} onClick={() => setEquipment(e)}
                className={`px-3 py-1.5 rounded-full text-sm font-bold ${equipment === e ? "bg-[#34E4A0] text-black" : "bg-white/5 text-white/60"}`}>
                {e}
              </button>
            ))}
          </div>

          <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Cooking skill</p>
          <div className="flex gap-2 mb-8">
            {["beginner", "comfortable cooking"].map((s) => (
              <button key={s} onClick={() => setSkill(s)}
                className={`flex-1 py-2 rounded-xl text-sm font-bold ${skill === s ? "bg-[#C6FF3D] text-black" : "bg-white/5 text-white/60"}`}>
                {s}
              </button>
            ))}
          </div>

          <button onClick={generate} disabled={loading}
            className="w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg active:scale-[0.98] transition-transform">
            {loading ? "Cooking up an idea…" : "Suggest something to cook"}
          </button>
          {error && <p className="text-[#FF6B4A] text-sm mt-3">{error}</p>}
        </>
      )}

      {recipe && totals && (
        <div>
          <h2 className="text-xl font-bold mb-1">{recipe.recipe_name}</h2>
          <span className="inline-block bg-white/10 text-white/50 text-[10px] font-mono px-2 py-0.5 rounded-full mb-4">estimated</span>

          <div className="flex gap-4 font-mono text-sm mb-5">
            <span style={{ color: COLORS.protein }}>P{Math.round(totals.protein)}</span>
            <span style={{ color: COLORS.fibre }}>F{Math.round(totals.fibre)}</span>
            <span style={{ color: COLORS.carbs }}>C{Math.round(totals.carbs)}</span>
          </div>

          <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Ingredients</p>
          {recipe.ingredients.map((ing, i) => (
            <p key={i} className="text-white/70 text-sm mb-1">{ing.quantity} {ing.name}</p>
          ))}

          <p className="text-white/40 text-xs uppercase tracking-wide mt-5 mb-2 font-mono">Steps</p>
          {recipe.steps.map((s, i) => (
            <p key={i} className="text-white/70 text-sm mb-1.5">{i + 1}. {s}</p>
          ))}

          <button
            onClick={() => onLog({
              name: recipe.recipe_name, restaurant: "Home cooked",
              protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fibre: Math.round(totals.fibre),
              estimated: true,
            })}
            className="mt-6 w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg active:scale-[0.98] transition-transform">
            I made this — log it
          </button>
        </div>
      )}
    </div>
  );
}

function AddDish({ onAdded, onBack }) {
  const [rawText, setRawText] = useState("");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function extract() {
    setBusy(true);
    setError(null);
    try {
      const parsed = await postJSON("/extract", { rawText });
      setDraft({
        ...parsed,
        allergens: Array.isArray(parsed.allergens) ? parsed.allergens : [],
        protein_g: Math.round(parsed.protein_g ?? 0),
        carbs_g: Math.round(parsed.carbs_g ?? 0),
        fibre_g: Math.round(parsed.fibre_g ?? 0),
      });
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onAdded(toDish(await postJSON("/dishes", draft)));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function edit(patch) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  const shell = (children) => (
    <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] px-6 py-8 font-['Space_Grotesk']">
      <button onClick={onBack} className="text-white/40 text-sm mb-6 font-mono">← back</button>
      {children}
      {error && <p className="text-[#FF6B4A] text-sm mt-3">{error}</p>}
    </div>
  );

  if (!draft) {
    return shell(
      <>
        <h1 className="text-2xl font-extrabold mb-1">Add a dish</h1>
        <p className="text-white/40 text-sm mb-6">
          Paste the menu description or nutrition panel. We'll pull the numbers out, you check them,
          and everyone gets the dish.
        </p>

        <textarea
          value={rawText} onChange={(e) => setRawText(e.target.value)} rows={7}
          placeholder="e.g. Chipotle chicken burrito bowl — brown rice, black beans, fajita veggies. 45g protein, 62g carbs, 14g fibre."
          className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl outline-none placeholder:text-white/30 resize-none"
        />

        <button
          onClick={extract} disabled={busy || rawText.trim().length < 10}
          className="mt-6 w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg disabled:opacity-30 active:scale-[0.98] transition-transform">
          {busy ? "Reading it…" : "Pull out the nutrition"}
        </button>
      </>
    );
  }

  const estimated = draft.confidence !== "high";

  return shell(
    <>
      <h1 className="text-2xl font-extrabold mb-1">Check the numbers</h1>
      <p className="text-white/40 text-sm mb-4">Fix anything that looks off before it goes in the database.</p>

      <span className={`inline-block text-[10px] font-mono px-2 py-0.5 rounded-full mb-4 ${estimated ? "bg-[#FF6B4A]/20 text-[#FF6B4A]" : "bg-[#34E4A0]/20 text-[#34E4A0]"}`}>
        {estimated ? "estimated" : "stated on the source"}
      </span>
      {draft.source_note && <p className="text-white/40 text-xs mb-4 leading-relaxed">{draft.source_note}</p>}

      <input
        value={draft.dish_name ?? ""} onChange={(e) => edit({ dish_name: e.target.value })} placeholder="Dish name"
        className="w-full bg-white/5 text-white px-4 py-3 rounded-xl mb-2 outline-none placeholder:text-white/30"
      />
      <input
        value={draft.restaurant_name ?? ""} onChange={(e) => edit({ restaurant_name: e.target.value })} placeholder="Restaurant"
        className="w-full bg-white/5 text-white px-4 py-3 rounded-xl mb-4 outline-none placeholder:text-white/30"
      />

      <Stepper label="Protein" value={draft.protein_g} onChange={(v) => edit({ protein_g: v })} color={COLORS.protein} />
      <Stepper label="Fibre" value={draft.fibre_g} onChange={(v) => edit({ fibre_g: v })} color={COLORS.fibre} step={1} />
      <Stepper label="Carbs" value={draft.carbs_g} onChange={(v) => edit({ carbs_g: v })} color={COLORS.carbs} step={5} />

      <div className="mt-6">
        <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Diet</p>
        <div className="flex gap-2">
          {[{ veg: true, l: "Vegetarian" }, { veg: false, l: "Non-veg" }].map((o) => (
            <button key={o.l} onClick={() => edit({ is_veg: o.veg })}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${draft.is_veg === o.veg ? "bg-[#C6FF3D] text-black" : "bg-white/5 text-white/60"}`}>
              {o.l}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <p className="text-white/40 text-xs uppercase tracking-wide mb-2 font-mono">Contains</p>
        <div className="flex flex-wrap gap-2">
          {ALLERGENS.map((a) => (
            <button key={a}
              onClick={() => edit({ allergens: draft.allergens.includes(a) ? draft.allergens.filter((x) => x !== a) : [...draft.allergens, a] })}
              className={`px-3 py-1.5 rounded-full text-sm font-bold transition-colors ${draft.allergens.includes(a) ? "bg-[#FF6B4A] text-black" : "bg-white/5 text-white/60"}`}>
              {a}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={save} disabled={busy || !draft.dish_name?.trim() || !draft.restaurant_name?.trim()}
        className="mt-8 w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg disabled:opacity-30 active:scale-[0.98] transition-transform">
        {busy ? "Saving…" : "Add to the database"}
      </button>
      <button onClick={() => setDraft(null)} className="mt-3 w-full text-white/40 text-sm font-mono">
        start over
      </button>
    </>
  );
}

function ManualLog({ onLog, onBack }) {
  const [name, setName] = useState("");
  const [protein, setProtein] = useState(0);
  const [carbs, setCarbs] = useState(0);
  const [fibre, setFibre] = useState(0);

  return (
    <div className="min-h-screen bg-[#0F0F13] text-[#F5F5F0] px-6 py-8 font-['Space_Grotesk']">
      <button onClick={onBack} className="text-white/40 text-sm mb-6 font-mono">← back</button>
      <h1 className="text-2xl font-extrabold mb-1">Log something</h1>
      <p className="text-white/40 text-sm mb-6">For anything not in the app — you know the numbers, we'll just add them up.</p>

      <input
        value={name} onChange={(e) => setName(e.target.value)} placeholder="What did you eat?"
        className="w-full bg-white/5 text-white px-4 py-3 rounded-xl mb-4 outline-none placeholder:text-white/30"
      />

      <Stepper label="Protein" value={protein} onChange={setProtein} color={COLORS.protein} />
      <Stepper label="Fibre" value={fibre} onChange={setFibre} color={COLORS.fibre} step={1} />
      <Stepper label="Carbs" value={carbs} onChange={setCarbs} color={COLORS.carbs} step={5} />

      <button
        disabled={!name}
        onClick={() => onLog({ name, restaurant: "Self-logged", protein, carbs, fibre, selfLogged: true })}
        className="mt-8 w-full bg-[#C6FF3D] text-black py-4 rounded-2xl font-extrabold text-lg disabled:opacity-30 active:scale-[0.98] transition-transform">
        Log it
      </button>
    </div>
  );
}

export default App;