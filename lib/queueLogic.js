"use client";

import {
  collection,
  doc,
  getDoc,
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
      staged: [],
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

// Nudges the running score for a live game, one point at a time.
// team is "A" or "B". Clamped at 0 so it can't go negative. Synced
// to every device watching the court in real time.
export async function adjustLiveScore(courtId, team, delta) {
  const ref = doc(db, "courts", courtId);
  const field = team === "A" ? "liveScoreA" : "liveScoreB";
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const current = snap.data()[field] || 0;
    tx.update(ref, { [field]: Math.max(0, current + delta) });
  });
}

// Auto-fills any empty slots (up to 4 total) in this court's "Up Next"
// staging area from the front of the queue — skipping anyone already
// staged on a DIFFERENT court, so two boxes can't both claim the same
// person when you're running multiple courts at once.
//
// This runs automatically and often (any time the queue or courts
// change), so it uses the indexed status+joinedAt query — bounded to
// just the waiting players, not a scan of everyone who's ever checked
// in — with a fallback for projects that haven't created that Firestore
// index yet.
export async function autoFillStaging(courtId) {
  let allWaitingIds;
  try {
    const waitingSnap = await getDocs(
      query(collection(db, "players"), where("status", "==", "waiting"), orderBy("joinedAt", "asc"), limit(50))
    );
    allWaitingIds = waitingSnap.docs.map((d) => d.id);
  } catch (e) {
    // Composite index not created yet — read everything and sort
    // locally instead. Slower, but still correct.
    const playersSnap = await getDocs(collection(db, "players"));
    allWaitingIds = playersSnap.docs
      .filter((d) => d.data().status === "waiting")
      .sort((a, b) => {
        const aTime = a.data().joinedAt?.toMillis?.() || 0;
        const bTime = b.data().joinedAt?.toMillis?.() || 0;
        return aTime - bTime;
      })
      .map((d) => d.id);
  }

  const [courtsSnap, settingsSnap] = await Promise.all([
    getDocs(collection(db, "courts")),
    getDoc(SETTINGS_REF()),
  ]);
  const activeCourtCount = settingsSnap.data()?.courtCount || DEFAULT_SETTINGS.courtCount;
  let thisStaged = [];
  const stagedElsewhere = new Set();
  courtsSnap.docs.forEach((d) => {
    // Court documents are kept when the organizer lowers the court count.
    // Their old staging lists must not reserve people from active courts.
    if ((d.data().number || Number(d.id)) > activeCourtCount) return;
    const staged = d.data().staged || [];
    if (d.id === courtId) thisStaged = staged;
    else staged.forEach((id) => stagedElsewhere.add(id));
  });

  const available = allWaitingIds.filter((id) => !stagedElsewhere.has(id) && !thisStaged.includes(id));
  const needed = Math.max(0, 4 - thisStaged.length);
  const newStaged = [...thisStaged, ...available.slice(0, needed)];

  await setDoc(doc(db, "courts", courtId), { staged: newStaged }, { merge: true });
}

// Removes one player from this court's staging box, opening that slot
// back up — used when someone leaves before their match starts.
export async function removeFromStaging(courtId, playerId) {
  const ref = doc(db, "courts", courtId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const staged = (snap.data().staged || []).filter((id) => id !== playerId);
    tx.update(ref, { staged });
  });
}

// Manually adds a specific player into this court's staging box
// (used for the "+ Tap to add player" picker) — capped at 4.
export async function addToStaging(courtId, playerId) {
  const ref = doc(db, "courts", courtId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const staged = snap.data().staged || [];
    if (staged.length >= 4 || staged.includes(playerId)) return;
    tx.update(ref, { staged: [...staged, playerId] });
  });
}

// Starts the match using whatever 4 players are currently staged for
// this court — first 2 become Team A, next 2 Team B. Reuses the same
// transaction-safe start used everywhere else in the app.
export async function startStagedMatch(courtId, stagedIds) {
  return startCustomMatch({
    courtId,
    teamA: stagedIds.slice(0, 2),
    teamB: stagedIds.slice(2, 4),
  });
}

// Swaps a different player into a live match in place of whoever is
// currently in that slot — for emergencies (injury, has to leave, a
// walk-in guest) without ending the game. The outgoing player is set
// to inactive (mirrors "leave"); the incoming player takes over that
// exact team slot, keeping the score and teams intact. Because
// games-played is only counted for whoever's actually on the court
// when the game finishes, the substitute gets credit for this game
// automatically — the player they replaced does not.
export async function substitutePlayer(courtId, outgoingPlayerId, incomingPlayerId) {
  const courtRef = doc(db, "courts", courtId);
  try {
    await runTransaction(db, async (tx) => {
      const courtSnap = await tx.get(courtRef);
      if (!courtSnap.exists() || courtSnap.data().status !== "playing") {
        throw new Error("court-not-playing");
      }
      const data = courtSnap.data();
      const playerIds = data.playerIds || [];
      const playerNames = data.playerNames || [];
      const idx = playerIds.indexOf(outgoingPlayerId);
      if (idx === -1) throw new Error("player-not-on-court");

      const incomingRef = doc(db, "players", incomingPlayerId);
      const incomingSnap = await tx.get(incomingRef);
      if (!incomingSnap.exists() || incomingSnap.data().status !== "waiting") {
        throw new Error("player-not-waiting");
      }

      const newPlayerIds = [...playerIds];
      const newPlayerNames = [...playerNames];
      newPlayerIds[idx] = incomingPlayerId;
      newPlayerNames[idx] = incomingSnap.data().name;

      tx.update(courtRef, { playerIds: newPlayerIds, playerNames: newPlayerNames });
      tx.update(doc(db, "players", outgoingPlayerId), { status: "inactive", courtId: null });
      tx.update(incomingRef, { status: "playing", courtId: courtRef.id });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Registers a name into the queue. Reuses an existing player doc (by
// case-insensitive name match) so wins/points persist across sessions.
//
// Looks up the name via an indexed `nameLower` field first — cheap and
// fast no matter how large the collection has grown. Only falls back to
// scanning the whole collection for names registered before this field
// existed; once that old doc is touched here it gains `nameLower` too,
// so the slow path is self-healing and fades out over time.
export async function registerPlayer(name) {
  const cleanName = name.trim();
  if (!cleanName) return { ok: false, reason: "empty" };
  const nameLower = cleanName.toLowerCase();

  let existingDoc = null;
  const fastSnap = await getDocs(
    query(collection(db, "players"), where("nameLower", "==", nameLower), limit(1))
  );
  if (!fastSnap.empty) {
    existingDoc = fastSnap.docs[0];
  } else {
    const allSnap = await getDocs(collection(db, "players"));
    existingDoc =
      allSnap.docs.find((d) => (d.data().name || "").trim().toLowerCase() === nameLower) || null;
  }

  if (existingDoc) {
    const data = existingDoc.data();
    if (data.status === "waiting" || data.status === "playing") {
      return { ok: false, reason: "already-in" };
    }
    await setDoc(
      doc(db, "players", existingDoc.id),
      { status: "waiting", joinedAt: serverTimestamp(), courtId: null, nameLower },
      { merge: true }
    );
    return { ok: true, id: existingDoc.id, reused: true };
  }

  const newRef = doc(collection(db, "players"));
  await setDoc(newRef, {
    name: cleanName,
    nameLower,
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
// automatically pulling the front of the queue. teamA/teamB can each
// be 1 player (singles/1v1) or 2 players (doubles) — any equal split.
// Still transaction-safe against two devices racing.
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
        liveScoreA: 0,
        liveScoreB: 0,
        staged: [],
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
        liveScoreA: 0,
        liveScoreB: 0,
        staged: [],
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
      liveScoreA: 0,
      liveScoreB: 0,
      // Deliberately NOT resetting `staged` here — if you pre-built the
      // next match in the Up Next card while this game was still live,
      // that stays intact instead of getting wiped the moment it ends.
    });

    // Distinct, ordered timestamps for the requeue — not serverTimestamp()
    // for each. All 4 updates land in the same transaction, and Firestore
    // resolves every serverTimestamp() in one transaction to the exact
    // same commit time, so all 4 players would tie. Ties then get broken
    // in whatever arbitrary order Firestore's snapshot happens to deliver
    // documents in — not their original team order — which is exactly
    // what was scrambling team pairings once these players got re-staged
    // together. A few milliseconds apart keeps their relative order
    // (and therefore their team pairing) stable when they're picked up.
    const requeueBase = Date.now();

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
      if (autoRequeue) update.joinedAt = Timestamp.fromMillis(requeueBase + i);
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
      staged: [],
    });
  });
  await batch.commit();

  return standings;
}
