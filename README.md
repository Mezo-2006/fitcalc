# FitCalc

A static, mobile-first calorie, macro and home-workout calculator. Pure HTML, CSS and vanilla JavaScript.
No backend, no database, no accounts, no API keys, no third-party requests. Data stays in the browser (localStorage).

## Structure
```
index.html   – markup (all sections, form, overlays)
style.css    – all styling (dark theme, responsive)
script.js    – part 1: pure calculation logic · part 2: UI
assets/      – favicon.svg
```

## Run locally
Open `index.html` in a browser, or serve the folder:
```
python -m http.server 8080      # then visit http://localhost:8080
# or: npx serve .
```

## Deploy free (any static host)
- **GitHub Pages:** push to a repo → Settings → Pages → deploy from branch `main` / root.
- **Netlify:** drag the folder onto app.netlify.com/drop.
- **Vercel:** `npx vercel` in the folder (framework: Other, no build command).
- **Cloudflare Pages:** connect the repo, no build command, output directory `/`.

All paths are relative, so it works from a sub-path (e.g. `user.github.io/fitcalc/`).
Point your QR code at the final URL.

## How the numbers work
1. **BMR** – Mifflin-St Jeor: `10·kg + 6.25·cm − 5·age + 5` (male) or `− 161` (female).
2. **TDEE** – BMR × activity factor (1.2 / 1.375 / 1.55 / 1.725 / 1.9). If weekly exercise days imply a higher level than the one chosen, the higher one is used.
3. **Goal calories** – TDEE −15% (moderate loss), −20% (aggressive loss), 0% (maintain), +5% (lean gain), +10% (build). Deficits never go below 1,500 kcal (male) / 1,200 kcal (female).
4. **Macros** – protein 1.6–2.2 g/kg by goal (reference weight capped at BMI 27, max 35% of calories); fat 25% of calories (min 0.6 g/kg); carbs fill the rest. 4/4/9 kcal per g, so the macros add up to the target within a few kcal.
5. **Extras** – BMI = kg/m²; water ≈ 35 ml/kg (+ training-day bonus); steps by activity level (+1,000 for fat loss).

Estimates only, not medical advice.
