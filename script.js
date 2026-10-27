// ====== CONFIG (Supabase > Settings > API) ======
const SUPABASE_URL = "https://qrbtumdmhlykvtfimwlx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyYnR1bWRtaGx5a3Z0Zmltd2x4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MjYxNDksImV4cCI6MjEwODUwMjE0OX0.5etuWaz_9LzSqhMGzxNgUaxFjmmmLw_u7-HaJFaEj0A"; // jamais la clé service_role !
const CHANNEL_NAME = "dev-chat";

const LONG_PRESS_MS = 450; // durée d'appui pour ouvrir le menu
const SWIPE_TRIGGER = 60; // distance (px) pour déclencher "répondre"

const { createClient } = supabase; // vient du script CDN
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Les liens des réponses de l'IA s'ouvrent dans un nouvel onglet
if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

// ====== ÉLÉMENTS ======
const loginScreen = document.getElementById("loginScreen");
const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const usernameInput = document.getElementById("usernameInput");
const signupBtn = document.getElementById("signupBtn");
const loginError = document.getElementById("loginError");
const messagesEl = document.getElementById("messages");
const input = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const logoutBtn = document.getElementById("logoutBtn");
const replyBar = document.getElementById("replyBar");
const replyText = document.getElementById("replyText");
const cancelReply = document.getElementById("cancelReply");
const msgMenu = document.getElementById("msgMenu");
const menuEdit = msgMenu.querySelector('[data-action="edit"]');
const menuDelete = msgMenu.querySelector('[data-action="delete"]');
const infoModal = document.getElementById("infoModal");
const infoBody = document.getElementById("infoBody");
const infoClose = document.getElementById("infoClose");
const typingInfo = document.getElementById("typingInfo");
const typingText = document.getElementById("typingText");
const newPill = document.getElementById("newPill");
const toastEl = document.getElementById("toast");
const unreadBadge = document.getElementById("unreadBadge");
const codeToggleBtn = document.getElementById("codeToggle");
const mentionMenu = document.getElementById("mentionMenu");

// ====== ÉTAT ======
let me = null;
let channelId = null;
let subscription = null;
let started = false;
let profiles = {}; // id -> username
let devs = []; // pseudos des comptes dev
let typingEl = null;
let roomReady = false; // canal temps réel connecté (nécessaire pour envoyer "écrit…")
const typers = new Map(); // clé (id d'utilisateur ou "ai") -> { name, ai, timer }
let lastTypingSent = 0;
let unread = 0; // messages reçus et pas encore vus
let toastTimer = null;
let replyTo = null; // message auquel on répond
let editing = null; // message en cours de modification
let menuMsg = null; // message ciblé par le menu
let mentionItems = []; // suggestions de complétion @
let mentionIdx = 0;
const byId = new Map(); // id -> message
const els = new Map(); // id -> élément DOM

// ====== AUTH ======
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  loginError.classList.remove("ok");
  const { error } = await db.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
  if (error) loginError.textContent = "Connexion impossible : " + error.message;
});

// Création de compte : le pseudo part dans les métadonnées, le trigger SQL crée le profil.
signupBtn.addEventListener("click", async () => {
  loginError.textContent = "";
  loginError.classList.remove("ok");

  const username = usernameInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    loginError.textContent =
      "Pseudo requis : 3 à 20 caractères (lettres, chiffres, _).";
    return;
  }
  if (!email || password.length < 6) {
    loginError.textContent = "Email et mot de passe (6 caractères min.) requis.";
    return;
  }

  signupBtn.disabled = true;

  // Vérifie la disponibilité du pseudo avant de créer le compte
  const { data: available, error: checkError } = await db.rpc(
    "username_available",
    { name: username }
  );
  if (checkError) {
    signupBtn.disabled = false;
    loginError.textContent = "Vérification du pseudo impossible : " + checkError.message;
    return;
  }
  if (!available) {
    signupBtn.disabled = false;
    loginError.textContent = "Ce pseudo est déjà pris, choisis-en un autre.";
    return;
  }

  const { data, error } = await db.auth.signUp({
    email,
    password,
    options: {
      data: { username },
      // Page affichée après le clic sur le lien du mail (même dossier que index.html)
      emailRedirectTo: new URL("verified.html", window.location.href).href,
    },
  });
  signupBtn.disabled = false;

  if (error) {
    // Cas rare : quelqu'un a pris le pseudo entre la vérification et l'inscription
    loginError.textContent = /database error/i.test(error.message)
      ? "Création impossible : le pseudo est peut-être déjà pris."
      : "Création impossible : " + error.message;
    return;
  }
  // Si la confirmation par email est activée dans Supabase, il n'y a pas encore de session.
  if (!data.session) {
    loginError.classList.add("ok");
    loginError.textContent = "Compte créé. Confirme ton email puis connecte-toi.";
  }
  // Sinon onAuthStateChange connecte automatiquement.
});

logoutBtn.addEventListener("click", () => db.auth.signOut());

// Important : ne pas appeler Supabase directement dans ce callback (risque de blocage),
// d'où le setTimeout.
db.auth.onAuthStateChange((_event, session) => {
  if (session && !started) {
    started = true;
    setTimeout(() => start(session.user), 0);
  } else if (!session && started) {
    setTimeout(stop, 0);
  } else if (!session) {
    loginScreen.classList.remove("hidden");
  }
});

// ====== DÉMARRAGE / ARRÊT ======
async function start(user) {
  me = user;
  loginScreen.classList.add("hidden");
  messagesEl.innerHTML = "";

  const { data: channel, error } = await db
    .from("channels")
    .select("id")
    .eq("name", CHANNEL_NAME)
    .maybeSingle();

  if (error || !channel) {
    showSystem("Accès refusé : ton profil doit avoir is_dev = true.");
    return;
  }
  channelId = channel.id;

  await loadProfiles();
  await loadHistory();
  subscribe();

  // Réinscription silencieuse si la permission a déjà été accordée
  if (pushSupported && Notification.permission === "granted") {
    enablePush().catch(() => {});
  }
}

function stop() {
  if (subscription) db.removeChannel(subscription);
  subscription = null;
  started = false;
  me = null;
  channelId = null;
  byId.clear();
  els.clear();
  profiles = {};
  devs = [];
  roomReady = false;
  clearAllTypers();
  unread = 0;
  updateUnreadUI();
  hideToast();
  closeMenu();
  hideMentions();
  replyTo = null;
  editing = null;
  input.value = "";
  updateBar();
  messagesEl.innerHTML = "";
  loginScreen.classList.remove("hidden");
}

// ====== DONNÉES ======
async function loadProfiles() {
  const { data } = await db.from("profiles").select("id, username, is_dev");
  (data ?? []).forEach((p) => (profiles[p.id] = p.username));
  devs = (data ?? []).filter((p) => p.is_dev).map((p) => p.username);
}

async function loadHistory() {
  const { data, error } = await db
    .from("messages")
    .select("id, author_id, role, content, created_at, reply_to, edited_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return showSystem("Erreur de chargement : " + error.message);
  (data ?? []).reverse().forEach((m) => addMessage(m));
}

function subscribe() {
  const filter = "channel_id=eq." + channelId;
  subscription = db
    .channel("room-" + channelId)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter },
      async (payload) => {
        const m = payload.new;
        if (m.author_id && !profiles[m.author_id]) await loadProfiles();
        // Le message est arrivé : son auteur n'est plus "en train d'écrire"
        if (m.author_id) clearTyper(m.author_id);
        if (m.role === "ai") clearTyper("ai");
        addMessage(m, true);
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "messages", filter },
      (payload) => updateMessage(payload.new)
    )
    // Les événements DELETE ne supportent pas de filtre : on ignore les ids inconnus
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "messages" },
      (payload) => removeMessage(payload.old.id)
    )
    // "En train d'écrire" : messages éphémères (non enregistrés en base)
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!payload?.key || payload.key === me?.id) return;
      setTyper(String(payload.key), String(payload.name ?? "…").slice(0, 30), Boolean(payload.ai));
    })
    .on("broadcast", { event: "stop" }, ({ payload }) => {
      if (payload?.key) clearTyper(String(payload.key));
    })
    .subscribe((status) => {
      roomReady = status === "SUBSCRIBED";
    });
}

function sendTypingEvent(on, key, name, ai = false) {
  if (!roomReady || !subscription) return;
  subscription
    .send({ type: "broadcast", event: on ? "typing" : "stop", payload: { key, name, ai } })
    .catch(() => {});
}

// ====== AFFICHAGE ======
function authorName(m) {
  return m.role === "ai" ? "@ai" : profiles[m.author_id] ?? "inconnu";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Corps du message : Markdown pour tous les messages (nettoyé par DOMPurify)
// breaks: true -> un saut de ligne saisi devient un saut de ligne affiché
function renderBody(m) {
  const el = document.createElement("div");
  if (window.marked && window.DOMPurify) {
    el.className = "md";
    const html = marked.parse(m.content, { breaks: true });
    el.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style"] });
    if (m.role !== "ai") highlightMentionsIn(el); // les @pseudos des devs restent surlignés
  } else {
    el.className = "plain";
    el.replaceChildren(highlightMentions(m.content)); // pas d'injection HTML
  }
  return el;
}

// Surligne les @pseudos dans les nœuds texte, sans toucher au code (code / pre)
function highlightMentionsIn(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!node.nodeValue.includes("@")) continue;
    if (node.parentElement?.closest("code, pre")) continue;
    node.replaceWith(highlightMentions(node.nodeValue));
  }
}

function highlightMentions(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  text.replace(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,20})/g, (full, pre, name, offset) => {
    const start = offset + pre.length;
    frag.append(text.slice(last, start));
    if (devs.some((d) => d.toLowerCase() === name.toLowerCase())) {
      const s = document.createElement("span");
      s.className = "mention";
      s.textContent = "@" + name;
      frag.append(s);
    } else {
      frag.append("@" + name);
    }
    last = start + name.length + 1;
    return full;
  });
  frag.append(text.slice(last));
  return frag;
}

function buildMessage(m) {
  const div = document.createElement("div");
  const isAI = m.role === "ai";
  const isMe = m.author_id === me?.id;
  div.className = "message " + (isAI ? "ai" : isMe ? "me" : "other");
  div.dataset.id = m.id;

  if (!isMe) {
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = authorName(m);
    div.appendChild(author);
  }

  // Citation du message auquel celui-ci répond
  if (m.reply_to) {
    const parent = byId.get(m.reply_to);
    const quote = document.createElement("span");
    quote.className = "quote";
    if (parent) {
      const who = document.createElement("b");
      who.textContent = authorName(parent);
      quote.appendChild(who);
      quote.appendChild(document.createTextNode(truncate(parent.content, 80)));
    } else {
      quote.textContent = "Message plus ancien";
    }
    div.appendChild(quote);
  }

  div.appendChild(renderBody(m));

  // Heure d'envoi (complète au survol)
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(m.created_at).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  time.title = fmtDate(m.created_at);
  div.appendChild(time);

  if (m.edited_at) {
    const tag = document.createElement("span");
    tag.className = "edited";
    tag.textContent = "modifié";
    div.appendChild(tag);
  }

  attachGestures(div, m);
  // Clic droit (ordinateur) = menu
  div.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu(m, div);
  });
  return div;
}

// live = vrai pour un message reçu en temps réel (déclenche les notifications)
function addMessage(m, live = false) {
  if (byId.has(m.id)) return;
  const wasNearBottom = isNearBottom(); // à mesurer avant d'ajouter le message
  byId.set(m.id, m);
  const div = buildMessage(m);
  els.set(m.id, div);
  messagesEl.appendChild(div);

  const mine = m.author_id === me?.id;
  // On ne tire pas l'utilisateur vers le bas s'il relit d'anciens messages
  if (!live || mine || wasNearBottom) scrollToBottom();
  if (live && !mine) noteIncoming(m, wasNearBottom);
}

// Mise à jour d'un message modifié (+ citations qui y font référence)
function updateMessage(row) {
  const old = byId.get(row.id);
  if (!old) return;
  const m = { ...old, ...row };
  byId.set(m.id, m);
  rerender(m.id);
  for (const [id, other] of byId) {
    if (other.reply_to === m.id) rerender(id);
  }
}

function rerender(id) {
  const m = byId.get(id);
  const oldEl = els.get(id);
  if (!m || !oldEl) return;
  const fresh = buildMessage(m);
  oldEl.replaceWith(fresh);
  els.set(id, fresh);
}

function showSystem(text) {
  const div = document.createElement("div");
  div.className = "message system";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function showTyping() {
  hideTyping();
  typingEl = document.createElement("div");
  typingEl.className = "message ai typing";
  const label = document.createElement("span");
  label.textContent = "@ai réfléchit";
  typingEl.append(label, makeDots());
  messagesEl.appendChild(typingEl);
  scrollToBottom();
}

function hideTyping() {
  if (typingEl) typingEl.remove();
  typingEl = null;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

// ====== "ÉCRIT…" (animation à trois points) ======
function makeDots() {
  const dots = document.createElement("span");
  dots.className = "dots";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
  return dots;
}

function setTyper(key, name, ai) {
  const old = typers.get(key);
  if (old) clearTimeout(old.timer);
  // Sans nouvelle nouvelle de lui, il disparaît tout seul (4 s ; 45 s pour l'IA)
  const timer = setTimeout(() => clearTyper(key), ai ? 45000 : 4000);
  typers.set(key, { name, ai, timer });
  renderTyping();
}

function clearTyper(key) {
  const t = typers.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  typers.delete(key);
  renderTyping();
}

function clearAllTypers() {
  typers.forEach((t) => clearTimeout(t.timer));
  typers.clear();
  renderTyping();
}

function renderTyping() {
  const humans = [...typers.values()].filter((t) => !t.ai).map((t) => t.name);
  const ai = [...typers.values()].some((t) => t.ai);
  const parts = [];
  if (humans.length === 1) parts.push(humans[0] + " écrit");
  else if (humans.length === 2) parts.push(humans[0] + " et " + humans[1] + " écrivent");
  else if (humans.length > 2) parts.push(humans.length + " personnes écrivent");
  if (ai) parts.push("@ai réfléchit");
  typingText.textContent = parts.join(" · ");
  typingInfo.classList.toggle("idle", parts.length === 0);
}

// ====== NOUVEAUX MESSAGES : pastille, titre de l'onglet, toast ======
const inCodeTab = () => document.body.classList.contains("code-mode");
const away = () => document.hidden || !document.hasFocus();

function noteIncoming(m, wasNearBottom) {
  if (inCodeTab()) {
    unread++;
    showToast(m);
  } else if (away() || !wasNearBottom) {
    unread++;
  }
  updateUnreadUI();
}

// Les messages sont "vus" quand le chat est affiché, la fenêtre active, et qu'on est en bas
function markSeen() {
  if (unread && !inCodeTab() && !away() && isNearBottom()) {
    unread = 0;
    updateUnreadUI();
  }
}

function updateUnreadUI() {
  const count = unread > 99 ? "99+" : String(unread);
  document.title = (unread ? "(" + count + ") " : "") + "Echo dev";
  unreadBadge.textContent = count;
  unreadBadge.classList.toggle("hidden", !(unread && inCodeTab()));
  newPill.textContent = "↓ " + unread + (unread > 1 ? " nouveaux messages" : " nouveau message");
  newPill.classList.toggle("hidden", !(unread && !inCodeTab() && !isNearBottom()));
}

function showToast(m) {
  toastEl.textContent = authorName(m) + " : " + truncate(m.content.replace(/\s+/g, " "), 80);
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4500);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.add("hidden");
}

// Toucher le toast = revenir sur le chat
toastEl.addEventListener("click", () => {
  hideToast();
  if (inCodeTab()) codeToggleBtn.click();
});

newPill.addEventListener("click", () => {
  scrollToBottom();
  unread = 0;
  updateUnreadUI();
});

messagesEl.addEventListener(
  "scroll",
  () => {
    markSeen();
    updateUnreadUI();
  },
  { passive: true }
);
document.addEventListener("visibilitychange", () => {
  markSeen();
  updateUnreadUI();
});
window.addEventListener("focus", () => {
  markSeen();
  updateUnreadUI();
});

// Changement d'onglet Chat <-> Code (la classe "code-mode" est posée par workspace.js)
new MutationObserver(() => {
  if (!inCodeTab()) {
    // La zone de messages perd son défilement quand elle est masquée : retour en bas
    scrollToBottom();
    markSeen();
  }
  hideToast();
  updateUnreadUI();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// ====== GESTES : glisser = répondre, appui long = menu ======
function attachGestures(div, m) {
  let sx = 0,
    sy = 0,
    dx = 0;
  let pressTimer = null;
  let swiping = false;
  let longPressed = false;
  let canSwipe = true;

  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };

  div.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      dx = 0;
      swiping = false;
      longPressed = false;
      // On évite le glissement quand on fait défiler un bloc de code
      canSwipe = !e.target.closest("pre");
      pressTimer = setTimeout(() => {
        longPressed = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openMenu(m, div);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

  div.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      const mx = t.clientX - sx;
      const my = t.clientY - sy;

      if (!swiping && (Math.abs(mx) > 10 || Math.abs(my) > 10)) cancelPress();
      if (longPressed) return;

      if (!swiping && canSwipe && mx > 10 && Math.abs(mx) > Math.abs(my) * 1.5) {
        swiping = true;
      }
      if (swiping) {
        dx = Math.max(0, Math.min(mx, 90));
        div.style.transition = "none";
        div.style.transform = "translateX(" + dx + "px)";
      }
    },
    { passive: true }
  );

  const end = () => {
    cancelPress();
    if (swiping) {
      div.style.transition = "transform 0.2s";
      div.style.transform = "";
      if (dx >= SWIPE_TRIGGER) setReply(m);
    }
    swiping = false;
    dx = 0;
  };
  div.addEventListener("touchend", end);
  div.addEventListener("touchcancel", end);
}

// ====== MENU (appui long / clic droit) ======
function openMenu(m, div) {
  menuMsg = m;
  const canEdit = m.role === "user" && m.author_id === me?.id;
  menuEdit.classList.toggle("hidden", !canEdit);
  // Tu peux supprimer tes messages et les réponses de l'IA
  menuDelete.classList.toggle("hidden", !(canEdit || m.role === "ai"));

  msgMenu.classList.remove("hidden");
  const rect = div.getBoundingClientRect();
  const w = msgMenu.offsetWidth;
  const h = msgMenu.offsetHeight;
  const margin = 10;

  let top = rect.bottom + 6;
  if (top + h > window.innerHeight - margin) top = rect.top - h - 6;
  top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));

  let left = m.author_id === me?.id ? rect.right - w : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));

  msgMenu.style.top = top + "px";
  msgMenu.style.left = left + "px";
}

function closeMenu() {
  msgMenu.classList.add("hidden");
  menuMsg = null;
}

document.addEventListener("pointerdown", (e) => {
  if (!msgMenu.classList.contains("hidden") && !msgMenu.contains(e.target)) {
    closeMenu();
  }
});
messagesEl.addEventListener("scroll", closeMenu, { passive: true });
window.addEventListener("resize", closeMenu);

msgMenu.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !menuMsg) return;
  const m = menuMsg;
  closeMenu();

  if (btn.dataset.action === "reply") setReply(m);
  else if (btn.dataset.action === "edit") startEdit(m);
  else if (btn.dataset.action === "info") showInfo(m);
  else if (btn.dataset.action === "delete") deleteMessage(m);
  else if (btn.dataset.action === "copy") {
    try {
      await navigator.clipboard.writeText(m.content);
    } catch (_) {
      showSystem("Copie impossible sur ce navigateur.");
    }
  }
});

// ====== SUPPRESSION ======
async function deleteMessage(m) {
  if (!confirm("Supprimer ce message pour tout le monde ?")) return;

  const { data, error } = await db
    .from("messages")
    .delete()
    .eq("id", m.id)
    .select("id");

  if (error) return showSystem("Suppression impossible : " + error.message);
  // La RLS refuse en silence : aucune ligne supprimée = pas le droit
  if (!data?.length) {
    return showSystem(
      "Suppression refusée. Si c'est bien ton message, la policy de suppression manque dans Supabase (voir schema.sql)."
    );
  }
  removeMessage(m.id);
}

function removeMessage(id) {
  if (!byId.has(id)) return;

  els.get(id)?.remove();
  els.delete(id);
  byId.delete(id);

  if (replyTo?.id === id) clearReply();
  if (editing?.id === id) clearEdit();

  // Les réponses à ce message perdent leur citation (comme après un rechargement,
  // car la base met reply_to à null)
  for (const [otherId, other] of byId) {
    if (other.reply_to === id) {
      byId.set(otherId, { ...other, reply_to: null });
      rerender(otherId);
    }
  }
}

// ====== INFORMATIONS ======
function showInfo(m) {
  const parent = m.reply_to ? byId.get(m.reply_to) : null;
  const rows = [
    ["Auteur", authorName(m)],
    ["Type", m.role === "ai" ? "Réponse de l'IA" : "Message utilisateur"],
    ["Envoyé", fmtDate(m.created_at)],
  ];
  if (m.edited_at) rows.push(["Modifié", fmtDate(m.edited_at)]);
  if (m.reply_to) {
    rows.push(["Réponse à", parent ? authorName(parent) : "un ancien message"]);
  }
  rows.push(["Longueur", m.content.length + " caractères"]);

  infoBody.innerHTML = "";
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "info-row";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.textContent = value;
    row.append(l, v);
    infoBody.appendChild(row);
  });
  infoModal.classList.remove("hidden");
}

infoClose.addEventListener("click", () => infoModal.classList.add("hidden"));
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) infoModal.classList.add("hidden");
});

// ====== RÉPONDRE / MODIFIER (barre au-dessus du champ) ======
// Le champ grandit avec le texte (jusqu'à 160 px, puis défilement)
function autosizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

function updateBar() {
  autosizeInput();
  if (editing) {
    replyText.textContent = "Modification du message";
    replyBar.classList.remove("hidden");
  } else if (replyTo) {
    replyText.textContent =
      "Répondre à " + authorName(replyTo) + " : " + truncate(replyTo.content, 60);
    replyBar.classList.remove("hidden");
  } else {
    replyBar.classList.add("hidden");
  }
  sendBtn.textContent = editing ? "Enregistrer" : "Envoyer";
}

function setReply(m) {
  if (editing) clearEdit();
  replyTo = m;
  updateBar();
  input.focus();
}

function clearReply() {
  replyTo = null;
  updateBar();
}

function startEdit(m) {
  replyTo = null;
  editing = m;
  input.value = m.content;
  updateBar();
  input.focus();
}

function clearEdit() {
  editing = null;
  input.value = "";
  updateBar();
}

cancelReply.addEventListener("click", () => {
  if (editing) clearEdit();
  else clearReply();
});

// ====== ENVOI ======
async function sendMessage() {
  const content = input.value.trim();
  if (!content || !channelId) return;
  if (editing) return saveEdit(content);

  input.value = "";
  autosizeInput();
  lastTypingSent = 0;
  sendTypingEvent(false, me.id); // je n'écris plus

  const { data, error } = await db
    .from("messages")
    .insert({
      channel_id: channelId,
      author_id: me.id,
      content,
      reply_to: replyTo?.id ?? null,
    })
    .select()
    .single();

  if (error) {
    input.value = content;
    autosizeInput();
    return showSystem("Envoi impossible : " + error.message);
  }
  clearReply();
  addMessage(data);

  const ping = content.match(/^@ai\b\s*(.*)$/is);
  if (ping && ping[1].trim()) askAI(ping[1].trim());
}

async function saveEdit(content) {
  const target = editing;
  if (content === target.content) return clearEdit();

  const { data, error } = await db
    .from("messages")
    .update({ content })
    .eq("id", target.id)
    .select()
    .single();

  if (error) return showSystem("Modification impossible : " + error.message);
  clearEdit();
  updateMessage(data);
}

async function askAI(question) {
  showTyping();
  sendTypingEvent(true, "ai", "@ai", true); // les autres voient aussi "@ai réfléchit"
  try {
    const { error } = await db.functions.invoke("ask-ai", {
      body: { channel_id: channelId, question },
    });
    if (error) throw error;
  } catch (err) {
    // Récupère le vrai message d'erreur renvoyé par la fonction
    let msg = err.message ?? String(err);
    try {
      const body = await err.context.json();
      if (body?.error) msg = body.error + " (code " + err.context.status + ")";
    } catch (_) {}
    showSystem("@ai n'a pas pu répondre : " + msg);
  } finally {
    hideTyping();
    sendTypingEvent(false, "ai");
  }
}

// ====== COMPLÉTION @ ======
function hideMentions() {
  mentionMenu.classList.add("hidden");
  mentionItems = [];
}

function currentMention() {
  const pos = input.selectionStart ?? input.value.length;
  const m = input.value.slice(0, pos).match(/(^|\s)@([A-Za-z0-9_]*)$/);
  return m ? { start: pos - m[2].length - 1, end: pos, q: m[2].toLowerCase() } : null;
}

function renderMentions() {
  mentionMenu.replaceChildren(
    ...mentionItems.map((name, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "@" + name;
      if (i === mentionIdx) b.classList.add("active");
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // garde le focus sur le champ
        applyMention(name);
      });
      return b;
    })
  );
}

function updateMentions() {
  const r = currentMention();
  const myName = profiles[me?.id];
  mentionItems = r
    ? devs
        .filter((d) => d.toLowerCase().startsWith(r.q) && d !== myName && d.toLowerCase() !== "ai")
        .slice(0, 6)
    : [];
  if (!mentionItems.length) return hideMentions();
  mentionIdx = 0;
  mentionMenu.classList.remove("hidden");
  renderMentions();
}

function applyMention(name) {
  const r = currentMention();
  if (!r) return;
  const v = input.value;
  input.value = v.slice(0, r.start) + "@" + name + " " + v.slice(r.end);
  const p = r.start + name.length + 2;
  input.setSelectionRange(p, p);
  hideMentions();
  input.focus();
}

input.addEventListener("input", updateMentions);
input.addEventListener("input", autosizeInput);
input.addEventListener("blur", () => setTimeout(hideMentions, 150));

// ====== CLAVIER : complétion + envoi (un seul listener, pas de doublon) ======
input.addEventListener("keydown", (e) => {
  // Menu de complétion ouvert
  if (!mentionMenu.classList.contains("hidden")) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = mentionItems.length;
      mentionIdx = (mentionIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      return renderMentions();
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      return applyMention(mentionItems[mentionIdx]);
    }
    if (e.key === "Escape") return hideMentions();
  }

  // Sinon : Entrée envoie, Maj+Entrée saute une ligne.
  // Sur écran tactile (pas de touche Maj), Entrée saute une ligne : on envoie avec le bouton.
  const touchDevice = window.matchMedia("(pointer: coarse)").matches;
  if (e.key === "Enter" && !e.shiftKey && !touchDevice) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// Diffusion de "j'écris…" (au plus toutes les 2,5 s tant que je tape)
input.addEventListener("input", () => {
  if (!me || editing) return;
  if (!input.value.trim()) {
    lastTypingSent = 0;
    return sendTypingEvent(false, me.id);
  }
  const now = Date.now();
  if (now - lastTypingSent > 2500) {
    lastTypingSent = now;
    sendTypingEvent(true, me.id, profiles[me.id] ?? "Quelqu'un");
  }
});