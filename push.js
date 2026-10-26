const VAPID_PUBLIC_KEY = "BLLAtRppKBU-vEmLNxn4y13nYLW3l7XYKRg11Ud99btsfFT7BoBEJy8DcI94PsFt6PKChh8FSPuLev6yZs8eDls";

const notifBtn = document.getElementById("notifBtn");
const pushSupported =
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Doit être appelée depuis un clic (exigence iOS et Chrome)
async function enablePush() {
  if (!pushSupported) throw new Error("Les notifications ne sont pas supportées sur ce navigateur.");

  if (isIOS() && !isStandalone()) {
    throw new Error(
      "Sur iPhone : touche Partager → « Sur l'écran d'accueil », puis ouvre Echo dev depuis cette icône."
    );
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications refusées.");

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = sub.toJSON();
  const { error } = await db.rpc("register_push", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
  });
  if (error) throw error;
}

function refreshNotifBtn() {
  if (!pushSupported) return notifBtn.classList.add("hidden");
  notifBtn.classList.toggle("hidden", Notification.permission === "granted");
}

notifBtn.addEventListener("click", async () => {
  try {
    await enablePush();
    refreshNotifBtn();
    alert("Notifications activées sur cet appareil.");
  } catch (err) {
    alert(err.message ?? String(err));
  }
});

refreshNotifBtn();