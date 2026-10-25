// ====== ESPACE DE TRAVAIL : éditeur de code + GitHub + Gemini ======
// Utilise `db` défini dans script.js. Tout est dans une fonction pour éviter les collisions de noms.
(() => {
  const toggleBtn = document.getElementById("codeToggle");
  const fileSelect = document.getElementById("wsFile");
  const newBtn = document.getElementById("wsNew");
  const reloadBtn = document.getElementById("wsReload");
  const saveBtn = document.getElementById("wsSave");
  const statusEl = document.getElementById("wsStatus");
  const editorEl = document.getElementById("wsEditor");
  const proposalEl = document.getElementById("wsProposal");
  const explainEl = document.getElementById("wsExplain");
  const diffEl = document.getElementById("wsDiff");
  const applyBtn = document.getElementById("wsApply");
  const rejectBtn = document.getElementById("wsReject");
  const promptInput = document.getElementById("wsPrompt");
  const askBtn = document.getElementById("wsAskBtn");
  const liveBtn = document.getElementById("wsLive");
  const peersEl = document.getElementById("wsPeers");

  let cm = null; // instance CodeMirror
  let paths = []; // chemins des fichiers du dépôt
  let current = null; // { path, sha } (sha = null pour un nouveau fichier)
  let dirty = false;
  let loading = false; // vrai quand on remplit l'éditeur par code
  let treeLoading = false;
  let pending = null; // proposition de Gemini { base, content, path }
  let liveOn = false; // mode "Live" activé
  let baseText = ""; // dernier contenu connu sur GitHub (sert au live)

  // ---------- utilitaires ----------
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind ?? "";
  }

  function refreshStatus() {
    if (!current) return setStatus(paths.length ? paths.length + " fichiers" : "");
    setStatus(current.path + (dirty ? " — modifié (non enregistré)" : ""));
  }

  async function callFn(name, body) {
    try {
      const { data, error } = await db.functions.invoke(name, { body });
      if (error) throw error;
      return data;
    } catch (err) {
      let msg = err.message ?? String(err);
      let status = null;
      try {
        const b = await err.context.json();
        if (b?.error) msg = b.error;
        status = err.context.status;
      } catch (_) {}
      const e = new Error(msg);
      e.status = status;
      throw e;
    }
  }

  function modeFor(path) {
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    const map = {
      js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
      ts: { name: "javascript", typescript: true },
      tsx: { name: "javascript", typescript: true },
      json: { name: "javascript", json: true },
      html: "htmlmixed", htm: "htmlmixed",
      xml: "xml", svg: "xml",
      css: "css", scss: "css",
      py: "python", sql: "sql", sh: "shell",
    };
    return map[ext] ?? null;
  }

  // ---------- éditeur ----------
  function initEditor() {
    if (typeof CodeMirror === "undefined") {
      setStatus("L'éditeur n'a pas pu se charger (CDN bloqué ?).", "error");
      return false;
    }
    cm = CodeMirror(editorEl, {
      value: "",
      lineNumbers: true,
      theme: "material-darker",
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      autoCloseBrackets: true,
      matchBrackets: true,
      extraKeys: {
        Tab: (c) =>
          c.somethingSelected() ? c.indentSelection("add") : c.replaceSelection("  ", "end"),
        "Ctrl-S": () => saveFile(),
        "Cmd-S": () => saveFile(),
      },
    });
    cm.setSize("100%", "100%");
    cm.on("change", () => {
      if (loading) return;
      dirty = true;
      refreshStatus();
    });
    return true;
  }

  function fillEditor(path, content) {
    baseText = content;
    loading = true;
    cm.setOption("mode", modeFor(path));
    cm.setValue(content);
    cm.clearHistory();
    loading = false;
    dirty = false;
  }

  // ---------- liste des fichiers ----------
  function renderSelect() {
    fileSelect.innerHTML = "";
    fileSelect.add(new Option("— choisir un fichier —", ""));
    const list = [...paths];
    if (current && !list.includes(current.path)) list.push(current.path);
    list.forEach((p) => fileSelect.add(new Option(p, p)));
    fileSelect.value = current?.path ?? "";
  }

  async function loadTree() {
    treeLoading = true;
    setStatus("Chargement des fichiers…");
    try {
      const d = await callFn("github", { action: "tree" });
      paths = d.files.map((f) => f.path);
      renderSelect();
      if (!paths.length) setStatus("Dépôt vide : crée un fichier avec « + ».");
      else setStatus(paths.length + " fichiers" + (d.truncated ? " (liste tronquée)" : ""));
    } catch (e) {
      setStatus("Erreur GitHub : " + e.message, "error");
    } finally {
      treeLoading = false;
    }
  }

  // ---------- ouvrir / créer / enregistrer ----------
  async function openFile(path) {
    hideProposal();
    window.EchoCollab?.stop();
    setStatus("Ouverture de " + path + "…");
    try {
      const d = await callFn("github", { action: "read", path });
      fillEditor(path, d.content);
      current = { path, sha: d.sha };
      renderSelect();
      refreshStatus();
      startLiveIfOn();
    } catch (e) {
      setStatus("Erreur : " + e.message, "error");
      fileSelect.value = current?.path ?? "";
    }
  }

  fileSelect.addEventListener("change", () => {
    const path = fileSelect.value;
    if (!path) return;
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) {
      fileSelect.value = current?.path ?? "";
      return;
    }
    openFile(path);
  });

  newBtn.addEventListener("click", () => {
    if (!cm) return;
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    const input = prompt("Chemin du nouveau fichier (ex : src/app.js) :");
    const clean = (input ?? "").trim().replace(/^\/+/, "");
    if (!clean) return;
    if (clean.includes("..")) return setStatus("Chemin invalide.", "error");
    if (paths.includes(clean)) return openFile(clean);

    hideProposal();
    window.EchoCollab?.stop();
    current = { path: clean, sha: null };
    fillEditor(clean, "");
    dirty = true;
    renderSelect();
    setStatus(clean + " — nouveau fichier (pas encore enregistré)");
    startLiveIfOn();
  });

  reloadBtn.addEventListener("click", async () => {
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    await loadTree();
    if (current?.sha) openFile(current.path);
  });

  async function saveFile() {
    if (!current) return setStatus("Aucun fichier ouvert.", "error");
    const message = prompt(
      "Message de commit :",
      "Modif de " + current.path + " depuis Echo dev"
    );
    if (!message) return;

    saveBtn.disabled = true;
    setStatus("Enregistrement…");
    try {
      const text = cm.getValue();
      const d = await callFn("github", {
        action: "write",
        path: current.path,
        content: text,
        sha: current.sha,
        message,
      });
      current.sha = d.sha;
      baseText = text;
      dirty = cm.getValue() !== text; // des modifications ont pu arriver pendant l'envoi
      window.EchoCollab?.notifySaved(d.sha, text);
      if (!paths.includes(current.path)) {
        paths.push(current.path);
        paths.sort();
        renderSelect();
      }
      setStatus("Enregistré sur GitHub ✔ " + current.path, "ok");
    } catch (e) {
      setStatus(
        e.status === 409
          ? "Conflit : le fichier a changé sur GitHub. Copie tes modifications, puis recharge (↻)."
          : "Enregistrement impossible : " + e.message,
        "error"
      );
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener("click", saveFile);

  // ---------- Gemini : propositions ----------
  function computeDiff(a, b) {
    const A = a.split("\n");
    const B = b.split("\n");
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length;
    let eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
      ea--;
      eb--;
    }
    const a2 = A.slice(s, ea);
    const b2 = B.slice(s, eb);
    const n = a2.length;
    const m = b2.length;
    if (n === 0 && m === 0) return { rows: [], changed: false };

    const rows = [];
    A.slice(Math.max(0, s - 2), s).forEach((l) => rows.push(["ctx", l]));

    if (n * m > 4000000) {
      // Trop gros pour un diff fin : tout est affiché comme remplacé
      a2.forEach((l) => rows.push(["del", l]));
      b2.forEach((l) => rows.push(["add", l]));
    } else {
      const w = m + 1;
      const t = new Uint16Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          t[i * w + j] =
            a2[i] === b2[j]
              ? t[(i + 1) * w + j + 1] + 1
              : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a2[i] === b2[j]) {
          rows.push(["ctx", a2[i]]);
          i++;
          j++;
        } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
          rows.push(["del", a2[i]]);
          i++;
        } else {
          rows.push(["add", b2[j]]);
          j++;
        }
      }
      while (i < n) rows.push(["del", a2[i++]]);
      while (j < m) rows.push(["add", b2[j++]]);
    }

    A.slice(ea, ea + 2).forEach((l) => rows.push(["ctx", l]));
    return { rows, changed: true };
  }

  function addDiffRow(type, text) {
    const div = document.createElement("div");
    div.className = "diff-" + type;
    div.textContent = (type === "add" ? "+ " : type === "del" ? "- " : "  ") + text;
    diffEl.appendChild(div);
  }

  function renderDiff(rows) {
    diffEl.innerHTML = "";
    let i = 0;
    while (i < rows.length) {
      if (rows[i][0] !== "ctx") {
        addDiffRow(rows[i][0], rows[i][1]);
        i++;
        continue;
      }
      let k = i;
      while (k < rows.length && rows[k][0] === "ctx") k++;
      const run = rows.slice(i, k);
      if (run.length > 6) {
        run.slice(0, 2).forEach((r) => addDiffRow("ctx", r[1]));
        const sep = document.createElement("div");
        sep.className = "diff-sep";
        sep.textContent = "⋯ " + (run.length - 4) + " lignes identiques ⋯";
        diffEl.appendChild(sep);
        run.slice(-2).forEach((r) => addDiffRow("ctx", r[1]));
      } else {
        run.forEach((r) => addDiffRow("ctx", r[1]));
      }
      i = k;
    }
  }

  function showProposal(base, d) {
    const diff = computeDiff(base, d.new_content);
    pending = { base, content: d.new_content, path: current.path };
    explainEl.textContent = d.explanation || "Proposition de Gemini";
    if (diff.changed) {
      renderDiff(diff.rows);
      applyBtn.classList.remove("hidden");
    } else {
      diffEl.innerHTML = "";
      addDiffRow("ctx", "Aucun changement proposé.");
      applyBtn.classList.add("hidden");
    }
    proposalEl.classList.remove("hidden");
    if (cm) cm.refresh();
  }

  function hideProposal() {
    pending = null;
    proposalEl.classList.add("hidden");
    if (cm) cm.refresh();
  }

  applyBtn.addEventListener("click", () => {
    if (!pending) return;
    if (current?.path !== pending.path) {
      hideProposal();
      return setStatus("Le fichier ouvert a changé : proposition annulée.", "error");
    }
    if (
      cm.getValue() !== pending.base &&
      !confirm("Le fichier a été modifié depuis ta demande. Remplacer quand même ?")
    ) {
      return;
    }
    cm.setValue(pending.content); // marque le fichier comme modifié (annulable avec Ctrl+Z)
    hideProposal();
  });

  rejectBtn.addEventListener("click", hideProposal);

  async function askGemini() {
    const instruction = promptInput.value.trim();
    if (!instruction) return;
    if (!current) return setStatus("Ouvre d'abord un fichier.", "error");

    const base = cm.getValue();
    askBtn.disabled = true;
    setStatus("Gemini réfléchit…");
    try {
      const d = await callFn("code-ai", {
        path: current.path,
        content: base,
        instruction,
        tree: paths.slice(0, 400),
      });
      showProposal(base, d);
      promptInput.value = "";
      refreshStatus();
    } catch (e) {
      setStatus("Gemini : " + e.message, "error");
    } finally {
      askBtn.disabled = false;
    }
  }

  askBtn.addEventListener("click", askGemini);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      askGemini();
    }
  });

  // ---------- Live : édition à plusieurs en direct ----------
  function setLive(on) {
    liveOn = on;
    liveBtn.classList.toggle("on", on);
    liveBtn.textContent = on ? "Live ●" : "Live";
    if (!on) {
      window.EchoCollab?.stop();
      peersEl.classList.add("hidden");
    } else if (current) {
      startLiveIfOn();
    } else {
      setStatus("Live activé : ouvre un fichier pour le partager.");
    }
  }

  function startLiveIfOn() {
    if (!liveOn || !current || !cm) return;
    if (!window.EchoCollab) {
      setStatus("Le live n'a pas pu se charger (collab.js manquant ?).", "error");
      return setLive(false);
    }
    if (
      dirty &&
      current.sha &&
      !confirm(
        "Rejoindre le live remplacera tes modifications non enregistrées si quelqu'un est déjà dans ce fichier. Continuer ?"
      )
    ) {
      return setLive(false);
    }

    EchoCollab.start(cm, {
      path: current.path,
      sha: current.sha,
      getBaseText: () => baseText,
      fill(text) {
        loading = true;
        cm.setValue(text);
        cm.clearHistory();
        loading = false;
        dirty = text !== baseText || !current?.sha;
        refreshStatus();
      },
      onPeers(names) {
        peersEl.classList.remove("hidden");
        peersEl.textContent = names.length
          ? "En direct avec : " + names.join(", ")
          : "En direct — personne d'autre pour l'instant";
      },
      onSaved(info) {
        if (!current) return;
        current.sha = info.sha;
        if (info.hash === EchoCollab.hash(cm.getValue())) {
          baseText = cm.getValue();
          dirty = false;
        }
        setStatus(current.path + " enregistré par un collaborateur ✔", "ok");
      },
      onError(msg) {
        setStatus(msg, "error");
        setLive(false);
      },
    });
  }

  liveBtn.addEventListener("click", () => setLive(!liveOn));

  // ---------- onglet Code / Chat ----------
  toggleBtn.addEventListener("click", () => {
    const on = document.body.classList.toggle("code-mode");
    toggleBtn.textContent = on ? "Chat" : "Code";
    if (!on) return;
    if (!cm && !initEditor()) return;
    setTimeout(() => cm.refresh(), 0);
    if (!paths.length && !treeLoading) loadTree();
  });

  // Déconnexion : on vide tout (pas d'appel Supabase dans ce callback)
  db.auth.onAuthStateChange((_event, session) => {
    if (session) return;
    document.body.classList.remove("code-mode");
    toggleBtn.textContent = "Code";
    window.EchoCollab?.stop();
    liveOn = false;
    liveBtn.classList.remove("on");
    liveBtn.textContent = "Live";
    peersEl.classList.add("hidden");
    paths = [];
    current = null;
    dirty = false;
    pending = null;
    proposalEl.classList.add("hidden");
    fileSelect.innerHTML = "";
    promptInput.value = "";
    if (cm) fillEditor("", "");
    setStatus("");
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
