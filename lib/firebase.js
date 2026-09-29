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
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  // initializeFirestore throws if it's called more than once for the
  // same app (e.g. a fast-refresh reload in dev) — fall back to the
  // already-initialized instance instead of crashing.
  db = getFirestore(app);
}

export { db };
