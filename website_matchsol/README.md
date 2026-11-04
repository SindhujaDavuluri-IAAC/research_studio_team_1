# MATCHSOL — the hourly version (kept for later)

> Homes are empty at noon. Schools are empty on weekends. MATCHSOL matches them, so every solar kilowatt-hour is used in the neighbourhood.

An earlier idea of the project, kept here in case we need it again. It matches buildings whose use falls at
different hours (homes give at noon on weekdays, schools and offices give at weekends and in summer), and
makes the hourly split table the law allows (a share for every hour, up to 5 km apart).

We moved to the simpler co-investment communities (the main site, `../website`), because we do not have
each building's real hours of use. This version needs them: today it uses step 5's typical day patterns.

**Open it:** open the repository folder in VS Code, right-click `website_matchsol/index.html` →
**Open with Live Server**. It reads the main site's data (`../website/data`) and pictures (`../website/img`),
so it must be opened from the repository folder, not from this folder alone.

| File | What it does |
|---|---|
| `match.js` | The matching engine: 24 typical days, use and sun shapes, growing matches by complementary schedules, the hourly split, the year file |
| `app.js` | The map and the four tabs (Matches, Hourly split, Money, How it works) |
| `config.js` | Matching rules (`MATCH`), use patterns (`USE`), prices, colours |
| `index.html`, `style.css`, `solar.js` | The page, its look, the quick roof estimate |

The design for this version is in the "MATCHSOL — 5 screens" canvas.
