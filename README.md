# CCF Open Play — Pickleball Queue

A live, multi-device queue and court timer for church open play. Register a
name, get placed in line, and get auto-seated on a court in groups of four
as soon as one opens up. Every screen — iPad at the door, phones on the
sideline, a laptop for the leaderboard — stays in sync through Firestore.

## What it does

- **Register / check in** — type a name, join the back of the queue.
- **Auto-queue** — as soon as a court is free and 4 people are waiting,
  they're seated automatically (first come, first served). This works
  safely even if two phones are both "watching" at once — Firestore
  transactions make sure only one device ever wins the seat.
- **10-minute timer** (adjustable) — counts down per court, synced from a
  shared server timestamp so every device shows the same time.
- **Scores** — enter points per team when a game ends, or skip and log it
  with no score. Win/loss + points roll up into a leaderboard.
- **Settings** — change number of courts (starts at 1, add more as you grow),
  game length, and whether players auto-requeue after finishing.

## 1. Create your Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Once created, click the **web (`</>`)** icon to register a web app. You
   don't need Firebase Hosting — just the config values.
3. In the left menu, go to **Build → Firestore Database → Create database**.
   Start in **production mode** (the app ships with its own rules, see
   below), pick a region close to you.
4. Go to **Firestore → Rules** and paste the contents of `firestore.rules`
   from this project, then **Publish**. (These rules are intentionally open
   — there's no login screen, anyone with the link can check in. That's
   fine for an internal open-play link; see the note in that file if you
   ever want to lock it down further.)
5. Back in **Project settings → General**, copy the six `firebaseConfig`
   values — you'll need them in step 3 below.

## 2. Run it locally (optional)

```bash
npm install
cp .env.local.example .env.local
# paste your Firebase config values into .env.local
npm run dev
```

Open http://localhost:3000.

## 3. Deploy to Vercel

1. Push this project to a GitHub repo.
2. Go to [vercel.com/new](https://vercel.com/new) and import that repo.
3. Vercel auto-detects Next.js — no build settings to change.
4. Before deploying, add the 6 environment variables from
   `.env.local.example` under **Environment Variables** (paste the same
   values you got from Firebase). All six must start with `NEXT_PUBLIC_`
   so the browser can read them — that's already set up in the code.
5. Click **Deploy**. Share the resulting `*.vercel.app` link with your
   group — that's the only "app install" anyone needs.

Any time you push to the repo's main branch, Vercel redeploys automatically.

## How the data is organized (Firestore)

- `config/settings` — court count, game length, auto-requeue toggle.
- `courts/{1,2,3...}` — one doc per court: status, current 4 players, start time.
- `players/{id}` — one doc per person: name, status (waiting / playing /
  inactive), running wins/losses/points/games played. A name is reused
  across sessions (matched case-insensitively) so stats persist.
- `matches/{id}` — a log of every finished game with the score, if entered.

## Notes / things you can tune later

- **Team assignment** is simply "first 2 pulled from the queue = Team A,
  next 2 = Team B." If you'd rather let people pick teams on the court,
  that's a small change to `CourtCard.js` / `ScoreModal.js`.
- **Auto-requeue** is on by default — after a game, all 4 players go back
  to the end of the line automatically. Turn it off in Settings if you'd
  rather people manually re-join when they're ready to play again.
- **No login** — this is built for a trusted, in-person group with a
  shared link, not the public internet. If you outgrow that, add Firebase
  Auth and tighten `firestore.rules`.
