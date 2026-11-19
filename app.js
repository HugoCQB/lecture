const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };

const RAW_DB_URL = (typeof ENV !== 'undefined' && ENV.FIREBASE_DB_URL)
    ? ENV.FIREBASE_DB_URL
    : "https://antibrainrotting-4f194-default-rtdb.europe-west1.firebasedatabase.app";
const DB_URL = RAW_DB_URL.replace(/\/+$/, '');

const DEFAULT_API_KEY = (typeof ENV !== 'undefined' && ENV.DEFAULT_GEMINI_API_KEY)
    ? ENV.DEFAULT_GEMINI_API_KEY : "";

let accountBooks = [];
let activeBook = null;
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

const dateKey = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const toArray = val => Array.isArray(val) ? val : Object.values(val || {});
const mergeReadChapters = (...lists) => [...new Set(lists.flatMap(l => toArray(l)).filter(Boolean))];
const isChapterValidated = (book, chap) => Boolean(book && chap && toArray(book.readChapters).includes(chap.id));

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
        const mergedRead = mergeReadChapters(existingDistant?.readChapters, book.readChapters);
        const mergedPaused = { ...(existingDistant?.pausedPositions || {}), ...(book.pausedPositions || {}) };
        const mergedLastIndex = Math.max(existingDistant?.lastIndex || 0, book.lastIndex || 0);

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

        for (let i = 0; i < book.chapters.length; i += 5) {
            const patch = {};
            book.chapters.slice(i, i + 5).forEach((c, idx) => {
                const n = i + idx;
                patch[`chapters/${n}`] = {
                    id: c.id || `chap_${n + 1}`,
                    chapterNum: c.chapterNum || n + 1,
                    label: stripChapterPrefix(c.label, n),
                    text: c.text,
                    wordCount: c.wordCount || c.text.split(/\s+/).filter(Boolean).length
                };
            });
            await fb(base, "PATCH", patch);
        }

        const full = { ...meta, chapters: book.chapters };
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

// --- IMPORT EPUP & BIBLIOTHÈQUE ---

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

        const slugId = cleanKey(`book_${slugifyTitle(title)}`);
        const legacyId = cleanKey(`book_${file.name}_${file.size}`);
        const existing = accountBooks.find(b => b.id === slugId || b.id === legacyId || slugifyTitle(b.title) === slugifyTitle(title));
        const bookId = existing?.id || slugId;

        const book = {
            id: bookId,
            publicId: existing?.publicId || null,
            title,
            fileName: file.name,
            visibility: existing?.visibility || 'public',
            sharedBy: syncKey || "Anonyme",
            chapters,
            readChapters: mergeReadChapters(existing?.readChapters),
            pausedPositions: existing?.pausedPositions || {},
            lastIndex: existing ? Math.min(existing.lastIndex || 0, chapters.length - 1) : 0,
            updatedAt: Date.now()
        };

        if (book.visibility === 'public' && !await publishPublic(book)) book.visibility = 'private';
        if (await saveBookCloud(book)) renderLibrary(bookId);
    } catch (err) {
        alert("Erreur import : " + err.message);
    } finally {
        label.textContent = "+ Importer un livre (EPUB)";
        $('file-input').value = '';
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
        const isOwner = !book.sharedBy || book.sharedBy === syncKey || book.sharedBy === "Anonyme";

        const row = document.createElement('div');
        row.className = `row ${book.id === current.id ? 'active' : ''}`;
        row.innerHTML = `
            <div class="row-info">
                <span class="row-title">${esc(book.title)}</span>
                <span class="row-sub">${readCount}/${book.chapters.length} ch. · ${isPub ? 'Public' : 'Privé'}</span>
            </div>
            <div class="row-btns">
                ${(!isPub || isOwner) ? `<button type="button" class="btn-mini btn-vis">${isPub ? 'Privé' : 'Publier'}</button>` : ''}
                <button type="button" class="btn-mini btn-del">Suppr.</button>
            </div>
        `;

        row.querySelector('.row-info').onclick = () => renderLibrary(book.id);

        const visBtn = row.querySelector('.btn-vis');
        if (visBtn) visBtn.onclick = async e => {
            e.stopPropagation();
            visBtn.disabled = true;
            if (!isPub) {
                book.visibility = (await publishPublic(book)) ? 'public' : 'private';
            } else {
                await fb(`focus_read_public_books/${encodeURIComponent(book.publicId || book.id)}`, "DELETE").catch(() => {});
                book.visibility = 'private';
            }
            await saveBookCloud(book);
            renderLibrary(book.id);
        };

        row.querySelector('.btn-del').onclick = async e => {
            e.stopPropagation();
            if (!accountLoaded || !syncKey || !book.id) return;
            if (!confirm(`Voulez-vous vraiment supprimer "${book.title}" et sa progression (${readCount}/${book.chapters.length} ch.) ?`)) return;
            const typed = prompt(`Pour confirmer la suppression définitive, tapez : SUPPRIMER`);
            if (typed !== "SUPPRIMER") return;

            isSaving = true;
            try {
                if (!await canWriteAccount()) return alert("Accès refusé.");
                await fb(`focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(book.id)}`, "DELETE");
                if (isPub && isOwner) await fb(`focus_read_public_books/${encodeURIComponent(book.publicId || book.id)}`, "DELETE").catch(() => {});
                accountBooks = accountBooks.filter(b => b.id !== book.id);
                renderLibrary();
            } finally {
                isSaving = false;
            }
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

    // Vitesse de base en pixels par seconde modulée par le multiplicateur
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

// --- LECTURE & GÉNÉRATION DE QUIZ ROBUSTE ---

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

async function callGeminiQuiz(apiKey, text, qCount) {
    const models = ["gemini-3.5-flash-lite"];
    const excerpt = prepareTextForQuiz(text);
    const prompt = `Tu es un professeur exigeant. À partir du texte suivant, génère exactement ${qCount} questions QCM de compréhension à 3 choix (index 0, 1 ou 2) couvrant l'ensemble du passage.\nRègles strictes pour éviter que la bonne réponse soit devinable : les 3 options doivent avoir une longueur comparable (environ 8 à 18 mots chacune), un niveau de précision et un style de formulation identiques, sans indices ni détails superflus réservés à la bonne réponse.\nFormat JSON attendu : [{"question":"...","options":["Choix 1","Choix 2","Choix 3"],"answer":0,"explanation":"Explication courte"}]\n\nTexte :\n"""\n${excerpt}\n"""`;

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

            const parsed = JSON.parse(match[0]);
            const valid = parsed
                .filter(q =>
                    q && typeof q.question === 'string' &&
                    Array.isArray(q.options) && q.options.length >= 2 &&
                    typeof q.answer === 'number' && q.answer >= 0 && q.answer < q.options.length
                )
                .map(shuffleQuestionOptions);

            if (!valid.length) throw new Error("Aucune question valide générée.");
            return valid;
        } catch (err) {
            errors.push(`${model} : ${err.message}`);
        }
    }
    throw new Error(errors.join(" | ") || "Impossible de générer le quiz.");
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

    const storedKey = localStorage.getItem("focus_read_gemini_key") || "";
    const apiKey = $('api-key')?.value.trim() || storedKey || DEFAULT_API_KEY;

    if (!apiKey) {
        await pauseReading();
        if ($('api-details-box')) $('api-details-box').open = true;
        alert("Entrez votre clé API Gemini en bas de l'accueil pour générer le quiz (votre position de lecture a été sauvegardée).");
        return;
    }

    const qCount = questionCount(chap?.wordCount || activeText.split(/\s+/).length);
    const btn = $('finish-reading-btn');
    btn.disabled = true;
    btn.textContent = "Création du quiz en cours...";

    try {
        generatedQuiz = await callGeminiQuiz(apiKey, activeText, qCount);

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

const updateApiTag = () => {
    const ok = Boolean($('api-key')?.value.trim() || DEFAULT_API_KEY);
    if ($('api-status-tag')) $('api-status-tag').textContent = ok ? "OK" : "Requise";
    if (!ok && $('api-details-box')) $('api-details-box').open = true;
};

on('api-key', 'oninput', e => {
    const v = e.target.value.trim();
    v ? localStorage.setItem("focus_read_gemini_key", v) : localStorage.removeItem("focus_read_gemini_key");
    updateApiTag();
});

on('file-drop-zone', 'onclick', () => $('file-input')?.click());
on('file-input', 'onchange', handleFileUpload);
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

// --- TAILLE DU TEXTE DE LECTURE ---
let readFontSize = parseFloat(localStorage.getItem("focus_read_font_size")) || 1.15;
const applyFontSize = () => {
    document.documentElement.style.setProperty('--read-size', `${readFontSize.toFixed(2)}rem`);
    localStorage.setItem("focus_read_font_size", readFontSize.toFixed(2));
    updateScroll();
};
on('font-dec-btn', 'onclick', () => {
    readFontSize = Math.max(0.85, readFontSize - 0.1);
    applyFontSize();
});
on('font-inc-btn', 'onclick', () => {
    readFontSize = Math.min(1.75, readFontSize + 0.1);
    applyFontSize();
});
applyFontSize();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

(async () => {
    if ($('api-key')) $('api-key').value = localStorage.getItem("focus_read_gemini_key") || DEFAULT_API_KEY;
    updateApiTag();
    updateAccountUI();
    renderStats();
    await pullAccount();
})();
