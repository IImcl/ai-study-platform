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
const BROWSER_ID_KEY = "ai_private_browser_id";
const SESSION_ARCHIVE_PREFIX = "ai_private_session_archive:";
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SESSION_NAME_MAX_LEN = 120;

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

function normalizeSessionTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SESSION_NAME_MAX_LEN);
}

function getSessionRawName(session) {
  return normalizeSessionTitle(session?.name ?? "");
}

function getSessionDisplayName(session) {
  const title = getSessionRawName(session);
  const fallbackId = String(session?.session_id || "").trim();
  if (title && title !== fallbackId) return title;
  return "Untitled chat";
}

function hasCustomSessionTitle(session) {
  const title = getSessionRawName(session);
  const fallbackId = String(session?.session_id || "").trim();
  return !!title && title !== fallbackId;
}

function getSessionTitleInputValue(session) {
  return hasCustomSessionTitle(session) ? getSessionRawName(session) : "";
}

function getSafeSessionId(value) {
  const id = String(value || "").trim();
  return SESSION_ID_RE.test(id) && id !== "local" ? id : "";
}

function initializeBrowserId() {
  const stored = getSafeSessionId(localStorage.getItem(BROWSER_ID_KEY));
  if (stored) return stored;

  const generated = generateSessionId();
  localStorage.setItem(BROWSER_ID_KEY, generated);
  return generated;
}

const SESSION_ARCHIVE_KEY = `${SESSION_ARCHIVE_PREFIX}${initializeBrowserId()}`;

function normalizeSessionRecord(session) {
  const id = getSafeSessionId(session?.session_id);
  if (!id) return null;

  return {
    session_id: id,
    name: normalizeSessionTitle(session?.name ?? ""),
    created_at: Number(session?.created_at || 0),
    updated_at: Number(session?.updated_at || Math.floor(Date.now() / 1000))
  };
}

function mergeSessionLists(...lists) {
  const merged = new Map();

  lists.flat().forEach((session) => {
    const next = normalizeSessionRecord(session);
    if (!next) return;

    const prev = merged.get(next.session_id);
    merged.set(next.session_id, {
      session_id: next.session_id,
      name: next.name || prev?.name || "",
      created_at: next.created_at || prev?.created_at || 0,
      updated_at: Math.max(next.updated_at || 0, prev?.updated_at || 0)
    });
  });

  return Array.from(merged.values())
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

function loadSessionArchive() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_ARCHIVE_KEY) || "[]");
    return Array.isArray(parsed) ? mergeSessionLists(parsed) : [];
  } catch {
    return [];
  }
}

function saveSessionArchive(list) {
  localStorage.setItem(SESSION_ARCHIVE_KEY, JSON.stringify(mergeSessionLists(list)));
}

function rememberSession(session) {
  const merged = mergeSessionLists(loadSessionArchive(), [session]);
  saveSessionArchive(merged);
  return merged;
}

function forgetSession(sessionIdToRemove) {
  const keep = loadSessionArchive()
    .filter((session) => session.session_id !== sessionIdToRemove);
  saveSessionArchive(keep);
  return keep;
}

function generateSessionId() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = window.crypto?.randomUUID
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
    const candidate = `chat_${token}`.slice(0, 40);
    if (SESSION_ID_RE.test(candidate)) return candidate;
  }

  return `chat_${Date.now().toString(36)}`;
}

function initializeSessionId() {
  const stored = getSafeSessionId(localStorage.getItem("session_id"));
  if (stored) {
    rememberSession({ session_id: stored });
    return stored;
  }

  const generated = generateSessionId();
  localStorage.setItem("session_id", generated);
  saveSelected(new Set());
  rememberSession({ session_id: generated });
  return generated;
}

let score = { correct: 0, answered: 0, total: 0 };
let scoreBoxEl = null;
let examTimerId = null;
let examEndsAt = 0;

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

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getExamDurationSeconds(totalQuestions) {
  const perQuestion = Math.max(1, Number(totalQuestions) || 0) * 60;
  return Math.max(5 * 60, Math.min(50 * 60, perQuestion));
}

function setExamTimerVisible(visible) {
  const el = document.getElementById("examTimer");
  if (el) el.style.display = visible ? "" : "none";
}

function setExamTimerText(text, urgent = false) {
  const el = document.getElementById("examTimer");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("urgent", urgent);
}

function stopExamTimer() {
  if (examTimerId) clearInterval(examTimerId);
  examTimerId = null;
  examEndsAt = 0;
}

function updateExamTimer() {
  if (!examEndsAt || examFinished) return;

  const remaining = Math.max(0, Math.ceil((examEndsAt - Date.now()) / 1000));
  setExamTimerText(`Time: ${formatDuration(remaining)}`, remaining <= 60);

  if (remaining <= 0) {
    finishExam("timeout");
  }
}

function startExamTimer(totalQuestions, restart = false) {
  if (examFinished) return;
  setExamTimerVisible(true);

  if (examTimerId && !restart) {
    updateExamTimer();
    return;
  }

  stopExamTimer();
  examEndsAt = Date.now() + getExamDurationSeconds(totalQuestions) * 1000;
  updateExamTimer();
  examTimerId = window.setInterval(updateExamTimer, 1000);
}

function revealFinishedExam() {
  document.querySelectorAll('[data-exam-card="1"]').forEach((card) => {
    const feedback = card.querySelector(".mcq-feedback");
    const type = card.dataset.questionType || "";

    if (type === "mcq") {
      const correctLetter = (card.dataset.correctLetter || "").toUpperCase();
      const selectedLetter = (card.dataset.selectedLetter || "").toUpperCase();
      const answerIsMissing = card.dataset.answerMissing === "1";

      card.querySelectorAll(".mcq-choice").forEach((line) => {
        const ltr = (line.dataset.letter || "").toUpperCase();
        line.classList.remove("selected");
        if (correctLetter && ltr === correctLetter) line.classList.add("correct");
        if (selectedLetter && ltr === selectedLetter && selectedLetter !== correctLetter) {
          line.classList.add("wrong");
        }
      });

      if (feedback) {
        if (answerIsMissing) {
          feedback.textContent = "No supported answer in sources (NOT_IN_SOURCES).";
        } else if (!selectedLetter) {
          feedback.textContent = correctLetter ? `Not answered. Correct: ${correctLetter}.` : "Not answered.";
        } else if (selectedLetter === correctLetter) {
          feedback.textContent = "Correct.";
        } else {
          feedback.textContent = correctLetter ? `Wrong. Correct: ${correctLetter}.` : "Wrong.";
        }
      }
    }

    if (type === "short" && feedback) {
      if (card.dataset.answered !== "1") {
        feedback.textContent = "Not answered. Review the answer below.";
      } else if (card.dataset.shortOk === "1") {
        feedback.textContent = "Correct.";
      } else {
        feedback.textContent = "Not marked correct. Review the answer below.";
      }
    }
  });
}

function finishExam(reason = "manual") {
  if (examFinished) return;
  examFinished = true;
  stopExamTimer();
  setExamTimerVisible(true);
  setExamTimerText(reason === "timeout" ? "Time: 00:00" : "Exam finished.", reason === "timeout");

  document.querySelectorAll('.mcq-choice input[type="radio"]').forEach(el => { el.disabled = true; });
  document.querySelectorAll('.short-input').forEach(el => { el.disabled = true; });
  document.querySelectorAll('.short-check').forEach(el => { el.disabled = true; });
  revealFinishedExam();

  document.querySelectorAll("details").forEach(d => {
    d.style.display = "";
    d.open = true;
  });

  const banner = document.getElementById("finalBanner") || document.createElement("div");
  banner.id = "finalBanner";
  banner.className = "final-banner";
  banner.textContent = `${reason === "timeout" ? "Time is up." : "Finished."} Final score: ${score.correct}/${score.total}. Answered: ${score.answered}/${score.total}.`;

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
      if (examOn) card.dataset.examCard = "1";

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
        if (examOn) {
          card.dataset.questionType = "mcq";
          card.dataset.correctLetter = correctLetter;
          card.dataset.answerMissing = answerIsMissing ? "1" : "0";
        }

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
            const selectedLetter = letter;
            card.dataset.answered = "1";
            card.dataset.selectedLetter = selectedLetter;

            if (answerIsMissing) {
              if (examOn) {
                line.classList.add("selected");
                score.answered += 1;
                updateScoreUI();
                hint.textContent = "Answer recorded. Results unlock when the exam is finished.";
                return;
              }

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

            const ok = selectedLetter === correctLetter;
            if (examOn) {
              line.classList.add("selected");
              score.answered += 1;
              if (ok) score.correct += 1;
              updateScoreUI();
              hint.textContent = t(
                "Answer recorded. Results unlock when the exam is finished.",
                "Answer recorded. Results unlock when the exam is finished.",
                "Answer recorded. Results unlock when the exam is finished."
              );
              return;
            }

            // highlight correct + selected
            card.querySelectorAll(".mcq-choice").forEach(l => {
              const ltr = (l.dataset.letter || "").toUpperCase();
              if (ltr === correctLetter) l.classList.add("correct");
              if (ltr === selectedLetter && selectedLetter !== correctLetter) l.classList.add("wrong");
            });

            hint.textContent = ok
              ? t("✅ Correct.", "✅ صح.", "✅ Doğru.")
              : t(
                  `❌ Wrong. Correct: ${correctLetter}.`,
                  `❌ غلط. الصحيح: ${correctLetter}.`,
                  `❌ Yanlış. Doğru: ${correctLetter}.`
                );

            if (detailsEl) {
              detailsEl.style.display = "";
              detailsEl.open = true;
            }
          });

          card.appendChild(line);
        });

        makeDetails();
      } else {
        if (examOn) card.dataset.questionType = "short";

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
            if (examOn) {
              card.dataset.answered = "1";
              score.answered += 1;
              updateScoreUI();
              fb.textContent = "Answer recorded. Results unlock when the exam is finished.";
              return;
            }

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

          if (examOn) {
            card.dataset.answered = "1";
            card.dataset.shortOk = ok ? "1" : "0";
            score.answered += 1;
            if (ok) score.correct += 1;
            updateScoreUI();
            fb.textContent = "Answer recorded. Results unlock when the exam is finished.";
            return;
          }

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

let sessionId = initializeSessionId();

function withSession(headers = {}, requestSessionId = sessionId) {
  return { ...headers, "X-Session-Id": requestSessionId };
}

async function apiFetch(path, options = {}) {
  const { sessionOverride, ...fetchOptions } = options;
  const headers = fetchOptions.headers ? { ...fetchOptions.headers } : {};
  return fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers: withSession(headers, sessionOverride || sessionId)
  });
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
  const uploadOverlayEl = document.getElementById("uploadOverlay");
  const uploadOverlayTitleEl = document.getElementById("uploadOverlayTitle");
  const uploadOverlayDetailEl = document.getElementById("uploadOverlayDetail");
  const themeBtn = document.getElementById("themeToggle");
  const helpFabBtn = document.getElementById("helpFab");
  const scrollTopBtn = document.getElementById("scrollTop");

  let lastRaw = "";
  let selected = loadSelected();
  let sessionsCache = [];
  let modalState = null;
  let uploadOverlayTimer = null;
  let uploadWatchToken = 0;

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
      menu.closest(".session-item")?.classList.remove("actions-open");
    });

    document.querySelectorAll(".session-item-trigger[aria-expanded='true']").forEach((btn) => {
      if (exceptMenu && btn._sessionMenu === exceptMenu) return;
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function isSidebarOpen() {
    if (!sidebarEl) return false;
    if (isMobileSidebarMode()) return sidebarEl.classList.contains("open");
    return !document.body.classList.contains("sidebar-collapsed");
  }

  function isMobileSidebarMode() {
    return window.matchMedia("(max-width: 980px)").matches;
  }

  function syncSidebarA11y() {
    if (!sidebarEl) return;
    const expanded = isSidebarOpen();
    sidebarToggleBtn?.setAttribute("aria-expanded", String(expanded));
    sidebarToggleBtn?.setAttribute("aria-label", expanded ? "Close conversations" : "Open conversations");
    sidebarToggleBtn?.setAttribute("title", expanded ? "Close conversations" : "Open conversations");
    sidebarEl.setAttribute("aria-hidden", String(!expanded));
  }

  function openSidebar() {
    if (!sidebarEl || !sidebarBackdropEl) return;
    closeDownloadMenu();
    closeCustomSelectMenus();
    closeSessionActionMenus();
    document.body.classList.remove("sidebar-collapsed");
    if (isMobileSidebarMode()) {
      sidebarEl.classList.add("open");
      sidebarBackdropEl.classList.add("open");
      document.body.classList.add("sidebar-open");
    } else {
      sidebarEl.classList.remove("open");
      sidebarBackdropEl.classList.remove("open");
      document.body.classList.remove("sidebar-open");
    }
    syncSidebarA11y();
  }

  function closeSidebar({ collapseDesktop = false } = {}) {
    if (!sidebarEl || !sidebarBackdropEl) return;
    sidebarEl.classList.remove("open");
    sidebarBackdropEl.classList.remove("open");
    document.body.classList.remove("sidebar-open");
    if (!isMobileSidebarMode() && collapseDesktop) document.body.classList.add("sidebar-collapsed");
    syncSidebarA11y();
  }

  function toggleSidebar() {
    if (isSidebarOpen()) closeSidebar({ collapseDesktop: true });
    else openSidebar();
  }

  function syncScrollTopButton() {
    if (!scrollTopBtn) return;
    scrollTopBtn.classList.toggle("visible", window.scrollY > 420);
  }

  function handleViewportChange() {
    if (!isMobileSidebarMode()) {
      sidebarEl?.classList.remove("open");
      sidebarBackdropEl?.classList.remove("open");
      document.body.classList.remove("sidebar-open");
    } else {
      document.body.classList.remove("sidebar-collapsed");
    }
    syncSidebarA11y();
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
    if (modalCancelBtn) modalCancelBtn.hidden = false;
    if (modalFieldWrapEl) {
      modalFieldWrapEl.hidden = true;
      modalFieldWrapEl.style.display = "none";
    }
    setModalError("");

    if (resolve) resolve(result);
  }

  function updateUploadOverlay(title, detail, state = "loading") {
    if (!uploadOverlayEl) return;

    if (uploadOverlayTimer) {
      clearTimeout(uploadOverlayTimer);
      uploadOverlayTimer = null;
    }

    uploadOverlayTitleEl.textContent = title || "Uploading and preparing your source...";
    uploadOverlayDetailEl.textContent = detail || "Please wait while the file is uploaded and indexed.";
    uploadOverlayEl.classList.toggle("success", state === "success");
    uploadOverlayEl.classList.toggle("error", state === "error");
    uploadOverlayEl.hidden = false;
    uploadOverlayEl.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    document.body.classList.add("upload-overlay-open");
  }

  function hideUploadOverlay(delay = 0) {
    if (!uploadOverlayEl) return;

    if (uploadOverlayTimer) clearTimeout(uploadOverlayTimer);
    uploadOverlayTimer = window.setTimeout(() => {
      uploadOverlayEl.hidden = true;
      uploadOverlayEl.classList.remove("success", "error");
      uploadOverlayEl.setAttribute("aria-busy", "false");
      document.body.classList.remove("upload-overlay-open");
      uploadOverlayTimer = null;
    }, delay);
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
    hideCancel = false,
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
    modalCancelBtn.hidden = !!hideCancel;
    modalConfirmBtn.textContent = confirmLabel;
    modalConfirmBtn.classList.toggle("button-danger", !!danger);

    setModalError("");

    if (input) {
      modalFieldWrapEl.hidden = false;
      modalFieldWrapEl.style.display = "";
      modalInputLabelEl.textContent = input.label || "Value";
      modalInputEl.value = input.value || "";
      modalInputEl.placeholder = input.placeholder || "";
      modalInputEl.maxLength = input.maxLength || 200;
      modalHelpEl.textContent = input.help || "";
      modalHelpEl.hidden = !modalHelpEl.textContent;
    } else {
      modalFieldWrapEl.hidden = true;
      modalFieldWrapEl.style.display = "none";
      modalInputLabelEl.textContent = "";
      modalInputEl.value = "";
      modalInputEl.placeholder = "";
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

  function syncCurrentSessionLabel() {
    if (!currentSessionLabelEl) return;
    const current = sessionsCache.find((session) => session.session_id === sessionId);
    currentSessionLabelEl.textContent = getSessionDisplayName(current || { session_id: sessionId });
  }

  async function updateSessionDisplayName(targetSessionId, title) {
    const normalizedTitle = normalizeSessionTitle(title);
    const data = await apiFetchJson("/sessions/set-name", {
      method: "POST",
      sessionOverride: targetSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: targetSessionId,
        name: normalizedTitle
      })
    });

    rememberSession({ session_id: targetSessionId, name: data.name ?? normalizedTitle });
    await loadSessions();
    return normalizeSessionTitle(data.name ?? normalizedTitle);
  }

  async function createSession(displayTitle = "") {
    let nextSessionId = generateSessionId();
    while (sessionsCache.some((session) => session.session_id === nextSessionId)) {
      nextSessionId = generateSessionId();
    }

    const normalizedTitle = normalizeSessionTitle(displayTitle);
    await apiFetchJson("/sessions", {
      method: "POST",
      sessionOverride: nextSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: nextSessionId, name: normalizedTitle })
    });

    sessionId = nextSessionId;
    localStorage.setItem("session_id", sessionId);
    rememberSession({ session_id: sessionId, name: normalizedTitle });
    selected.clear();
    saveSelected(selected);
    updateSelectedInfo();
    syncCurrentSessionLabel();
    closeSidebar();

    await loadSessions();
    await refreshSources();
    return nextSessionId;
  }

  function renderSessionList() {
    if (!sessionListEl) return;

    sessionListEl.innerHTML = "";

    if (sessionCountEl) sessionCountEl.textContent = String(sessionsCache.length);

    const savedCount = sessionsCache.length;
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
      meta.textContent = hasCustomSessionTitle(session) ? session.session_id : "No custom title yet";

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
        rememberSession(session);
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
      trigger._sessionMenu = menu;

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "session-menu-item";
      renameBtn.textContent = "Edit title";
      renameBtn.addEventListener("click", async () => {
        closeSessionActionMenus();

        const result = await openModal({
          title: "Edit conversation title",
          message: "Change the display title for this chat. Leave it blank to use the default title behavior.",
          confirmLabel: "Save title",
          input: {
            label: "Display title",
            value: getSessionTitleInputValue(session),
            placeholder: "e.g. Chapter 5 Review",
            maxLength: SESSION_NAME_MAX_LEN,
            help: "Free text is allowed. This changes only the visible chat title."
          }
        });

        if (!result.confirmed) return;

        try {
          const savedTitle = await updateSessionDisplayName(session.session_id, result.value);
          setText(
            statusEl,
            savedTitle
              ? `Conversation title updated: ${savedTitle}`
              : "Conversation title cleared."
          );
        } catch (e) {
          setText(statusEl, `Update title failed: ${e.message}`);
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
              method: "DELETE",
              sessionOverride: session.session_id
            });

            const wasCurrent = session.session_id === sessionId;
            forgetSession(session.session_id);
            if (wasCurrent) {
              sessionId = generateSessionId();
              localStorage.setItem("session_id", sessionId);
              rememberSession({ session_id: sessionId });
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
        item.classList.toggle("actions-open", willOpen);
        trigger.setAttribute("aria-expanded", String(willOpen));
      });

      actions.appendChild(trigger);

      item.appendChild(mainBtn);
      item.appendChild(actions);
      item.appendChild(menu);
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
      if (examOn && !examFinished) startExamTimer(score.total || (Array.isArray(parsed.items) ? parsed.items.length : 0));
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

  syncSidebarA11y();

  sidebarToggleBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSidebar();
  });

  sidebarCloseBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeSidebar({ collapseDesktop: true });
  });

  sidebarBackdropEl?.addEventListener("click", (e) => {
    e.preventDefault();
    closeSidebar();
  });

  scrollTopBtn?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  helpFabBtn?.addEventListener("click", () => {
    openModal({
      title: "How to use this study tool",
      message: "1. Upload a PDF/TXT file or paste a manual source.\n2. Select one or more ready sources.\n3. Choose quiz, flashcards, or tricky questions.\n4. Use Focus Query to stay on one topic.\n5. Turn on Exam Mode before Generate for a timed attempt.",
      confirmLabel: "Got it",
      hideCancel: true
    });
  });

  window.addEventListener("scroll", syncScrollTopButton, { passive: true });
  window.addEventListener("resize", handleViewportChange);
  syncScrollTopButton();

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
  if (finishExamBtn) finishExamBtn.addEventListener("click", () => finishExam());

  if (examModeEl) {
    examModeEl.addEventListener("change", () => {
      const on = !!examModeEl.checked;

      // Exam mode = hide answer key + show score
      if (showAnswerKeyEl) {
        showAnswerKeyEl.checked = !on ? showAnswerKeyEl.checked : false;
        showAnswerKeyEl.disabled = on;
      }
      if (scoreBoxEl) scoreBoxEl.style.display = on ? "" : "none";
      setExamTimerVisible(on);
      if (resetScoreBtn) resetScoreBtn.style.display = on ? "" : "none";
      if (finishExamBtn) finishExamBtn.style.display = on ? "" : "none";
      examFinished = false;
      if (!on) {
        stopExamTimer();
        setExamTimerText("Time: --:--", false);
      }
      updateScoreUI();
      rerenderLastPretty();
      if (on && lastRaw) {
        try {
          const parsed = JSON.parse(lastRaw);
          score.total = Array.isArray(parsed.items) ? parsed.items.length : 0;
          score.correct = 0;
          score.answered = 0;
          const banner = document.getElementById("finalBanner");
          if (banner) banner.remove();
          updateScoreUI();
          startExamTimer(score.total, true);
        } catch {
          // ignore exam timer start errors
        }
      }
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
        if (examOn && !examFinished) {
          score.total = Array.isArray(parsed.items) ? parsed.items.length : score.total;
          startExamTimer(score.total);
        }
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
        return [];
      }

      const list = data.sources || [];
      sourcesListEl.innerHTML = "";

      if (list.length === 0) {
        sourcesListEl.innerHTML = `<div class="muted">No stored sources yet. Upload a file or add manual text.</div>`;
        updateSelectedInfo();
        return list;
      }

      list.forEach((s) => {
        const row = document.createElement("div");
        row.className = "item";
        row.classList.toggle("selected", selected.has(s.source_id));

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(s.source_id);
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(s.source_id);
          else selected.delete(s.source_id);
          row.classList.toggle("selected", cb.checked);
          saveSelected(selected);
          updateSelectedInfo();
        });

        const label = document.createElement("div");
        label.className = "source-details";
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
        delBtn.className = "source-delete";
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
      return list;
    } catch (e) {
      sourcesListEl.innerHTML = `<div style="color:#b00">Failed to fetch /sources: ${escapeHtml(String(e))}</div>`;
      return [];
    }
  }

  async function waitForUploadedSourceReady(sourceId, token) {
    if (!sourceId) {
      hideUploadOverlay(700);
      return;
    }

    updateUploadOverlay(
      "Indexing source...",
      "Please wait while the file is indexed and made ready for generation."
    );

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (token !== uploadWatchToken) return;

      const list = await refreshSources();
      const source = (list || []).find((item) => item.source_id === sourceId);
      const status = source?.status || "pending";
      const progress = source?.pages_total
        ? ` Indexed ${source.pages_done || 0}/${source.pages_total} pages.`
        : "";

      if (status === "ready") {
        updateUploadOverlay("Source ready", "Your file is ready to use.", "success");
        setText(statusEl, `Source ready: ${sourceId}`);
        hideUploadOverlay(900);
        return;
      }

      if (status === "failed") {
        const detail = source?.detail || "The file uploaded, but indexing failed. Please try another file.";
        updateUploadOverlay(
          "Upload failed",
          detail,
          "error"
        );
        setText(statusEl, `Upload failed: ${detail}`);
        hideUploadOverlay(2200);
        return;
      }

      updateUploadOverlay(
        "Indexing source...",
        `Please wait while the file is indexed and made ready for generation.${progress}`
      );
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }

    if (token === uploadWatchToken) {
      updateUploadOverlay(
        "Still indexing source...",
        "This file is taking longer than usual. You can continue once the source status becomes ready."
      );
      setText(statusEl, "Still indexing source. You can continue once it becomes ready.");
      hideUploadOverlay(2600);
    }
  }

  async function loadSessions() {
    sessionsCache = mergeSessionLists(loadSessionArchive(), [{ session_id: sessionId }]);
    saveSessionArchive(sessionsCache);
    renderSessionList();
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
    stopExamTimer();
    setExamTimerText("Time: --:--", false);
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
        if (examOn) startExamTimer(score.total, true);
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

    const uploadToken = ++uploadWatchToken;
    updateUploadOverlay(
      "Uploading source...",
      `Uploading "${f.name}" and preparing it for indexing.`
    );
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
      const autoSessionName = normalizeSessionTitle(data.session_name || "");
      rememberSession({ session_id: sessionId, name: autoSessionName });
      setText(
        statusEl,
        autoSessionName
          ? `Uploaded: ${newId || f.name}. Chat title set to "${autoSessionName}".`
          : `Uploaded: ${newId || f.name}`
      );
      await loadSessions();
      if (newId) {
        await waitForUploadedSourceReady(newId, uploadToken);
      } else {
        await refreshSources();
        updateUploadOverlay("Source ready", "Your file was uploaded successfully.", "success");
        hideUploadOverlay(900);
      }
    } catch (e) {
      uploadWatchToken += 1;
      const message = e?.message || String(e);
      fileEl.value = "";
      updateUploadOverlay(
        "Upload failed",
        message || "The file could not be uploaded. Please try again.",
        "error"
      );
      hideUploadOverlay(2400);
      setText(statusEl, `Upload failed: ${message}`);
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
      title: "Create new chat",
      message: "Create a new chat with an internal ID generated automatically. You can add a display title now or let the first uploaded file title it later.",
      confirmLabel: "Create",
      input: {
        label: "Display title",
        value: "",
        placeholder: "e.g. Midterm review",
        maxLength: SESSION_NAME_MAX_LEN,
        help: "Optional. Leave blank to auto-title this chat from the first uploaded file."
      }
    });
    if (!result.confirmed) return;

    try {
      await createSession(result.value);
      setText(
        statusEl,
        normalizeSessionTitle(result.value)
          ? `Chat created: ${normalizeSessionTitle(result.value)}`
          : "Chat created. Upload a file to auto-title it."
      );
    } catch (e) {
      setText(statusEl, `Create chat failed: ${e.message}`);
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
