const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };

const RAW_DB_URL = (typeof ENV !== 'undefined' && ENV.FIREBASE_DB_URL)
    ? ENV.FIREBASE_DB_URL
    : "https://antibrainrotting-4f194-default-rtdb.europe-west1.firebasedatabase.app";
const DB_URL = RAW_DB_URL.replace(/\/+$/, '');

const DEFAULT_API_KEY = (typeof ENV !== 'undefined' && ENV.DEFAULT_GEMINI_API_KEY)
    ? ENV.DEFAULT_GEMINI_API_KEY : "";
const DEFAULT_GROQ_API_KEY = (typeof ENV !== 'undefined' && ENV.DEFAULT_GROQ_API_KEY)
    ? ENV.DEFAULT_GROQ_API_KEY : "";

let accountBooks = [];
let activeBook = null;
let settingsBookId = null;
let currentChapterIndex = 0;
let activeText = "";
let generatedQuiz = [];
let userAnswers = {};

// Verrous de sécurité anti-écrasement
let isSaving = false;
let accountLoaded = false;

let syncKey = localStorage.getItem("focus_read_sync_key") || null;
let currentKeyPassword = localStorage.getItem("focus_read_sync_pwd") || "";
let userStats = { scoreTotal: 0, quizzesCompleted: 0, perfectScores: 0, totalChaptersRead: 0, streakDays: 0, lastReadDate: null };

// --- UTILITAIRES RÉSEAU & STOCKAGE ---

const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const cleanKey = k => String(k).trim().replace(/[.#$\[\]/]/g, '_');
const slugifyTitle = t => String(t || "sans_titre")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || "sans_titre";

const stripChapterPrefix = (label, fallbackIndex = 0) => String(label || "")
    .replace(/^chapitre\s*\d+\s*[:.-]?\s*/i, "")
    .trim() || `Partie ${fallbackIndex + 1}`;

const normalizeChapterSig = c => {
    const cleanTitle = stripChapterPrefix(c?.label || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/\s+/g, ' ').trim();
    const cleanSample = String(c?.text || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 140);
    return `${cleanTitle}::${cleanSample}`;
};

const dateKey = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const toArray = val => Array.isArray(val) ? val : Object.values(val || {});
const mergeReadChapters = (...lists) => [...new Set(lists.flatMap(l => toArray(l)).filter(Boolean))];
const isChapterValidated = (book, chap) => Boolean(book && chap && toArray(book.readChapters).includes(chap.id));

function reindexChaptersAndProgress(rawChapters = [], readChapters = [], pausedPositions = {}) {
    const idMap = {};
    const chapters = toArray(rawChapters)
        .filter(c => c && c.text)
        .map((c, idx) => {
            const oldId = c.id || `chap_${idx + 1}`;
            const newId = `chap_${idx + 1}`;
            idMap[oldId] = newId;
            return {
                id: newId,
                chapterNum: idx + 1,
                label: stripChapterPrefix(c.label, idx),
                text: c.text,
                wordCount: c.wordCount || c.text.split(/\s+/).filter(Boolean).length
            };
        });

    const validIds = new Set(chapters.map(c => c.id));
    const remappedRead = mergeReadChapters(
        toArray(readChapters).map(id => idMap[id] || id).filter(id => validIds.has(id))
    );
    const remappedPaused = {};
    for (const [k, v] of Object.entries(pausedPositions || {})) {
        const mapped = idMap[k] || k;
        if (validIds.has(mapped)) remappedPaused[mapped] = v;
    }

    return { chapters, readChapters: remappedRead, pausedPositions: remappedPaused };
}

function appendChaptersToBook(book, incomingChapters = []) {
    const baseList = toArray(book.chapters).filter(c => c && c.text);
    const nextList = toArray(incomingChapters).filter(c => c && c.text);
    const seenSigs = new Set(baseList.map(normalizeChapterSig));
    let addedCount = 0;

    const combined = [...baseList];
    for (const inc of nextList) {
        const sig = normalizeChapterSig(inc);
        if (seenSigs.has(sig)) continue;
        seenSigs.add(sig);
        combined.push({
            id: `chap_${combined.length + 1}`,
            chapterNum: combined.length + 1,
            label: stripChapterPrefix(inc.label, combined.length),
            text: inc.text,
            wordCount: inc.wordCount || inc.text.split(/\s+/).filter(Boolean).length
        });
        addedCount += 1;
    }

    const reindexed = reindexChaptersAndProgress(combined, book.readChapters, book.pausedPositions);
    book.chapters = reindexed.chapters;
    book.readChapters = reindexed.readChapters;
    book.pausedPositions = reindexed.pausedPositions;
    return addedCount;
}

function shuffleQuestionOptions(q) {
    const indexed = q.options.map((text, idx) => ({ text, isCorrect: idx === q.answer }));
    for (let i = indexed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
    }
    return {
        ...q,
        options: indexed.map(item => item.text),
        answer: indexed.findIndex(item => item.isCorrect)
    };
}

function sanitizeQuestions(rawQuestions) {
    if (!Array.isArray(rawQuestions)) return [];
    return rawQuestions
        .filter(q =>
            q && typeof q.question === 'string' &&
            Array.isArray(q.options) && q.options.length === 4 &&
            q.options.every(o => typeof o === 'string' && o.trim().length > 0) &&
            typeof q.answer === 'number' && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4
        )
        .map(shuffleQuestionOptions);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fb(path, method = "GET", body = null) {
    const cleanPath = path.replace(/^\/+/, '');
    if (!cleanPath) throw new Error("Chemin Firebase racine interdit.");
    const opts = { method, cache: "no-store" };
    if (body !== null) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
    }
    const res = await fetchWithTimeout(`${DB_URL}/${cleanPath}.json`, opts, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return method === "DELETE" ? true : res.json();
}

async function sha256(str) {
    if (!str) return null;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join("");
}

function showView(viewId) {
    if (viewId !== 'game-screen') stopAutoScroll();
    ['setup-screen', 'game-screen', 'quiz-screen'].forEach(id => {
        const el = $(id);
        if (el) el.hidden = id !== viewId;
    });
    window.scrollTo(0, 0);
}

function setSyncStatus(msg, online = false) {
    if ($('syncStatus')) $('syncStatus').textContent = msg;
    if ($('syncDot')) $('syncDot').classList.toggle('online', online);
}

// --- STATISTIQUES ---

function getStreak(stats = userStats) {
    if (!stats?.lastReadDate || !stats?.streakDays) return 0;
    return (stats.lastReadDate === dateKey(0) || stats.lastReadDate === dateKey(-1)) ? stats.streakDays : 0;
}

function getQuizSuccessRatio(stats = userStats) {
    const completed = stats?.quizzesCompleted || 0;
    const succeeded = stats?.perfectScores || 0;
    if (!completed) return null;
    return Math.round((succeeded / completed) * 100);
}

function renderStats() {
    $('stat-streak').textContent = `${getStreak()} j`;
    $('stat-chapters').textContent = userStats.totalChaptersRead || 0;
    $('stat-score').textContent = userStats.scoreTotal || 0;
    const ratio = getQuizSuccessRatio();
    if ($('stat-ratio')) {
        $('stat-ratio').textContent = ratio === null
            ? "—"
            : `${ratio}% (${userStats.perfectScores || 0}/${userStats.quizzesCompleted || 0})`;
    }
}

function questionCount(words) {
    const pages = (words || 0) / 250;
    if (pages <= 2) return 3;
    if (pages <= 5) return 4;
    if (pages <= 9) return 6;
    if (pages <= 15) return 8;
    if (pages <= 22) return 10;
    return 12;
}

// --- BACK-END : SYNCHRONISATION FIREBASE BLINDÉE ---

function updateAccountUI() {
    $('syncKeyLabel').textContent = syncKey ? `${syncKey}${currentKeyPassword ? " · 🔒" : ""}` : "Définir un compte";
    $('current-lb-key').textContent = syncKey || "—";
}

async function canWriteAccount() {
    if (!syncKey || !accountLoaded) return false;
    const distantHash = await fb(`focus_read_users/${encodeURIComponent(syncKey)}/passwordHash`);
    return !distantHash || distantHash === await sha256(currentKeyPassword);
}

async function saveBookCloud(book) {
    if (!navigator.onLine) {
        setSyncStatus("Hors ligne (non sauvegardé)");
        return false;
    }
    if (!syncKey) {
        syncKey = "READ-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        localStorage.setItem("focus_read_sync_key", syncKey);
        accountLoaded = true;
        updateAccountUI();
    }
    if (!accountLoaded) {
        setSyncStatus("Chargement du compte requis avant écriture");
        return false;
    }

    isSaving = true;
    book.id = cleanKey(book.id || `book_${slugifyTitle(book.title)}`);
    setSyncStatus("Sauvegarde du livre...");

    try {
        if (!await canWriteAccount()) {
            setSyncStatus("Accès refusé");
            return false;
        }

        const base = `focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(book.id)}`;
        const existingDistant = await fb(base).catch(() => null);

        const finalChapters = toArray(book.chapters).filter(c => c && c.text);
        const mergedRead = mergeReadChapters(existingDistant?.readChapters, book.readChapters);
        const mergedPaused = { ...(existingDistant?.pausedPositions || {}), ...(book.pausedPositions || {}) };
        const mergedLastIndex = Math.max(
            0,
            Math.min(book.lastIndex ?? existingDistant?.lastIndex ?? 0, Math.max(0, finalChapters.length - 1))
        );

        const meta = {
            id: book.id,
            publicId: book.publicId || existingDistant?.publicId || null,
            title: book.title || existingDistant?.title || "Sans titre",
            fileName: book.fileName || existingDistant?.fileName || "livre.epub",
            visibility: book.visibility || existingDistant?.visibility || 'public',
            sharedBy: book.sharedBy || existingDistant?.sharedBy || syncKey,
            readChapters: mergedRead,
            pausedPositions: mergedPaused,
            lastIndex: mergedLastIndex,
            updatedAt: Date.now()
        };

        await fb(base, "PATCH", meta);
        await fb(`${base}/chapters`, "DELETE").catch(() => {});

        for (let i = 0; i < finalChapters.length; i += 5) {
            const patch = {};
            finalChapters.slice(i, i + 5).forEach((c, idx) => {
                const n = i + idx;
                patch[`chapters/${n}`] = {
                    id: c.id || `chap_${n + 1}`,
                    chapterNum: n + 1,
                    label: stripChapterPrefix(c.label, n),
                    text: c.text,
                    wordCount: c.wordCount || c.text.split(/\s+/).filter(Boolean).length
                };
            });
            await fb(base, "PATCH", patch);
        }

        const full = { ...meta, chapters: finalChapters };
        const idx = accountBooks.findIndex(b => b.id === book.id);
        idx >= 0 ? (accountBooks[idx] = full) : accountBooks.unshift(full);

        setSyncStatus("Synchronisé", true);
        return true;
    } catch (e) {
        setSyncStatus(`Erreur sync (${e.message})`);
        return false;
    } finally {
        isSaving = false;
    }
}

async function saveBookProgress(book) {
    if (!book || !syncKey || !accountLoaded) return false;
    const idx = accountBooks.findIndex(b => b.id === book.id);
    if (idx >= 0) accountBooks[idx] = { ...accountBooks[idx], ...book };

    if (!navigator.onLine) {
        setSyncStatus("Hors ligne (non sauvegardé)");
        return false;
    }

    isSaving = true;
    setSyncStatus("Sauvegarde progression...");
    try {
        if (!await canWriteAccount()) {
            setSyncStatus("Accès refusé");
            return false;
        }
        const base = `focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(book.id)}`;

        const distantRead = await fb(`${base}/readChapters`).catch(() => []);
        const mergedRead = mergeReadChapters(distantRead, book.readChapters);
        book.readChapters = mergedRead;
        if (idx >= 0) accountBooks[idx].readChapters = mergedRead;

        await fb(base, "PATCH", {
            readChapters: mergedRead,
            pausedPositions: book.pausedPositions || {},
            lastIndex: book.lastIndex || 0,
            updatedAt: Date.now()
        });
        setSyncStatus("Progression enregistrée ✓", true);
        return true;
    } catch (e) {
        setSyncStatus(`Erreur sync (${e.message})`);
        return false;
    } finally {
        isSaving = false;
    }
}

async function pullAccount(silent = false) {
    if (isSaving) return;
    if (!navigator.onLine) return setSyncStatus("Hors ligne");

    if (!syncKey) {
        if (silent) return;
        const input = prompt("Entrez votre identifiant de compte (ou vide pour en créer un) :");
        const cleaned = input ? cleanKey(input) : "";
        syncKey = cleaned || ("READ-" + Math.random().toString(36).substring(2, 8).toUpperCase());
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateAccountUI();
        if (!cleaned) {
            accountLoaded = true;
            return pushStats();
        }
    }

    if (!silent) setSyncStatus("Chargement...");
    try {
        const data = await fb(`focus_read_users/${encodeURIComponent(syncKey)}`);
        if (isSaving) return;

        if (data === null) {
            accountLoaded = true;
            setSyncStatus("Nouveau profil", true);
            return pushStats();
        }

        if (data.passwordHash) {
            let tries = 0;
            while (await sha256(currentKeyPassword) !== data.passwordHash && tries++ < 3) {
                const pwd = prompt(`Mot de passe pour "${syncKey}" :`);
                if (pwd === null) break;
                currentKeyPassword = pwd.trim();
            }
            if (await sha256(currentKeyPassword) !== data.passwordHash) {
                syncKey = null;
                currentKeyPassword = "";
                accountLoaded = false;
                localStorage.removeItem("focus_read_sync_key");
                localStorage.removeItem("focus_read_sync_pwd");
                updateAccountUI();
                return setSyncStatus("Mot de passe incorrect");
            }
            localStorage.setItem("focus_read_sync_pwd", currentKeyPassword);
            updateAccountUI();
        }

        userStats = {
            scoreTotal: Math.max(accountLoaded ? userStats.scoreTotal : 0, data.scoreTotal || 0),
            quizzesCompleted: Math.max(accountLoaded ? userStats.quizzesCompleted : 0, data.quizzesCompleted || 0),
            perfectScores: Math.max(accountLoaded ? userStats.perfectScores : 0, data.perfectScores || 0),
            totalChaptersRead: Math.max(accountLoaded ? userStats.totalChaptersRead : 0, data.totalChaptersRead || data.perfectScores || 0),
            streakDays: data.streakDays || 0,
            lastReadDate: data.lastReadDate || null
        };
        renderStats();

        const localById = new Map(accountBooks.map(b => [b.id, b]));
        accountBooks = Object.values(data.library || {})
            .filter(b => b && b.chapters)
            .map(b => {
                const prev = localById.get(b.id);
                return {
                    ...b,
                    chapters: toArray(b.chapters).filter(c => c && c.text),
                    readChapters: mergeReadChapters(prev?.readChapters, b.readChapters),
                    pausedPositions: { ...(prev?.pausedPositions || {}), ...(b.pausedPositions || {}) }
                };
            })
            .filter(b => b.chapters.length > 0);

        accountLoaded = true;

        if (!$('setup-screen').hidden) renderLibrary(activeBook?.id);
        setSyncStatus(`À jour · ${accountBooks.length} livre${accountBooks.length > 1 ? 's' : ''}`, true);
    } catch (e) {
        if (!silent) setSyncStatus(`Erreur réseau (${e.message})`);
    }
}

async function pushStats() {
    if (!navigator.onLine || !syncKey || !accountLoaded) return;
    isSaving = true;
    try {
        if (!await canWriteAccount()) return setSyncStatus("Écriture refusée");

        const distant = await fb(`focus_read_users/${encodeURIComponent(syncKey)}`).catch(() => null);
        const safeStats = {
            scoreTotal: Math.max(distant?.scoreTotal || 0, userStats.scoreTotal || 0),
            quizzesCompleted: Math.max(distant?.quizzesCompleted || 0, userStats.quizzesCompleted || 0),
            perfectScores: Math.max(distant?.perfectScores || 0, userStats.perfectScores || 0),
            totalChaptersRead: Math.max(distant?.totalChaptersRead || 0, userStats.totalChaptersRead || 0),
            streakDays: Math.max(distant?.streakDays || 0, getStreak()),
            lastReadDate: userStats.lastReadDate || distant?.lastReadDate || null
        };
        userStats = { ...userStats, ...safeStats };
        renderStats();

        await fb(`focus_read_users/${encodeURIComponent(syncKey)}`, "PATCH", {
            ...safeStats,
            passwordHash: await sha256(currentKeyPassword),
            updatedAt: Date.now()
        });
        setSyncStatus("Synchronisé", true);
    } catch (e) {
        setSyncStatus(`Erreur envoi (${e.message})`);
    } finally {
        isSaving = false;
    }
}

async function switchAccount() {
    const choice = prompt(
        `Profil : ${syncKey || "Aucun"}\n1. Changer / créer un compte\n2. Définir un mot de passe\nEntrez 1, 2 ou directement le nom du compte :`
    );
    if (choice === null) return;
    const val = choice.trim();

    if (val === "2") {
        if (!syncKey || !accountLoaded) return alert("Chargez d'abord un compte valide.");
        const pwd = prompt("Nouveau mot de passe (laisser vide pour supprimer) :");
        if (pwd === null) return;
        currentKeyPassword = pwd.trim();
        currentKeyPassword ? localStorage.setItem("focus_read_sync_pwd", currentKeyPassword) : localStorage.removeItem("focus_read_sync_pwd");
        updateAccountUI();
        return pushStats();
    }

    const raw = val === "1" ? (prompt("Nom exact du compte :") || "") : val;
    syncKey = cleanKey(raw) || ("READ-" + Math.random().toString(36).substring(2, 8).toUpperCase());
    currentKeyPassword = "";
    accountLoaded = false;
    localStorage.removeItem("focus_read_sync_pwd");
    localStorage.setItem("focus_read_sync_key", syncKey);

    accountBooks = [];
    activeBook = null;
    userStats = { scoreTotal: 0, quizzesCompleted: 0, perfectScores: 0, totalChaptersRead: 0, streakDays: 0, lastReadDate: null };
    renderStats();
    renderLibrary();
    updateAccountUI();
    await pullAccount();
}

// --- IMPORT EPUB & PARAMÈTRES DU LIVRE ---

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const label = $('file-label');
    label.textContent = "Analyse du fichier...";

    try {
        if (!file.name.toLowerCase().endsWith('.epub')) {
            throw new Error("Seuls les fichiers .epub sont pris en charge.");
        }

        const { bookTitle: title, chapters } = await parseEpub(file);
        if (!chapters.length) throw new Error("Aucun chapitre lisible trouvé.");

        const bookId = cleanKey(`book_${slugifyTitle(title)}_${Date.now()}`);
        const book = {
            id: bookId,
            publicId: null,
            title,
            fileName: file.name,
            visibility: 'public',
            sharedBy: syncKey || "Anonyme",
            chapters,
            readChapters: [],
            pausedPositions: {},
            lastIndex: 0,
            updatedAt: Date.now()
        };

        if (book.visibility === 'public' && !await publishPublic(book)) book.visibility = 'private';
        if (await saveBookCloud(book)) renderLibrary(bookId);
    } catch (err) {
        alert("Erreur import : " + err.message);
    } finally {
        label.textContent = "+ Importer un livre EPUB";
        $('file-input').value = '';
    }
}

function openBookSettings(bookId) {
    const book = accountBooks.find(b => b.id === bookId);
    if (!book) return;
    settingsBookId = book.id;
    $('book-settings-title').textContent = book.title;
    renderBookSettingsModal(book);
    $('book-settings-overlay').hidden = false;
}

function renderBookSettingsModal(book) {
    if (!book) return;
    const isPub = book.visibility === 'public';
    const isOwner = !book.sharedBy || book.sharedBy === syncKey || book.sharedBy === "Anonyme";

    $('book-visibility-badge').textContent = `Statut : ${isPub ? 'Public' : 'Privé'}`;
    const visBtn = $('settings-vis-btn');
    if (visBtn) {
        visBtn.hidden = isPub && !isOwner;
        visBtn.disabled = false;
        visBtn.textContent = isPub ? 'Rendre privé' : 'Rendre public';
        visBtn.onclick = async () => {
            visBtn.disabled = true;
            if (!isPub) {
                book.visibility = (await publishPublic(book)) ? 'public' : 'private';
            } else {
                await fb(`focus_read_public_books/${encodeURIComponent(book.publicId || book.id)}`, "DELETE").catch(() => {});
                book.visibility = 'private';
            }
            book.updatedAt = Date.now();
            await saveBookCloud(book);
            renderBookSettingsModal(book);
            renderLibrary(book.id);
        };
    }

    const delBtn = $('settings-del-btn');
    if (delBtn) {
        delBtn.disabled = false;
        delBtn.onclick = async () => {
            const readCount = (book.readChapters || []).filter(id => book.chapters.some(c => c.id === id)).length;
            if (!accountLoaded || !syncKey || !book.id) return;
            if (!confirm(`Voulez-vous vraiment supprimer "${book.title}" et sa progression (${readCount}/${book.chapters.length} ch.) ?`)) return;
            const typed = prompt(`Pour confirmer la suppression définitive, tapez : SUPPRIMER`);
            if (typed !== "SUPPRIMER") return;

            delBtn.disabled = true;
            isSaving = true;
            try {
                if (!await canWriteAccount()) return alert("Accès refusé.");
                await fb(`focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(book.id)}`, "DELETE");
                if (isPub && isOwner) await fb(`focus_read_public_books/${encodeURIComponent(book.publicId || book.id)}`, "DELETE").catch(() => {});
                accountBooks = accountBooks.filter(b => b.id !== book.id);
                $('book-settings-overlay').hidden = true;
                settingsBookId = null;
                renderLibrary();
            } finally {
                isSaving = false;
                delBtn.disabled = false;
            }
        };
    }

    const container = $('book-chapters-manager');
    const countEl = $('book-settings-count');
    if (!container) return;

    const readSet = new Set(book.readChapters || []);
    countEl.textContent = `${book.chapters.length} chapitre${book.chapters.length > 1 ? 's' : ''}`;

    if (!book.chapters.length) {
        container.innerHTML = '<div class="row static-row"><span class="muted">Aucun chapitre.</span></div>';
        return;
    }

    container.innerHTML = '';
    book.chapters.forEach((chap, idx) => {
        const isRead = readSet.has(chap.id);
        const pages = Math.max(1, Math.round((chap.wordCount || 0) / 250));
        const row = document.createElement('div');
        row.className = 'row static-row';
        row.innerHTML = `
            <div class="row-info">
                <span class="row-title">${idx + 1}. ${esc(stripChapterPrefix(chap.label, idx))}</span>
                <span class="row-sub">~${pages} p.${isRead ? ' · Validé' : ''}</span>
            </div>
            <div class="row-btns">
                <button type="button" class="btn-mini btn-up" ${idx === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
                <button type="button" class="btn-mini btn-down" ${idx === book.chapters.length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
                <button type="button" class="btn-mini btn-rm" ${book.chapters.length <= 1 ? 'disabled' : ''}>Suppr.</button>
            </div>
        `;

        row.querySelector('.btn-up').onclick = async () => {
            if (idx === 0) return;
            const copy = [...book.chapters];
            [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
            await commitChapterChanges(book, copy);
        };

        row.querySelector('.btn-down').onclick = async () => {
            if (idx >= book.chapters.length - 1) return;
            const copy = [...book.chapters];
            [copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
            await commitChapterChanges(book, copy);
        };

        row.querySelector('.btn-rm').onclick = async () => {
            if (book.chapters.length <= 1) return;
            if (!confirm(`Supprimer le chapitre "${stripChapterPrefix(chap.label, idx)}" ?`)) return;
            const copy = book.chapters.filter((_, i) => i !== idx);
            await commitChapterChanges(book, copy);
        };

        container.appendChild(row);
    });
}

async function commitChapterChanges(book, nextChapters) {
    const reindexed = reindexChaptersAndProgress(nextChapters, book.readChapters, book.pausedPositions);
    book.chapters = reindexed.chapters;
    book.readChapters = reindexed.readChapters;
    book.pausedPositions = reindexed.pausedPositions;
    book.lastIndex = Math.max(0, Math.min(book.lastIndex || 0, Math.max(0, book.chapters.length - 1)));
    book.updatedAt = Date.now();

    if (book.visibility === 'public') await publishPublic(book);
    await saveBookCloud(book);
    renderBookSettingsModal(book);
    renderLibrary(book.id);
}

async function handleAppendChapters(e) {
    const file = e.target.files[0];
    const book = accountBooks.find(b => b.id === settingsBookId);
    if (!file || !book) {
        $('append-chapters-input').value = '';
        return;
    }

    const btn = $('add-chapters-btn');
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Ajout...";

    try {
        if (!file.name.toLowerCase().endsWith('.epub')) {
            throw new Error("Seuls les fichiers .epub sont pris en charge.");
        }
        const { chapters: incoming } = await parseEpub(file);
        if (!incoming.length) throw new Error("Aucun chapitre lisible trouvé dans ce fichier.");

        const prevLen = book.chapters.length;
        const added = appendChaptersToBook(book, incoming);
        if (added > 0) {
            book.lastIndex = prevLen;
            book.updatedAt = Date.now();
            if (book.visibility === 'public') await publishPublic(book);
            await saveBookCloud(book);
            renderBookSettingsModal(book);
            renderLibrary(book.id);
            alert(`${added} chapitre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''} à "${book.title}".`);
        } else {
            alert("Aucun nouveau chapitre à ajouter.");
        }
    } catch (err) {
        alert("Erreur ajout chapitres : " + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = prevText;
        $('append-chapters-input').value = '';
    }
}

async function parseEpub(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const parser = new DOMParser();
    const containerXml = await zip.file("META-INF/container.xml")?.async("text");
    if (!containerXml) throw new Error("EPUB invalide.");

    const opfPath = parser.parseFromString(containerXml, "application/xml").querySelector("rootfile")?.getAttribute("full-path");
    if (!opfPath) throw new Error("Fichier OPF introuvable.");

    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfDoc = parser.parseFromString(await zip.file(opfPath).async("text"), "application/xml");

    const bookTitle = opfDoc.querySelector("metadata title, dc\\:title")?.textContent.trim() || file.name.replace(/\.epub$/i, '');
    const manifest = Object.fromEntries([...opfDoc.querySelectorAll("manifest > item")].map(i => [i.getAttribute("id"), i.getAttribute("href")]));

    const chapters = [];
    for (const ref of opfDoc.querySelectorAll("spine > itemref")) {
        const href = manifest[ref.getAttribute("idref")];
        const entry = href && zip.file(decodeURIComponent(opfDir + href.split('#')[0]));
        if (!entry) continue;

        const doc = parser.parseFromString(await entry.async("text"), "text/html");
        doc.querySelectorAll("style, script, nav").forEach(el => el.remove());

        let heading = doc.querySelector("h1, h2, h3")?.textContent.replace(/\s+/g, ' ').replace(/^chapitre\s*\d+\s*[:.-]?\s*/i, '').trim() || "";
        if (heading.length > 42) heading = heading.slice(0, 39) + "...";

        const blocks = [...doc.querySelectorAll("p, div")]
            .filter(el => el.children.length === 0 || el.tagName === 'P')
            .map(el => el.textContent.replace(/\s+/g, ' ').trim())
            .filter(Boolean);

        const text = blocks.length ? blocks.join('\n\n') : (doc.body?.textContent.replace(/\s+/g, ' ').trim() || "");
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount < 45) continue;

        const num = chapters.length + 1;
        chapters.push({
            id: `chap_${num}`,
            chapterNum: num,
            label: heading || `Partie ${num}`,
            text,
            wordCount
        });
    }
    return { bookTitle, chapters };
}

async function publishPublic(book) {
    if (!navigator.onLine) return false;
    try {
        const pubId = book.publicId || `${slugifyTitle(book.title)}_${Date.now()}`;
        book.publicId = pubId;
        await fb(`focus_read_public_books/${encodeURIComponent(pubId)}`, "PUT", {
            id: pubId, localId: book.id, title: book.title, fileName: book.fileName,
            sharedBy: syncKey || "Anonyme", chapterCount: book.chapters.length, publishedAt: Date.now()
        });
        for (let i = 0; i < book.chapters.length; i++) {
            await fb(`focus_read_public_books/${encodeURIComponent(pubId)}/chapters/${i}`, "PUT", book.chapters[i]);
        }
        return true;
    } catch {
        return false;
    }
}

function renderLibrary(selectedId = null) {
    const books = [...accountBooks].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const list = $('library-list');

    if (!books.length) {
        $('library-box').hidden = true;
        $('chapter-selector-box').hidden = true;
        $('start-btn').disabled = true;
        $('start-btn').textContent = "Sélectionnez un livre";
        activeBook = null;
        return;
    }

    $('library-box').hidden = false;
    const current = books.find(b => b.id === (selectedId || activeBook?.id)) || books[0];
    list.innerHTML = '';

    books.forEach(book => {
        const readCount = (book.readChapters || []).filter(id => book.chapters.some(c => c.id === id)).length;
        const isPub = book.visibility === 'public';

        const row = document.createElement('div');
        row.className = `row ${book.id === current.id ? 'active' : ''}`;
        row.innerHTML = `
            <div class="row-info">
                <span class="row-title">${esc(book.title)}</span>
                <span class="row-sub">${readCount}/${book.chapters.length} ch. · ${isPub ? 'Public' : 'Privé'}</span>
            </div>
            <div class="row-btns">
                <button type="button" class="btn-mini btn-cfg">Paramètres</button>
            </div>
        `;

        row.querySelector('.row-info').onclick = () => renderLibrary(book.id);
        row.querySelector('.btn-cfg').onclick = e => {
            e.stopPropagation();
            openBookSettings(book.id);
        };

        list.appendChild(row);
    });

    activeBook = current;
    const readSet = new Set(current.readChapters || []);
    const readCount = current.chapters.filter(c => readSet.has(c.id)).length;
    const pct = Math.round((readCount / current.chapters.length) * 100);

    $('book-title-label').textContent = current.title;
    $('book-progress-text').textContent = `${readCount}/${current.chapters.length} (${pct}%)`;
    $('book-progress-bar-fill').style.width = `${pct}%`;

    const select = $('chapter-select');
    select.innerHTML = current.chapters.map((c, i) => {
        const tag = readSet.has(c.id) ? "✓ " : (current.pausedPositions?.[c.id] > 0 ? "⏸ " : "");
        const chapTitle = stripChapterPrefix(c.label, i);
        const pages = Math.max(1, Math.round((c.wordCount || 0) / 250));
        return `<option value="${i}">${tag}${esc(chapTitle)} (~${pages} p.)</option>`;
    }).join('');

    $('chapter-selector-box').hidden = false;
    $('start-btn').disabled = false;
    selectChapter(Math.min(current.lastIndex || 0, current.chapters.length - 1), false);
}

async function selectChapter(idx, save = true) {
    if (!activeBook) return;
    currentChapterIndex = parseInt(idx, 10) || 0;
    const chap = activeBook.chapters[currentChapterIndex];
    if (!chap) return;

    $('chapter-select').value = currentChapterIndex;
    const isPaused = activeBook.pausedPositions?.[chap.id] > 0;
    const isRead = isChapterValidated(activeBook, chap);
    $('start-btn').textContent = isPaused ? "Reprendre la lecture" : (isRead ? "Relire le chapitre (validé)" : "Lire le chapitre");

    if (save && activeBook.lastIndex !== currentChapterIndex) {
        activeBook.lastIndex = currentChapterIndex;
        activeBook.updatedAt = Date.now();
        await saveBookProgress(activeBook);
    }
}

// --- DÉFILEMENT AUTOMATIQUE ---

const AUTO_SPEEDS = [0.5, 1, 1.5, 2, 3];
let autoSpeedIdx = parseInt(localStorage.getItem("focus_read_autoscroll_speed_idx") || "1", 10);
if (isNaN(autoSpeedIdx) || autoSpeedIdx < 0 || autoSpeedIdx >= AUTO_SPEEDS.length) autoSpeedIdx = 1;

let autoScrollActive = false;
let autoScrollRafId = null;
let autoScrollLastTime = 0;
let autoScrollRemainder = 0;

function updateAutoScrollButtons() {
    const toggleBtn = $('autoscroll-toggle-btn');
    const speedBtn = $('autoscroll-speed-btn');
    if (toggleBtn) toggleBtn.classList.toggle('active-mode', autoScrollActive);
    if (speedBtn) speedBtn.textContent = `${AUTO_SPEEDS[autoSpeedIdx]}x`;
}

function stopAutoScroll() {
    autoScrollActive = false;
    autoScrollRemainder = 0;
    if (autoScrollRafId) {
        cancelAnimationFrame(autoScrollRafId);
        autoScrollRafId = null;
    }
    updateAutoScrollButtons();
}

function autoScrollStep(timestamp) {
    if (!autoScrollActive || $('game-screen')?.hidden) {
        stopAutoScroll();
        return;
    }
    if (!autoScrollLastTime) autoScrollLastTime = timestamp;
    const dt = Math.min(100, timestamp - autoScrollLastTime);
    autoScrollLastTime = timestamp;

    const pxPerSec = 26 * AUTO_SPEEDS[autoSpeedIdx];
    autoScrollRemainder += (pxPerSec * dt) / 1000;

    if (autoScrollRemainder >= 1) {
        const stepPx = Math.floor(autoScrollRemainder);
        autoScrollRemainder -= stepPx;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (window.scrollY >= maxScroll - 1) {
            stopAutoScroll();
            return;
        }
        window.scrollBy(0, stepPx);
    }

    autoScrollRafId = requestAnimationFrame(autoScrollStep);
}

function toggleAutoScroll() {
    if (autoScrollActive) {
        stopAutoScroll();
    } else {
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (maxScroll <= 0 || window.scrollY >= maxScroll - 1) return;
        autoScrollActive = true;
        autoScrollLastTime = 0;
        autoScrollRemainder = 0;
        updateAutoScrollButtons();
        autoScrollRafId = requestAnimationFrame(autoScrollStep);
    }
}

function cycleAutoScrollSpeed() {
    autoSpeedIdx = (autoSpeedIdx + 1) % AUTO_SPEEDS.length;
    localStorage.setItem("focus_read_autoscroll_speed_idx", String(autoSpeedIdx));
    updateAutoScrollButtons();
}

// --- LECTURE & GÉNÉRATION DE QUIZ ROBUSTE (GEMINI + GROQ SECOURS) ---

function startReading() {
    stopAutoScroll();
    const chap = activeBook?.chapters[currentChapterIndex];
    if (!chap) return;
    activeText = chap.text;
    const validated = isChapterValidated(activeBook, chap);
    const qCount = questionCount(chap.wordCount || activeText.split(/\s+/).length);

    $('hud-chapter-title').textContent = chap.label;
    $('finish-reading-btn').textContent = validated
        ? "Chapitre déjà validé · Retour à l'accueil"
        : `Terminer & Lancer le quiz (${qCount} questions)`;
    $('text-track').textContent = activeText;
    updateAutoScrollButtons();

    showView('game-screen');
    requestAnimationFrame(() => {
        window.scrollTo(0, activeBook.pausedPositions?.[chap.id] || 0);
        updateScroll();
    });
}

async function pauseReading() {
    stopAutoScroll();
    const chap = activeBook?.chapters[currentChapterIndex];
    const btn = $('pause-reading-btn');
    if (btn) btn.disabled = true;

    if (chap) {
        activeBook.pausedPositions = { ...(activeBook.pausedPositions || {}), [chap.id]: Math.round(window.scrollY) };
        activeBook.lastIndex = currentChapterIndex;
        activeBook.updatedAt = Date.now();
        await saveBookProgress(activeBook);
    }
    if (btn) btn.disabled = false;
    showView('setup-screen');
    renderLibrary(activeBook?.id);
}

function updateScroll() {
    if ($('game-screen').hidden) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    $('scroll-percent').textContent = max <= 0 ? "100%" : `${Math.min(100, Math.round((window.scrollY / max) * 100))}%`;
}

function prepareTextForQuiz(text, maxChars = 28000) {
    if (text.length <= maxChars) return text;
    const part = Math.floor(maxChars / 3);
    const mid = Math.floor((text.length - part) / 2);
    return `${text.slice(0, part)}\n[...]\n${text.slice(mid, mid + part)}\n[...]\n${text.slice(-part)}`;
}

function buildQuizPrompt(excerpt, qCount, rootAsObject = false) {
    const schema = rootAsObject
        ? `{"questions":[{"question":"...","options":["Choix 1","Choix 2","Choix 3","Choix 4"],"answer":0,"explanation":"Explication courte"}]}`
        : `[{"question":"...","options":["Choix 1","Choix 2","Choix 3","Choix 4"],"answer":0,"explanation":"Explication courte"}]`;

    return `Tu es un professeur exigeant. À partir du texte suivant, génère exactement ${qCount} questions QCM de compréhension à 4 choix (index 0, 1, 2 ou 3) couvrant l'ensemble du passage.\nRègles strictes pour éviter que la bonne réponse soit devinable : les 4 options doivent avoir une longueur comparable (environ 8 à 18 mots chacune), un niveau de précision et un style de formulation identiques, sans indices ni détails superflus réservés à la bonne réponse.\nFormat JSON attendu : ${schema}\n\nTexte :\n"""\n${excerpt}\n"""`;
}

async function callGeminiQuiz(apiKey, text, qCount) {
    const models = ["gemini-3.5-flash-lite"];
    const excerpt = prepareTextForQuiz(text, 28000);
    const prompt = buildQuizPrompt(excerpt, qCount, false);

    const errors = [];
    for (const model of models) {
        try {
            const res = await fetchWithTimeout(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            temperature: 0.3
                        }
                    })
                },
                30000
            );

            const json = await res.json();
            if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);

            const raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
            const match = raw.match(/\[[\s\S]*\]/);
            if (!match) throw new Error("Réponse JSON introuvable.");

            const valid = sanitizeQuestions(JSON.parse(match[0]));
            if (!valid.length) throw new Error("Aucune question valide générée.");
            return valid;
        } catch (err) {
            errors.push(`${model} : ${err.message}`);
        }
    }
    throw new Error(errors.join(" | ") || "Impossible de générer le quiz avec Gemini.");
}

async function callGroqQuiz(groqKey, text, qCount) {
    // Modèles gratuits Groq proches de Flash-Lite, calibrés sous la limite gratuite de 8 000 TPM
    const models = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"];
    const excerpt = prepareTextForQuiz(text, 16000);
    const prompt = buildQuizPrompt(excerpt, qCount, true);

    const errors = [];
    for (const model of models) {
        try {
            const res = await fetchWithTimeout(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${groqKey}`
                    },
                    body: JSON.stringify({
                        model,
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" },
                        temperature: 0.3
                    })
                },
                30000
            );

            const json = await res.json();
            if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);

            const raw = json.choices?.[0]?.message?.content || "";
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : (parsed.questions || parsed.quiz || []);
            const valid = sanitizeQuestions(list);
            if (!valid.length) throw new Error("Aucune question valide générée.");
            return valid;
        } catch (err) {
            errors.push(`${model} : ${err.message}`);
        }
    }
    throw new Error(errors.join(" | ") || "Impossible de générer le quiz avec Groq.");
}

function getConfiguredApiKeys() {
    const storedGemini = localStorage.getItem("focus_read_gemini_key") || "";
    const geminiKey = $('api-key')?.value.trim() || storedGemini || DEFAULT_API_KEY;

    const groqInput = $('groq-api-key');
    const storedGroq = localStorage.getItem("focus_read_groq_key") || "";
    const groqKey = geminiKey
        ? (groqInput ? groqInput.value.trim() : (storedGroq || DEFAULT_GROQ_API_KEY))
        : "";

    return { geminiKey, groqKey };
}

async function generateQuizWithFallback(text, qCount) {
    const { geminiKey, groqKey } = getConfiguredApiKeys();

    if (!geminiKey) {
        throw new Error("Une clé API Gemini est requise avant d'utiliser Groq.");
    }

    try {
        return await callGeminiQuiz(geminiKey, text, qCount);
    } catch (e) {
        if (!groqKey) {
            throw new Error(`Gemini (${e.message})`);
        }
        try {
            return await callGroqQuiz(groqKey, text, qCount);
        } catch (groqErr) {
            throw new Error(`Gemini (${e.message}) → Groq (${groqErr.message})`);
        }
    }
}

async function finishAndQuiz() {
    stopAutoScroll();
    const chap = activeBook?.chapters[currentChapterIndex];

    if (isChapterValidated(activeBook, chap)) {
        if (activeBook?.pausedPositions?.[chap.id]) {
            delete activeBook.pausedPositions[chap.id];
            await saveBookProgress(activeBook);
        }
        showView('setup-screen');
        renderLibrary(activeBook?.id);
        return;
    }

    const { geminiKey } = getConfiguredApiKeys();

    if (!geminiKey) {
        await pauseReading();
        if ($('api-details-box')) $('api-details-box').open = true;
        alert("Renseignez d'abord votre clé API Gemini en bas de l'accueil pour générer le quiz (votre position de lecture a été sauvegardée).");
        return;
    }

    const qCount = questionCount(chap?.wordCount || activeText.split(/\s+/).length);
    const btn = $('finish-reading-btn');
    btn.disabled = true;
    btn.textContent = "Création du quiz en cours...";

    try {
        generatedQuiz = await generateQuizWithFallback(activeText, qCount);

        if (activeBook?.pausedPositions?.[chap?.id]) {
            delete activeBook.pausedPositions[chap.id];
            await saveBookProgress(activeBook);
        }
        renderQuiz();
    } catch (e) {
        alert("Erreur lors de la génération du quiz : " + (e.name === 'AbortError' ? "Délai dépassé (vérifiez votre connexion)." : e.message));
    } finally {
        btn.disabled = false;
        btn.textContent = `Terminer & Lancer le quiz (${qCount} questions)`;
    }
}

function renderQuiz() {
    userAnswers = {};
    $('quiz-title').textContent = `Quiz (${generatedQuiz.length} questions)`;
    $('abandon-quiz-btn').hidden = false;
    $('submit-quiz-btn').hidden = false;
    $('retry-chapter-btn').hidden = true;
    $('next-chapter-btn').hidden = true;
    $('restart-btn').hidden = true;

    const box = $('quiz-container');
    box.innerHTML = '';
    generatedQuiz.forEach((q, qi) => {
        const div = document.createElement('div');
        div.className = 'q-block';
        div.innerHTML = `<p>${qi + 1}. ${esc(q.question)}</p>`;
        q.options.forEach((opt, oi) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'q-opt';
            b.textContent = opt;
            b.onclick = () => {
                userAnswers[qi] = oi;
                div.querySelectorAll('.q-opt').forEach(x => x.classList.remove('selected'));
                b.classList.add('selected');
            };
            div.appendChild(b);
        });
        box.appendChild(div);
    });
    applyFontSize();
    showView('quiz-screen');
}

async function evaluateQuiz() {
    if (Object.keys(userAnswers).length < generatedQuiz.length) return alert("Répondez à toutes les questions.");

    const chap = activeBook.chapters[currentChapterIndex];
    const alreadyValidated = isChapterValidated(activeBook, chap);

    let score = 0;
    document.querySelectorAll('.q-block').forEach((div, qi) => {
        const q = generatedQuiz[qi];
        const chosen = userAnswers[qi];
        if (chosen === q.answer) score++;

        div.querySelectorAll('.q-opt').forEach((b, i) => {
            b.disabled = true;
            if (i === chosen) b.classList.add('selected');
            else b.classList.remove('selected');
        });
    });

    const total = generatedQuiz.length;
    const perfect = score === total;
    const pts = (!alreadyValidated && perfect) ? (total * 10 + 20) : 0;

    if (!alreadyValidated) {
        userStats.quizzesCompleted += 1;
        if (perfect) {
            userStats.scoreTotal += pts;
            userStats.perfectScores += 1;
            activeBook.readChapters = mergeReadChapters(activeBook.readChapters, [chap.id]);
            userStats.totalChaptersRead += 1;
            if (userStats.lastReadDate === dateKey(-1)) userStats.streakDays = (userStats.streakDays || 0) + 1;
            else if (userStats.lastReadDate !== dateKey(0)) userStats.streakDays = 1;
            userStats.lastReadDate = dateKey(0);
            activeBook.updatedAt = Date.now();
            await saveBookProgress(activeBook);
        }
        renderStats();
        await pushStats();
    }

    $('quiz-container').insertAdjacentHTML('afterbegin', `
        <div class="score-banner">
            <strong>${score} / ${total} (${Math.round((score / total) * 100)}%)</strong>
        </div>
    `);

    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('abandon-quiz-btn').hidden = true;
    $('submit-quiz-btn').hidden = true;
    $('restart-btn').hidden = false;
    $('retry-chapter-btn').hidden = perfect || alreadyValidated;
    if (currentChapterIndex + 1 < activeBook.chapters.length) {
        $('next-chapter-btn').textContent = `Lire ${activeBook.chapters[currentChapterIndex + 1].label} →`;
        $('next-chapter-btn').hidden = false;
    }
}

// --- MODALES ---

async function openCommunity() {
    $('community-overlay').hidden = false;
    const list = $('community-list');
    list.innerHTML = '<div class="row"><span class="muted">Chargement...</span></div>';

    try {
        const data = await fb('focus_read_public_books');
        if (!data) return (list.innerHTML = '<div class="row"><span class="muted">Aucun livre disponible.</span></div>');

        const owned = new Set(accountBooks.flatMap(b => [b.id, b.publicId, `book_${slugifyTitle(b.title)}`].filter(Boolean)));
        list.innerHTML = '';
        Object.values(data).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).forEach(pub => {
            const stableId = cleanKey(pub.localId || `book_${slugifyTitle(pub.title)}`);
            const has = owned.has(pub.id) || owned.has(pub.localId) || owned.has(stableId);
            const row = document.createElement('div');
            row.className = 'row';
            row.innerHTML = `
                <div class="row-info">
                    <span class="row-title">${esc(pub.title)}</span>
                    <span class="row-sub">${esc(pub.sharedBy || "Anonyme")} · ${pub.chapterCount || "?"} ch.</span>
                </div>
                <button type="button" class="btn-mini" ${has ? 'disabled' : ''}>${has ? 'Ajouté' : '+ Ajouter'}</button>
            `;
            const btn = row.querySelector('button');
            if (!has) btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = "...";
                const chaps = toArray(pub.chapters).filter(c => c && c.text);
                if (!chaps.length) {
                    btn.disabled = false;
                    btn.textContent = "+ Ajouter";
                    return alert("Livre vide.");
                }
                const ok = await saveBookCloud({
                    id: stableId, publicId: pub.id, title: pub.title, fileName: pub.fileName,
                    visibility: 'public', sharedBy: pub.sharedBy, chapters: chaps, readChapters: [], pausedPositions: {}, lastIndex: 0, updatedAt: Date.now()
                });
                if (ok) { renderLibrary(stableId); btn.textContent = "Ajouté"; }
                else { btn.disabled = false; btn.textContent = "+ Ajouter"; }
            };
            list.appendChild(row);
        });
    } catch (e) {
        list.innerHTML = `<div class="row"><span class="muted">Erreur : ${e.message}</span></div>`;
    }
}

async function openLeaderboard() {
    $('leaderboard-overlay').hidden = false;
    updateAccountUI();
    const list = $('leaderboard-list');
    list.innerHTML = '<div class="row"><span class="muted">Chargement...</span></div>';

    try {
        const data = await fb('focus_read_users');
        if (!data) return (list.innerHTML = '<div class="row"><span class="muted">Aucun lecteur.</span></div>');

        const ranked = Object.entries(data)
            .map(([k, v]) => {
                const ratio = getQuizSuccessRatio(v);
                const ch = v.totalChaptersRead || v.perfectScores || 0;
                return {
                    k,
                    pts: v.scoreTotal || 0,
                    ch,
                    st: getStreak(v),
                    ratioText: ratio === null ? "Ratio —" : `Ratio ${ratio}% (${v.perfectScores || 0}/${v.quizzesCompleted || 0})`
                };
            })
            .filter(p => p.ch > 0)
            .sort((a, b) => b.pts - a.pts)
            .slice(0, 30);

        if (!ranked.length) {
            return (list.innerHTML = '<div class="row"><span class="muted">Aucun lecteur ayant complété au moins un chapitre.</span></div>');
        }

        list.innerHTML = ranked.map((p, i) => `
            <div class="row ${p.k === syncKey ? 'me' : ''}">
                <div class="row-info">
                    <span class="row-title">${i + 1}. ${esc(p.k)}</span>
                    <span class="row-sub">Série ${p.st} j · ${p.ch} ch. · ${p.ratioText}</span>
                </div>
                <strong>${p.pts} pts</strong>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = `<div class="row"><span class="muted">Erreur : ${e.message}</span></div>`;
    }
}

// --- ÉVÉNEMENTS & INIT ---

const syncApiKeyInputsState = () => {
    const geminiVal = ($('api-key')?.value.trim() || DEFAULT_API_KEY || "");
    const groqInput = $('groq-api-key');
    if (!groqInput) return;

    if (!geminiVal) {
        groqInput.value = "";
        groqInput.disabled = true;
        localStorage.removeItem("focus_read_groq_key");
    } else {
        groqInput.disabled = false;
        if (!groqInput.value.trim()) {
            const restored = localStorage.getItem("focus_read_groq_key") || DEFAULT_GROQ_API_KEY || "";
            if (restored) groqInput.value = restored;
        }
    }
};

const updateApiTag = () => {
    syncApiKeyInputsState();
    const { geminiKey, groqKey } = getConfiguredApiKeys();
    if ($('api-status-tag')) {
        if (geminiKey && groqKey) $('api-status-tag').textContent = "OK + Secours";
        else if (geminiKey) $('api-status-tag').textContent = "OK";
        else $('api-status-tag').textContent = "Requise";
    }
    if (!geminiKey && $('api-details-box')) $('api-details-box').open = true;
};

on('api-key', 'oninput', e => {
    const v = e.target.value.trim();
    v ? localStorage.setItem("focus_read_gemini_key", v) : localStorage.removeItem("focus_read_gemini_key");
    updateApiTag();
});

on('groq-api-key', 'oninput', e => {
    const { geminiKey } = getConfiguredApiKeys();
    if (!geminiKey) {
        e.target.value = "";
        localStorage.removeItem("focus_read_groq_key");
        updateApiTag();
        return;
    }
    const v = e.target.value.trim();
    v ? localStorage.setItem("focus_read_groq_key", v) : localStorage.removeItem("focus_read_groq_key");
    updateApiTag();
});

on('file-drop-zone', 'onclick', () => $('file-input')?.click());
on('file-input', 'onchange', handleFileUpload);
on('add-chapters-btn', 'onclick', () => $('append-chapters-input')?.click());
on('append-chapters-input', 'onchange', handleAppendChapters);
on('chapter-select', 'onchange', e => selectChapter(e.target.value, true));

on('start-btn', 'onclick', startReading);
on('pause-reading-btn', 'onclick', pauseReading);
on('autoscroll-toggle-btn', 'onclick', toggleAutoScroll);
on('autoscroll-speed-btn', 'onclick', cycleAutoScrollSpeed);
window.addEventListener('scroll', updateScroll, { passive: true });
window.addEventListener('wheel', () => { if (autoScrollActive) stopAutoScroll(); }, { passive: true });
window.addEventListener('touchstart', () => { if (autoScrollActive) stopAutoScroll(); }, { passive: true });
on('finish-reading-btn', 'onclick', finishAndQuiz);

on('abandon-quiz-btn', 'onclick', () => confirm("Quitter le quiz ?") && (showView('setup-screen'), renderLibrary(activeBook?.id)));
on('submit-quiz-btn', 'onclick', evaluateQuiz);
on('retry-chapter-btn', 'onclick', startReading);
on('next-chapter-btn', 'onclick', async () => { await selectChapter(currentChapterIndex + 1, true); startReading(); });
on('restart-btn', 'onclick', () => { showView('setup-screen'); renderLibrary(activeBook?.id); });

on('btnSyncKey', 'onclick', switchAccount);
on('btnTutorial', 'onclick', () => { if ($('tutorial-overlay')) $('tutorial-overlay').hidden = false; });
on('btnCommunity', 'onclick', openCommunity);
on('btnLeaderboard', 'onclick', openLeaderboard);

document.querySelectorAll('[data-close]').forEach(btn => btn.onclick = () => {
    const target = $(btn.dataset.close);
    if (target) target.hidden = true;
});
document.querySelectorAll('.modal-bg').forEach(ov => ov.onclick = e => { if (e.target === ov) ov.hidden = true; });

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopAutoScroll();
    if (document.visibilityState === 'visible' && syncKey && !$('setup-screen').hidden) {
        pullAccount(true);
    }
});

// --- TAILLE DU TEXTE (LECTURE & QUIZ) ---
let readFontSize = parseFloat(localStorage.getItem("focus_read_font_size")) || 1.15;
const applyFontSize = () => {
    const sizeCss = `${readFontSize.toFixed(2)}rem`;
    document.documentElement.style.setProperty('--read-size', sizeCss);
    localStorage.setItem("focus_read_font_size", readFontSize.toFixed(2));
    updateScroll();
};
const decreaseFontSize = () => {
    readFontSize = Math.max(0.85, readFontSize - 0.1);
    applyFontSize();
};
const increaseFontSize = () => {
    readFontSize = Math.min(1.75, readFontSize + 0.1);
    applyFontSize();
};

on('font-dec-btn', 'onclick', decreaseFontSize);
on('font-inc-btn', 'onclick', increaseFontSize);
on('quiz-font-dec-btn', 'onclick', decreaseFontSize);
on('quiz-font-inc-btn', 'onclick', increaseFontSize);
applyFontSize();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

(async () => {
    if ($('api-key')) $('api-key').value = localStorage.getItem("focus_read_gemini_key") || DEFAULT_API_KEY;
    if ($('groq-api-key')) $('groq-api-key').value = localStorage.getItem("focus_read_groq_key") || DEFAULT_GROQ_API_KEY;
    updateApiTag();
    updateAccountUI();
    renderStats();
    await pullAccount();
})();
