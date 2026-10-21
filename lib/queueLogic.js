"use client";

import { useSyncExternalStore } from "react";
import { doc, setDoc, Timestamp } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------
// LOCAL-FIRST STORE
//
// The whole open-play session (players, queue, courts, scores, Up Next)
// lives on THIS device, saved in the browser's localStorage after every
// change. It never reads from or listens to the database while you play,
// so nothing can be overwritten, go missing, or load slowly because of
// the connection — the app works the same with no internet at all.
//
// The database is only touched when you tap "End session": the final
// standings and match list are uploaded then (and retried automatically
// if you're offline at that moment).
// ---------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  courtCount: 1,
  gameMinutes: 10,
  autoRequeue: true,
  mode: "fifo", // fifo | balanced | roundrobin | king
  pointsToWin: 11,
  winByTwo: true,
  trackServe: true,
  kingMaxWins: 2, // king of the court: most games in a row a team can stay on
};

export const MODES = [
  { id: "fifo", name: "First In, First Out", desc: "Players go on court strictly in the order they joined the line." },
  { id: "balanced", name: "Court Balancing", desc: "Players of similar skill levels usually play among themselves, and teams are split evenly." },
  { id: "roundrobin", name: "Round Robin", desc: "Partners and opponents change every game so everyone plays with and against as many different players as possible." },
  { id: "king", name: "King of the Court", desc: "Winners stay on for one more game, as a team, against the next players in line. Losers go to the back of the line." },
];

export const SKILLS = ["Newbie", "Beginner", "Developing", "Intermediate", "Advanced", "Expert"];
export const DEFAULT_SKILL = 3;

// Number of player slots on a court: 4 for doubles, 2 for singles.
export const slotCount = (court) => (court && court.format === "singles" ? 2 : 4);

const STORAGE_KEY = "ccf-open-play-v1";

function makeCourt(number, gameMinutes) {
  return {
    id: String(number),
    number,
    status: "idle",
    playerIds: [],
    playerNames: [],
    startTime: null,
    gameMinutes,
    staged: [],
    liveScoreA: 0,
    liveScoreB: 0,
    format: "doubles",
    sound: true,
    servingTeam: "A",
    serverNum: 2,
    king: null,
  };
}

function initialState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    courts: [makeCourt(1, DEFAULT_SETTINGS.gameMinutes)],
    players: [],
    matches: [], // finished games in the current session
    pending: [], // ended sessions not yet uploaded to the database
    broadcast: { on: false, hostId: null, lastSent: 0 }, // live read-only view for other devices
  };
}

const SERVER_STATE = initialState();
let state = null;
const listeners = new Set();

// Fills in fields added by newer versions so an older saved session keeps working.
function migrate(saved) {
  const base = initialState();
  const settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
  return {
    ...base,
    ...saved,
    settings,
    courts: (saved.courts || base.courts).map((c) => ({ ...makeCourt(c.number, c.gameMinutes || 10), ...c })),
    players: (saved.players || []).map((p) => ({ skill: DEFAULT_SKILL, ...p })),
  };
}

function ensureLoaded() {
  if (state) return state;
  state = initialState();
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) state = migrate(JSON.parse(raw));
    } catch (e) {
      console.warn("Couldn't read saved session:", e);
    }
  }
  return state;
}

function setState(mutator) {
  // Every change is "settled" in the same step: any court whose Up Next is
  // empty is filled right away, so the next match is there the instant a
  // game ends — no waiting on a later screen update.
  state = settle(mutator(ensureLoaded()));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Couldn't save session on this device:", e);
  }
  listeners.forEach((l) => l());
  schedulePush();
}

function subscribe(listener) {
  listeners.add(listener);
  // Keep a second open tab on this device in step.
  const onStorage = (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      state = migrate(JSON.parse(e.newValue));
      listeners.forEach((l) => l());
    } catch {}
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStore() {
  return useSyncExternalStore(subscribe, ensureLoaded, () => SERVER_STATE);
}

// ---------- helpers ----------

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// A "joined the line" time that is always later than everyone else's, even
// for several events in the same millisecond, so queue order never ties or
// interleaves between groups.
function nextJoinTime(s) {
  const max = s.players.reduce((m, p) => Math.max(m, p.joinedAt || 0), 0);
  return Math.max(Date.now(), max + 1);
}

function waitingSorted(s) {
  return s.players.filter((p) => p.status === "waiting").sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

function activeCourts(s) {
  return s.courts.filter((c) => c.number <= s.settings.courtCount);
}

// Up Next staging is a fixed 4-slot array (slots 0-1 = Team 1, 2-3 =
// Team 2); an empty slot is `null`, so removing/swapping one person never
// slides anyone else into a different team.
function normalizeStaged(raw, waitingSet, n = 4) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = (raw || [])[i] || null;
    if (!id || seen.has(id) || (waitingSet && !waitingSet.has(id))) out.push(null);
    else {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

const updateCourt = (s, courtId, patch) => ({
  ...s,
  courts: s.courts.map((c) => (c.id === courtId ? { ...c, ...patch } : c)),
});

const updatePlayers = (s, ids, patchOrFn) => {
  const set = new Set(ids);
  return {
    ...s,
    players: s.players.map((p) =>
      set.has(p.id) ? { ...p, ...(typeof patchOrFn === "function" ? patchOrFn(p) : patchOrFn) } : p
    ),
  };
};

// ---------- settings & courts ----------

export function updateSettings(patch) {
  setState((s) => {
    let next = { ...s, settings: { ...s.settings, ...patch } };
    if (patch.mode && patch.mode !== s.settings.mode) {
      // New mode => re-draw every Up Next with the new rules.
      next = { ...next, courts: next.courts.map((c) => ({ ...c, staged: [], king: null })) };
    }
    if (patch.courtCount) {
      const courts = [...next.courts];
      for (let i = 1; i <= patch.courtCount; i++) {
        if (!courts.some((c) => c.number === i)) courts.push(makeCourt(i, next.settings.gameMinutes));
      }
      next = { ...next, courts: courts.sort((a, b) => a.number - b.number) };
    }
    if (patch.gameMinutes) {
      next = {
        ...next,
        courts: next.courts.map((c) => ({ ...c, gameMinutes: patch.gameMinutes })),
      };
    }
    return next;
  });
}

export async function adjustCourtMinutes(courtId, delta) {
  setState((s) => {
    const c = s.courts.find((x) => x.id === courtId);
    if (!c) return s;
    return updateCourt(s, courtId, { gameMinutes: Math.max(1, (c.gameMinutes || 10) + delta) });
  });
}

export async function adjustLiveScore(courtId, team, delta) {
  const field = team === "A" ? "liveScoreA" : "liveScoreB";
  setState((s) => {
    const c = s.courts.find((x) => x.id === courtId);
    if (!c) return s;
    return updateCourt(s, courtId, { [field]: Math.max(0, (c[field] || 0) + delta) });
  });
}

// ---------- smart grouping (modes) ----------

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const skillOf = (p) => p.skill || DEFAULT_SKILL;

// How often each pair has partnered / faced each other this session.
function historyCounts(matches) {
  const partners = new Map();
  const opponents = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  (matches || []).forEach((m) => {
    const A = m.teamA || [];
    const B = m.teamB || [];
    if (A.length === 2) bump(partners, pairKey(A[0], A[1]));
    if (B.length === 2) bump(partners, pairKey(B[0], B[1]));
    A.forEach((x) => B.forEach((y) => bump(opponents, pairKey(x, y))));
  });
  return { partners, opponents };
}

// Splits a chosen group into teams (first half = Team 1). Court Balancing
// evens out total skill; Round Robin avoids repeat partners/opponents.
function arrangeTeams(group, mode, hist) {
  if (group.length !== 4) return group.map((p) => p.id);
  const options = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];
  let best = null;
  options.forEach(([ta, tb]) => {
    const A = ta.map((i) => group[i]);
    const B = tb.map((i) => group[i]);
    const diff = Math.abs(A.reduce((t, p) => t + skillOf(p), 0) - B.reduce((t, p) => t + skillOf(p), 0));
    let repeats = 0;
    repeats += 3 * (hist.partners.get(pairKey(A[0].id, A[1].id)) || 0);
    repeats += 3 * (hist.partners.get(pairKey(B[0].id, B[1].id)) || 0);
    A.forEach((x) => B.forEach((y) => (repeats += hist.opponents.get(pairKey(x.id, y.id)) || 0)));
    const score = mode === "roundrobin" ? repeats * 10 + diff : diff * 10 + repeats;
    if (!best || score < best.score) best = { score, order: [...A, ...B] };
  });
  return best.order.map((p) => p.id);
}

function combos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const out = [];
  arr.forEach((x, i) => combos(arr.slice(i + 1), k - 1).forEach((rest) => out.push([x, ...rest])));
  return out;
}

// Picks `n` players from the waiting line (already in queue order) for the
// current mode. The player at the front is always included so nobody gets
// skipped forever; the others come from the next several in line.
function pickGroup(waiting, n, mode, matches) {
  if (waiting.length < n) return null;
  if (mode === "fifo" || mode === "king") return waiting.slice(0, n).map((p) => p.id);

  const hist = historyCounts(matches);
  const window = waiting.slice(0, Math.min(waiting.length, 12));
  const anchor = window[0];
  const rest = window.slice(1);
  let best = null;
  combos(rest, n - 1).forEach((others) => {
    const group = [anchor, ...others];
    const skills = group.map(skillOf);
    const spread = Math.max(...skills) - Math.min(...skills);
    let met = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const k = pairKey(group[i].id, group[j].id);
        met += (hist.partners.get(k) || 0) + (hist.opponents.get(k) || 0);
      }
    }
    const waitCost = others.reduce((t, p) => t + window.indexOf(p), 0); // prefer people nearer the front
    const score = mode === "balanced" ? spread * 20 + met * 2 + waitCost : met * 20 + spread * 2 + waitCost;
    if (!best || score < best.score) best = { score, group };
  });
  return arrangeTeams(best.group, mode, hist);
}

// ---------- Up Next staging ----------

// Fills a court's open Up Next slots from the line. Completely empty box:
// the mode decides who and how teams split. Partly filled (someone chosen
// by hand): the open slots simply take the next people in line.
function fillCourtStaging(s, courtId, onlyIfEmpty = false) {
  const court = s.courts.find((c) => c.id === courtId);
  if (!court) return s;
  const n = slotCount(court);
  const waiting = waitingSorted(s);
  const waitingSet = new Set(waiting.map((p) => p.id));
  const claimed = new Set();
  activeCourts(s).forEach((c) =>
    normalizeStaged(c.staged, waitingSet, slotCount(c)).forEach((id) => id && claimed.add(id))
  );
  const staged = normalizeStaged(court.staged, waitingSet, n);
  const free = waiting.filter((p) => !claimed.has(p.id));

  if (staged.every((id) => !id)) {
    const group = pickGroup(free, n, s.settings.mode, s.matches);
    if (group) return updateCourt(s, courtId, { staged: group });
  }
  if (onlyIfEmpty) return s;
  let qi = 0;
  for (let slot = 0; slot < n && qi < free.length; slot++) {
    if (!staged[slot]) staged[slot] = free[qi++].id;
  }
  const before = normalizeStaged(court.staged, null, n);
  if (staged.every((id, k) => id === before[k])) return s;
  return updateCourt(s, courtId, { staged });
}

// Keeps every court's Up Next stocked (only boxes that are completely empty).
function settle(s) {
  if (!s.players.some((p) => p.status === "waiting")) return s;
  return activeCourts(s).reduce((acc, c) => fillCourtStaging(acc, c.id, true), s);
}

// Clears one court's Up Next and re-draws it from the line using the
// current mode (handy after dragging the queue into a new order).
export async function redrawStaging(courtId) {
  setState((s) => updateCourt(s, courtId, { staged: [] }));
}

export async function autoFillAllStaging(courtIds) {
  const ids = Array.from(new Set((courtIds || []).filter(Boolean)));
  if (ids.length === 0) return;
  setState((s) => ids.reduce((acc, id) => fillCourtStaging(acc, id), s));
}

export async function autoFillStaging(courtId) {
  return autoFillAllStaging([courtId]);
}

export async function removeFromStaging(courtId, playerId) {
  setState((s) => {
    const c = s.courts.find((x) => x.id === courtId);
    if (!c) return s;
    return updateCourt(s, courtId, {
      staged: normalizeStaged(c.staged, null, slotCount(c)).map((id) => (id === playerId ? null : id)),
    });
  });
}

export async function addToStaging(courtId, playerId) {
  setState((s) => {
    const c = s.courts.find((x) => x.id === courtId);
    if (!c) return s;
    const takenElsewhere = activeCourts(s).some(
      (o) => o.id !== courtId && normalizeStaged(o.staged, null, slotCount(o)).includes(playerId)
    );
    if (takenElsewhere) return s;
    const staged = normalizeStaged(c.staged, null, slotCount(c));
    if (staged.includes(playerId)) return s;
    const slot = staged.indexOf(null);
    if (slot === -1) return s;
    staged[slot] = playerId;
    return updateCourt(s, courtId, { staged });
  });
}

export async function startStagedMatch(courtId, stagedIds) {
  const half = Math.ceil(stagedIds.length / 2);
  return startCustomMatch({
    courtId,
    teamA: stagedIds.slice(0, half),
    teamB: stagedIds.slice(half),
  });
}

// ---------- players & queue ----------

export async function registerPlayer(name, skill = DEFAULT_SKILL) {
  const cleanName = name.trim();
  if (!cleanName) return { ok: false, reason: "empty" };
  const lower = cleanName.toLowerCase();
  const s = ensureLoaded();
  const existing = s.players.find((p) => (p.name || "").trim().toLowerCase() === lower);
  const now = nextJoinTime(s);

  if (existing) {
    if (existing.status === "waiting" || existing.status === "playing") {
      return { ok: false, reason: "already-in" };
    }
    setState((st) =>
      updatePlayers(st, [existing.id], { status: "waiting", joinedAt: now, courtId: null, skill: Number(skill) || existing.skill || DEFAULT_SKILL })
    );
    return { ok: true, id: existing.id, reused: true };
  }

  const id = newId("p");
  setState((st) => ({
    ...st,
    players: [
      ...st.players,
      {
        id,
        name: cleanName,
        skill: Number(skill) || DEFAULT_SKILL,
        status: "waiting",
        joinedAt: now,
        courtId: null,
        wins: 0,
        losses: 0,
        points: 0,
        gamesPlayed: 0,
      },
    ],
  }));
  return { ok: true, id, reused: false };
}

export async function updatePlayer(playerId, patch) {
  const clean = {};
  if (typeof patch.name === "string" && patch.name.trim()) clean.name = patch.name.trim();
  if (patch.skill) clean.skill = Math.min(6, Math.max(1, Number(patch.skill)));
  setState((s) => {
    let next = updatePlayers(s, [playerId], clean);
    // Keep the name shown on a live court in step with a rename.
    if (clean.name) {
      next = {
        ...next,
        courts: next.courts.map((c) =>
          (c.playerIds || []).includes(playerId)
            ? { ...c, playerNames: c.playerIds.map((id, i) => (id === playerId ? clean.name : c.playerNames[i])) }
            : c
        ),
      };
    }
    return next;
  });
}

export async function withdrawPlayer(playerId) {
  setState((s) => updatePlayers(s, [playerId], { status: "inactive", courtId: null }));
}

export async function reorderQueue(orderedPlayerIds) {
  const base = Date.now();
  const order = new Map(orderedPlayerIds.map((id, i) => [id, base + i]));
  setState((s) => ({
    ...s,
    players: s.players.map((p) => (order.has(p.id) ? { ...p, joinedAt: order.get(p.id) } : p)),
  }));
}

// ---------- matches ----------

export async function startCustomMatch({ courtId, teamA, teamB }) {
  const s = ensureLoaded();
  const playerIds = [...teamA, ...teamB];
  const court = s.courts.find((c) => c.id === courtId);
  if (!court || court.status !== "idle") return { ok: false, reason: "court-not-idle" };
  const found = playerIds.map((id) => s.players.find((p) => p.id === id));
  if (!found.every((p) => p && p.status === "waiting")) return { ok: false, reason: "player-not-waiting" };

  setState((st) => {
    const next = updateCourt(st, courtId, {
      status: "playing",
      playerIds,
      playerNames: found.map((p) => p.name),
      startTime: Date.now(),
      liveScoreA: 0,
      liveScoreB: 0,
      servingTeam: "A",
      serverNum: 2, // the opening serve starts at "0-0-2"
      staged: [],
    });
    return updatePlayers(next, playerIds, { status: "playing", courtId });
  });
  return { ok: true };
}

export async function fillCourtIfPossible(courtId) {
  const st = ensureLoaded();
  const court = st.courts.find((c) => c.id === courtId);
  if (!court) return { ok: false, reason: "court-not-idle" };
  const n = slotCount(court);
  const group = pickGroup(waitingSorted(st), n, st.settings.mode, st.matches);
  if (!group) return { ok: false, reason: "not-enough-players" };
  const half = n / 2;
  return startCustomMatch({ courtId, teamA: group.slice(0, half), teamB: group.slice(half) });
}

// Emergency swap: replace a player on a live court with a waiting one,
// keeping score and teams. Whoever is on court at finish gets the credit.
export async function substitutePlayer(courtId, outgoingPlayerId, incomingPlayerId) {
  const s = ensureLoaded();
  const court = s.courts.find((c) => c.id === courtId);
  if (!court || court.status !== "playing") return { ok: false, reason: "court-not-playing" };
  const idx = (court.playerIds || []).indexOf(outgoingPlayerId);
  if (idx === -1) return { ok: false, reason: "player-not-on-court" };
  const incoming = s.players.find((p) => p.id === incomingPlayerId);
  if (!incoming || incoming.status !== "waiting") return { ok: false, reason: "player-not-waiting" };

  setState((st) => {
    const ids = [...court.playerIds];
    const names = [...court.playerNames];
    ids[idx] = incomingPlayerId;
    names[idx] = incoming.name;
    let next = updateCourt(st, courtId, { playerIds: ids, playerNames: names });
    next = updatePlayers(next, [outgoingPlayerId], { status: "inactive", courtId: null });
    return updatePlayers(next, [incomingPlayerId], { status: "playing", courtId });
  });
  return { ok: true };
}

export async function finishGame({ courtId, scoreA, scoreB, winner, autoRequeue }) {
  const s = ensureLoaded();
  const court = s.courts.find((c) => c.id === courtId);
  if (!court || court.status !== "playing") return { ok: false, reason: "court-not-playing" };

  const hasScore = scoreA !== null && scoreA !== undefined && scoreB !== null && scoreB !== undefined;
  const playerIds = court.playerIds || [];
  const playerNames = court.playerNames || [];
  const half = Math.ceil(playerIds.length / 2);
  const teamA = playerIds.slice(0, half);
  const teamB = playerIds.slice(half);
  const requeueBase = nextJoinTime(s);

  // Who won (explicit pick, else from the scores).
  let winTeam = null;
  if (winner === "A" || winner === "B") winTeam = winner;
  else if (hasScore && scoreA !== scoreB) winTeam = scoreA > scoreB ? "A" : "B";
  const winners = winTeam === "A" ? teamA : winTeam === "B" ? teamB : [];
  const losers = winTeam === "A" ? teamB : winTeam === "B" ? teamA : [];

  // King of the Court: winners stay as a team for up to `kingMaxWins`
  // games in a row; losers go to the back of the line.
  const isKing = s.settings.mode === "king" && winTeam && autoRequeue;
  const sameKing = court.king && court.king.ids.length === winners.length && winners.every((id) => court.king.ids.includes(id));
  const streak = isKing ? (sameKing ? court.king.wins + 1 : 1) : 0;
  const winnersStay = isKing && streak < (s.settings.kingMaxWins || 2);

  setState((st) => {
    let next = updateCourt(st, courtId, {
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
      liveScoreA: 0,
      liveScoreB: 0,
      servingTeam: "A",
      serverNum: 2,
      king: winnersStay ? { ids: winners, wins: streak } : null,
      // `staged` is kept: a pre-built Up Next lineup survives the game ending.
    });
    next = {
      ...next,
      matches: [
        ...next.matches,
        {
          id: newId("m"),
          courtId,
          playerIds,
          playerNames,
          teamA,
          teamB,
          scoreA: hasScore ? scoreA : null,
          scoreB: hasScore ? scoreB : null,
          winner: winTeam,
          finishedAt: Date.now(),
        },
      ],
    };

    // Losers (and winners who've used up their stay) requeue; order keeps
    // each team together, winners ahead of losers.
    const order = winnersStay ? losers : isKing ? [...winners, ...losers] : playerIds;
    next = {
      ...next,
      players: next.players.map((p) => {
        const i = playerIds.indexOf(p.id);
        if (i === -1) return p;
        const onTeamA = teamA.includes(p.id);
        let won = null;
        if (winTeam) won = winTeam === (onTeamA ? "A" : "B");
        const u = {
          ...p,
          gamesPlayed: (p.gamesPlayed || 0) + 1,
          status: autoRequeue ? "waiting" : "inactive",
          courtId: null,
        };
        if (autoRequeue) u.joinedAt = requeueBase + Math.max(0, order.indexOf(p.id)) + (winnersStay && winners.includes(p.id) ? -50 : 0);
        if (hasScore) u.points = (p.points || 0) + (onTeamA ? scoreA : scoreB);
        if (won === true) u.wins = (p.wins || 0) + 1;
        if (won === false) u.losses = (p.losses || 0) + 1;
        return u;
      }),
    };

    if (winnersStay) {
      // Winners take Team 1 of this court's Up Next; challengers fill the rest.
      const staged = [...winners, ...Array(Math.max(0, playerIds.length - winners.length)).fill(null)];
      next = updateCourt(next, courtId, { staged });
      next = fillCourtStaging(next, courtId);
    }
    return next;
  });
  return { ok: true };
}

// Calls off a match without recording anything: everyone goes back to the
// FRONT of the line in their original order, no stats change.
export async function cancelMatch(courtId) {
  const s = ensureLoaded();
  const court = s.courts.find((c) => c.id === courtId);
  if (!court || court.status !== "playing") return { ok: false, reason: "court-not-playing" };
  const ids = court.playerIds || [];
  const waiting = waitingSorted(s);
  const front = (waiting[0]?.joinedAt || Date.now()) - 1000;
  setState((st) => {
    const next = updateCourt(st, courtId, {
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
      liveScoreA: 0,
      liveScoreB: 0,
      servingTeam: "A",
      serverNum: 2,
    });
    return {
      ...next,
      players: next.players.map((p) => {
        const i = ids.indexOf(p.id);
        return i === -1 ? p : { ...p, status: "waiting", courtId: null, joinedAt: front + i };
      }),
    };
  });
  return { ok: true };
}

// A rally was won by `team`. With serve tracking on: only the serving team
// scores; if the receiving team wins, it's a side-out (second server, or
// the serve passes over). With tracking off it's a plain +1.
export async function scorePoint(courtId, team) {
  setState((s) => {
    const c = s.courts.find((x) => x.id === courtId);
    if (!c || c.status !== "playing") return s;
    const field = team === "A" ? "liveScoreA" : "liveScoreB";
    if (!s.settings.trackServe || team === c.servingTeam) {
      return updateCourt(s, courtId, { [field]: (c[field] || 0) + 1 });
    }
    // side out
    if (c.format !== "singles" && c.serverNum === 1) return updateCourt(s, courtId, { serverNum: 2 });
    return updateCourt(s, courtId, { servingTeam: team, serverNum: 1 });
  });
}

export async function setServe(courtId, servingTeam) {
  setState((s) => updateCourt(s, courtId, { servingTeam, serverNum: 1 }));
}

export async function setCourtFormat(courtId, format) {
  setState((s) => {
    const c = s.courts.find((x) => x.id === courtId);
    if (!c || c.status !== "idle") return s;
    const n = format === "singles" ? 2 : 4;
    return updateCourt(s, courtId, {
      format,
      staged: normalizeStaged(c.staged, null, n),
    });
  });
}

export async function setCourtSound(courtId, sound) {
  setState((s) => updateCourt(s, courtId, { sound }));
}

// ---------- end of session: the ONLY time the database is used ----------

let flushing = false;

// Uploads any ended sessions that haven't reached the database yet. Safe
// to call any time: each session has a fixed id (so a retry can't create
// a duplicate), and it's removed from the device only once uploaded.
export async function flushPending() {
  if (flushing) return;
  flushing = true;
  try {
    for (const session of [...ensureLoaded().pending]) {
      try {
        await setDoc(doc(db, "sessions", session.id), {
          endedAt: Timestamp.fromMillis(session.endedAt),
          totalPlayers: session.totalPlayers,
          totalGames: session.totalGames,
          standings: session.standings,
          matches: session.matches,
        });
        setState((s) => ({ ...s, pending: s.pending.filter((p) => p.id !== session.id) }));
      } catch (e) {
        console.warn("Session upload will retry:", e?.message);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

export async function endSession() {
  const s = ensureLoaded();
  const standings = s.players
    .map((p) => ({
      id: p.id,
      name: p.name || "",
      wins: p.wins || 0,
      losses: p.losses || 0,
      points: p.points || 0,
      gamesPlayed: p.gamesPlayed || 0,
    }))
    .filter((p) => p.gamesPlayed > 0)
    .sort((a, b) => (b.wins !== a.wins ? b.wins - a.wins : b.points - a.points));

  const session = {
    id: newId("s"),
    endedAt: Date.now(),
    totalPlayers: standings.length,
    totalGames: Math.round(standings.reduce((sum, p) => sum + p.gamesPlayed, 0) / 4),
    standings,
    matches: s.matches,
  };

  setState((st) => ({
    ...st,
    pending: [...st.pending, session],
    matches: [],
    courts: st.courts.map((c) => ({
      ...c,
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
      staged: [],
      liveScoreA: 0,
      liveScoreB: 0,
    })),
    players: st.players.map((p) => ({
      ...p,
      status: "inactive",
      courtId: null,
      wins: 0,
      losses: 0,
      points: 0,
      gamesPlayed: 0,
    })),
  }));

  flushPending();
  return standings;
}


// ---------- live view for other devices (read-only) ----------
//
// THIS device stays the only writer. When sharing is on, it sends a full
// copy of the session to one Firestore document after every change (at
// most one send in flight; if the internet is down the newest copy goes
// out when it's back). Other devices open /view and only ever read it, so
// they can't overwrite anything and nobody can go missing.

let pushTimer = null;
let pushing = false;
let pushAgain = false;

function schedulePush() {
  if (typeof window === "undefined") return;
  const s = state;
  if (!s || !s.broadcast || !s.broadcast.on) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushLive, 800);
}

async function pushLive() {
  const s = ensureLoaded();
  if (!s.broadcast.on) return;
  if (pushing) {
    pushAgain = true;
    return;
  }
  pushing = true;
  const sentAt = Date.now();
  try {
    await setDoc(doc(db, "live", "state"), {
      hostId: s.broadcast.hostId,
      updatedAt: sentAt,
      settings: s.settings,
      courts: s.courts,
      players: s.players
        .filter((p) => p.status !== "inactive" || (p.gamesPlayed || 0) > 0)
        .map((p) => ({
          id: p.id,
          name: p.name,
          skill: p.skill || 3,
          status: p.status,
          courtId: p.courtId ?? null,
          joinedAt: p.joinedAt || 0,
          wins: p.wins || 0,
          losses: p.losses || 0,
          points: p.points || 0,
          gamesPlayed: p.gamesPlayed || 0,
        })),
      matches: s.matches.slice(-60),
    });
    // Record success without triggering another push.
    state = { ...state, broadcast: { ...state.broadcast, lastSent: sentAt } };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
    listeners.forEach((l) => l());
  } catch (e) {
    console.warn("Live view send will retry:", e?.message);
  } finally {
    pushing = false;
    if (pushAgain) {
      pushAgain = false;
      schedulePush();
    }
  }
}

export function setBroadcasting(on) {
  setState((s) => ({
    ...s,
    broadcast: {
      ...s.broadcast,
      on,
      hostId: s.broadcast.hostId || newId("host"),
    },
  }));
  if (on) pushLive();
}

// ---------- backup / restore ----------

export function exportBackup() {
  const s = ensureLoaded();
  return JSON.stringify({ app: "ccf-open-play", version: 1, savedAt: Date.now(), state: s });
}

export function restoreBackup(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.app !== "ccf-open-play" || !parsed.state) throw new Error("Not a backup file");
  setState(() => migrate(parsed.state));
}
