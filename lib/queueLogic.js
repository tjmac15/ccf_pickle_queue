"use client";

import {
  collection,
  doc,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------
// How writes work in this file (important)
//
// Nothing here uses Firestore transactions or waits for the server any
// more. Transactions need a live connection to check that two devices
// aren't clashing, so on slow or dropped wifi every start/end/substitute
// hung or failed. Instead:
//   * Every action decides what to do from the app's own live copy of
//     the data (`syncLocalState`, called by the page on every update).
//   * It then sends one batched write and returns immediately. Firestore
//     applies the write to the on-device copy at once (so the screen
//     updates instantly) and delivers it to the server as soon as the
//     connection allows — in order, even after a drop.
//   * Counters use increment(), which merges correctly across devices.
// Trade-off: if two devices tap the exact same action at the exact same
// moment, the later write wins instead of one being rejected.
// ---------------------------------------------------------------------

let local = { courts: [], players: [], settings: null, loaded: false };

// Called by the page on every render with its latest live data.
export function syncLocalState(next) {
  local = next;
}

const SETTINGS_REF = () => doc(db, "config", "settings");

// Fire the batch without waiting for the server (so an offline tap never
// freezes the UI); surface failures in the console.
function commit(batch) {
  batch.commit().catch((e) => console.error("Sync failed:", e));
}

function ms(ts) {
  return ts?.toMillis?.() || 0;
}

function waitingSorted() {
  return local.players.filter((p) => p.status === "waiting").sort((a, b) => ms(a.joinedAt) - ms(b.joinedAt));
}

function activeCourts() {
  const count = local.settings?.courtCount || DEFAULT_SETTINGS.courtCount;
  return local.courts.filter((c) => (c.number || Number(c.id)) <= count);
}

// Up Next staging is a fixed 4-slot array (slots 0-1 = Team 1, 2-3 =
// Team 2) where an empty slot is `null`. Holes (not a compacted array)
// mean removing or swapping one person never slides anyone else into a
// different team. If `waitingSet` is given, anyone no longer waiting is
// dropped to a hole, and duplicates are removed.
function normalizeStaged(raw, waitingSet) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < 4; i++) {
    const id = (raw || [])[i] || null;
    if (!id || seen.has(id) || (waitingSet && !waitingSet.has(id))) {
      out.push(null);
    } else {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  courtCount: 1,
  gameMinutes: 10,
  autoRequeue: true,
};

export async function ensureSettingsExist() {
  setDoc(SETTINGS_REF(), DEFAULT_SETTINGS, { merge: true }).catch((e) => console.error(e));
}

// Only creates courts that don't exist yet — never touches an existing
// court's doc, so adding court #2 can't reset court #1's timer.
export async function ensureCourtsExist(courtCount, gameMinutes = DEFAULT_SETTINGS.gameMinutes) {
  const existing = new Set(local.courts.map((c) => Number(c.id)));
  const batch = writeBatch(db);
  let any = false;
  for (let i = 1; i <= courtCount; i++) {
    if (existing.has(i)) continue;
    any = true;
    batch.set(doc(db, "courts", String(i)), {
      number: i,
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
      gameMinutes,
      staged: [],
    });
  }
  if (any) commit(batch);
}

// Pushes a new default game length to every court at once.
export async function setAllCourtsMinutes(courtCount, minutes) {
  const batch = writeBatch(db);
  for (let i = 1; i <= courtCount; i++) {
    batch.set(doc(db, "courts", String(i)), { gameMinutes: minutes }, { merge: true });
  }
  commit(batch);
}

// Nudges one court's game length by `delta` minutes (min 1). Works idle
// or live (the timer is just gameMinutes minus elapsed time).
export async function adjustCourtMinutes(courtId, delta) {
  const court = local.courts.find((c) => c.id === courtId);
  if (!court) return;
  const current = court.gameMinutes || DEFAULT_SETTINGS.gameMinutes;
  updateDoc(doc(db, "courts", courtId), { gameMinutes: Math.max(1, current + delta) }).catch((e) =>
    console.error(e)
  );
}

// Live score +/-. increment() needs no read, applies instantly, queues
// offline, and merges correctly with taps from other devices.
export async function adjustLiveScore(courtId, team, delta) {
  const field = team === "A" ? "liveScoreA" : "liveScoreB";
  updateDoc(doc(db, "courts", courtId), { [field]: increment(delta) }).catch((e) => console.error(e));
}

// Fills empty "Up Next" slots across ALL given courts in one pass from
// the front of the queue, so two courts can never claim the same person.
export async function autoFillAllStaging(courtIds) {
  const idsToFill = Array.from(new Set((courtIds || []).filter(Boolean)));
  if (idsToFill.length === 0) return;

  const waiting = waitingSorted();
  const waitingSet = new Set(waiting.map((p) => p.id));
  const courts = activeCourts();

  const stagedById = new Map();
  courts.forEach((c) => stagedById.set(c.id, normalizeStaged(c.staged, waitingSet)));

  const claimed = new Set();
  stagedById.forEach((staged) => staged.forEach((id) => id && claimed.add(id)));
  const queue = waiting.map((p) => p.id).filter((id) => !claimed.has(id));
  let qi = 0;

  const batch = writeBatch(db);
  let any = false;
  idsToFill.forEach((courtId) => {
    const court = courts.find((c) => c.id === courtId);
    if (!court) return;
    const staged = [...stagedById.get(courtId)];
    for (let slot = 0; slot < 4 && qi < queue.length; slot++) {
      if (!staged[slot]) staged[slot] = queue[qi++];
    }
    const before = normalizeStaged(court.staged);
    if (staged.some((id, k) => id !== before[k])) {
      batch.update(doc(db, "courts", courtId), { staged });
      any = true;
    }
  });
  if (any) commit(batch);
}

export async function autoFillStaging(courtId) {
  return autoFillAllStaging([courtId]);
}

// Opens one slot back up (slot-preserving, so teams don't shift).
export async function removeFromStaging(courtId, playerId) {
  const court = local.courts.find((c) => c.id === courtId);
  if (!court) return;
  const staged = normalizeStaged(court.staged).map((id) => (id === playerId ? null : id));
  updateDoc(doc(db, "courts", courtId), { staged }).catch((e) => console.error(e));
}

// Puts a player in the first open slot (cap 4). Refuses anyone already
// staged on another court.
export async function addToStaging(courtId, playerId) {
  const court = local.courts.find((c) => c.id === courtId);
  if (!court) return;
  const takenElsewhere = activeCourts().some(
    (c) => c.id !== courtId && normalizeStaged(c.staged).includes(playerId)
  );
  if (takenElsewhere) return;
  const staged = normalizeStaged(court.staged);
  if (staged.includes(playerId)) return;
  const slot = staged.indexOf(null);
  if (slot === -1) return;
  staged[slot] = playerId;
  updateDoc(doc(db, "courts", courtId), { staged }).catch((e) => console.error(e));
}

// Starts the match with the staged players: first 2 = Team A, rest = B.
export async function startStagedMatch(courtId, stagedIds) {
  return startCustomMatch({
    courtId,
    teamA: stagedIds.slice(0, 2),
    teamB: stagedIds.slice(2, 4),
  });
}

// Registers a name into the queue. Reuses an existing player doc (by
// case-insensitive name) so wins/points persist across sessions.
export async function registerPlayer(name) {
  const cleanName = name.trim();
  if (!cleanName) return { ok: false, reason: "empty" };
  if (!local.loaded) return { ok: false, reason: "not-loaded" };

  const lower = cleanName.toLowerCase();
  const existing = local.players.find((p) => (p.name || "").trim().toLowerCase() === lower);
  const now = Timestamp.now();

  if (existing) {
    if (existing.status === "waiting" || existing.status === "playing") {
      return { ok: false, reason: "already-in" };
    }
    updateDoc(doc(db, "players", existing.id), { status: "waiting", joinedAt: now, courtId: null }).catch(
      (e) => console.error(e)
    );
    return { ok: true, id: existing.id, reused: true };
  }

  const newRef = doc(collection(db, "players"));
  setDoc(newRef, {
    name: cleanName,
    status: "waiting",
    joinedAt: now,
    courtId: null,
    wins: 0,
    losses: 0,
    points: 0,
    gamesPlayed: 0,
    createdAt: now,
  }).catch((e) => console.error(e));
  return { ok: true, id: newRef.id, reused: false };
}

export async function withdrawPlayer(playerId) {
  updateDoc(doc(db, "players", playerId), { status: "inactive", courtId: null }).catch((e) =>
    console.error(e)
  );
}

// Rewrites joinedAt in the exact order given (manual reorder).
export async function reorderQueue(orderedPlayerIds) {
  const batch = writeBatch(db);
  const base = Date.now();
  orderedPlayerIds.forEach((id, i) => {
    batch.update(doc(db, "players", id), { joinedAt: Timestamp.fromMillis(base + i) });
  });
  commit(batch);
}

// Starts a match with chosen players (1v1 or 2v2, equal split).
export async function startCustomMatch({ courtId, teamA, teamB }) {
  const playerIds = [...teamA, ...teamB];
  const court = local.courts.find((c) => c.id === courtId);
  if (!court || court.status !== "idle") return { ok: false, reason: "court-not-idle" };

  const found = playerIds.map((id) => local.players.find((p) => p.id === id));
  if (!found.every((p) => p && p.status === "waiting")) return { ok: false, reason: "player-not-waiting" };

  const batch = writeBatch(db);
  batch.update(doc(db, "courts", courtId), {
    status: "playing",
    playerIds,
    playerNames: found.map((p) => p.name),
    startTime: serverTimestamp(),
    liveScoreA: 0,
    liveScoreB: 0,
    staged: [],
  });
  playerIds.forEach((id) => batch.update(doc(db, "players", id), { status: "playing", courtId }));
  commit(batch);
  return { ok: true };
}

// Emergency swap: replaces a player on a live court with a waiting one,
// keeping score and teams. Whoever is on court at finish gets the credit.
export async function substitutePlayer(courtId, outgoingPlayerId, incomingPlayerId) {
  const court = local.courts.find((c) => c.id === courtId);
  if (!court || court.status !== "playing") return { ok: false, reason: "court-not-playing" };
  const playerIds = court.playerIds || [];
  const idx = playerIds.indexOf(outgoingPlayerId);
  if (idx === -1) return { ok: false, reason: "player-not-on-court" };
  const incoming = local.players.find((p) => p.id === incomingPlayerId);
  if (!incoming || incoming.status !== "waiting") return { ok: false, reason: "player-not-waiting" };

  const newIds = [...playerIds];
  const newNames = [...(court.playerNames || [])];
  newIds[idx] = incomingPlayerId;
  newNames[idx] = incoming.name;

  const batch = writeBatch(db);
  batch.update(doc(db, "courts", courtId), { playerIds: newIds, playerNames: newNames });
  batch.update(doc(db, "players", outgoingPlayerId), { status: "inactive", courtId: null });
  batch.update(doc(db, "players", incomingPlayerId), { status: "playing", courtId });
  commit(batch);
  return { ok: true };
}

// Starts a game from the front 4 of the queue.
export async function fillCourtIfPossible(courtId) {
  const waiting = waitingSorted();
  if (waiting.length < 4) return { ok: false, reason: "not-enough-players" };
  const ids = waiting.slice(0, 4).map((p) => p.id);
  return startCustomMatch({ courtId, teamA: ids.slice(0, 2), teamB: ids.slice(2, 4) });
}

// Ends a game: records the match, updates stats (increment, so they merge
// safely), frees the court, and optionally requeues the players.
export async function finishGame({
  courtId,
  scoreA,
  scoreB,
  winner,
  autoRequeue,
}) {
  const court = local.courts.find((c) => c.id === courtId);
  // Already finished (double-tap / other device): do nothing, so nobody is
  // credited twice.
  if (!court || court.status !== "playing") return { ok: false, reason: "court-not-playing" };

  const hasScore =
    scoreA !== null && scoreA !== undefined && scoreB !== null && scoreB !== undefined;

  // Use the court's CURRENT roster (a substitution may have changed it).
  const playerIds = court.playerIds || [];
  const playerNames = court.playerNames || [];
  const half = Math.ceil(playerIds.length / 2);
  const teamA = playerIds.slice(0, half);
  const teamB = playerIds.slice(half);

  const startMs = court.startTime?.getTime?.() || 0;
  // Same game => same match id, so a duplicate end can't create a second record.
  const matchRef = doc(db, "matches", `${courtId}_${startMs}`);

  const batch = writeBatch(db);
  batch.set(matchRef, {
    courtId,
    playerIds,
    playerNames,
    teamA,
    teamB,
    scoreA: hasScore ? scoreA : null,
    scoreB: hasScore ? scoreB : null,
    hasScore,
    winner: winner || null,
    finishedAt: serverTimestamp(),
  });

  // NOT resetting `staged`: a pre-built Up Next lineup survives the game ending.
  batch.update(doc(db, "courts", courtId), {
    status: "idle",
    playerIds: [],
    playerNames: [],
    startTime: null,
    liveScoreA: 0,
    liveScoreB: 0,
  });

  // Distinct ordered timestamps so the four keep their team order in the queue.
  const requeueBase = Date.now();
  playerIds.forEach((id, i) => {
    const onTeamA = teamA.includes(id);
    const teamScore = onTeamA ? scoreA : scoreB;
    let won = null;
    if (winner === "A") won = onTeamA;
    else if (winner === "B") won = !onTeamA;
    else if (hasScore) won = onTeamA ? scoreA > scoreB : scoreB > scoreA;

    const update = {
      gamesPlayed: increment(1),
      status: autoRequeue ? "waiting" : "inactive",
      courtId: null,
    };
    if (autoRequeue) update.joinedAt = Timestamp.fromMillis(requeueBase + i);
    if (hasScore) update.points = increment(teamScore);
    if (won === true) update.wins = increment(1);
    if (won === false) update.losses = increment(1);
    batch.update(doc(db, "players", id), update);
  });

  commit(batch);
  return { ok: true };
}

// Ends the open-play session: archives final standings, then resets
// stats and the queue.
export async function endSession() {
  const standings = local.players
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

  const totalGames = standings.reduce((sum, p) => sum + p.gamesPlayed, 0) / 4;

  const sessionBatch = writeBatch(db);
  sessionBatch.set(doc(collection(db, "sessions")), {
    endedAt: serverTimestamp(),
    totalPlayers: standings.length,
    totalGames: Math.round(totalGames),
    standings,
  });
  local.courts.forEach((c) => {
    sessionBatch.update(doc(db, "courts", c.id), {
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
      staged: [],
    });
  });
  commit(sessionBatch);

  // Only players that actually need resetting, in chunks (a Firestore
  // batch is capped at 500 writes).
  const toReset = local.players.filter(
    (p) => p.status !== "inactive" || p.wins || p.losses || p.points || p.gamesPlayed || p.courtId
  );
  for (let i = 0; i < toReset.length; i += 400) {
    const batch = writeBatch(db);
    toReset.slice(i, i + 400).forEach((p) => {
      batch.update(doc(db, "players", p.id), {
        status: "inactive",
        courtId: null,
        wins: 0,
        losses: 0,
        points: 0,
        gamesPlayed: 0,
      });
    });
    commit(batch);
  }

  return standings;
}
