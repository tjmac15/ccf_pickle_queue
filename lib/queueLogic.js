"use client";

import {
  collection,
  doc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

const SETTINGS_REF = () => doc(db, "config", "settings");

export const DEFAULT_SETTINGS = {
  courtCount: 1,
  gameMinutes: 10,
  autoRequeue: true,
};

export async function ensureSettingsExist() {
  const ref = SETTINGS_REF();
  await setDoc(ref, DEFAULT_SETTINGS, { merge: true });
}

// Only creates courts that don't exist yet — never touches an existing
// court's doc, so adding court #2 can't reset court #1's timer.
export async function ensureCourtsExist(courtCount, gameMinutes = DEFAULT_SETTINGS.gameMinutes) {
  const snap = await getDocs(collection(db, "courts"));
  const existing = new Set(snap.docs.map((d) => Number(d.id)));
  for (let i = 1; i <= courtCount; i++) {
    if (existing.has(i)) continue;
    const ref = doc(db, "courts", String(i));
    await setDoc(ref, {
      number: i,
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
      gameMinutes,
    });
  }
}

// Pushes a new default game length to every existing court at once —
// used when the organizer changes the global setting.
export async function setAllCourtsMinutes(courtCount, minutes) {
  for (let i = 1; i <= courtCount; i++) {
    await setDoc(doc(db, "courts", String(i)), { gameMinutes: minutes }, { merge: true });
  }
}

// Nudges one court's game length up or down by `delta` minutes (min 1).
// Works whether the court is idle (sets the length for its next game)
// or already playing (extends/shortens the live countdown immediately,
// since the timer is just gameMinutes - elapsed time).
export async function adjustCourtMinutes(courtId, delta) {
  const ref = doc(db, "courts", courtId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const current = snap.data().gameMinutes || DEFAULT_SETTINGS.gameMinutes;
    tx.update(ref, { gameMinutes: Math.max(1, current + delta) });
  });
}

// Registers a name into the queue. Reuses an existing player doc (by
// case-insensitive name match) so wins/points persist across sessions.
export async function registerPlayer(name) {
  const cleanName = name.trim();
  if (!cleanName) return { ok: false, reason: "empty" };

  const playersRef = collection(db, "players");
  const snap = await getDocs(playersRef);
  const existing = snap.docs.find(
    (d) => (d.data().name || "").trim().toLowerCase() === cleanName.toLowerCase()
  );

  if (existing) {
    const data = existing.data();
    if (data.status === "waiting" || data.status === "playing") {
      return { ok: false, reason: "already-in" };
    }
    await setDoc(
      doc(db, "players", existing.id),
      { status: "waiting", joinedAt: serverTimestamp(), courtId: null },
      { merge: true }
    );
    return { ok: true, id: existing.id, reused: true };
  }

  const newRef = doc(collection(db, "players"));
  await setDoc(newRef, {
    name: cleanName,
    status: "waiting",
    joinedAt: serverTimestamp(),
    courtId: null,
    wins: 0,
    losses: 0,
    points: 0,
    gamesPlayed: 0,
    createdAt: serverTimestamp(),
  });
  return { ok: true, id: newRef.id, reused: false };
}

export async function withdrawPlayer(playerId) {
  await setDoc(
    doc(db, "players", playerId),
    { status: "inactive", courtId: null },
    { merge: true }
  );
}

// Rewrites joinedAt for every player in `orderedPlayerIds`, in the exact
// order given, so the queue reflects a manual reorder (drag/move up-down).
// Uses client timestamps purely for ordering — accuracy to the second
// doesn't matter, only the relative order does.
export async function reorderQueue(orderedPlayerIds) {
  const batch = writeBatch(db);
  const base = Date.now();
  orderedPlayerIds.forEach((id, i) => {
    batch.update(doc(db, "players", id), { joinedAt: Timestamp.fromMillis(base + i) });
  });
  await batch.commit();
}

// Starts a match with hand-picked players and partners, instead of
// automatically pulling the front of the queue. teamA/teamB are each
// a 2-id array. Still transaction-safe against two devices racing.
export async function startCustomMatch({ courtId, teamA, teamB }) {
  const playerIds = [...teamA, ...teamB];
  const courtRef = doc(db, "courts", courtId);
  try {
    await runTransaction(db, async (tx) => {
      const courtSnap = await tx.get(courtRef);
      if (!courtSnap.exists() || courtSnap.data().status !== "idle") {
        throw new Error("court-not-idle");
      }
      const playerRefs = playerIds.map((id) => doc(db, "players", id));
      const playerSnaps = await Promise.all(playerRefs.map((r) => tx.get(r)));
      const names = playerSnaps.map((s) => (s.exists() ? s.data().name : ""));
      const allWaiting = playerSnaps.every((s) => s.exists() && s.data().status === "waiting");
      if (!allWaiting) throw new Error("player-not-waiting");

      tx.update(courtRef, {
        status: "playing",
        playerIds,
        playerNames: names,
        startTime: serverTimestamp(),
      });
      playerRefs.forEach((ref) => {
        tx.update(ref, { status: "playing", courtId: courtRef.id });
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Attempts to fill one idle court from the front of the queue.
// Safe to call from every connected device at once: the transaction
// re-checks court + player status before writing, so only one caller
// can ever win the race for a given court/group of players.
export async function fillCourtIfPossible(courtId) {
  const courtRef = doc(db, "courts", courtId);

  const waitingQuery = query(
    collection(db, "players"),
    where("status", "==", "waiting"),
    orderBy("joinedAt", "asc"),
    limit(4)
  );

  let waitingSnap;
  try {
    waitingSnap = await getDocs(waitingQuery);
  } catch (e) {
    // Most likely cause: the required Firestore composite index
    // (players: status ASC, joinedAt ASC) hasn't been created yet.
    // The original error's `message` contains a direct link to create it.
    console.error("Queue query failed — you may need to create a Firestore index:", e.message);
    return { ok: false, reason: "query-failed", detail: e.message };
  }
  if (waitingSnap.size < 4) return { ok: false, reason: "not-enough-players" };

  const candidateIds = waitingSnap.docs.map((d) => d.id);
  const candidateNames = waitingSnap.docs.map((d) => d.data().name);

  try {
    await runTransaction(db, async (tx) => {
      const courtSnap = await tx.get(courtRef);
      if (!courtSnap.exists() || courtSnap.data().status !== "idle") {
        throw new Error("court-not-idle");
      }

      const playerRefs = candidateIds.map((id) => doc(db, "players", id));
      const playerSnaps = await Promise.all(playerRefs.map((r) => tx.get(r)));
      const allStillWaiting = playerSnaps.every(
        (s) => s.exists() && s.data().status === "waiting"
      );
      if (!allStillWaiting) throw new Error("player-taken");

      tx.update(courtRef, {
        status: "playing",
        playerIds: candidateIds,
        playerNames: candidateNames,
        startTime: serverTimestamp(),
      });
      playerRefs.forEach((ref) => {
        tx.update(ref, { status: "playing", courtId: courtRef.id });
      });
    });
    return { ok: true };
  } catch (e) {
    // Another device won the race, or the court filled a moment ago.
    // The next snapshot tick will simply try again.
    return { ok: false, reason: e.message };
  }
}

// Ends a game: records the match, updates player stats, frees the court,
// and (optionally) sends the four players back to the end of the queue.
// `winner` ('A' | 'B' | null) lets you record who won even when you skip
// entering a numeric score — scores are only used for the points total.
export async function finishGame({
  courtId,
  playerIds,
  playerNames,
  teamA,
  teamB,
  scoreA,
  scoreB,
  winner,
  autoRequeue,
}) {
  const hasScore =
    scoreA !== null && scoreA !== undefined && scoreB !== null && scoreB !== undefined;
  const matchRef = doc(collection(db, "matches"));

  await runTransaction(db, async (tx) => {
    const courtRef = doc(db, "courts", courtId);
    const playerRefs = playerIds.map((id) => doc(db, "players", id));
    const playerSnaps = await Promise.all(playerRefs.map((r) => tx.get(r)));

    tx.set(matchRef, {
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

    tx.update(courtRef, {
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
    });

    playerRefs.forEach((ref, i) => {
      const snap = playerSnaps[i];
      const data = snap.exists() ? snap.data() : {};
      const id = playerIds[i];
      const onTeamA = teamA.includes(id);
      const teamScore = onTeamA ? scoreA : scoreB;

      // Winner can come from an explicit pick (winner === 'A'/'B') or,
      // if not picked, from comparing the entered scores.
      let won = null;
      if (winner === "A") won = onTeamA;
      else if (winner === "B") won = !onTeamA;
      else if (hasScore) won = onTeamA ? scoreA > scoreB : scoreB > scoreA;

      const update = {
        gamesPlayed: (data.gamesPlayed || 0) + 1,
        status: autoRequeue ? "waiting" : "inactive",
        courtId: null,
      };
      if (autoRequeue) update.joinedAt = serverTimestamp();
      if (hasScore) update.points = (data.points || 0) + teamScore;
      if (won === true) update.wins = (data.wins || 0) + 1;
      if (won === false) update.losses = (data.losses || 0) + 1;

      tx.update(ref, update);
    });
  });
}

// Ends the open-play session: snapshots every player's stats as the
// final standings, archives that snapshot to `sessions/{id}`, then
// resets stats and the queue so the app is ready for next time.
export async function endSession() {
  const playersSnap = await getDocs(collection(db, "players"));
  const standings = playersSnap.docs
    .map((d) => {
      const p = d.data();
      return {
        id: d.id,
        name: p.name || "",
        wins: p.wins || 0,
        losses: p.losses || 0,
        points: p.points || 0,
        gamesPlayed: p.gamesPlayed || 0,
      };
    })
    .filter((p) => p.gamesPlayed > 0)
    .sort((a, b) => (b.wins !== a.wins ? b.wins - a.wins : b.points - a.points));

  const totalGames = standings.reduce((sum, p) => sum + p.gamesPlayed, 0) / 4;

  const sessionRef = doc(collection(db, "sessions"));
  await setDoc(sessionRef, {
    endedAt: serverTimestamp(),
    totalPlayers: standings.length,
    totalGames: Math.round(totalGames),
    standings,
  });

  const batch = writeBatch(db);
  playersSnap.docs.forEach((d) => {
    batch.update(d.ref, {
      status: "inactive",
      courtId: null,
      wins: 0,
      losses: 0,
      points: 0,
      gamesPlayed: 0,
    });
  });
  const courtsSnap = await getDocs(collection(db, "courts"));
  courtsSnap.docs.forEach((d) => {
    batch.update(d.ref, {
      status: "idle",
      playerIds: [],
      playerNames: [],
      startTime: null,
    });
  });
  await batch.commit();

  return standings;
}