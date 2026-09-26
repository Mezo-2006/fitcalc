/* =========================================================
   FitCalc — script.js
   Part 1: pure calculation + data logic (no DOM access)
   Part 2: UI
   Units: height = cm, weight = kg, energy = kcal, macros = grams.
   ========================================================= */
'use strict';

/* =========================================================
   PART 1 — CONFIG & CALCULATIONS
   ========================================================= */

const STORAGE_KEY = 'fitcalc:v1';

/** Accepted input ranges (validation). */
const LIMITS = {
  age:    { min: 15,  max: 90,  label: 'Age',    unit: 'years', integer: true },
  height: { min: 120, max: 230, label: 'Height', unit: 'cm' },
  weight: { min: 30,  max: 300, label: 'Weight', unit: 'kg' },
};

/**
 * Activity multipliers applied to BMR to estimate TDEE.
 * These are the standard Harris-Benedict / Mifflin activity factors.
 */
const ACTIVITY_LEVELS = {
  sedentary: { label: 'Sedentary',         multiplier: 1.2 },
  light:     { label: 'Lightly Active',    multiplier: 1.375 },
  moderate:  { label: 'Moderately Active', multiplier: 1.55 },
  very:      { label: 'Very Active',       multiplier: 1.725 },
  extreme:   { label: 'Extremely Active',  multiplier: 1.9 },
};
const ACTIVITY_ORDER = ['sedentary', 'light', 'moderate', 'very', 'extreme'];

/**
 * Exercise days per week. `days` is a representative number; `minLevel` is the lowest
 * activity level we will assume for that much training (so someone who trains 5–6 days
 * but calls themselves "Sedentary" is not under-estimated).
 */
const EXERCISE_DAYS = {
  '0':   { days: 0, minLevel: 'sedentary' },
  '1-2': { days: 2, minLevel: 'light' },
  '3-4': { days: 4, minLevel: 'moderate' },
  '5-6': { days: 6, minLevel: 'moderate' },
  '7':   { days: 7, minLevel: 'very' },
};

/**
 * Goals. `adjust` = fraction of TDEE added (+) or removed (-).
 * `protein` = grams per kg of (reference) body weight.
 */
const GOALS = {
  'lose-moderate':   { label: 'Moderate fat loss',   short: 'fat loss',      adjust: -0.15, protein: 2.0, direction: 'lose' },
  'lose-aggressive': { label: 'Aggressive fat loss', short: 'fat loss',      adjust: -0.20, protein: 2.2, direction: 'lose' },
  'maintain':        { label: 'Maintain weight',     short: 'maintenance',   adjust: 0,     protein: 1.6, direction: 'hold' },
  'lean-gain':       { label: 'Lean gain',           short: 'lean gain',     adjust: 0.05,  protein: 1.8, direction: 'gain' },
  'build':           { label: 'Build muscle',        short: 'muscle gain',   adjust: 0.10,  protein: 1.8, direction: 'gain' },
};

/** Safeguard: never recommend fewer calories than this on a deficit goal. */
const MIN_CALORIES = { male: 1500, female: 1200 };

/** Energy per gram (Atwater factors). */
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

const FAT_SHARE = 0.25;      // default: 25% of calories from fat
const MIN_FAT_PER_KG = 0.6;  // never go below ~0.6 g/kg (hormone/vitamin health)
const MIN_CARBS_G = 80;      // keep a sensible carbohydrate floor
const PROTEIN_MAX_SHARE = 0.35; // protein never more than 35% of calories

const roundTo = (n, step) => Math.round(n / step) * step;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** Parse a user-typed number strictly ("72", "72.5", "72,5"). Returns NaN if invalid. */
function parseNumber(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/**
 * Validate raw form values (strings). Returns { valid, errors, values }.
 * `errors` is keyed by field name with friendly messages.
 */
function validateInputs(raw) {
  const errors = {};
  const values = {};

  if (raw.sex === 'male' || raw.sex === 'female') values.sex = raw.sex;
  else errors.sex = 'Please choose male or female. It is only used in the BMR formula.';

  for (const key of ['age', 'height', 'weight']) {
    const lim = LIMITS[key];
    const text = String(raw[key] ?? '').trim();
    const n = parseNumber(text);
    if (text === '') errors[key] = `Please enter your ${lim.label.toLowerCase()}.`;
    else if (Number.isNaN(n)) errors[key] = 'Numbers only, please (for example 72).';
    else if (lim.integer && !Number.isInteger(n)) errors[key] = `${lim.label} should be a whole number.`;
    else if (n < lim.min || n > lim.max) errors[key] = `${lim.label} should be between ${lim.min} and ${lim.max} ${lim.unit}.`;
    else values[key] = n;
  }

  if (raw.days in EXERCISE_DAYS) values.days = raw.days;
  else errors.days = 'Pick how many days per week you exercise.';

  if (raw.level in ACTIVITY_LEVELS) values.level = raw.level;
  else errors.level = 'Pick the activity level that fits a typical day.';

  if (raw.goal in GOALS) values.goal = raw.goal;
  else errors.goal = 'Choose a goal so we can set your calorie target.';

  return { valid: Object.keys(errors).length === 0, errors, values };
}

/**
 * BMR — Mifflin-St Jeor equation.
 *   Male:   10 × weight(kg) + 6.25 × height(cm) − 5 × age + 5
 *   Female: 10 × weight(kg) + 6.25 × height(cm) − 5 × age − 161
 */
function calculateBMR({ sex, age, height, weight }) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}

/**
 * TDEE = BMR × activity multiplier.
 * The effective level is the higher of the chosen level and the minimum implied by exercise days.
 */
function calculateTDEE(bmr, level, daysKey) {
  const floorLevel = EXERCISE_DAYS[daysKey].minLevel;
  const effective = ACTIVITY_ORDER.indexOf(floorLevel) > ACTIVITY_ORDER.indexOf(level) ? floorLevel : level;
  const multiplier = ACTIVITY_LEVELS[effective].multiplier;
  return { tdee: bmr * multiplier, level: effective, multiplier, adjusted: effective !== level };
}

/**
 * Goal calories = TDEE × (1 + goal adjustment), rounded to 10 kcal.
 * On a deficit the target is not allowed to fall under a safe minimum (1500 male / 1200 female),
 * but the floor is never allowed to exceed maintenance itself.
 */
function calculateCalories(tdee, goalKey, sex) {
  const goal = GOALS[goalKey];
  let target = tdee * (1 + goal.adjust);
  let floorApplied = false;
  if (goal.adjust < 0) {
    const floor = Math.min(MIN_CALORIES[sex], tdee);
    if (target < floor) { target = floor; floorApplied = true; }
  }
  target = roundTo(target, 10);
  return { target, adjust: goal.adjust, floorApplied, percentFromTDEE: ((target / tdee) - 1) * 100 };
}

/**
 * Macros that add up to the calorie target.
 *  1. Protein = g/kg (by goal) × reference weight. Reference weight is capped at BMI 27 so that
 *     people with a lot of body fat are not given inflated protein numbers. Max 35% of calories.
 *  2. Fat = 25% of calories (but at least 0.6 g/kg).
 *  3. Carbs = whatever calories remain (÷ 4 kcal/g).
 *  4. If carbs would drop below 80 g (very low-calorie plans) fat is trimmed first, then protein.
 * Grams are rounded, then carbs are re-derived from the remainder so the total stays within a few kcal.
 */
function calculateMacros(calories, weightKg, heightCm, goalKey) {
  const goal = GOALS[goalKey];
  const hm = heightCm / 100;
  const refWeight = Math.min(weightKg, 27 * hm * hm);

  let protein = Math.min(goal.protein * refWeight, (PROTEIN_MAX_SHARE * calories) / KCAL_PER_G.protein);
  let fat = Math.max((FAT_SHARE * calories) / KCAL_PER_G.fat, MIN_FAT_PER_KG * refWeight);
  let carbs = (calories - protein * KCAL_PER_G.protein - fat * KCAL_PER_G.fat) / KCAL_PER_G.carbs;

  if (carbs < MIN_CARBS_G) {
    fat = Math.max((0.2 * calories) / KCAL_PER_G.fat, 0.5 * refWeight);
    carbs = (calories - protein * KCAL_PER_G.protein - fat * KCAL_PER_G.fat) / KCAL_PER_G.carbs;
    if (carbs < MIN_CARBS_G) {
      carbs = MIN_CARBS_G;
      protein = (calories - fat * KCAL_PER_G.fat - carbs * KCAL_PER_G.carbs) / KCAL_PER_G.protein;
    }
  }

  const p = Math.round(protein);
  const f = Math.round(fat);
  const c = Math.max(0, Math.round((calories - p * KCAL_PER_G.protein - f * KCAL_PER_G.fat) / KCAL_PER_G.carbs));

  const kcal = { protein: p * KCAL_PER_G.protein, carbs: c * KCAL_PER_G.carbs, fat: f * KCAL_PER_G.fat };
  const total = kcal.protein + kcal.carbs + kcal.fat;

  // Percentages that always add to exactly 100 (largest-remainder style fix on the biggest share).
  const pct = {
    protein: Math.round((kcal.protein / total) * 100),
    carbs: Math.round((kcal.carbs / total) * 100),
    fat: Math.round((kcal.fat / total) * 100),
  };
  const drift = 100 - (pct.protein + pct.carbs + pct.fat);
  if (drift !== 0) {
    const biggest = Object.keys(pct).reduce((a, b) => (pct[a] >= pct[b] ? a : b));
    pct[biggest] += drift;
  }

  return { protein: p, carbs: c, fat: f, kcal, totalKcal: total, pct, diffFromTarget: total - calories };
}

/** BMI = weight(kg) / height(m)². */
function calculateBMI(weightKg, heightCm) {
  const bmi = weightKg / Math.pow(heightCm / 100, 2);
  let category = 'Obesity range';
  if (bmi < 18.5) category = 'Underweight range';
  else if (bmi < 25) category = 'Healthy range';
  else if (bmi < 30) category = 'Overweight range';
  return { value: Math.round(bmi * 10) / 10, category };
}

/** Water: ~35 ml per kg per day, plus extra on training days. Returned in litres (0.1 precision). */
function calculateWater(weightKg, daysKey) {
  const days = EXERCISE_DAYS[daysKey].days;
  const extra = days >= 3 ? 0.5 : days >= 1 ? 0.25 : 0;
  const litres = Math.round((weightKg * 0.035 + extra) * 10) / 10;
  return { litres, glasses: Math.round((litres * 1000) / 250) };
}

/** Suggested daily steps: based on effective activity level, +1,000 for fat-loss goals (max 12,000). */
function calculateSteps(level, goalKey) {
  const base = { sedentary: 6000, light: 7000, moderate: 8000, very: 10000, extreme: 10000 }[level];
  const bonus = GOALS[goalKey].direction === 'lose' ? 1000 : 0;
  return Math.min(12000, roundTo(base + bonus, 500));
}

/** Build the whole plan from validated values. */
function calculatePlan(values) {
  const bmr = calculateBMR(values);
  const activity = calculateTDEE(bmr, values.level, values.days);
  const calories = calculateCalories(activity.tdee, values.goal, values.sex);
  const macros = calculateMacros(calories.target, values.weight, values.height, values.goal);
  const plan = {
    inputs: values,
    bmr,
    activity,
    tdee: activity.tdee,
    calories,
    macros,
    bmi: calculateBMI(values.weight, values.height),
    water: calculateWater(values.weight, values.days),
    steps: calculateSteps(activity.level, values.goal),
  };
  plan.notes = buildNotes(plan);
  plan.summary = generateSummary(plan);
  return plan;
}

/** Short personalised paragraph. Estimates only — no medical claims. */
function generateSummary(plan) {
  const { inputs, tdee, calories, macros } = plan;
  const goal = GOALS[inputs.goal];
  const maintenance = fmt(roundTo(tdee, 10));
  const target = fmt(calories.target);
  const pct = Math.abs(Math.round(calories.percentFromTDEE));

  let goalSentence;
  if (goal.direction === 'lose') {
    const style = inputs.goal === 'lose-aggressive' ? 'an assertive' : 'a moderate';
    goalSentence = `Since your goal is fat loss, ${style} target of around ${target} kcal/day (about ${pct}% below maintenance) may be appropriate.`;
  } else if (goal.direction === 'gain') {
    const what = inputs.goal === 'build' ? 'building muscle' : 'a lean gain';
    goalSentence = `Since your goal is ${what}, a modest surplus of around ${target} kcal/day (about ${pct}% above maintenance) may be appropriate.`;
  } else {
    goalSentence = `Since your goal is to maintain your weight, eating around ${target} kcal/day may be a good fit.`;
  }

  const macroSentence = `That works out to roughly ${macros.protein} g protein, ${macros.carbs} g carbs and ${macros.fat} g fat per day.`;
  const tail = goal.direction === 'lose'
    ? ' Pairing this with regular strength training can help you keep muscle while you lose fat.'
    : goal.direction === 'gain'
      ? ' Pair it with progressive strength training and adequate rest.'
      : '';

  return `Based on your current stats and activity level, your estimated maintenance intake is around ${maintenance} kcal/day. ${goalSentence} ${macroSentence}${tail}`;
}

/** Helpful heads-ups shown under the summary. */
function buildNotes(plan) {
  const notes = [];
  const { inputs, calories, activity, bmi } = plan;
  if (calories.floorApplied) {
    notes.push(`Your target was kept at ${fmt(calories.target)} kcal, a commonly used minimum, instead of going lower. Very low intakes are not recommended.`);
  }
  if (activity.adjusted) {
    notes.push(`Because you exercise ${inputs.days === '7' ? 'every day' : inputs.days.replace('-', '–') + ' days a week'}, we treated your activity as "${ACTIVITY_LEVELS[activity.level].label}".`);
  }
  if (inputs.age < 18) {
    notes.push('These formulas are designed for adults. If you are under 18, please talk to a doctor or dietitian before changing your diet.');
  }
  if (bmi.value < 18.5 && GOALS[inputs.goal].direction === 'lose') {
    notes.push('Your BMI is in the underweight range, so a fat-loss goal may not suit you. Consider Maintain or a gain goal, or ask a qualified professional.');
  }
  return notes;
}

/* =========================================================
   WORKOUT DATA
   rx[level] = [sets, reps/duration, rest seconds]
   names[level] = display name for beginner / intermediate / advanced
   ========================================================= */

const LEVELS = ['beginner', 'intermediate', 'advanced'];

const EXERCISES = {
  pushup: {
    names: ['Incline Push-ups', 'Push-ups', 'Decline Push-ups'], icon: 'push',
    muscles: ['Chest', 'Shoulders', 'Triceps'],
    desc: 'Hands on a sofa or wall for beginners. Keep your body in one straight line and lower your chest to just above the floor.',
    rx: [[3, '8–10', 60], [3, '10–15', 45], [4, '12–20', 45]],
  },
  squat: {
    names: ['Bodyweight Squats', 'Bodyweight Squats', 'Jump Squats'], icon: 'squat',
    muscles: ['Quads', 'Glutes', 'Hamstrings'],
    desc: 'Feet shoulder-width apart, sit your hips back and down, chest tall, then drive up through your heels.',
    rx: [[3, '12', 60], [3, '15', 45], [4, '12', 45]],
  },
  bridge: {
    names: ['Glute Bridges', 'Glute Bridges', 'Single-Leg Glute Bridges'], icon: 'bridge',
    muscles: ['Glutes', 'Hamstrings', 'Lower back'],
    desc: 'Lie on your back with knees bent. Push through your heels to lift your hips, squeeze at the top, lower slowly.',
    rx: [[3, '12', 45], [3, '15', 45], [3, '10 each leg', 45]],
  },
  lunge: {
    names: ['Reverse Lunges', 'Lunges', 'Walking Lunges'], icon: 'lunge',
    muscles: ['Quads', 'Glutes', 'Balance'],
    desc: 'Step one leg back or forward and lower until both knees are about 90°. Push back up and switch legs.',
    rx: [[2, '8 each leg', 60], [3, '10 each leg', 45], [4, '12 each leg', 45]],
  },
  plank: {
    names: ['Knee Plank', 'Plank', 'Plank'], icon: 'hold',
    muscles: ['Core', 'Shoulders', 'Glutes'],
    desc: 'Forearms on the floor, body in a straight line from head to heels. Squeeze your abs and glutes and breathe steadily.',
    rx: [[3, '20 sec', 45], [3, '30–40 sec', 45], [3, '45–60 sec', 45]],
  },
  mountain: {
    names: ['Mountain Climbers', 'Mountain Climbers', 'Mountain Climbers'], icon: 'cardio',
    muscles: ['Core', 'Shoulders', 'Cardio'],
    desc: 'From a high plank, drive your knees toward your chest one after the other. Keep your hips low and steady.',
    rx: [[3, '20 sec', 45], [3, '30 sec', 45], [4, '40 sec', 30]],
  },
  pike: {
    names: ['Pike Hold', 'Pike Push-ups', 'Elevated Pike Push-ups'], icon: 'push',
    muscles: ['Shoulders', 'Triceps', 'Upper chest'],
    desc: 'Hips high in an upside-down V. Bend your elbows to bring your head toward the floor, then press back up.',
    rx: [[3, '20 sec', 60], [3, '8–12', 60], [4, '8–12', 60]],
  },
  dips: {
    names: ['Chair Tricep Dips', 'Chair Tricep Dips', 'Chair Tricep Dips'], icon: 'push',
    muscles: ['Triceps', 'Chest', 'Shoulders'],
    desc: 'Hands on a sturdy chair edge, hips just off the seat. Bend your elbows straight back, then press up. Straighten your legs to make it harder.',
    rx: [[3, '6–8', 60], [3, '10–12', 45], [4, '12–15', 45]],
  },
  superman: {
    names: ['Superman', 'Superman', 'Superman Hold'], icon: 'hold',
    muscles: ['Lower back', 'Glutes', 'Rear shoulders'],
    desc: 'Lie face down and lift arms, chest and legs a few centimetres. Pause for a second and lower under control.',
    rx: [[3, '10', 45], [3, '12–15', 45], [4, '15', 30]],
  },
  taps: {
    names: ['Plank Shoulder Taps', 'Plank Shoulder Taps', 'Plank Shoulder Taps'], icon: 'hold',
    muscles: ['Shoulders', 'Core'],
    desc: 'In a high plank with feet wide, tap each shoulder with the opposite hand without rocking your hips.',
    rx: [[3, '8 each side', 45], [3, '12 each side', 45], [4, '16 each side', 30]],
  },
  wallsit: {
    names: ['Wall Sit', 'Wall Sit', 'Wall Sit'], icon: 'squat',
    muscles: ['Quads', 'Glutes'],
    desc: 'Back flat against a wall, thighs parallel to the floor and knees over ankles. Hold and breathe.',
    rx: [[3, '20 sec', 45], [3, '40 sec', 45], [3, '60 sec', 45]],
  },
  sidelunge: {
    names: ['Side Lunges', 'Side Lunges', 'Side Lunges'], icon: 'lunge',
    muscles: ['Inner thighs', 'Glutes', 'Quads'],
    desc: 'Step wide to one side, sit back into that hip with the other leg straight, then push back to centre.',
    rx: [[3, '8 each side', 45], [3, '10 each side', 45], [4, '12 each side', 45]],
  },
  calf: {
    names: ['Calf Raises', 'Calf Raises', 'Single-Leg Calf Raises'], icon: 'squat',
    muscles: ['Calves', 'Ankles'],
    desc: 'Rise onto the balls of your feet, pause at the top, and lower slowly. Hold a wall for balance if needed.',
    rx: [[3, '15', 30], [3, '20', 30], [3, '15 each leg', 30]],
  },
  deadbug: {
    names: ['Dead Bugs', 'Dead Bugs', 'Dead Bugs'], icon: 'core',
    muscles: ['Deep core', 'Hip flexors'],
    desc: 'On your back, arms up and knees over hips. Lower opposite arm and leg while keeping your lower back on the floor.',
    rx: [[3, '8 each side', 45], [3, '10 each side', 45], [3, '12 each side', 30]],
  },
  bicycle: {
    names: ['Bicycle Crunches', 'Bicycle Crunches', 'Bicycle Crunches'], icon: 'core',
    muscles: ['Abs', 'Obliques'],
    desc: 'Hands lightly behind your head. Bring opposite elbow and knee together in a smooth pedalling motion.',
    rx: [[3, '12 total', 45], [3, '20 total', 45], [3, '30 total', 30]],
  },
  legraise: {
    names: ['Bent-Knee Leg Raises', 'Lying Leg Raises', 'Lying Leg Raises'], icon: 'core',
    muscles: ['Lower abs', 'Hip flexors'],
    desc: 'Lie on your back, press your lower back into the floor and raise your legs, then lower slowly without arching.',
    rx: [[3, '10', 45], [3, '12', 45], [3, '15', 30]],
  },
  twist: {
    names: ['Russian Twists', 'Russian Twists', 'Russian Twists'], icon: 'core',
    muscles: ['Obliques', 'Abs'],
    desc: 'Sit leaning back with knees bent, and rotate your torso side to side. Lift your feet to make it harder.',
    rx: [[3, '16 total', 45], [3, '24 total', 45], [3, '40 total', 30]],
  },
  birddog: {
    names: ['Bird Dogs', 'Bird Dogs', 'Bird Dogs'], icon: 'core',
    muscles: ['Core', 'Lower back', 'Glutes'],
    desc: 'On hands and knees, extend the opposite arm and leg, hold a moment, then switch without twisting your hips.',
    rx: [[3, '8 each side', 45], [3, '10 each side', 45], [3, '12 each side', 30]],
  },
  jacks: {
    names: ['Jumping Jacks', 'Jumping Jacks', 'Jumping Jacks'], icon: 'cardio',
    muscles: ['Full body', 'Cardio'],
    desc: 'Jump your feet wide while raising your arms overhead, then return. Step side to side for a low-impact option.',
    rx: [[3, '30 sec', 30], [3, '40 sec', 30], [3, '45 sec', 30]],
  },
};

const WORKOUT_TYPES = {
  full:  { title: 'Full Body',  blurb: 'Every major muscle group in one session.', list: ['pushup', 'squat', 'bridge', 'lunge', 'plank', 'mountain'] },
  upper: { title: 'Upper Body', blurb: 'Chest, shoulders, arms and back.',          list: ['pushup', 'pike', 'dips', 'superman', 'taps', 'plank'] },
  lower: { title: 'Lower Body', blurb: 'Quads, glutes, hamstrings and calves.',     list: ['squat', 'lunge', 'bridge', 'wallsit', 'sidelunge', 'calf'] },
  core:  { title: 'Core',       blurb: 'Abs, obliques and a stable spine.',         list: ['plank', 'deadbug', 'bicycle', 'legraise', 'twist', 'birddog'] },
  quick: { title: 'Quick 10-Min Workout', blurb: 'A fast circuit: 5 moves, 2 rounds.', list: ['jacks', 'squat', 'pushup', 'mountain', 'plank'] },
};

/** Work/rest seconds for the Quick 10-Min circuit (5 exercises × 2 rounds × 60s ≈ 10 min). */
const QUICK_TIMING = [{ work: 30, rest: 30 }, { work: 40, rest: 20 }, { work: 45, rest: 15 }];

/** Seconds of work when a prescription is a duration ("30–40 sec" → 40), otherwise null. */
function parseSeconds(reps) {
  const m = /(\d+)\s*sec/.exec(reps);
  return m ? Number(m[1]) : null;
}

/** Build a workout for a type + level. */
function generateWorkout(type, level) {
  const def = WORKOUT_TYPES[type] || WORKOUT_TYPES.full;
  const li = Math.max(0, LEVELS.indexOf(level));
  const isQuick = type === 'quick';

  const exercises = def.list.map((id) => {
    const ex = EXERCISES[id];
    let [sets, reps, rest] = ex.rx[li];
    if (isQuick) {
      const t = QUICK_TIMING[li];
      sets = 2; reps = `${t.work} sec`; rest = t.rest;
    }
    return {
      id, name: ex.names[li], difficulty: LEVELS[li], muscles: ex.muscles, icon: ex.icon,
      desc: ex.desc, sets, reps, rest, seconds: parseSeconds(reps),
    };
  });

  // Estimated duration: timed sets use their length, rep sets are estimated at ~40 s.
  let total = 0;
  exercises.forEach((e) => { total += e.sets * ((e.seconds || 40) + e.rest); });
  total -= exercises[exercises.length - 1].rest;
  return { type, level: LEVELS[li], title: def.title, blurb: def.blurb, exercises, minutes: Math.max(1, Math.round(total / 60)) };
}

/** Suggest a level from how many days per week the user trains. */
function suggestLevel(daysKey) {
  if (daysKey === '0' || daysKey === '1-2') return 'beginner';
  if (daysKey === '3-4') return 'intermediate';
  return 'advanced';
}

/* Allow Node-based tests to import the pure logic. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateInputs, calculateBMR, calculateTDEE, calculateCalories, calculateMacros,
    calculateBMI, calculateWater, calculateSteps, calculatePlan, generateSummary,
    generateWorkout, suggestLevel, GOALS, ACTIVITY_LEVELS, WORKOUT_TYPES, LEVELS, EXERCISES,
  };
}

/* =========================================================
   PART 2 — UI (browser only)
   ========================================================= */
if (typeof document !== 'undefined') {
  (function initUI() {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- Safe localStorage ---------- */
    const store = {
      read() {
        try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
      },
      write(data) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable — app still works */ }
      },
      clear() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      },
    };

    /* ---------- Toast ---------- */
    const toastEl = $('#toast');
    let toastTimer;
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.hidden = false;
      toastEl.style.animation = 'none'; void toastEl.offsetWidth; toastEl.style.animation = '';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
    }

    /* =====================================================
       NAVIGATION
       ===================================================== */
    const nav = $('#site-nav');
    const navToggle = $('#nav-toggle');
    function setNav(open) {
      nav.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    navToggle.addEventListener('click', () => setNav(!nav.classList.contains('open')));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { setNav(false); navToggle.focus(); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('.header-inner')) setNav(false); });

    // Highlight the current section in the nav.
    const navLinks = new Map($$('[data-nav]').map((a) => [a.dataset.nav, a]));
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            navLinks.forEach((a) => { a.classList.remove('active'); a.removeAttribute('aria-current'); });
            const a = navLinks.get(en.target.id);
            if (a) { a.classList.add('active'); a.setAttribute('aria-current', 'true'); }
          }
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      ['home', 'calculator', 'results', 'workouts', 'tips'].forEach((id) => { const s = document.getElementById(id); if (s) io.observe(s); });
    }

    /* =====================================================
       FORM (3 steps)
       ===================================================== */
    const form = $('#calc-form');
    const steps = $$('.step', form);
    const STEP_NAMES = ['About you', 'Activity', 'Your goal'];
    const STEP_FIELDS = { 1: ['sex', 'age', 'height', 'weight'], 2: ['days', 'level'], 3: ['goal'] };
    const btnBack = $('#btn-back');
    const btnNext = $('#btn-next');
    let currentStep = 1;

    function getFormValues() {
      const checked = (name) => { const el = form.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ''; };
      return {
        sex: checked('sex'), age: form.age.value, height: form.height.value, weight: form.weight.value,
        days: checked('days'), level: checked('level'), goal: checked('goal'),
      };
    }

    function setFormValues(v) {
      if (!v) return;
      ['age', 'height', 'weight'].forEach((k) => { if (v[k] !== undefined && v[k] !== null) form[k].value = v[k]; });
      ['sex', 'days', 'level', 'goal'].forEach((k) => {
        $$(`input[name="${k}"]`, form).forEach((r) => { r.checked = r.value === v[k]; });
      });
    }

    function showError(field, msg) {
      const el = $(`#err-${field}`);
      if (el) el.textContent = msg || '';
      const input = form.elements[field];
      if (input && input.tagName === 'INPUT' && input.type === 'text') {
        if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      }
    }
    function clearErrors() { Object.values(STEP_FIELDS).flat().forEach((f) => showError(f, '')); }

    function goToStep(n, { focus = true } = {}) {
      currentStep = Math.min(3, Math.max(1, n));
      steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== currentStep; });
      const pct = (currentStep / 3) * 100;
      $('#progress-fill').style.width = pct + '%';
      const bar = $('#progress-bar');
      bar.setAttribute('aria-valuenow', String(currentStep));
      bar.setAttribute('aria-valuetext', `Step ${currentStep} of 3: ${STEP_NAMES[currentStep - 1]}`);
      $('#step-label').textContent = `Step ${currentStep} of 3`;
      $('#step-name').textContent = STEP_NAMES[currentStep - 1];
      btnBack.hidden = currentStep === 1;
      btnNext.innerHTML = currentStep === 3
        ? 'Calculate <span class="arrow" aria-hidden="true">→</span>'
        : 'Next <span class="arrow" aria-hidden="true">→</span>';
      if (focus) $('legend', steps[currentStep - 1]).focus({ preventScroll: true });
    }

    /** Validate only the fields on one step. Returns true when OK. */
    function validateStep(n) {
      const { errors } = validateInputs(getFormValues());
      let firstBad = null;
      STEP_FIELDS[n].forEach((f) => {
        showError(f, errors[f] || '');
        if (errors[f] && !firstBad) firstBad = f;
      });
      if (firstBad) {
        const target = form.elements[firstBad];
        const el = target && target.focus ? target : (target && target[0]);
        if (el) el.focus();
        return false;
      }
      return true;
    }

    function persist() {
      const prev = store.read() || {};
      store.write({ ...prev, inputs: getFormValues() });
    }

    // Live feedback: clear errors as the user fixes them, and save drafts.
    form.addEventListener('input', (e) => {
      const name = e.target.name;
      if (name) showError(name, '');
      persist();
    });
    form.addEventListener('change', (e) => { if (e.target.name) showError(e.target.name, ''); persist(); });

    btnBack.addEventListener('click', () => goToStep(currentStep - 1));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!validateStep(currentStep)) return;
      if (currentStep < 3) { goToStep(currentStep + 1); return; }
      // Final step: validate everything (defensive) and calculate.
      const result = validateInputs(getFormValues());
      if (!result.valid) {
        for (const n of [1, 2, 3]) { if (!validateStep(n)) { goToStep(n, { focus: false }); validateStep(n); return; } }
        return;
      }
      runCalculation(result.values, { animate: true });
    });

    function resetForm() {
      form.reset();
      $$('input[type="radio"]', form).forEach((r) => { r.checked = false; });
      clearErrors();
      goToStep(1, { focus: false });
    }

    $('#btn-reset').addEventListener('click', () => {
      resetForm();
      persist();
      toast('Form reset');
    });

    /* =====================================================
       RESULTS
       ===================================================== */
    const resultsEmpty = $('#results-empty');
    const resultsContent = $('#results-content');
    const loader = $('#loader');
    let lastPlan = null;

    function countUp(el, to, ms = 1100) {
      if (reduceMotion) { el.textContent = fmt(to); return; }
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = fmt(to * eased);
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    const DONUT_R = 52;
    const DONUT_C = 2 * Math.PI * DONUT_R;

    function renderResults(plan) {
      lastPlan = plan;
      const { macros, calories, inputs } = plan;

      // Donut: three segments proportional to each macro's share of calories.
      let offset = 0;
      ['protein', 'carbs', 'fat'].forEach((k) => {
        const seg = $(`#seg-${k}`);
        const len = (macros.kcal[k] / macros.totalKcal) * DONUT_C;
        const visible = Math.max(0, len - 2); // 2px gap between segments
        seg.style.strokeDashoffset = String(-offset);
        seg.style.strokeDasharray = '0 ' + DONUT_C;
        requestAnimationFrame(() => requestAnimationFrame(() => { seg.style.strokeDasharray = `${visible} ${DONUT_C}`; }));
        offset += len;
      });
      $('#donut').setAttribute('aria-label',
        `Calorie split: protein ${macros.pct.protein}%, carbs ${macros.pct.carbs}%, fat ${macros.pct.fat}%`);

      countUp($('#res-kcal'), calories.target);
      $('#res-goal').textContent = GOALS[inputs.goal].label;
      $('#res-summary').textContent = plan.summary;

      const notes = $('#res-notes');
      notes.innerHTML = '';
      plan.notes.forEach((n) => { const li = document.createElement('li'); li.textContent = n; notes.appendChild(li); });

      ['protein', 'carbs', 'fat'].forEach((k) => {
        $(`#res-${k}`).textContent = macros[k];
        $(`#meta-${k}`).textContent = `${macros.pct[k]}% of calories · ${fmt(macros.kcal[k])} kcal`;
        const wrap = $(`#bar-${k}-wrap`);
        wrap.setAttribute('aria-label', `${k} provides ${macros.pct[k]}% of your calories`);
        const fill = $(`#bar-${k}`);
        fill.style.width = '0%';
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = macros.pct[k] + '%'; }));
      });

      $('#res-bmr').textContent = fmt(plan.bmr);
      $('#res-tdee').textContent = fmt(plan.tdee);
      $('#res-bmi').textContent = plan.bmi.value.toFixed(1);
      $('#res-bmi-cat').textContent = plan.bmi.category;
      $('#res-water').textContent = plan.water.litres.toFixed(1);
      $('#res-water-note').textContent = `About ${plan.water.glasses} glasses (250 ml)`;
      $('#res-steps').textContent = fmt(plan.steps);

      resultsEmpty.hidden = true;
      resultsContent.hidden = false;
      // Restart entrance animation.
      resultsContent.style.animation = 'none'; void resultsContent.offsetWidth; resultsContent.style.animation = '';
    }

    function showLoader(messages, perStep) {
      return new Promise((resolve) => {
        const text = $('#loader-text');
        loader.hidden = false;
        let i = 0;
        text.textContent = messages[0];
        const id = setInterval(() => {
          i += 1;
          if (i >= messages.length) { clearInterval(id); loader.hidden = true; resolve(); return; }
          text.textContent = messages[i];
        }, perStep);
      });
    }

    async function runCalculation(values, { animate }) {
      const plan = calculatePlan(values);
      const prev = store.read() || {};
      store.write({ ...prev, inputs: getFormValues(), calculated: true });

      if (animate) {
        btnNext.disabled = true;
        await showLoader(['Reading your stats…', 'Estimating your BMR…', 'Balancing your macros…', 'Building your plan…', ''], reduceMotion ? 80 : 380);
        btnNext.disabled = false;
      }
      renderResults(plan);

      // Suggest a workout level from training frequency.
      selectWorkout({ level: suggestLevel(values.days) });

      if (animate) {
        document.getElementById('results').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        $('#results').focus({ preventScroll: true });
      }
    }

    $('#btn-recalc').addEventListener('click', () => {
      goToStep(1, { focus: false });
      document.getElementById('calculator').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
      toast('Edit your details, then calculate again');
    });

    function clearAllData() {
      store.clear();
      resetForm();
      lastPlan = null;
      resultsContent.hidden = true;
      resultsEmpty.hidden = false;
      selectWorkout({ level: 'beginner', type: 'full' });
      store.clear(); // selectWorkout re-saves preferences; wipe everything again
      toast('Your data has been cleared');
    }
    ['#btn-clear-results', '#btn-clear-footer'].forEach((s) => $(s).addEventListener('click', clearAllData));

    /* =====================================================
       WORKOUTS
       ===================================================== */
    const ICONS = {
      // Simple stroke pictograms (36×36) — CSS colours them via currentColor.
      push:   '<circle cx="7" cy="17" r="3"/><path d="M11 20l17 5M12 20l-2 8M28 25v5M8 30h22"/>',
      squat:  '<circle cx="15" cy="7" r="3"/><path d="M15 11l2 8 8 3M17 19l-5 5v8M25 22l3 10M11 17l-6 3"/>',
      bridge: '<circle cx="6" cy="24" r="3"/><path d="M9 25l9-8 8 8-4 7M26 25l4 7M4 32h28"/>',
      lunge:  '<circle cx="16" cy="6" r="3"/><path d="M16 10v10M16 20l-8 4v8M16 20l9 3 2 9M12 14l4 2 4-2"/>',
      hold:   '<circle cx="6" cy="17" r="3"/><path d="M10 19l20 5M12 20v9M4 29h14M30 24v5"/>',
      core:   '<circle cx="8" cy="20" r="3"/><path d="M12 21l12 1 6-8M24 22l6 8M4 30h28"/>',
      cardio: '<circle cx="18" cy="6" r="3"/><path d="M18 10v11M18 14l-9-4M18 14l9-4M18 21l-7 10M18 21l7 10"/>',
    };
    const iconSVG = (kind) =>
      `<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[kind] || ICONS.cardio}</svg>`;

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Reusable exercise card. */
    function exerciseCard(ex, index) {
      return `
        <article class="card ex-card" style="animation-delay:${index * 60}ms">
          <div class="ex-top">
            <div class="ex-icon">${iconSVG(ex.icon)}</div>
            <div>
              <p class="ex-num">EXERCISE ${String(index + 1).padStart(2, '0')}</p>
              <h3 class="ex-name">${esc(ex.name)}</h3>
            </div>
          </div>
          <div class="ex-rx" aria-label="${ex.sets} sets of ${esc(ex.reps)}, rest ${ex.rest} seconds">
            <span class="ex-sets">${ex.sets} × ${esc(ex.reps)}</span>
            <span class="ex-rest">Rest ${ex.rest}s</span>
          </div>
          <div class="tags">
            <span class="tag level">${esc(ex.difficulty)}</span>
            ${ex.muscles.map((m) => `<span class="tag">${esc(m)}</span>`).join('')}
          </div>
          <p class="ex-desc">${esc(ex.desc)}</p>
        </article>`;
    }

    let currentWorkout = null;

    function renderWorkout() {
      const level = ($('input[name="w-level"]:checked') || {}).value || 'beginner';
      const type = ($('input[name="w-type"]:checked') || {}).value || 'full';
      const w = generateWorkout(type, level);
      currentWorkout = w;
      $('#w-kicker').textContent = `${w.title} · ${w.level}`.toUpperCase();
      $('#w-title').textContent = w.title;
      $('#w-meta').textContent = `${w.blurb} ${w.exercises.length} exercises · about ${w.minutes} min.`;
      $('#exercise-grid').innerHTML = w.exercises.map(exerciseCard).join('');
    }

    /** Programmatically select workout level/type, then re-render. */
    function selectWorkout({ level, type } = {}) {
      if (level) { const r = $(`input[name="w-level"][value="${level}"]`); if (r) r.checked = true; }
      if (type) { const r = $(`input[name="w-type"][value="${type}"]`); if (r) r.checked = true; }
      renderWorkout();
      persistWorkoutPrefs();
    }
    function persistWorkoutPrefs() {
      const prev = store.read() || {};
      store.write({
        ...prev,
        workout: {
          level: ($('input[name="w-level"]:checked') || {}).value,
          type: ($('input[name="w-type"]:checked') || {}).value,
        },
      });
    }
    $('#pick-level').addEventListener('change', () => { renderWorkout(); persistWorkoutPrefs(); });
    $('#pick-type').addEventListener('change', () => { renderWorkout(); persistWorkoutPrefs(); });

    /* =====================================================
       WORKOUT TIMER
       ===================================================== */
    const timerEl = $('#timer');
    const T = { steps: [], i: 0, endAt: 0, pausedLeft: null, tick: null, opener: null, startedAt: 0 };

    /** Flatten a workout into work/rest steps. */
    function buildTimerSteps(w) {
      const out = [];
      w.exercises.forEach((ex, exIdx) => {
        for (let s = 1; s <= ex.sets; s++) {
          out.push({ kind: 'work', ex, exIdx, set: s, secs: ex.seconds });
          const isLast = exIdx === w.exercises.length - 1 && s === ex.sets;
          if (!isLast) out.push({ kind: 'rest', ex, exIdx, set: s, secs: ex.rest });
        }
      });
      return out;
    }

    const mmss = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s));

    function openTimer() {
      if (!currentWorkout) return;
      T.opener = document.activeElement;
      T.steps = buildTimerSteps(currentWorkout);
      T.startedAt = Date.now();
      timerEl.hidden = false;
      document.body.classList.add('no-scroll');
      startStep(0);
      $('#timer-main').focus();
    }

    function closeTimer() {
      clearInterval(T.tick);
      timerEl.hidden = true;
      document.body.classList.remove('no-scroll');
      if (T.opener && T.opener.focus) T.opener.focus();
    }

    function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

    function startStep(i) {
      clearInterval(T.tick);
      if (i >= T.steps.length) { finishWorkout(); return; }
      T.i = i;
      const s = T.steps[i];
      T.pausedLeft = null;
      const phase = $('#timer-phase');
      const clock = $('#timer-clock');
      const main = $('#timer-main');
      const skip = $('#timer-skip');

      phase.textContent = s.kind === 'work' ? 'WORK' : 'REST';
      phase.classList.toggle('rest', s.kind === 'rest');
      $('#timer-progress').style.width = (i / T.steps.length) * 100 + '%';

      if (s.kind === 'work') {
        $('#timer-title').textContent = s.ex.name;
        $('#timer-set').textContent = `Set ${s.set} of ${s.ex.sets}`;
        $('#timer-desc').textContent = s.ex.desc;
      } else {
        $('#timer-title').textContent = 'Rest';
        $('#timer-set').textContent = 'Breathe and shake it out';
        $('#timer-desc').textContent = '';
      }

      // What comes next?
      const nxt = T.steps.slice(i + 1).find((x) => x.kind === 'work');
      $('#timer-next').innerHTML = nxt
        ? `Up next: <b>${esc(nxt.ex.name)}</b> — set ${nxt.set} of ${nxt.ex.sets}`
        : 'Last one — finish strong!';

      if (s.secs) {
        clock.classList.remove('reps');
        skip.hidden = false;
        main.textContent = 'Pause';
        T.endAt = performance.now() + s.secs * 1000;
        clock.textContent = mmss(s.secs);
        T.tick = setInterval(onTick, 200);
      } else {
        // Rep-based work: user taps Done.
        clock.classList.add('reps');
        clock.textContent = `${s.ex.reps} reps`;
        main.textContent = 'Done ✓';
        skip.hidden = true;
      }
      vibrate(s.kind === 'work' ? 120 : 60);
    }

    function onTick() {
      const left = Math.max(0, Math.ceil((T.endAt - performance.now()) / 1000));
      $('#timer-clock').textContent = mmss(left);
      if (left <= 0) startStep(T.i + 1);
    }

    function togglePause() {
      const s = T.steps[T.i];
      if (!s || !s.secs) { startStep(T.i + 1); return; } // rep-based: "Done"
      const main = $('#timer-main');
      if (T.pausedLeft === null) {
        T.pausedLeft = T.endAt - performance.now();
        clearInterval(T.tick);
        main.textContent = 'Resume';
      } else {
        T.endAt = performance.now() + T.pausedLeft;
        T.pausedLeft = null;
        T.tick = setInterval(onTick, 200);
        main.textContent = 'Pause';
      }
    }

    function finishWorkout() {
      clearInterval(T.tick);
      const mins = Math.max(1, Math.round((Date.now() - T.startedAt) / 60000));
      $('#timer-phase').textContent = 'DONE';
      $('#timer-phase').classList.remove('rest');
      $('#timer-title').textContent = 'Workout complete! 🎉';
      $('#timer-set').textContent = `${currentWorkout.title} · ${mins} min`;
      const clock = $('#timer-clock');
      clock.classList.add('reps');
      clock.textContent = 'Great work';
      $('#timer-desc').textContent = 'Drink some water, stretch gently, and come back tomorrow. Consistency wins.';
      $('#timer-next').textContent = '';
      $('#timer-progress').style.width = '100%';
      $('#timer-skip').hidden = true;
      const main = $('#timer-main');
      main.textContent = 'Close';
      T.steps = []; // main button now just closes
      vibrate(300);
    }

    $('#btn-start-workout').addEventListener('click', openTimer);
    $('#timer-close').addEventListener('click', closeTimer);
    $('#timer-skip').addEventListener('click', () => startStep(T.i + 1));
    $('#timer-main').addEventListener('click', () => {
      if (T.steps.length === 0) { closeTimer(); return; }
      togglePause();
    });
    timerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeTimer(); return; }
      if (e.key === 'Tab') { // simple focus trap
        const f = $$('button:not([hidden])', timerEl);
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    /* =====================================================
       INIT — restore saved data
       ===================================================== */
    function init() {
      const saved = store.read();
      if (saved && saved.inputs) setFormValues(saved.inputs);
      goToStep(1, { focus: false });

      if (saved && saved.workout) {
        selectWorkout({ level: saved.workout.level, type: saved.workout.type });
      } else {
        renderWorkout();
      }

      // If the user had already calculated, show their results right away (no animation/scroll).
      if (saved && saved.calculated && saved.inputs) {
        const r = validateInputs(saved.inputs);
        if (r.valid) {
          renderResults(calculatePlan(r.values));
        }
      }
    }

    // Belt and braces: never let a bad saved state break the page.
    try { init(); } catch (err) {
      store.clear();
      goToStep(1, { focus: false });
      renderWorkout();
    }
  })();
}
