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
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

const SETTINGS_REF = () => doc(db, "config", "settings");

// Up Next staging is a fixed 4-slot array (slots 0-1 = Team 1, 2-3 =
// Team 2) where an empty slot is `null`. Keeping holes instead of
// compacting the array means removing or swapping one person never
// slides everyone else into a different slot — which is what used to
// shuffle the team pairings. Older compact arrays pad out to 4 as well.
// If `waitingSet` is given, anyone no longer waiting (left, or started
// playing elsewhere) is dropped to a hole, and duplicates are removed.
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
  // increment() instead of a transaction: it needs no read first, so a tap
  // is applied instantly on this device, queues if the connection drops,
  // and merges correctly with taps from other devices when it's back.
  const field = team === "A" ? "liveScoreA" : "liveScoreB";
  await updateDoc(doc(db, "courts", courtId), { [field]: increment(delta) });
}

// Auto-fills any empty slots (up to 4 total) across ALL of the given
// courts' "Up Next" staging areas, from the front of the queue, in one
// single pass. This used to be done as a separate read-then-write call
// per court, looped one at a time — with 2+ courts, calls could overlap
// (one court's write landing after another's read), so a player could
// get claimed by both boxes at once, or dropped from both. Doing every
// court's assignment inside one transaction, from one consistent read
// of the queue, removes that window entirely: either every court's
// staging list updates together and consistently, or (on a rare write
// conflict with something else touching the same court) the whole pass
// retries and recomputes from fresh data.
export async function autoFillAllStaging(courtIds) {
  const idsToFill = Array.from(new Set((courtIds || []).filter(Boolean)));
  if (idsToFill.length === 0) return;

  await runTransaction(db, async (tx) => {
    // All transactional reads must happen before any writes.
    const courtRefs = idsToFill.map((id) => doc(db, "courts", id));
    const courtSnaps = await Promise.all(courtRefs.map((r) => tx.get(r)));
    const settingsSnap = await tx.get(SETTINGS_REF());

    // Read then sort locally instead of using a compound Firestore query.
    // This keeps auto-fill working on projects that haven't created the
    // optional `status + joinedAt` composite index yet. Not a transactional
    // read (Firestore transactions can't run collection queries), so on
    // rare overlap with a brand-new registration this can be a moment
    // stale — self-corrects on the next pass.
    const [playersSnap, allCourtsSnap] = await Promise.all([
      getDocs(collection(db, "players")),
      getDocs(collection(db, "courts")),
    ]);

    const allWaitingIds = playersSnap.docs
      .filter((d) => d.data().status === "waiting")
      .sort((a, b) => {
        const aTime = a.data().joinedAt?.toMillis?.() || 0;
        const bTime = b.data().joinedAt?.toMillis?.() || 0;
        return aTime - bTime;
      })
      .map((d) => d.id);

    const activeCourtCount = settingsSnap.exists()
      ? settingsSnap.data().courtCount || DEFAULT_SETTINGS.courtCount
      : DEFAULT_SETTINGS.courtCount;

    const waitingSet = new Set(allWaitingIds);

    // Start from everyone's current staging list (pruned of anyone who is
    // no longer waiting) so courts NOT being refilled keep their existing
    // reservations intact, and stale/ghost entries can't block a refill.
    const stagedById = new Map();
    allCourtsSnap.docs.forEach((d) => {
      if ((d.data().number || Number(d.id)) > activeCourtCount) return;
      stagedById.set(d.id, normalizeStaged(d.data().staged, waitingSet));
    });
    // Overlay the transactional (freshest, conflict-checked) reads for
    // the courts we're actually filling.
    courtSnaps.forEach((snap, i) => {
      if (snap.exists()) stagedById.set(idsToFill[i], normalizeStaged(snap.data().staged, waitingSet));
    });

    const claimed = new Set();
    stagedById.forEach((staged) => staged.forEach((id) => id && claimed.add(id)));

    const queue = allWaitingIds.filter((id) => !claimed.has(id));
    let qi = 0;
    idsToFill.forEach((courtId, i) => {
      const snap = courtSnaps[i];
      if (!snap.exists()) return;
      const staged = [...(stagedById.get(courtId) || normalizeStaged([], waitingSet))];
      for (let slot = 0; slot < 4 && qi < queue.length; slot++) {
        if (!staged[slot]) staged[slot] = queue[qi++];
      }
      const before = normalizeStaged(snap.data().staged);
      if (staged.some((id, k) => id !== before[k])) {
        stagedById.set(courtId, staged);
        tx.update(courtRefs[i], { staged });
      }
    });
  });
}

// Single-court convenience wrapper, used by the manual "Auto-fill"
// button on one Up Next card.
export async function autoFillStaging(courtId) {
  return autoFillAllStaging([courtId]);
}

// Removes one player from this court's staging box, opening that slot
// back up — used when someone leaves before their match starts.
export async function removeFromStaging(courtId, playerId) {
  const ref = doc(db, "courts", courtId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const staged = normalizeStaged(snap.data().staged).map((id) => (id === playerId ? null : id));
    tx.update(ref, { staged });
  });
}

// Manually adds a specific player into the first open slot of this
// court's staging box (used for the dropdown / drag-and-drop) — capped
// at 4. Refuses anyone already staged on another court.
export async function addToStaging(courtId, playerId) {
  const ref = doc(db, "courts", courtId);
  const otherRefs = [];
  const all = await getDocs(collection(db, "courts"));
  all.docs.forEach((d) => {
    if (d.id !== courtId) otherRefs.push(d.ref);
  });
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const others = await Promise.all(otherRefs.map((r) => tx.get(r)));
    const taken = others.some((o) => o.exists() && normalizeStaged(o.data().staged).includes(playerId));
    if (taken) return;
    const staged = normalizeStaged(snap.data().staged);
    if (staged.includes(playerId)) return;
    const slot = staged.indexOf(null);
    if (slot === -1) return;
    staged[slot] = playerId;
    tx.update(ref, { staged });
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

// Swaps a different player into a live match in place of whoever is
// currently in that slot — for emergencies (injury, has to leave, a
// walk-in guest) without ending the game. The outgoing player goes back
// to inactive (like "leave"); the incoming player takes over that exact
// team slot, keeping the score and the rest of the match intact. Because
// games-played/wins/losses are only credited to whoever is actually on
// the court when the game finishes (see finishGame), the substitute gets
// credit for this game automatically — the player they replaced does not.
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

  const result = await runTransaction(db, async (tx) => {
    const courtRef = doc(db, "courts", courtId);
    const courtSnap = await tx.get(courtRef);
    // Already finished (double-tap, or two devices ending the same game):
    // do nothing instead of crediting a second game to these players.
    if (!courtSnap.exists() || courtSnap.data().status !== "playing") {
      return { ok: false, reason: "court-not-playing" };
    }
    // Trust the court's CURRENT roster over what the screen sent — a
    // substitution on another device may have changed it since.
    const current = courtSnap.data();
    playerIds = current.playerIds || playerIds;
    playerNames = current.playerNames || playerNames;
    const half = Math.ceil(playerIds.length / 2);
    teamA = playerIds.slice(0, half);
    teamB = playerIds.slice(half);
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
      // Deliberately NOT resetting `staged` here — if the next match for
      // this court was already pre-built in the Up Next card while this
      // game was still live, that lineup survives instead of getting
      // wiped the instant the game ends (which is exactly when it's
      // needed).
    });

    // Distinct, ordered timestamps for the requeue — not serverTimestamp()
    // for each. Firestore resolves every serverTimestamp() call within one
    // transaction to the exact same commit-time value, so all 4 players
    // would tie. Those ties then get broken in whatever arbitrary order
    // Firestore's snapshot happens to deliver documents in — not their
    // original team order — which is what was scrambling team pairings
    // once these players got auto-staged together again. A few
    // milliseconds apart (in original team order) keeps their relative
    // queue order, and therefore their team pairing, stable.
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
    return { ok: true };
  });
  return result;
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
