"use client";

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Turns on Firestore's built-in on-device cache: reads that are already
// cached come back instantly instead of waiting on the network every
// time, and if wifi drops for a few seconds, writes queue up locally and
// send automatically once it's back. This is NOT the same as "the whole
// app keeps working with no internet all night" — it's "brief
// connectivity drops don't break things, and everything feels snappier."
// `persistentMultipleTabManager` lets it work correctly if the same
// device ever has the app open in two browser tabs at once.
let db;
if (typeof window === "undefined") {
  // Server-side prerender has no IndexedDB — plain in-memory instance.
  db = getFirestore(app);
} else {
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      // Church/venue wifi and proxies often break Firestore's default
      // streaming connection, which shows up as "loads forever / blank
      // lists". This lets the SDK detect that and fall back to long
      // polling automatically.
      experimentalAutoDetectLongPolling: true,
    });
  } catch (e) {
    // Already initialized (dev fast-refresh) or IndexedDB unavailable
    // (private browsing) — fall back, but say so instead of failing silently.
    console.warn("Offline cache unavailable, using memory cache:", e?.message);
    db = getFirestore(app);
  }
}

export { db };
