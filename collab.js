// ====== LIVE SHARE : édition à plusieurs en direct ======
// Yjs (CRDT) fusionne les modifications, Supabase Realtime (canal PRIVÉ) les transporte.
// Utilise `db`, `me` et `profiles` définis dans script.js, et `window.Y` (chargé dans index.html).
(() => {
  const SEED_WAIT_MS = 1200; // attente d'une réponse des autres avant de créer la session
  const MAX_CHARS = 100000; // fichier max pour le live
  const MAX_PAYLOAD = 240000; // taille max d'un message Realtime (base64)

  let session = null;
  let startCounter = 0;

  // ---------- utilitaires ----------
  function u8ToB64(u8) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode(...u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToU8(b64) {
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function hueFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  const solid = (hue) => "hsl(" + hue + ", 75%, 62%)";
  const faded = (hue) => "hsla(" + hue + ", 75%, 62%, 0.3)";

  function whenYjs() {
    return new Promise((resolve, reject) => {
      if (window.Y) return resolve();
      const timer = setTimeout(
        () => reject(new Error("Yjs n'a pas pu se charger (CDN bloqué ?).")),
        8000
      );
      window.addEventListener(
        "yjs-ready",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  // ---------- démarrage ----------
  async function start(cm, opts) {
    stop();
    const myStart = ++startCounter;

    if (cm.getValue().length > MAX_CHARS) {
      opts.onError?.("Fichier trop gros pour le live (100 000 caractères max).");
      return;
    }
    try {
      await whenYjs();
    } catch (e) {
      opts.onError?.(e.message);
      return;
    }
    if (myStart !== startCounter) return; // arrêt ou autre démarrage entre-temps

    const Y = window.Y;
    const userId = me?.id ?? "anon";
    const name = (typeof profiles !== "undefined" && profiles[userId]) || "dev";
    const hue = hueFor(userId);
    const clientId = crypto.randomUUID
      ? crypto.randomUUID()
      : String(Math.random()).slice(2);

    const doc = new Y.Doc();
    const ytext = doc.getText("code");

    // Canal PRIVÉ : seuls les devs autorisés par la policy SQL peuvent le rejoindre
    const channel = db.channel("ws-" + hash(opts.path), {
      config: {
        private: true,
        broadcast: { self: false },
        presence: { key: clientId },
      },
    });

    const s = {
      Y, doc, ytext, cm, channel, clientId, name, hue, opts,
      synced: false,
      stopped: false,
      gotRemote: false,
      retried: false,
      base: null,
      remote: new Map(), // clientId -> { name, hue, anchor, head }
      marks: [],
      pending: [],
      flushTimer: null,
      seedTimer: null,
      cursorTimer: null,
      renderQueued: false,
      applyingRemote: false,
      onBefore: null,
      onObserve: null,
      onUpdate: null,
      onCursor: null,
    };
    s.send = (event, payload = {}) => {
      if (s.stopped) return;
      channel
        .send({ type: "broadcast", event, payload: { from: clientId, ...payload } })
        .catch(() => {});
    };
    session = s;

    // Lecture seule pendant la synchronisation (quelques secondes au plus)
    cm.setOption("readOnly", true);

    // --- messages reçus ---
    channel.on("broadcast", { event: "hello" }, ({ payload }) => {
      if (!s.synced) {
        s.gotRemote = true;
        return;
      }
      sendPayload(s, "state", {
        to: payload.from,
        base: s.base,
        u: u8ToB64(Y.encodeStateAsUpdate(doc)),
      });
      sendCursor(s);
    });

    channel.on("broadcast", { event: "state" }, ({ payload }) => {
      if (payload.to !== clientId) return;
      if (!s.synced) join(s, payload);
      else Y.applyUpdate(doc, b64ToU8(payload.u), "remote"); // rattrapage idempotent
    });

    channel.on("broadcast", { event: "update" }, ({ payload }) => {
      if (!s.synced) {
        s.gotRemote = true;
        return;
      }
      Y.applyUpdate(doc, b64ToU8(payload.u), "remote");
    });

    channel.on("broadcast", { event: "cursor" }, ({ payload }) => {
      if (!s.synced) return;
      s.remote.set(payload.from, {
        name: payload.name,
        hue: payload.hue,
        anchor: payload.anchor,
        head: payload.head,
      });
      scheduleRender(s);
    });

    channel.on("broadcast", { event: "saved" }, ({ payload }) => {
      opts.onSaved?.(payload);
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const names = [];
      const alive = new Set();
      for (const [key, metas] of Object.entries(state)) {
        alive.add(key);
        if (key !== clientId) names.push(metas[0]?.name ?? "dev");
      }
      for (const id of [...s.remote.keys()]) {
        if (!alive.has(id)) s.remote.delete(id);
      }
      opts.onPeers?.(names);
      scheduleRender(s);
    });

    channel.subscribe(async (status, err) => {
      if (s.stopped) return;
      if (status === "SUBSCRIBED") {
        await channel.track({ name, hue });
        s.send("hello");
        s.seedTimer = setTimeout(() => seed(s), SEED_WAIT_MS);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        opts.onError?.(
          "Live indisponible (" + status + "). Vérifie les policies realtime.messages du SQL." +
            (err?.message ? " " + err.message : "")
        );
        stop();
      }
    });
  }

  function sendPayload(s, event, payload) {
    if (payload.u && payload.u.length > MAX_PAYLOAD) {
      s.opts.onError?.("Modification trop volumineuse pour le temps réel.");
      return;
    }
    s.send(event, payload);
  }

  // ---------- première synchronisation ----------
  // Cas 1 : quelqu'un est déjà là -> on reçoit son état complet
  function join(s, payload) {
    if (s.synced || s.stopped) return;
    clearTimeout(s.seedTimer);
    s.Y.applyUpdate(s.doc, b64ToU8(payload.u), "remote");
    s.base = payload.base ?? null;
    s.synced = true;
    s.opts.fill(s.ytext.toString());
    bind(s);
    s.cm.setOption("readOnly", false);
    sendCursor(s);
    // Rattrapage : une 2e demande récupère d'éventuelles modifications arrivées pendant la synchro
    setTimeout(() => s.send("hello"), 800);
  }

  // Cas 2 : personne d'autre -> on crée la session à partir du fichier GitHub.
  // Le clientID 0 rend la "semence" identique chez tous : deux semences identiques fusionnent sans doublon.
  function seed(s) {
    if (s.synced || s.stopped) return;
    if (s.gotRemote && !s.retried) {
      s.retried = true;
      s.send("hello");
      s.seedTimer = setTimeout(() => seed(s), 2500);
      return;
    }

    const cur = s.cm.getValue();
    const base = s.opts.getBaseText ? s.opts.getBaseText() : cur;

    const realId = s.doc.clientID;
    s.doc.clientID = 0;
    s.doc.transact(() => s.ytext.insert(0, base), "seed");
    s.doc.clientID = realId;

    // Modifications locales non enregistrées : appliquées par-dessus la base
    let changed = false;
    if (cur !== base) {
      let p = 0;
      const max = Math.min(cur.length, base.length);
      while (p < max && cur[p] === base[p]) p++;
      let e = 0;
      while (e < max - p && cur[cur.length - 1 - e] === base[base.length - 1 - e]) e++;
      s.doc.transact(() => {
        const delLen = base.length - p - e;
        if (delLen > 0) s.ytext.delete(p, delLen);
        const ins = cur.slice(p, cur.length - e);
        if (ins) s.ytext.insert(p, ins);
      }, "local");
      changed = true;
    }

    s.base = s.opts.sha ?? null;
    s.synced = true;
    bind(s);
    s.cm.setOption("readOnly", false);
    if (changed) {
      sendPayload(s, "update", { u: u8ToB64(s.Y.encodeStateAsUpdate(s.doc)) });
    }
    sendCursor(s);
  }

  // ---------- liaison éditeur <-> Yjs ----------
  function bind(s) {
    const { Y, doc, ytext, cm } = s;

    // Éditeur -> Yjs. "beforeChange" donne la position exacte avant chaque modification.
    s.onBefore = (_cm, change) => {
      if (s.applyingRemote || change.origin === "yjs") return;
      const from = cm.indexFromPos(change.from);
      const to = cm.indexFromPos(change.to);
      doc.transact(() => {
        if (to > from) ytext.delete(from, to - from);
        const text = change.text.join("\n");
        if (text) ytext.insert(from, text);
      }, "local");
    };
    cm.on("beforeChange", s.onBefore);

    // Yjs -> éditeur (modifications des autres)
    s.onObserve = (event) => {
      if (event.transaction.origin !== "local") {
        s.applyingRemote = true;
        try {
          cm.operation(() => {
            let index = 0;
            for (const op of event.delta) {
              if (op.retain != null) {
                index += op.retain;
              } else if (op.insert != null) {
                const pos = cm.posFromIndex(index);
                cm.replaceRange(op.insert, pos, pos, "yjs");
                index += op.insert.length;
              } else if (op.delete != null) {
                const from = cm.posFromIndex(index);
                const to = cm.posFromIndex(index + op.delete);
                cm.replaceRange("", from, to, "yjs");
              }
            }
          });
        } finally {
          s.applyingRemote = false;
        }
      }
      scheduleRender(s);
    };
    ytext.observe(s.onObserve);

    // Modifications locales -> réseau (regroupées toutes les 60 ms)
    s.onUpdate = (update, origin) => {
      if (origin === "remote" || origin === "seed") return;
      s.pending.push(update);
      if (s.flushTimer) return;
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        const batch = s.pending;
        s.pending = [];
        if (!batch.length) return;
        const merged = batch.length > 1 ? Y.mergeUpdates(batch) : batch[0];
        sendPayload(s, "update", { u: u8ToB64(merged) });
      }, 60);
    };
    doc.on("update", s.onUpdate);

    // Mon curseur -> réseau
    s.onCursor = () => {
      if (s.cursorTimer) return;
      s.cursorTimer = setTimeout(() => {
        s.cursorTimer = null;
        sendCursor(s);
      }, 120);
    };
    cm.on("cursorActivity", s.onCursor);
  }

  // ---------- curseurs des autres ----------
  function sendCursor(s) {
    if (!s.synced || s.stopped) return;
    const { Y, ytext, cm } = s;
    const a = cm.indexFromPos(cm.getCursor("anchor"));
    const h = cm.indexFromPos(cm.getCursor("head"));
    const rel = (i) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, i));
    s.send("cursor", { name: s.name, hue: s.hue, anchor: rel(a), head: rel(h) });
  }

  function scheduleRender(s) {
    if (s.renderQueued || s.stopped) return;
    s.renderQueued = true;
    setTimeout(() => renderRemote(s), 0);
  }

  function renderRemote(s) {
    s.renderQueued = false;
    if (s.stopped) return;
    const { Y, doc, cm } = s;

    s.marks.forEach((m) => m.clear());
    s.marks = [];

    const abs = (relJson) => {
      try {
        const ap = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(relJson),
          doc
        );
        return ap ? ap.index : null;
      } catch (_) {
        return null;
      }
    };

    for (const r of s.remote.values()) {
      const a = abs(r.anchor);
      const h = abs(r.head);
      if (a == null || h == null) continue;

      if (a !== h) {
        s.marks.push(
          cm.markText(
            cm.posFromIndex(Math.min(a, h)),
            cm.posFromIndex(Math.max(a, h)),
            { css: "background:" + faded(r.hue) }
          )
        );
      }

      const el = document.createElement("span");
      el.className = "remote-cursor";
      el.style.borderLeftColor = solid(r.hue);
      const label = document.createElement("span");
      label.className = "remote-cursor-label";
      label.style.background = solid(r.hue);
      label.textContent = r.name;
      el.appendChild(label);
      s.marks.push(cm.setBookmark(cm.posFromIndex(h), { widget: el, insertLeft: true }));
    }
  }

  // ---------- arrêt ----------
  function stop() {
    startCounter++;
    const s = session;
    if (!s) return;
    session = null;
    s.stopped = true;

    clearTimeout(s.seedTimer);
    clearTimeout(s.flushTimer);
    clearTimeout(s.cursorTimer);

    if (s.onBefore) s.cm.off("beforeChange", s.onBefore);
    if (s.onCursor) s.cm.off("cursorActivity", s.onCursor);
    if (s.onObserve) s.ytext.unobserve(s.onObserve);
    if (s.onUpdate) s.doc.off("update", s.onUpdate);

    s.marks.forEach((m) => m.clear());
    s.cm.setOption("readOnly", false);

    db.removeChannel(s.channel);
    s.doc.destroy();
  }

  function notifySaved(sha, text) {
    if (session?.synced) session.send("saved", { sha, hash: hash(text) });
  }

  window.EchoCollab = {
    start,
    stop,
    notifySaved,
    hash,
    isActive: () => Boolean(session?.synced),
  };
})();
