// ====== CONFIG (Supabase > Settings > API) ======
const SUPABASE_URL = "https://qrbtumdmhlykvtfimwlx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyYnR1bWRtaGx5a3Z0Zmltd2x4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MjYxNDksImV4cCI6MjEwODUwMjE0OX0.5etuWaz_9LzSqhMGzxNgUaxFjmmmLw_u7-HaJFaEj0A"; // jamais la clé service_role !
const CHANNEL_NAME = "dev-chat";

const { createClient } = supabase; // vient du script CDN
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// ====== ÉTAT ======
let me = null;
let channelId = null;
let subscription = null;
let started = false;
let profiles = {}; // id -> username
const seen = new Set(); // ids de messages déjà affichés
let typingEl = null;

// ====== AUTH ======
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
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
    loginError.textContent =
      "Compte créé. Confirme ton email puis connecte-toi.";
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
  seen.clear();
  profiles = {};
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
    .select("id, author_id, role, content, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return showSystem("Erreur de chargement : " + error.message);
  (data ?? []).reverse().forEach(addMessage);
}

function subscribe() {
  subscription = db
    .channel("room-" + channelId)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: "channel_id=eq." + channelId,
      },
      async (payload) => {
        const m = payload.new;
        if (m.author_id && !profiles[m.author_id]) await loadProfiles();
        addMessage(m);
      }
    )
    .subscribe();
}

// ====== AFFICHAGE ======
function addMessage(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);

  const div = document.createElement("div");
  const isAI = m.role === "ai";
  const isMe = m.author_id === me?.id;
  div.className = "message " + (isAI ? "ai" : isMe ? "me" : "other");

  if (!isMe) {
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = isAI ? "@ai" : profiles[m.author_id] ?? "inconnu";
    div.appendChild(author);
  }

  const text = document.createElement("span");
  text.textContent = m.content; // textContent = pas d'injection HTML
  div.appendChild(text);

  messagesEl.appendChild(div);
  scrollToBottom();
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

// ====== ENVOI ======
async function sendMessage() {
  const content = input.value.trim();
  if (!content || !channelId) return;
  input.value = "";

  const { data, error } = await db
    .from("messages")
    .insert({ channel_id: channelId, author_id: me.id, content })
    .select()
    .single();

  if (error) {
    input.value = content;
    return showSystem("Envoi impossible : " + error.message);
  }
  addMessage(data);

  const ping = content.match(/^@ai\b\s*(.*)$/is);
  if (ping && ping[1].trim()) askAI(ping[1].trim());
}

async function askAI(question) {
  showTyping();
  try {
    const { error } = await db.functions.invoke("ask-ai", {
      body: { channel_id: channelId, question },
    });
    if (error) throw error;
  } catch (err) {
    showSystem("@ai n'a pas pu répondre : " + (err.message ?? err));
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
