// frontend/main.js
function resolveApiBase() {
  const configured = String(window.AI_STUDY_CONFIG?.API_BASE || "").trim().replace(/\/+$/, "");
  if (configured) return configured;

  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:5000";
  }

  return window.location.origin.replace(/\/+$/, "");
}

const API_BASE = resolveApiBase();
const SELECTED_KEY = "ai_selected_sources";
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function loadSelected() {
  try { return new Set(JSON.parse(localStorage.getItem(SELECTED_KEY) || "[]")); }
  catch { return new Set(); }
}

function saveSelected(set) {
  localStorage.setItem(SELECTED_KEY, JSON.stringify(Array.from(set)));
}

function setText(el, text) { el.textContent = text || ""; }

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

let score = { correct: 0, answered: 0, total: 0 };
let scoreBoxEl = null;

function updateScoreUI() {
  if (!scoreBoxEl) return;
  scoreBoxEl.textContent = `Score: ${score.correct}/${score.answered} (Total: ${score.total})`;
}

function resetScore() {
  score = { correct: 0, answered: 0, total: score.total };
  updateScoreUI();
}

function _shortenText(s, maxLen = 140) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

function _normalizeWord(w) {
  return String(w || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function _tokenize(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  return t.split(/\s+/).map(_normalizeWord).filter(Boolean);
}

function _filterTokens(tokens) {
  return tokens.filter(tok => tok.length >= 1);
}

function _normalizeAnswerText(text) {
  return _tokenize(text).join(" ");
}

function _keywordMatch(userText, expectedText, minMatch = 3) {
  const normalizedUser = _normalizeAnswerText(userText);
  const normalizedExpected = _normalizeAnswerText(expectedText);

  // Exact match should pass regardless of case or punctuation.
  if (normalizedUser && normalizedExpected && normalizedUser === normalizedExpected) {
    const exactTokens = _tokenize(expectedText);
    return {
      ok: true,
      matchedCount: exactTokens.length || 1,
      matchedWords: exactTokens.slice(0, 8),
      required: exactTokens.length || 1,
      exact: true
    };
  }

  const user = new Set(_filterTokens(_tokenize(userText)));
  const expTokens = _filterTokens(_tokenize(expectedText));

  const matched = [];
  for (const w of expTokens) {
    if (user.has(w) && !matched.includes(w)) matched.push(w);
  }

  // Require up to 3 matched words, but never more than the answer itself contains.
  const required = Math.min(minMatch, Math.max(1, expTokens.length));

  return {
    ok: matched.length >= required,
    matchedCount: matched.length,
    matchedWords: matched.slice(0, 8),
    required,
    exact: false
  };
}

let examFinished = false;

function finishExam() {
  examFinished = true;

  document.querySelectorAll('.mcq-choice input[type="radio"]').forEach(el => { el.disabled = true; });
  document.querySelectorAll('.short-input').forEach(el => { el.disabled = true; });
  document.querySelectorAll('.short-check').forEach(el => { el.disabled = true; });

  document.querySelectorAll("details").forEach(d => {
    d.style.display = "";
    d.open = false;
  });

  const banner = document.getElementById("finalBanner") || document.createElement("div");
  banner.id = "finalBanner";
  banner.className = "final-banner";
  banner.textContent = `Finished. Score: ${score.correct}/${score.answered} (Total: ${score.total})`;

  const out = document.getElementById("outPretty");
  if (out && !document.getElementById("finalBanner")) out.prepend(banner);

  updateScoreUI();
}

function renderPretty(container, jsonObj, opts = {}) {
  const showKey = opts.showKey !== false;
  const examOn = !!opts.examOn;

  container.innerHTML = "";

  const uiLang = (document.getElementById("lang")?.value || "en");
  const t = (en, ar, tr) => (uiLang === "ar" ? ar : (uiLang === "tr" ? tr : en));

  const normalizeAnswerLetter = (ans) => {
    const m = String(ans || "").toUpperCase().match(/[A-D]/);
    return m ? m[0] : "";
  };

  const getChoiceLetter = (ch, i) => {
    const m = String(ch || "").trim().match(/^([A-D])\s*\)/i);
    if (m) return m[1].toUpperCase();
    return ["A", "B", "C", "D"][i] || "";
  };

  if (jsonObj && Array.isArray(jsonObj.items)) {
    jsonObj.items.forEach((it, idx) => {
      const card = document.createElement("div");
      card.style.border = "1px solid var(--border)";
      card.style.background = "var(--card)";
      card.style.padding = "12px";
      card.style.margin = "10px 0";
      card.style.borderRadius = "10px";

      const title = document.createElement("div");
      title.innerHTML = `<b>Q${idx + 1}</b> <span style="padding:2px 8px;border:1px solid var(--border);border-radius:10px;margin-left:6px">${escapeHtml(it.type || "")}</span>`;
      card.appendChild(title);

      const q = document.createElement("div");
      q.style.margin = "10px 0";
      q.innerHTML = `<div style="font-size:18px">${escapeHtml(it.question || "")}</div>`;
      card.appendChild(q);

      let detailsEl = null;
      const makeDetails = () => {
        const details = document.createElement("details");
        const sum = document.createElement("summary");
        sum.textContent = t("Show Answer / Explanation", "إظهار الجواب / الشرح", "Cevap / Açıklama");
        details.appendChild(sum);

        const a = document.createElement("div");
        a.style.marginTop = "8px";
        const shortAns = _shortenText(it.answer || "NOT_IN_SOURCES", 140);
        const shortExp = _shortenText(it.explanation || "", 220);
        a.innerHTML = `
          <div><b>Answer:</b> ${escapeHtml(shortAns)}</div>
          <div style="margin-top:6px"><b>Explanation:</b> ${escapeHtml(shortExp)}</div>
          <div style="margin-top:6px"><b>Citations:</b> ${escapeHtml((it.citations || []).join(", "))}</div>
        `;
        details.appendChild(a);

        const shouldHideDetails = examOn || !showKey;
        details.style.display = shouldHideDetails ? "none" : "";
        details.open = !!showKey && !examOn;
        detailsEl = details;
        card.appendChild(details);
      };

      const isMcq =
        (it.type || "").toLowerCase() === "mcq" &&
        Array.isArray(it.choices) &&
        it.choices.length >= 2;
      if (isMcq) {
        const correctLetter = normalizeAnswerLetter(it.answer);
        const answerIsMissing = !correctLetter || String(it.answer || "").trim() === "NOT_IN_SOURCES";

        const hint = document.createElement("div");
        hint.className = "mcq-feedback muted";
        hint.textContent = t(
          "Pick one answer (one attempt).",
          "اختر إجابة واحدة (محاولة واحدة).",
          "Bir cevap seç (tek deneme)."
        );
        card.appendChild(hint);

        it.choices.forEach((ch, i) => {
          const letter = getChoiceLetter(ch, i);

          const line = document.createElement("label");
          line.className = "mcq-choice";
          line.dataset.letter = letter;
          line.innerHTML = `<input type="radio" name="q_${idx}" /> ${escapeHtml(ch)}`;

          const input = line.querySelector("input");
          input.addEventListener("change", () => {
            if (examFinished) return;
            if (card.dataset.locked === "1") return;
            card.dataset.locked = "1";

            // lock all options (one click only)
            card.querySelectorAll(`input[name="q_${idx}"]`).forEach(x => { x.disabled = true; });

            if (answerIsMissing) {
              hint.textContent = t(
                "No supported answer in sources (NOT_IN_SOURCES).",
                "لا يوجد جواب مدعوم في المصادر (NOT_IN_SOURCES).",
                "Kaynaklarda destekli cevap yok (NOT_IN_SOURCES)."
              );
              if (detailsEl) {
                detailsEl.style.display = "";
                detailsEl.open = true;
              }
              return;
            }

            // highlight correct + selected
            const selectedLetter = letter;
            card.querySelectorAll(".mcq-choice").forEach(l => {
              const ltr = (l.dataset.letter || "").toUpperCase();
              if (ltr === correctLetter) l.classList.add("correct");
              if (ltr === selectedLetter && selectedLetter !== correctLetter) l.classList.add("wrong");
            });

            const ok = selectedLetter === correctLetter;
            hint.textContent = ok
              ? t("✅ Correct.", "✅ صح.", "✅ Doğru.")
              : t(
                  `❌ Wrong. Correct: ${correctLetter}.`,
                  `❌ غلط. الصحيح: ${correctLetter}.`,
                  `❌ Yanlış. Doğru: ${correctLetter}.`
                );

            if (examOn) {
              score.answered += 1;
              if (ok) score.correct += 1;
              updateScoreUI();
            }

            if (detailsEl) {
              detailsEl.style.display = "";
              detailsEl.open = true;
            }
          });

          card.appendChild(line);
        });

        makeDetails();
      } else {
        // If model claims MCQ but did not provide choices, show a warning.
        if ((it.type || "").toLowerCase() === "mcq") {
          const warn = document.createElement("div");
          warn.className = "mcq-feedback muted";
          warn.textContent = t(
            "⚠️ MCQ returned without valid choices.",
            "⚠️ سؤال MCQ بدون خيارات صالحة.",
            "⚠️ Seçenekleri eksik MCQ döndü."
          );
          card.appendChild(warn);
        }

        // SHORT self-test UI
        const note = document.createElement("div");
        note.className = "muted";
        note.innerHTML = `<i>${escapeHtml(t("Short answer question", "سؤال إجابة قصيرة", "Kısa cevap sorusu"))}</i>`;
        card.appendChild(note);

        const inputWrap = document.createElement("div");
        inputWrap.className = "short-wrap";

        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "short-input";
        inp.placeholder = t("Type your answer…", "اكتب جوابك…", "Cevabını yaz…");

        const btn = document.createElement("button");
        btn.className = "short-check";
        btn.textContent = t("Check", "تحقّق", "Kontrol");

        const fb = document.createElement("div");
        fb.className = "mcq-feedback muted";
        fb.textContent = t(
          "Answer once to reveal explanation.",
          "جاوب مرة واحدة ليظهر الشرح.",
          "Açıklama için bir kez cevapla."
        );

        btn.addEventListener("click", () => {
          if (examFinished) return;
          if (card.dataset.locked === "1") return;
          card.dataset.locked = "1";
          inp.disabled = true;
          btn.disabled = true;

          const expected = String(it.answer || "").trim();
          const userAns = String(inp.value || "").trim();

          if (!expected || expected === "NOT_IN_SOURCES") {
            fb.textContent = t(
              "No supported answer in sources (NOT_IN_SOURCES).",
              "لا يوجد جواب مدعوم في المصادر (NOT_IN_SOURCES).",
              "Kaynaklarda destekli cevap yok (NOT_IN_SOURCES)."
            );
            if (detailsEl) { detailsEl.style.display = ""; detailsEl.open = true; }
            return;
          }

          const minMatch = 3;
          const res = _keywordMatch(userAns, expected);
          const ok = res.ok;

          fb.textContent = ok
            ? t(
                `✅ Correct. Matched ${res.matchedCount} words.`,
                `✅ صح. طابقت ${res.matchedCount} كلمات.`,
                `✅ Doğru. ${res.matchedCount} kelime eşleşti.`
              )
            : t(
                `❌ Wrong. Matched ${res.matchedCount}/${minMatch} words (need ≥ ${minMatch}).`,
                `❌ غلط. طابقت ${res.matchedCount}/${minMatch} كلمات (يلزم ≥ ${minMatch}).`,
                `❌ Yanlış. ${res.matchedCount}/${minMatch} kelime eşleşti (≥ ${minMatch} gerekli).`
              );

          fb.textContent = ok
            ? (
                res.exact
                  ? t(
                      "✅ Correct.",
                      "✅ صح.",
                      "✅ Doğru."
                    )
                  : t(
                      `✅ Correct. Matched ${res.matchedCount} words.`,
                      `✅ صح. طابقت ${res.matchedCount} كلمات.`,
                      `✅ Doğru. ${res.matchedCount} kelime eşleşti.`
                    )
              )
            : t(
                `❌ Wrong. Matched ${res.matchedCount}/${res.required} words (need ≥ ${res.required}).`,
                `❌ غلط. طابقت ${res.matchedCount}/${res.required} كلمات (يلزم ≥ ${res.required}).`,
                `❌ Yanlış. ${res.matchedCount}/${res.required} kelime eşleşti (≥ ${res.required} gerekli).`
              );

          if (!ok && res.matchedWords.length) {
            fb.textContent += t(
              ` Matched: ${res.matchedWords.join(", ")}`,
              ` الكلمات المطابقة: ${res.matchedWords.join(", ")}`,
              ` Eşleşenler: ${res.matchedWords.join(", ")}`
            );
          }

          if (examOn) {
            score.answered += 1;
            if (ok) score.correct += 1;
            updateScoreUI();
          }

          if (detailsEl) { detailsEl.style.display = ""; detailsEl.open = true; }
        });

        inputWrap.appendChild(inp);
        inputWrap.appendChild(btn);
        card.appendChild(inputWrap);
        card.appendChild(fb);

        makeDetails();
      }

      container.appendChild(card);
    });
    return;
  }

  if (jsonObj && Array.isArray(jsonObj.cards)) {
    jsonObj.cards.forEach((c, idx) => {
      const card = document.createElement("div");
      card.style.border = "1px solid #ddd";
      card.style.padding = "12px";
      card.style.margin = "10px 0";
      card.style.borderRadius = "10px";
      card.innerHTML = `
        <div><b>Card ${idx + 1}</b></div>
        <div style="margin-top:8px"><b>Term:</b> ${escapeHtml(c.term || "")}</div>
        <div style="margin-top:6px"><b>Definition:</b> ${escapeHtml(c.definition || "")}</div>
        <div style="margin-top:6px"><b>Example:</b> ${escapeHtml(c.example || "")}</div>
        <div style="margin-top:6px"><b>Citations:</b> ${escapeHtml((c.citations || []).join(", "))}</div>
      `;
      container.appendChild(card);
    });
    return;
  }

  container.innerHTML = `<pre>${escapeHtml(JSON.stringify(jsonObj, null, 2))}</pre>`;
}

let sessionId = localStorage.getItem("session_id") || "local";

function withSession(headers = {}) {
  return { ...headers, "X-Session-Id": sessionId };
}

async function apiFetch(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  return fetch(`${API_BASE}${path}`, { ...options, headers: withSession(headers) });
}

function buildErrorMessage(data, fallback = "Request failed") {
  if (data && typeof data === "object") {
    if (data.details) return `${data.error || fallback}: ${data.details}`;
    if (data.error) return data.error;
  }
  return fallback;
}

async function apiFetchJson(path, options = {}) {
  const res = await apiFetch(path, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(buildErrorMessage(data, `HTTP ${res.status}`));
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

window.addEventListener("DOMContentLoaded", () => {
  const taskEl = document.getElementById("task");
  const nEl = document.getElementById("n");
  const viewEl = document.getElementById("view");
  const queryEl = document.getElementById("query");
  const focusEl = document.getElementById("focus") || document.getElementById("focusQuery") || queryEl;
  const strictFocusEl = document.getElementById("strictFocus");
  const modeEl = document.getElementById("mode");
  const shuffleChoicesEl = document.getElementById("shuffleChoices");
  const showAnswerKeyEl = document.getElementById("showAnswerKey");
  const examModeEl = document.getElementById("examMode");
  scoreBoxEl = document.getElementById("scoreBox");
  const resetScoreBtn = document.getElementById("resetScore");
  const finishExamBtn = document.getElementById("finishExam");
  const printBtn = document.getElementById("printExam");
  const langEl = document.getElementById("lang");
  const diffEl = document.getElementById("difficulty");

  const outPretty = document.getElementById("outPretty");
  const outRaw = document.getElementById("outRaw");
  const statusEl = document.getElementById("status");

  const goBtn = document.getElementById("go");
  const copyBtn = document.getElementById("copy");
  const downloadSelect = document.getElementById("downloadSelect");
  const downloadDropdown = document.getElementById("downloadDropdown");
  const downloadMenuBtn = document.getElementById("downloadMenuBtn");
  const downloadMenu = document.getElementById("downloadMenu");
  const downloadTxtBtn = document.getElementById("downloadTxtBtn");
  const downloadJsonBtn = document.getElementById("downloadJsonBtn");
  const downloadCsvBtn = document.getElementById("downloadCsvBtn");

  const sourcesListEl = document.getElementById("sourcesList");
  const selectedInfoEl = document.getElementById("selectedInfo");
  const selectedPillsEl = document.getElementById("selectedPills");
  const retrievedBoxEl = document.getElementById("retrievedBox");

  const refreshBtn = document.getElementById("refreshSources");
  const clearBtn = document.getElementById("clearSources");

  const fileEl = document.getElementById("file");

  const manualNameEl = document.getElementById("manualName");
  const manualIdEl = document.getElementById("manualId");
  const manualTextEl = document.getElementById("manualText");

  const newSessionBtn = document.getElementById("newSession");
  const sessionListEl = document.getElementById("sessionList");
  const sessionCountEl = document.getElementById("sessionCount");
  const sessionArchiveHintEl = document.getElementById("sessionArchiveHint");
  const currentSessionLabelEl = document.getElementById("currentSessionLabel");
  const sidebarEl = document.getElementById("workspaceSidebar");
  const sidebarBackdropEl = document.getElementById("sidebarBackdrop");
  const sidebarToggleBtn = document.getElementById("sidebarToggle");
  const sidebarCloseBtn = document.getElementById("sidebarClose");
  const modalEl = document.getElementById("appModal");
  const modalCloseBtn = document.getElementById("modalClose");
  const modalTitleEl = document.getElementById("modalTitle");
  const modalMessageEl = document.getElementById("modalMessage");
  const modalFieldWrapEl = document.getElementById("modalFieldWrap");
  const modalInputLabelEl = document.getElementById("modalInputLabel");
  const modalInputEl = document.getElementById("modalInput");
  const modalHelpEl = document.getElementById("modalHelp");
  const modalErrorEl = document.getElementById("modalError");
  const modalCancelBtn = document.getElementById("modalCancel");
  const modalConfirmBtn = document.getElementById("modalConfirm");
  const themeBtn = document.getElementById("themeToggle");

  let lastRaw = "";
  let selected = loadSelected();
  let sessionsCache = [];
  let modalState = null;

  function syncOutputView() {
    const rawMode = viewEl && viewEl.value === "raw";
    if (outPretty) outPretty.style.display = rawMode ? "none" : "";
    if (outRaw) outRaw.style.display = rawMode ? "block" : "none";
  }

  function showRawOutput(text) {
    if (outPretty) outPretty.style.display = "none";
    if (outRaw) outRaw.style.display = "block";
    setText(outRaw, text);
  }

  function closeDownloadMenu() {
    if (!downloadMenu || !downloadMenuBtn) return;
    downloadMenu.classList.remove("open");
    downloadMenuBtn.setAttribute("aria-expanded", "false");
  }

  function closeCustomSelectMenus(exceptMenu = null) {
    document.querySelectorAll(".custom-select-menu.open").forEach((menu) => {
      if (exceptMenu && menu === exceptMenu) return;
      menu.classList.remove("open");
    });

    document.querySelectorAll(".custom-select-toggle[aria-expanded='true']").forEach((btn) => {
      if (exceptMenu && btn.nextElementSibling === exceptMenu) return;
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function closeSessionActionMenus(exceptMenu = null) {
    document.querySelectorAll(".session-actions-menu.open").forEach((menu) => {
      if (exceptMenu && menu === exceptMenu) return;
      menu.classList.remove("open");
    });

    document.querySelectorAll(".session-item-trigger[aria-expanded='true']").forEach((btn) => {
      if (exceptMenu && btn.nextElementSibling === exceptMenu) return;
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function openSidebar() {
    if (!sidebarEl || !sidebarBackdropEl) return;
    sidebarEl.classList.add("open");
    sidebarBackdropEl.classList.add("open");
    document.body.classList.add("sidebar-open");
  }

  function closeSidebar() {
    if (!sidebarEl || !sidebarBackdropEl) return;
    sidebarEl.classList.remove("open");
    sidebarBackdropEl.classList.remove("open");
    document.body.classList.remove("sidebar-open");
  }

  function setModalError(message = "") {
    if (!modalErrorEl) return;
    modalErrorEl.textContent = message;
    modalErrorEl.hidden = !message;
  }

  function closeModal(result = { confirmed: false, value: "" }) {
    if (!modalState || !modalEl) return;

    const resolve = modalState.resolve;
    modalState = null;
    modalEl.hidden = true;
    modalEl.classList.remove("open");
    modalEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    modalConfirmBtn?.classList.remove("button-danger");
    setModalError("");

    if (resolve) resolve(result);
  }

  function confirmModalAction() {
    if (!modalState) return;

    const inputConfig = modalState.inputConfig;
    const value = String(modalInputEl?.value || "").trim();

    if (inputConfig) {
      if (inputConfig.required && !value) {
        setModalError(inputConfig.requiredMessage || "This field is required.");
        modalInputEl?.focus();
        return;
      }

      if (typeof inputConfig.validate === "function") {
        const error = inputConfig.validate(value);
        if (error) {
          setModalError(error);
          modalInputEl?.focus();
          return;
        }
      }
    }

    closeModal({ confirmed: true, value });
  }

  function openModal({
    title,
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    input = null
  }) {
    if (!modalEl) return Promise.resolve({ confirmed: false, value: "" });

    if (modalState) closeModal();

    closeDownloadMenu();
    closeCustomSelectMenus();
    closeSessionActionMenus();

    modalTitleEl.textContent = title || "Confirm";
    modalMessageEl.textContent = message || "";
    modalMessageEl.hidden = !message;
    modalCancelBtn.textContent = cancelLabel;
    modalConfirmBtn.textContent = confirmLabel;
    modalConfirmBtn.classList.toggle("button-danger", !!danger);

    setModalError("");

    if (input) {
      modalFieldWrapEl.hidden = false;
      modalInputLabelEl.textContent = input.label || "Value";
      modalInputEl.value = input.value || "";
      modalInputEl.placeholder = input.placeholder || "";
      modalInputEl.maxLength = input.maxLength || 200;
      modalHelpEl.textContent = input.help || "";
      modalHelpEl.hidden = !modalHelpEl.textContent;
    } else {
      modalFieldWrapEl.hidden = true;
      modalInputEl.value = "";
      modalHelpEl.textContent = "";
      modalHelpEl.hidden = true;
    }

    modalEl.hidden = false;
    modalEl.classList.add("open");
    modalEl.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    return new Promise((resolve) => {
      modalState = {
        resolve,
        inputConfig: input
      };

      window.setTimeout(() => {
        if (input) modalInputEl?.focus();
        else modalConfirmBtn?.focus();
      }, 0);
    });
  }

  function getSessionDisplayName(session) {
    const raw = String(session?.name || session?.session_id || "").trim();
    if (!raw) return "Untitled chat";
    return raw;
  }

  function syncCurrentSessionLabel() {
    if (!currentSessionLabelEl) return;
    const current = sessionsCache.find((session) => session.session_id === sessionId);
    currentSessionLabelEl.textContent = getSessionDisplayName(current || { session_id: sessionId });
  }

  function renderSessionList() {
    if (!sessionListEl) return;

    sessionListEl.innerHTML = "";

    if (sessionCountEl) sessionCountEl.textContent = String(sessionsCache.length);

    const savedCount = sessionsCache.filter((session) => session.session_id !== "local").length;
    if (sessionArchiveHintEl) {
      sessionArchiveHintEl.textContent = savedCount
        ? ""
        : "No saved conversations yet. Create one to start your archive.";
    }

    if (!sessionsCache.length) {
      const empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = "No conversations found.";
      sessionListEl.appendChild(empty);
      return;
    }

    sessionsCache.forEach((session) => {
      const item = document.createElement("div");
      item.className = "session-item";
      if (session.session_id === sessionId) item.classList.add("active");

      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "session-item-main";
      mainBtn.setAttribute("aria-current", session.session_id === sessionId ? "true" : "false");

      const title = document.createElement("span");
      title.className = "session-item-title";
      title.textContent = getSessionDisplayName(session);

      const meta = document.createElement("span");
      meta.className = "session-item-meta";
      meta.textContent = session.session_id === "local" ? "Local default session" : session.session_id;

      mainBtn.appendChild(title);
      mainBtn.appendChild(meta);
      mainBtn.addEventListener("click", async () => {
        closeSessionActionMenus();
        if (session.session_id === sessionId) {
          closeSidebar();
          return;
        }

        sessionId = session.session_id;
        localStorage.setItem("session_id", sessionId);
        selected.clear();
        saveSelected(selected);
        updateSelectedInfo();
        syncCurrentSessionLabel();
        closeSidebar();
        await loadSessions();
        await refreshSources();
      });

      const actions = document.createElement("div");
      actions.className = "session-actions";

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "icon-only session-item-trigger";
      trigger.setAttribute("aria-haspopup", "true");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("title", `Actions for ${session.session_id}`);
      trigger.textContent = "...";

      const menu = document.createElement("div");
      menu.className = "session-actions-menu";

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "session-menu-item";
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", async () => {
        closeSessionActionMenus();

        const result = await openModal({
          title: "Rename conversation",
          message: `Rename "${session.session_id}".`,
          confirmLabel: "Save",
          input: {
            label: "Session ID",
            value: session.session_id,
            placeholder: "letters, numbers, _ or -",
            help: "Use 1-40 letters, numbers, underscores, or hyphens.",
            required: true,
            requiredMessage: "Session ID is required.",
            validate: (value) => (
              SESSION_ID_RE.test(value)
                ? ""
                : "Use 1-40 letters, numbers, underscores, or hyphens only."
            )
          }
        });

        if (!result.confirmed) return;

        try {
          await apiFetchJson("/sessions/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: session.session_id, to: result.value })
          });

          if (session.session_id === sessionId) {
            sessionId = result.value;
            localStorage.setItem("session_id", sessionId);
            syncCurrentSessionLabel();
          }

          setText(statusEl, `Session renamed to: ${result.value}`);
          await loadSessions();
          if (session.session_id === sessionId || result.value === sessionId) {
            await refreshSources();
          }
        } catch (e) {
          setText(statusEl, `Rename failed: ${e.message}`);
        }
      });

      menu.appendChild(renameBtn);

      if (session.session_id !== "local") {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "session-menu-item danger";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
          closeSessionActionMenus();

          const result = await openModal({
            title: "Delete conversation",
            message: `Delete "${session.session_id}" and all of its sources? This cannot be undone.`,
            confirmLabel: "Delete",
            danger: true
          });

          if (!result.confirmed) return;

          try {
            await apiFetchJson(`/sessions/${encodeURIComponent(session.session_id)}`, {
              method: "DELETE"
            });

            const wasCurrent = session.session_id === sessionId;
            if (wasCurrent) {
              sessionId = "local";
              localStorage.setItem("session_id", sessionId);
              selected.clear();
              saveSelected(selected);
              updateSelectedInfo();
              syncCurrentSessionLabel();
            }

            setText(statusEl, `Session deleted: ${session.session_id}`);
            await loadSessions();
            if (wasCurrent) await refreshSources();
          } catch (e) {
            setText(statusEl, `Delete session failed: ${e.message}`);
          }
        });

        menu.appendChild(deleteBtn);
      }

      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDownloadMenu();
        closeCustomSelectMenus();
        const willOpen = !menu.classList.contains("open");
        closeSessionActionMenus();
        menu.classList.toggle("open", willOpen);
        trigger.setAttribute("aria-expanded", String(willOpen));
      });

      actions.appendChild(trigger);
      actions.appendChild(menu);

      item.appendChild(mainBtn);
      item.appendChild(actions);
      sessionListEl.appendChild(item);
    });

    syncCurrentSessionLabel();
  }

  function enhanceSelect(selectEl) {
    if (!selectEl || selectEl.dataset.customized === "1") return;

    const shell = selectEl.closest(".select-shell");
    if (!shell) return;

    selectEl.dataset.customized = "1";
    shell.classList.add("select-shell-custom");
    selectEl.classList.add("native-select-hidden");

    const custom = document.createElement("div");
    custom.className = "custom-select";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dropdown-toggle custom-select-toggle";
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "custom-select-label";

    const arrow = document.createElement("span");
    arrow.className = "mini-arrow";
    arrow.textContent = "⌄";

    toggle.appendChild(label);
    toggle.appendChild(arrow);

    const menu = document.createElement("div");
    menu.className = "dropdown-menu custom-select-menu";

    const items = [];

    Array.from(selectEl.options).forEach((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dropdown-item custom-select-item";
      item.textContent = opt.textContent;
      item.dataset.value = opt.value;

      item.addEventListener("click", () => {
        selectEl.value = opt.value;
        syncFromSelect();
        closeCustomSelectMenus();
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      });

      menu.appendChild(item);
      items.push(item);
    });

    function syncFromSelect() {
      const current = selectEl.options[selectEl.selectedIndex];
      label.textContent = current ? current.textContent : "";

      items.forEach((item) => {
        const isSelected = item.dataset.value === selectEl.value;
        item.classList.toggle("selected", isSelected);
        item.setAttribute("aria-current", isSelected ? "true" : "false");
      });
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDownloadMenu();
      closeSessionActionMenus();

      const willOpen = !menu.classList.contains("open");
      closeCustomSelectMenus();
      menu.classList.toggle("open", willOpen);
      toggle.setAttribute("aria-expanded", String(willOpen));
    });

    selectEl.addEventListener("change", syncFromSelect);

    custom.appendChild(toggle);
    custom.appendChild(menu);
    shell.appendChild(custom);

    syncFromSelect();
  }

  function rerenderLastPretty() {
    if (!lastRaw || viewEl.value === "raw") return;

    try {
      const parsed = JSON.parse(lastRaw);
      const examOn = !!(examModeEl && examModeEl.checked);
      const showKey = !!(showAnswerKeyEl && showAnswerKeyEl.checked) && !examOn;
      renderPretty(outPretty, parsed, { showKey, examOn });
    } catch {
      // ignore rerender errors
    }
  }

  syncOutputView();
  document.querySelectorAll('select[data-custom-select="true"]').forEach(enhanceSelect);

  document.addEventListener("click", () => {
    closeCustomSelectMenus();
    closeSessionActionMenus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modalState) {
        closeModal();
        return;
      }

      closeCustomSelectMenus();
      closeSessionActionMenus();
      closeDownloadMenu();
      closeSidebar();
    }
  });

  sidebarToggleBtn?.addEventListener("click", () => {
    openSidebar();
  });

  sidebarCloseBtn?.addEventListener("click", () => {
    closeSidebar();
  });

  sidebarBackdropEl?.addEventListener("click", () => {
    closeSidebar();
  });

  modalCancelBtn?.addEventListener("click", () => {
    closeModal();
  });

  modalCloseBtn?.addEventListener("click", () => {
    closeModal();
  });

  modalEl?.addEventListener("click", (e) => {
    if (e.target?.dataset?.modalClose === "true") closeModal();
  });

  modalConfirmBtn?.addEventListener("click", () => {
    confirmModalAction();
  });

  modalInputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmModalAction();
    }
  });

  if (resetScoreBtn) resetScoreBtn.addEventListener("click", resetScore);
  if (finishExamBtn) finishExamBtn.addEventListener("click", finishExam);

  if (examModeEl) {
    examModeEl.addEventListener("change", () => {
      const on = !!examModeEl.checked;

      // Exam mode = hide answer key + show score
      if (showAnswerKeyEl) {
        showAnswerKeyEl.checked = !on ? showAnswerKeyEl.checked : false;
        showAnswerKeyEl.disabled = on;
      }
      if (scoreBoxEl) scoreBoxEl.style.display = on ? "" : "none";
      if (resetScoreBtn) resetScoreBtn.style.display = on ? "" : "none";
      if (finishExamBtn) finishExamBtn.style.display = on ? "" : "none";
      examFinished = false;
      updateScoreUI();
      rerenderLastPretty();
    });
  }

  if (showAnswerKeyEl) {
    showAnswerKeyEl.addEventListener("change", rerenderLastPretty);
  }

  if (viewEl) {
    viewEl.addEventListener("change", () => {
      syncOutputView();
      if (!lastRaw) return;

      if (viewEl.value === "raw") {
        setText(outRaw, lastRaw);
        return;
      }

      try {
        const parsed = JSON.parse(lastRaw);
        const examOn = !!(examModeEl && examModeEl.checked);
        const showKey = !!(showAnswerKeyEl && showAnswerKeyEl.checked) && !examOn;
        setText(outRaw, "");
        renderPretty(outPretty, parsed, { showKey, examOn });
      } catch {
        showRawOutput(lastRaw);
      }
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if (document.body) document.body.setAttribute("data-theme", theme);
    if (themeBtn) themeBtn.textContent = theme === "dark" ? "Light" : "Dark";
  }

  const savedTheme = localStorage.getItem("theme") || "light";
  applyTheme(savedTheme);
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      const next = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      localStorage.setItem("theme", next);
    });
  }

  function updateSelectedInfo() {
    const arr = Array.from(selected);
    selectedInfoEl.textContent = arr.length ? `Selected sources: ${arr.join(", ")}` : "No sources selected.";
    renderSelectedPills();
  }

  function renderSelectedPills() {
    if (!selectedPillsEl) return;
    selectedPillsEl.innerHTML = "";
    const arr = Array.from(selected);

    if (!arr.length) {
      selectedPillsEl.innerHTML = `<span class="muted">(none)</span>`;
      return;
    }

    arr.forEach((sid) => {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.innerHTML = `<b>${escapeHtml(sid)}</b>`;

      const x = document.createElement("button");
      x.textContent = "x";
      x.title = "Unselect";
      x.onclick = () => {
        selected.delete(sid);
        saveSelected(selected);
        updateSelectedInfo();
        refreshSources();
      };

      pill.appendChild(x);
      selectedPillsEl.appendChild(pill);
    });
  }

  async function refreshSources() {
    sourcesListEl.innerHTML = "Loading...";
    try {
      const res = await apiFetch("/sources", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        sourcesListEl.innerHTML = `<div style="color:#b00">Error loading sources: ${escapeHtml(JSON.stringify(data))}</div>`;
        return;
      }

      const list = data.sources || [];
      sourcesListEl.innerHTML = "";

      if (list.length === 0) {
        sourcesListEl.innerHTML = `<div class="muted">No stored sources yet. Upload a file or add manual text.</div>`;
        updateSelectedInfo();
        return;
      }

      list.forEach((s) => {
        const row = document.createElement("div");
        row.className = "item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(s.source_id);
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(s.source_id);
          else selected.delete(s.source_id);
          saveSelected(selected);
          updateSelectedInfo();
        });

        const label = document.createElement("div");
        const statusColor = (s.status === "ready") ? "green" : (s.status === "failed" ? "#b00" : "#c90");
        const prog = (s.pages_total && s.pages_total > 0)
          ? ` (${s.pages_done || 0}/${s.pages_total})`
          : "";
        const detailHtml = (s.status === "failed" && s.detail)
          ? `<div class="muted" style="margin-top:6px;color:#ff8c9a">${escapeHtml(s.detail)}</div>`
          : "";

        label.innerHTML = `
          <div>
            <b>${escapeHtml(s.source_id)}</b>
            <span class="muted">${escapeHtml(s.name || "")}</span>
            <span style="margin-left:8px;font-size:12px;color:${statusColor}">
              ${escapeHtml((s.status || "pending") + prog)}
            </span>
            ${detailHtml}
          </div>
        `;

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", async () => {
          const result = await openModal({
            title: "Delete source",
            message: `Delete source "${s.source_id}" from the current session?`,
            confirmLabel: "Delete",
            danger: true
          });
          if (!result.confirmed) return;

          setText(statusEl, "Deleting...");

          try {
            await apiFetchJson(`/sources/${encodeURIComponent(s.source_id)}`, {
              method: "DELETE"
            });

            selected.delete(s.source_id);
            saveSelected(selected);
            updateSelectedInfo();
            setText(statusEl, `Deleted: ${s.source_id}`);
            await refreshSources();
          } catch (e) {
            setText(statusEl, `Delete failed: ${e.message}`);
          }
        });

        row.appendChild(cb);
        row.appendChild(label);
        row.appendChild(delBtn);

        sourcesListEl.appendChild(row);
      });

      updateSelectedInfo();
      renderSelectedPills();

      if (window._pollTimer) clearTimeout(window._pollTimer);
      const hasPending = (list || []).some(s => s.status === "pending");
      if (hasPending) {
        window._pollTimer = setTimeout(refreshSources, 1500);
      }
    } catch (e) {
      sourcesListEl.innerHTML = `<div style="color:#b00">Failed to fetch /sources: ${escapeHtml(String(e))}</div>`;
    }
  }

  async function loadSessions() {
    try {
      const data = await apiFetchJson("/sessions", { method: "GET" });
      const seen = new Set();
      const list = [];

      (data.sessions || []).forEach((session) => {
        const id = String(session.session_id || "").trim();
        if (!id || seen.has(id)) return;

        seen.add(id);
        list.push({
          session_id: id,
          name: String(session.name || id).trim() || id,
          created_at: session.created_at || 0,
          updated_at: session.updated_at || 0
        });
      });

      if (!seen.has("local")) {
        list.push({
          session_id: "local",
          name: "Local chat",
          created_at: 0,
          updated_at: 0
        });
      }

      if (!seen.has(sessionId)) {
        list.unshift({
          session_id: sessionId,
          name: sessionId === "local" ? "Local chat" : sessionId,
          created_at: 0,
          updated_at: 0
        });
      }

      sessionsCache = list;
      renderSessionList();
    } catch (e) {
      sessionsCache = [
        {
          session_id: sessionId,
          name: sessionId === "local" ? "Local chat" : sessionId,
          created_at: 0,
          updated_at: 0
        }
      ];
      renderSessionList();
      setText(statusEl, `Load sessions failed: ${e.message}`);
    }
  }

  async function addManualSource() {
    const name = (manualNameEl.value || "").trim();
    const sourceId = (manualIdEl.value || "").trim();
    const text = (manualTextEl.value || "").trim();

    if (!text) {
      setText(statusEl, "Please enter manual source text first.");
      return;
    }

    if (sourceId && !/^S\d+$/.test(sourceId)) {
      setText(statusEl, "Source ID must look like S1, S2, S3...");
      return;
    }

    setText(statusEl, "Adding manual source...");
    try {
      const body = { text };
      if (name) body.name = name;
      if (sourceId) body.source_id = sourceId;

      const r = await apiFetch("/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Add manual source failed");

      const newId = data.source_id;
      selected.add(newId);
      saveSelected(selected);
      updateSelectedInfo();

      manualNameEl.value = "";
      manualIdEl.value = "";
      manualTextEl.value = "";

      setText(statusEl, `Manual source added: ${newId}`);
      await refreshSources();

    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      setText(statusEl, `Manual source failed: ${msg}`);
    }
  }

  async function runGenerate() {
    setText(statusEl, "Loading...");
    outPretty.innerHTML = "";
    setText(outRaw, "");
    lastRaw = "";
    syncOutputView();

    const sourceIds = Array.from(selected);

    const payload = {
      task_type: taskEl.value,
      n: Number(nEl.value || 5),
      source_ids: sourceIds,
      language: (langEl.value || "en"),
      difficulty: (diffEl.value || "medium"),
      mode: modeEl ? modeEl.value : "mixed",
      shuffle_choices: !!(shuffleChoicesEl && shuffleChoicesEl.checked)
    };

    const q = (focusEl && focusEl.value ? focusEl.value : "").trim();
    if (q) {
      payload.focus_query = q;
      payload.strict_focus = !!(strictFocusEl && strictFocusEl.checked);
    }

    if (sourceIds.length === 0) {
      setText(statusEl, "Please select at least one source first.");
      return;
    }

    try {
      const res = await apiFetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        lastRaw = JSON.stringify(data, null, 2);
        const errMsg =
          (data && data.details) ? data.details :
          (data && data.error) ? data.error :
          `HTTP ${res.status}`;
        setText(statusEl, `Error ❌ (${res.status}) ${errMsg}`);
        if (res.status === 413 && data && data.error === "SOURCES_TOO_LARGE") {
          setText(statusEl, "Sources too large ❌ (reduce selected sources/pages)");
        }
        if (res.status === 409 && data && data.error === "SOURCES_NOT_INDEXED") {
          setText(statusEl, "Indexing not finished ❌ (wait until sources become ready)");
        }
        setText(outRaw, lastRaw);
        outPretty.innerHTML = "";
        return;
      }

      lastRaw = data.output || "";
      setText(statusEl, "Done ?");
      if (retrievedBoxEl) {
        const r = data.retrieved || [];
        retrievedBoxEl.textContent = r.length
          ? ("Retrieved: " + r.map(x => x.citation).join(", "))
          : "";
      }

      if (viewEl.value === "raw") {
        syncOutputView();
        setText(outRaw, lastRaw);
        outPretty.innerHTML = "";
        return;
      }

      try {
        const parsed = JSON.parse(lastRaw);
        setText(outRaw, "");
        const examOn = !!(examModeEl && examModeEl.checked);
        const showKey = !!(showAnswerKeyEl && showAnswerKeyEl.checked) && !examOn;

        score.total = Array.isArray(parsed.items) ? parsed.items.length : 0;
        score.correct = 0;
        score.answered = 0;
        examFinished = false;
        const banner = document.getElementById("finalBanner");
        if (banner) banner.remove();
        updateScoreUI();

        renderPretty(outPretty, parsed, { showKey, examOn });
        syncOutputView();
      } catch {
        outPretty.innerHTML = "";
        showRawOutput(lastRaw);
      }

    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      setText(statusEl, `ERROR: ${msg}`);
      showRawOutput(`ERROR: ${msg}`);
    }
  }

  fileEl.addEventListener("change", async () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;

    setText(statusEl, `Uploading ${f.name} ...`);

    try {
      const fd = new FormData();
      fd.append("file", f);

      const data = await apiFetchJson("/upload", {
        method: "POST",
        body: fd
      });

      const newId = data.source_id;
      if (newId) {
        selected.add(newId);
        saveSelected(selected);
        updateSelectedInfo();
      }

      fileEl.value = "";
      setText(statusEl, `Uploaded: ${newId || f.name}`);
      await refreshSources();
    } catch (e) {
      fileEl.value = "";
      setText(statusEl, `Upload failed: ${e.message}`);
    }
  });

  goBtn.addEventListener("click", runGenerate);

  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lastRaw || ""); alert("Copied ?"); }
    catch (e) { alert("Copy failed: " + ((e && e.message) ? e.message : e)); }
  });

  if (downloadSelect) {
    downloadSelect.addEventListener("change", () => {
      const val = downloadSelect.value;

      if (val === "txt") {
        downloadTxtBtn?.click();
      } else if (val === "json") {
        downloadJsonBtn?.click();
      } else if (val === "csv") {
        downloadCsvBtn?.click();
      }

      downloadSelect.value = "";
    });
  }

  if (downloadMenuBtn && downloadMenu && downloadDropdown) {
    downloadMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeCustomSelectMenus();
      closeSessionActionMenus();
      const isOpen = downloadMenu.classList.toggle("open");
      downloadMenuBtn.setAttribute("aria-expanded", String(isOpen));
    });

    document.addEventListener("click", (e) => {
      if (!downloadDropdown.contains(e.target)) {
        closeDownloadMenu();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeDownloadMenu();
      }
    });
  }

  downloadTxtBtn.addEventListener("click", () => {
    closeDownloadMenu();
    downloadText("ai-output.txt", lastRaw || "");
  });

  downloadJsonBtn.addEventListener("click", () => {
    closeDownloadMenu();
    try {
      const obj = JSON.parse(lastRaw || "{}");
      downloadText("ai-output.json", JSON.stringify(obj, null, 2));
    } catch {
      downloadText("ai-output.json", JSON.stringify({ raw: lastRaw || "" }, null, 2));
    }
  });

  function toCsv(rows) {
    const esc = (v) => {
      const s = (v === null || v === undefined) ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    return rows.map(r => r.map(esc).join(",")).join("\n");
  }

  function buildCsvFromJson(obj) {
    if (obj && Array.isArray(obj.items)) {
      const rows = [["type","question","choices","answer","explanation","citations"]];
      obj.items.forEach(it => {
        rows.push([
          it.type || "",
          it.question || "",
          Array.isArray(it.choices) ? it.choices.join(" | ") : "",
          it.answer || "",
          it.explanation || "",
          Array.isArray(it.citations) ? it.citations.join(" ") : ""
        ]);
      });
      return toCsv(rows);
    }

    if (obj && Array.isArray(obj.cards)) {
      const rows = [["term","definition","example","citations"]];
      obj.cards.forEach(c => {
        rows.push([
          c.term || "",
          c.definition || "",
          c.example || "",
          Array.isArray(c.citations) ? c.citations.join(" ") : ""
        ]);
      });
      return toCsv(rows);
    }

    return toCsv([["raw"], [JSON.stringify(obj)]]);
  }

  downloadCsvBtn.addEventListener("click", () => {
    closeDownloadMenu();
    try {
      const obj = JSON.parse(lastRaw || "{}");
      const csv = buildCsvFromJson(obj);
      downloadText("ai-output.csv", csv);
    } catch {
      downloadText("ai-output.csv", "raw\n" + (lastRaw || "").replace(/\n/g, "\\n"));
    }
  });

  if (printBtn) {
    printBtn.addEventListener("click", () => window.print());
  }

  newSessionBtn?.addEventListener("click", async () => {
    const result = await openModal({
      title: "Create conversation",
      message: "Create a new conversation archive using a session ID.",
      confirmLabel: "Create",
      input: {
        label: "Session ID",
        value: "",
        placeholder: "letters, numbers, _ or -",
        help: "Use 1-40 letters, numbers, underscores, or hyphens.",
        required: true,
        requiredMessage: "Session ID is required.",
        validate: (value) => (
          SESSION_ID_RE.test(value)
            ? ""
            : "Use 1-40 letters, numbers, underscores, or hyphens only."
        )
      }
    });
    if (!result.confirmed) return;

    try {
      await apiFetchJson("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: result.value, name: result.value })
      });

      sessionId = result.value;
      localStorage.setItem("session_id", sessionId);
      selected.clear();
      saveSelected(selected);
      updateSelectedInfo();
      syncCurrentSessionLabel();
      closeSidebar();

      setText(statusEl, `Session created: ${result.value}`);
      await loadSessions();
      await refreshSources();
    } catch (e) {
      setText(statusEl, `Create session failed: ${e.message}`);
    }
  });

  refreshBtn.addEventListener("click", refreshSources);

  clearBtn.addEventListener("click", async () => {
    const result = await openModal({
      title: "Clear all sources",
      message: "Delete every source in the current session? This cannot be undone.",
      confirmLabel: "Clear all",
      danger: true
    });
    if (!result.confirmed) return;

    try {
      await apiFetchJson("/sources", { method: "DELETE" });
      selected.clear();
      saveSelected(selected);
      updateSelectedInfo();
      outPretty.innerHTML = "";
      setText(outRaw, "");
      lastRaw = "";
      if (retrievedBoxEl) retrievedBoxEl.textContent = "";
      setText(statusEl, "All sources cleared.");
      await refreshSources();
    } catch (e) {
      setText(statusEl, `Clear failed: ${e.message}`);
    }
  });

  document.getElementById("addManual").addEventListener("click", addManualSource);

  updateSelectedInfo();
  loadSessions();
  refreshSources();
});
