// One-time camera/mic grant for the side panel (see offerPanelGrant in sidebar.js).
"use strict";
const msg = document.getElementById("msg");
const go = document.getElementById("go");

async function ask() {
  go.disabled = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    s.getTracks().forEach((t) => t.stop());
    msg.className = "ok";
    msg.textContent = "All set — your camera and mic are on in WatchParty. This tab will close.";
    go.hidden = true;
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    msg.className = "err";
    msg.textContent = err && err.name === "NotAllowedError"
      ? "Access was blocked. Click the camera icon in the address bar to allow it, then try again."
      : "Couldn't open the camera or mic — check that no other app is using them.";
    go.disabled = false;
  }
}

go.addEventListener("click", ask);
ask();
