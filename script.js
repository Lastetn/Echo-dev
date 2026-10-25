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

// ====== ÉTAT ======
let me = null;
let channelId = null;
let subscription = null;
let started = false;
let profiles = {}; // id -> username
let typingEl = null;
let replyTo = null; // message auquel on répond
let editing = null; // message en cours de modification
let menuMsg = null; // message ciblé par le menu
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
  closeMenu();
  replyTo = null;
  editing = null;
  input.value = "";
  updateBar();
  messagesEl.innerHTML = "";
  loginScreen.classList.remove("hidden");
}

// ====== DONNÉES ======
async function loadProfiles() {
  const { data } = await db.from("profiles").select("id, username");
  (data ?? []).forEach((p) => (profiles[p.id] = p.username));
}

async function loadHistory() {
  const { data, error } = await db
    .from("messages")
    .select("id, author_id, role, content, created_at, reply_to, edited_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return showSystem("Erreur de chargement : " + error.message);
  (data ?? []).reverse().forEach(addMessage);
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
        addMessage(m);
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
    .subscribe();
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

// Corps du message : Markdown pour l'IA (nettoyé), texte brut pour les humains
function renderBody(m) {
  const el = document.createElement("div");
  if (m.role === "ai" && window.marked && window.DOMPurify) {
    el.className = "md";
    const html = marked.parse(m.content, { breaks: true });
    el.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style"] });
  } else {
    el.className = "plain";
    el.textContent = m.content; // textContent = pas d'injection HTML
  }
  return el;
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

function addMessage(m) {
  if (byId.has(m.id)) return;
  byId.set(m.id, m);
  const div = buildMessage(m);
  els.set(m.id, div);
  messagesEl.appendChild(div);
  scrollToBottom();
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
  typingEl.textContent = "@ai réfléchit…";
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
  if (!data?.length) return showSystem("Suppression refusée.");
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
function updateBar() {
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
  }
}

sendBtn.addEventListener("click", sendMessage);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
