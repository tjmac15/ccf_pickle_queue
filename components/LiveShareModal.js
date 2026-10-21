"use client";

import { useEffect, useState } from "react";
import { setBroadcasting, exportBackup, restoreBackup } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

// Turn on the read-only live view for other phones/iPads, and keep a backup file.
export default function LiveShareModal({ open, broadcast, onClose }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  useEscapeKey(onClose, open);
  useEffect(() => setOrigin(window.location.origin), []);
  if (!open) return null;

  const link = `${origin}/view`;

  function copy() {
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function downloadBackup() {
    const blob = new Blob([exportBackup()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `open-play-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onRestore(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm("Replace this device's current session with the backup file?")) return;
    file.text().then((text) => {
      try {
        restoreBackup(text);
        setMsg("Backup restored.");
      } catch {
        setMsg("That file isn't a valid backup.");
      }
    });
    e.target.value = "";
  }

  const last = broadcast.lastSent ? new Date(broadcast.lastSent).toLocaleTimeString() : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Live view &amp; backup</h3>
        <p className="hint">
          This device runs the session. Turn sharing on and anyone can watch the queue and scores on
          their own phone at the link below — view only, so nothing can be changed or lost from there.
        </p>

        <div className="settings-field">
          <label>Share live view</label>
          <button className={`toggle ${broadcast.on ? "on" : ""}`} onClick={() => setBroadcasting(!broadcast.on)}>
            <span className="knob" />
          </button>
        </div>

        {broadcast.on && (
          <>
            <div className="share-link">{link}</div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={copy}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <p className="hint">
              {last ? `Last sent ${last}.` : "Sending…"} If the internet drops, the newest copy is sent
              automatically when it's back; play continues normally here.
            </p>
          </>
        )}

        <p className="hint" style={{ marginTop: 18 }}>
          Backup: save a copy of this session to your device, or restore one.
        </p>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={downloadBackup}>
            Download backup
          </button>
          <label className="btn-secondary file-btn">
            Restore backup
            <input type="file" accept="application/json,.json" onChange={onRestore} hidden />
          </label>
        </div>
        {msg && <div className="form-msg">{msg}</div>}
      </div>
    </div>
  );
}
