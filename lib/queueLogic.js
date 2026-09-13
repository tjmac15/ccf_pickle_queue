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
  const waitingSnap = await getDocs(waitingQuery);
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
export async function finishGame({
  courtId,
  playerIds,
  playerNames,
  teamA,
  teamB,
  scoreA,
  scoreB,
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
      const oppScore = onTeamA ? scoreB : scoreA;
      const won = hasScore ? teamScore > oppScore : null;

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
