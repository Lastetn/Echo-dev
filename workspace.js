// ====== ESPACE DE TRAVAIL : explorateur + éditeur de code + GitHub + Gemini + live ======
// Utilise `db` défini dans script.js. Tout est dans une fonction pour éviter les collisions de noms.
(() => {
  const workspaceEl = document.getElementById("workspace");
  const toggleBtn = document.getElementById("codeToggle");
  const filesBtn = document.getElementById("wsFilesBtn");
  const currentEl = document.getElementById("wsCurrent");
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

  // Explorateur
  const treeEl = document.getElementById("wsTree");
  const newFileBtn = document.getElementById("wsNewFile");
  const newFolderBtn = document.getElementById("wsNewFolder");
  const reloadBtn = document.getElementById("wsReload");
  const expCloseBtn = document.getElementById("wsExpClose");
  const backdropEl = document.getElementById("wsBackdrop");
  const itemMenu = document.getElementById("wsItemMenu");
  const pickerEl = document.getElementById("wsPicker");
  const pickerTitle = document.getElementById("wsPickerTitle");
  const pickerList = document.getElementById("wsPickerList");
  const pickerCancel = document.getElementById("wsPickerCancel");

  let cm = null; // instance CodeMirror
  let paths = []; // chemins des fichiers du dépôt (y compris les .gitkeep)
  let current = null; // { path, sha } (sha = null pour un nouveau fichier)
  let dirty = false;
  let loading = false; // vrai quand on remplit l'éditeur par code
  let treeLoading = false;
  let pending = null; // proposition de Gemini { base, content, path }
  let liveOn = false; // mode "Live" activé
  let baseText = ""; // dernier contenu connu sur GitHub (sert au live)

  let expanded = new Set(); // dossiers dépliés
  let firstTreeLoad = true;
  const rowEls = new Map(); // chemin -> ligne de l'arbre
  let menuItem = null; // élément ciblé par le menu
  let dragItem = null; // élément en cours de glisser-déposer

  // ---------- utilitaires ----------
  // Un dossier = un fichier ".gitkeep" (Git ne stocke pas les dossiers vides) : caché dans l'arbre
  const isKeep = (p) => p === ".gitkeep" || p.endsWith("/.gitkeep");
  const realFiles = () => paths.filter((p) => !isKeep(p));
  const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
  const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const isDesktop = () => window.matchMedia("(min-width: 800px)").matches;

  // Le chemin p est-il concerné par l'élément (fichier exact, ou contenu du dossier) ?
  const touches = (item, p) =>
    item.kind === "folder" ? p.startsWith(item.path + "/") : p === item.path;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind ?? "";
  }

  function updateCurrentLabel() {
    currentEl.textContent = current ? current.path + (dirty ? " ●" : "") : "Aucun fichier ouvert";
    currentEl.title = current ? current.path : "";
  }

  function markDirty() {
    if (current) rowEls.get(current.path)?.classList.toggle("dirty", dirty);
  }

  function refreshStatus() {
    updateCurrentLabel();
    markDirty();
    if (!current) {
      const n = realFiles().length;
      return setStatus(n ? n + " fichiers" : "");
    }
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

  // ---------- explorateur : ouverture / fermeture ----------
  function setExplorer(open) {
    workspaceEl.classList.toggle("explorer-open", open);
    if (cm) setTimeout(() => cm.refresh(), 0);
  }

  filesBtn.addEventListener("click", () =>
    setExplorer(!workspaceEl.classList.contains("explorer-open"))
  );
  expCloseBtn.addEventListener("click", () => setExplorer(false));
  backdropEl.addEventListener("click", () => setExplorer(false));
  window.addEventListener("resize", () => cm && cm.refresh());
  setExplorer(isDesktop());

  // ---------- explorateur : arbre ----------
  function allFolders() {
    const folders = new Set();
    const all = [...paths];
    if (current && !all.includes(current.path)) all.push(current.path);
    for (const p of all) {
      const parts = p.split("/");
      parts.pop();
      let acc = "";
      for (const part of parts) {
        acc = acc ? acc + "/" + part : part;
        folders.add(acc);
      }
    }
    return folders;
  }

  function expandAncestors(path) {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      expanded.add(acc);
    }
  }

  function buildTree() {
    const root = { name: "", path: "", dirs: new Map(), files: [] };
    const all = [...paths];
    if (current && !all.includes(current.path)) all.push(current.path);
    for (const p of all) {
      const parts = p.split("/");
      const name = parts.pop();
      let node = root;
      let acc = "";
      for (const part of parts) {
        acc = acc ? acc + "/" + part : part;
        if (!node.dirs.has(part)) {
          node.dirs.set(part, { name: part, path: acc, dirs: new Map(), files: [] });
        }
        node = node.dirs.get(part);
      }
      if (!isKeep(p)) node.files.push({ name, path: p });
    }
    return root;
  }

  const FILE_BADGES = {
    js: ["JS", "fi-js"], mjs: ["JS", "fi-js"], cjs: ["JS", "fi-js"], jsx: ["JSX", "fi-js"],
    ts: ["TS", "fi-ts"], tsx: ["TSX", "fi-ts"],
    json: ["{ }", "fi-json"],
    html: ["HTML", "fi-html"], htm: ["HTML", "fi-html"],
    css: ["CSS", "fi-css"], scss: ["SCSS", "fi-css"],
    md: ["MD", "fi-md"], txt: ["TXT", "fi-md"], csv: ["CSV", "fi-md"],
    py: ["PY", "fi-py"], sql: ["SQL", "fi-sql"], sh: ["SH", "fi-sh"],
    xml: ["XML", "fi-xml"], svg: ["SVG", "fi-xml"],
    yml: ["YML", "fi-cfg"], yaml: ["YML", "fi-cfg"], toml: ["TML", "fi-cfg"],
  };

  function badgeFor(name) {
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const [label, cls] = FILE_BADGES[ext] ?? [ext ? ext.slice(0, 3).toUpperCase() : "≡", ""];
    const el = document.createElement("span");
    el.className = "fi" + (cls ? " " + cls : "");
    el.textContent = label;
    return el;
  }

  function makeRow(kind, path, depth) {
    const row = document.createElement("div");
    row.className = "tree-row " + kind;
    row.style.setProperty("--depth", depth);
    row.dataset.path = path;
    row.dataset.kind = kind;
    row.draggable = true;
    row.title = path;
    return row;
  }

  function addCommon(row, name) {
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    const dot = document.createElement("span");
    dot.className = "dot";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "tree-more";
    more.textContent = "⋯";
    more.title = "Actions";
    more.setAttribute("aria-label", "Actions");
    row.append(label, dot, more);
  }

  function renderTree() {
    rowEls.clear();
    treeEl.innerHTML = "";
    const root = buildTree();

    if (!root.dirs.size && !root.files.length) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "Dépôt vide. Crée un fichier avec ＋.";
      treeEl.appendChild(empty);
      return;
    }

    const byName = (a, b) => a.name.localeCompare(b.name);
    const draw = (node, depth) => {
      for (const d of [...node.dirs.values()].sort(byName)) {
        const open = expanded.has(d.path);
        const row = makeRow("folder", d.path, depth);
        const chev = document.createElement("span");
        chev.className = "chev";
        chev.textContent = open ? "▾" : "▸";
        const icon = document.createElement("span");
        icon.className = "ficon";
        icon.textContent = open ? "📂" : "📁";
        row.append(chev, icon);
        addCommon(row, d.name);
        treeEl.appendChild(row);
        rowEls.set(d.path, row);

        if (open) {
          draw(d, depth + 1);
          if (!d.dirs.size && !d.files.length) {
            const hint = document.createElement("div");
            hint.className = "tree-hint";
            hint.style.setProperty("--depth", depth + 1);
            hint.textContent = "Dossier vide";
            treeEl.appendChild(hint);
          }
        }
      }
      for (const f of [...node.files].sort(byName)) {
        const row = makeRow("file", f.path, depth);
        const spacer = document.createElement("span");
        spacer.className = "chev";
        row.append(spacer, badgeFor(f.name));
        addCommon(row, f.name);
        if (current?.path === f.path) {
          row.classList.add("active");
          if (dirty) row.classList.add("dirty");
        }
        treeEl.appendChild(row);
        rowEls.set(f.path, row);
      }
    };
    draw(root, 0);
  }

  async function loadTree() {
    treeLoading = true;
    setStatus("Chargement des fichiers…");
    try {
      const d = await callFn("github", { action: "tree" });
      paths = d.files.map((f) => f.path);
      if (firstTreeLoad) {
        firstTreeLoad = false;
        const folders = allFolders();
        if (folders.size <= 10) folders.forEach((f) => expanded.add(f)); // petit dépôt : tout déplié
      }
      if (current) expandAncestors(current.path);
      renderTree();
      if (!paths.length) setStatus("Dépôt vide : crée un fichier avec ＋.");
      else setStatus(realFiles().length + " fichiers" + (d.truncated ? " (liste tronquée)" : ""));
    } catch (e) {
      setStatus("Erreur GitHub : " + e.message, "error");
    } finally {
      treeLoading = false;
    }
  }

  // Clic sur une ligne : ouvrir / replier, ou menu via le bouton ⋯
  treeEl.addEventListener("click", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    const item = { path: row.dataset.path, kind: row.dataset.kind };
    if (e.target.closest(".tree-more")) return openItemMenu(e.target.closest(".tree-more"), item);

    if (item.kind === "folder") {
      if (expanded.has(item.path)) expanded.delete(item.path);
      else expanded.add(item.path);
      renderTree();
    } else {
      requestOpen(item.path);
    }
  });

  // Clic droit (ordinateur) = menu
  treeEl.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    e.preventDefault();
    openItemMenu(row, { path: row.dataset.path, kind: row.dataset.kind });
  });

  // ---------- explorateur : glisser-déposer (ordinateur) ----------
  function canDrop(item, destFolder) {
    if (destFolder === dirName(item.path)) return false; // déjà dedans
    if (item.kind === "folder" && (destFolder === item.path || destFolder.startsWith(item.path + "/"))) {
      return false; // pas dans lui-même
    }
    return true;
  }

  function clearDropMarks() {
    treeEl.classList.remove("drop-root");
    treeEl.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  }

  treeEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".tree-row");
    if (!row) return;
    dragItem = { path: row.dataset.path, kind: row.dataset.kind };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragItem.path);
  });

  treeEl.addEventListener("dragend", () => {
    dragItem = null;
    clearDropMarks();
  });

  // Cible valide : une ligne de dossier, ou le vide de l'arbre (= racine)
  function dropTarget(e) {
    const row = e.target.closest(".tree-row");
    if (!row) return { dest: "", row: null };
    if (row.dataset.kind !== "folder") return null;
    return { dest: row.dataset.path, row };
  }

  treeEl.addEventListener("dragover", (e) => {
    if (!dragItem) return;
    const t = dropTarget(e);
    if (!t || !canDrop(dragItem, t.dest)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    if (t.row) t.row.classList.add("drop-target");
    else treeEl.classList.add("drop-root");
  });

  treeEl.addEventListener("dragleave", (e) => {
    if (!treeEl.contains(e.relatedTarget)) clearDropMarks();
  });

  treeEl.addEventListener("drop", (e) => {
    if (!dragItem) return;
    const t = dropTarget(e);
    const item = dragItem;
    dragItem = null;
    clearDropMarks();
    if (!t || !canDrop(item, t.dest)) return;
    e.preventDefault();
    moveInto(item, t.dest);
  });

  // ---------- explorateur : menu d'un élément ----------
  function openItemMenu(anchor, item) {
    menuItem = item;
    itemMenu
      .querySelectorAll(".folder-only")
      .forEach((b) => b.classList.toggle("hidden", item.kind !== "folder"));
    itemMenu.classList.remove("hidden");

    const r = anchor.getBoundingClientRect();
    const w = itemMenu.offsetWidth;
    const h = itemMenu.offsetHeight;
    const m = 8;
    const left = Math.max(m, Math.min(r.right - w, window.innerWidth - w - m));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - m) top = Math.max(m, r.top - h - 4);
    itemMenu.style.left = left + "px";
    itemMenu.style.top = top + "px";
  }

  function closeItemMenu() {
    itemMenu.classList.add("hidden");
    menuItem = null;
  }

  document.addEventListener("pointerdown", (e) => {
    if (!itemMenu.classList.contains("hidden") && !itemMenu.contains(e.target)) closeItemMenu();
  });
  treeEl.addEventListener("scroll", closeItemMenu, { passive: true });
  window.addEventListener("resize", closeItemMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeItemMenu();
    closePicker();
  });

  itemMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !menuItem) return;
    const item = menuItem;
    closeItemMenu();
    switch (btn.dataset.action) {
      case "newfile": return createEntry("file", item.path + "/");
      case "newfolder": return createEntry("folder", item.path + "/");
      case "rename": return renameItem(item);
      case "move": return openPicker(item);
      case "delete": return doDelete(item);
    }
  });

  // ---------- explorateur : choix du dossier de destination ----------
  function openPicker(item) {
    pickerTitle.textContent = "Déplacer « " + baseName(item.path) + " » vers…";
    pickerList.innerHTML = "";

    const dests = ["", ...[...allFolders()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
    for (const dest of dests) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pick-row";
      btn.style.setProperty("--depth", dest ? dest.split("/").length : 0);
      btn.textContent = dest ? "📁 " + baseName(dest) : "📁 / (racine)";
      btn.title = dest || "racine";
      if (!canDrop(item, dest)) {
        btn.disabled = true;
        if (dest === dirName(item.path)) btn.textContent += "  (déjà ici)";
      } else {
        btn.addEventListener("click", () => {
          closePicker();
          moveInto(item, dest);
        });
      }
      pickerList.appendChild(btn);
    }
    pickerEl.classList.remove("hidden");
  }

  function closePicker() {
    pickerEl.classList.add("hidden");
  }

  pickerCancel.addEventListener("click", closePicker);
  pickerEl.addEventListener("click", (e) => {
    if (e.target === pickerEl) closePicker();
  });

  // ---------- ouvrir / créer ----------
  function requestOpen(path) {
    if (current?.path === path) {
      if (!isDesktop()) setExplorer(false);
      return;
    }
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    openFile(path);
  }

  async function openFile(path) {
    hideProposal();
    window.EchoCollab?.stop();
    setStatus("Ouverture de " + path + "…");
    try {
      const d = await callFn("github", { action: "read", path });
      fillEditor(path, d.content);
      current = { path, sha: d.sha };
      expandAncestors(path);
      renderTree();
      refreshStatus();
      if (!isDesktop()) setExplorer(false);
      startLiveIfOn();
    } catch (e) {
      setStatus("Erreur : " + e.message, "error");
    }
  }

  // kind = "file" ou "folder" ; prefix = dossier de départ (ex : "src/")
  async function createEntry(kind, prefix = "") {
    if (!cm) return;
    const input = prompt(
      kind === "folder"
        ? "Nom du dossier (ex : src ou src/utils) :"
        : "Nom du fichier (ex : app.js ou src/app.js) :",
      prefix
    );
    let clean = (input ?? "").trim().replace(/^\/+/, "");
    if (!clean) return;
    if (clean.includes("..") || clean.includes("\\")) return setStatus("Chemin invalide.", "error");
    if (kind === "file" && clean.endsWith("/")) kind = "folder"; // « src/ » = un dossier
    clean = clean.replace(/\/+$/, "");
    if (!clean) return;

    if (kind === "folder") return createFolder(clean);

    if (paths.some((p) => p.startsWith(clean + "/"))) {
      return setStatus("Un dossier porte déjà ce nom.", "error");
    }
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    if (paths.includes(clean)) return openFile(clean);

    hideProposal();
    window.EchoCollab?.stop();
    current = { path: clean, sha: null };
    fillEditor(clean, "");
    dirty = true;
    expandAncestors(clean);
    renderTree();
    refreshStatus();
    setStatus(clean + " — nouveau fichier (pas encore enregistré)");
    if (!isDesktop()) setExplorer(false);
    startLiveIfOn();
  }

  // GitHub ne garde pas les dossiers vides : on y ajoute un fichier .gitkeep
  async function createFolder(dir) {
    if (paths.some((p) => p === dir + "/.gitkeep" || p.startsWith(dir + "/"))) {
      return setStatus("Ce dossier existe déjà.", "error");
    }
    if (paths.includes(dir)) return setStatus("Un fichier porte déjà ce nom.", "error");

    setStatus("Création du dossier " + dir + "…");
    try {
      await callFn("github", {
        action: "write",
        path: dir + "/.gitkeep",
        content: "\n",
        message: "Créer le dossier " + dir,
      });
      paths.push(dir + "/.gitkeep");
      paths.sort();
      expandAncestors(dir + "/.gitkeep"); // déplie le dossier et ses parents
      renderTree();
      setStatus("Dossier " + dir + "/ créé ✔", "ok");
    } catch (e) {
      setStatus("Création impossible : " + e.message, "error");
    }
  }

  newFileBtn.addEventListener("click", () => {
    const slash = current ? current.path.lastIndexOf("/") : -1;
    createEntry("file", slash === -1 ? "" : current.path.slice(0, slash + 1));
  });
  newFolderBtn.addEventListener("click", () => {
    const slash = current ? current.path.lastIndexOf("/") : -1;
    createEntry("folder", slash === -1 ? "" : current.path.slice(0, slash + 1));
  });

  reloadBtn.addEventListener("click", async () => {
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    await loadTree();
    if (current?.sha) openFile(current.path);
  });

  // ---------- renommer / déplacer / supprimer ----------
  const isUnsavedNew = (item) =>
    item.kind === "file" &&
    current?.path === item.path &&
    !current.sha &&
    !paths.includes(item.path);

  function closeCurrent() {
    window.EchoCollab?.stop();
    if (liveOn) setLive(false);
    hideProposal();
    current = null;
    loading = true;
    cm.setOption("mode", null);
    cm.setValue("");
    cm.clearHistory();
    loading = false;
    dirty = false;
    baseText = "";
  }

  function renameItem(item) {
    const name = baseName(item.path);
    const input = prompt("Nouveau nom :", name);
    const clean = (input ?? "").trim();
    if (!clean || clean === name) return;
    if (/[\\/]/.test(clean) || clean === "." || clean === "..") {
      return setStatus("Nom invalide (pas de / dans un nom).", "error");
    }
    const dir = dirName(item.path);
    doMove(item, (dir ? dir + "/" : "") + clean);
  }

  function moveInto(item, destFolder) {
    expanded.add(destFolder);
    doMove(item, (destFolder ? destFolder + "/" : "") + baseName(item.path));
  }

  async function doMove(item, to) {
    const affectsCurrent = Boolean(current) && touches(item, current.path);
    const renamed = dirName(item.path) === dirName(to);
    let liveNote = "";
    if (affectsCurrent && liveOn) {
      window.EchoCollab?.stop();
      setLive(false);
      liveNote = " Live désactivé (le chemin a changé).";
    }

    // Nouveau fichier pas encore enregistré : rien à faire côté GitHub
    if (isUnsavedNew(item)) {
      if (paths.includes(to) || paths.some((p) => p.startsWith(to + "/"))) {
        return setStatus("Un élément porte déjà ce nom.", "error");
      }
      current.path = to;
      cm.setOption("mode", modeFor(to));
      expandAncestors(to);
      renderTree();
      refreshStatus();
      return setStatus(to + " — nouveau fichier (pas encore enregistré)." + liveNote);
    }

    setStatus("Déplacement en cours…");
    try {
      const d = await callFn("github", { action: "move", kind: item.kind, from: item.path, to });

      const map = new Map(d.moves.map((m) => [m.from, m.to]));
      paths = paths.map((p) => map.get(p) ?? p).sort();

      if (affectsCurrent) {
        current.path = item.kind === "folder" ? to + current.path.slice(item.path.length) : to;
        cm.setOption("mode", modeFor(current.path));
      }
      if (item.kind === "folder") {
        const next = new Set();
        for (const f of expanded) {
          next.add(touches(item, f + "/x") || f === item.path ? to + f.slice(item.path.length) : f);
        }
        expanded = next;
      }
      expandAncestors(to);
      renderTree();
      refreshStatus();
      setStatus(
        "« " + baseName(item.path) + " » " + (renamed ? "renommé" : "déplacé") + " ✔." + liveNote,
        "ok"
      );
    } catch (e) {
      setStatus("Impossible : " + e.message, "error");
    }
  }

  async function doDelete(item) {
    const isFolder = item.kind === "folder";
    const affectsCurrent = Boolean(current) && touches(item, current.path);

    // Nouveau fichier jamais enregistré : on l'abandonne simplement
    if (isUnsavedNew(item)) {
      if (!confirm("Abandonner le nouveau fichier « " + item.path + " » ?")) return;
      closeCurrent();
      renderTree();
      return refreshStatus();
    }

    const count = isFolder ? realFiles().filter((p) => p.startsWith(item.path + "/")).length : 1;
    let msg = isFolder
      ? "Supprimer le dossier « " + item.path + " » et tout son contenu" +
        (count ? " (" + count + " fichier" + (count > 1 ? "s" : "") + ")" : "") + " ?"
      : "Supprimer « " + item.path + " » ?";
    msg += "\n\nUn commit est créé sur GitHub : tu pourras le retrouver dans l'historique Git.";
    if (affectsCurrent && dirty) msg += "\nTes modifications non enregistrées seront perdues.";
    if (!confirm(msg)) return;

    setStatus("Suppression en cours…");
    try {
      const d = await callFn("github", { action: "delete", kind: item.kind, path: item.path });
      const gone = new Set(d.deleted);
      paths = paths.filter((p) => !gone.has(p));
      if (isFolder) {
        expanded = new Set([...expanded].filter((f) => f !== item.path && !f.startsWith(item.path + "/")));
      }
      if (affectsCurrent) closeCurrent();
      renderTree();
      refreshStatus();
      setStatus("« " + baseName(item.path) + " » supprimé ✔", "ok");
    } catch (e) {
      setStatus("Suppression impossible : " + e.message, "error");
    }
  }

  // ---------- enregistrer ----------
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
        renderTree();
      }
      updateCurrentLabel();
      markDirty();
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
        tree: realFiles().slice(0, 400),
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
          updateCurrentLabel();
          markDirty();
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
    closeItemMenu();
    closePicker();
    paths = [];
    expanded = new Set();
    firstTreeLoad = true;
    current = null;
    dirty = false;
    pending = null;
    proposalEl.classList.add("hidden");
    treeEl.innerHTML = "";
    rowEls.clear();
    promptInput.value = "";
    if (cm) fillEditor("", "");
    updateCurrentLabel();
    setStatus("");
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
