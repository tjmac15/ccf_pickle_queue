"use client";

import { useState } from "react";
import { registerPlayer } from "../lib/queueLogic";

export default function RegisterForm() {
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setMsg("");
    const result = await registerPlayer(name);
    setBusy(false);
    if (result.ok) {
      setName("");
    } else if (result.reason === "already-in") {
      setMsg("That name is already in the queue or on a court.");
    } else {
      setMsg("Enter a name to join the queue.");
    }
  }

  return (
    <div className="register-card">
      <h2>Join the queue</h2>
      <p className="hint">Type your name and you'll be added to the back of the line.</p>
      <form className="register-row" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Joining…" : "Join queue"}
        </button>
      </form>
      {msg && <div className="form-msg">{msg}</div>}
    </div>
  );
}
