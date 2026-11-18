const $ = id => document.getElementById(id);

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

let syncKey = localStorage.getItem("focus_read_sync_key") || null;
let currentKeyPassword = localStorage.getItem("focus_read_sync_pwd") || "";
let userStats = { scoreTotal: 0, quizzesCompleted: 0, perfectScores: 0, totalChaptersRead: 0, streakDays: 0, lastReadDate: null };

// --- UTILITAIRES & FIREBASE ---

const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const cleanKey = k => String(k).trim().replace(/[.#$\[\]/]/g, '_');
const dateKey = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function fb(path, method = "GET", body = null) {
    const cleanPath = path.replace(/^\/+/, '');
    const opts = { method, cache: "no-store" };
    if (body !== null) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${DB_URL}/${cleanPath}.json`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return method === "DELETE" ? true : res.json();
}

async function sha256(str) {
    if (!str) return null;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function showView(viewId) {
    ['setup-screen', 'game-screen', 'quiz-screen'].forEach(id => $(id).hidden = id !== viewId);
    window.scrollTo(0, 0);
}

function setSyncStatus(msg, online = false) {
    $('syncStatus').textContent = `Sync : ${msg}`;
    $('syncDot').classList.toggle('online', online);
}

// --- STATISTIQUES & STREAK ---

function getStreak(stats = userStats) {
    if (!stats?.lastReadDate || !stats?.streakDays) return 0;
    return (stats.lastReadDate === dateKey(0) || stats.lastReadDate === dateKey(-1)) ? stats.streakDays : 0;
}

function renderStats() {
    $('stat-streak').textContent = `${getStreak()} j`;
    $('stat-chapters').textContent = userStats.totalChaptersRead || 0;
    $('stat-score').textContent = userStats.scoreTotal || 0;
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

// --- COMPTE & SYNCHRONISATION ---

function updateAccountUI() {
    $('syncKeyLabel').textContent = syncKey ? `${syncKey}${currentKeyPassword ? " · 🔒" : ""}` : "Définir un compte";
    $('current-lb-key').textContent = syncKey || "—";
}

async function canWriteAccount() {
    const distantHash = await fb(`focus_read_users/${encodeURIComponent(syncKey)}/passwordHash`);
    return !distantHash || distantHash === await sha256(currentKeyPassword);
}

async function saveBookCloud(book) {
    if (!navigator.onLine) return alert("Connexion requise."), false;
    if (!syncKey) {
        syncKey = "READ-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateAccountUI();
    }

    book.id = cleanKey(book.id || `book_${Date.now()}`);
    setSyncStatus("Sauvegarde...");

    try {
        if (!await canWriteAccount()) return setSyncStatus("Accès refusé"), alert("Mot de passe incorrect."), false;

        const base = `focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(book.id)}`;
        const meta = {
            id: book.id,
            publicId: book.publicId || null,
            title: book.title || "Sans titre",
            fileName: book.fileName || "livre.epub",
            visibility: book.visibility || 'public',
            sharedBy: book.sharedBy || syncKey,
            readChapters: book.readChapters || [],
            pausedPositions: book.pausedPositions || {},
            lastIndex: book.lastIndex || 0,
            updatedAt: book.updatedAt || Date.now()
        };

        await fb(base, "PATCH", meta);

        for (let i = 0; i < book.chapters.length; i += 5) {
            const patch = {};
            book.chapters.slice(i, i + 5).forEach((c, idx) => {
                const n = i + idx;
                patch[`chapters/${n}`] = {
                    id: c.id || `chap_${n + 1}`,
                    chapterNum: c.chapterNum || n + 1,
                    label: c.label || `Chapitre ${n + 1}`,
                    text: c.text,
                    wordCount: c.wordCount || c.text.split(/\s+/).filter(Boolean).length
                };
            });
            await fb(base, "PATCH", patch);
        }

        const full = { ...meta, chapters: book.chapters };
        const idx = accountBooks.findIndex(b => b.id === book.id);
        idx >= 0 ? (accountBooks[idx] = full) : accountBooks.unshift(full);

        setSyncStatus("À jour", true);
        return true;
    } catch (e) {
        setSyncStatus(`Erreur sync (${e.message})`);
        alert("Erreur sauvegarde : " + e.message);
        return false;
    }
}

async function pullAccount() {
    if (!navigator.onLine) return setSyncStatus("Hors ligne");

    if (!syncKey) {
        const input = prompt("Entrez votre nom de compte existant (ou laissez vide pour en créer un) :");
        const cleaned = input ? cleanKey(input) : "";
        syncKey = cleaned || ("READ-" + Math.random().toString(36).substring(2, 8).toUpperCase());
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateAccountUI();
        if (!cleaned) return pushStats();
    }

    setSyncStatus("Chargement...");
    try {
        const data = await fb(`focus_read_users/${encodeURIComponent(syncKey)}`);
        if (!data) {
            setSyncStatus("Nouveau compte créé", true);
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
                localStorage.removeItem("focus_read_sync_key");
                localStorage.removeItem("focus_read_sync_pwd");
                updateAccountUI();
                return setSyncStatus("Accès refusé");
            }
            localStorage.setItem("focus_read_sync_pwd", currentKeyPassword);
            updateAccountUI();
        }

        userStats = {
            scoreTotal: data.scoreTotal || 0,
            quizzesCompleted: data.quizzesCompleted || 0,
            perfectScores: data.perfectScores || 0,
            totalChaptersRead: data.totalChaptersRead || data.perfectScores || 0,
            streakDays: data.streakDays || 0,
            lastReadDate: data.lastReadDate || null
        };
        renderStats();

        accountBooks = Object.values(data.library || {})
            .filter(b => b && b.chapters)
            .map(b => ({
                ...b,
                chapters: (Array.isArray(b.chapters) ? b.chapters : Object.values(b.chapters)).filter(c => c && c.text),
                readChapters: b.readChapters || [],
                pausedPositions: b.pausedPositions || {}
            }))
            .filter(b => b.chapters.length > 0);

        renderLibrary();
        setSyncStatus(`À jour (${accountBooks.length} livre${accountBooks.length > 1 ? 's' : ''})`, true);
    } catch (e) {
        console.error("Erreur pullAccount:", e);
        setSyncStatus(`Erreur (${e.message})`);
    }
}

async function pushStats() {
    if (!navigator.onLine || !syncKey) return;
    try {
        if (!await canWriteAccount()) return setSyncStatus("Écriture refusée");
        await fb(`focus_read_users/${encodeURIComponent(syncKey)}`, "PATCH", {
            ...userStats,
            streakDays: getStreak(),
            passwordHash: await sha256(currentKeyPassword),
            updatedAt: Date.now()
        });
        setSyncStatus("Synchronisé", true);
    } catch (e) {
        setSyncStatus(`Erreur envoi (${e.message})`);
    }
}

async function switchAccount() {
    const choice = prompt(
        `Compte actuel : ${syncKey || "Aucun"}\n1. Changer / créer un compte\n2. Modifier le mot de passe\nEntrez 1, 2 ou directement le nom du compte :`
    );
    if (choice === null) return;
    const val = choice.trim();

    if (val === "2") {
        if (!syncKey) return alert("Définissez d'abord un compte.");
        const pwd = prompt("Nouveau mot de passe (vide pour supprimer) :");
        if (pwd === null) return;
        currentKeyPassword = pwd.trim();
        currentKeyPassword ? localStorage.setItem("focus_read_sync_pwd", currentKeyPassword) : localStorage.removeItem("focus_read_sync_pwd");
        updateAccountUI();
        return pushStats();
    }

    const raw = val === "1" ? (prompt("Nom du compte :") || "") : val;
    syncKey = cleanKey(raw) || ("READ-" + Math.random().toString(36).substring(2, 8).toUpperCase());
    currentKeyPassword = "";
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

// --- IMPORT EPUB / TXT & BIBLIOTHÈQUE ---

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const label = $('file-label');
    label.textContent = "Analyse...";

    try {
        const bookId = cleanKey(`book_${file.name}_${file.size}`);
        let title = file.name.replace(/\.(epub|txt)$/i, '');
        let chapters = [];

        if (file.name.toLowerCase().endsWith('.epub')) {
            ({ bookTitle: title, chapters } = await parseEpub(file));
        } else {
            const clean = (await file.text()).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            if (clean.length < 30) throw new Error("Fichier trop court.");
            chapters = [{ id: "chap_1", chapterNum: 1, label: `Chapitre 1 : ${title}`, text: clean, wordCount: clean.split(/\s+/).length }];
        }

        if (!chapters.length) throw new Error("Aucun chapitre lisible trouvé.");

        const existing = accountBooks.find(b => b.id === bookId);
        const book = {
            id: bookId,
            publicId: existing?.publicId || null,
            title,
            fileName: file.name,
            visibility: existing?.visibility || 'public',
            sharedBy: syncKey || "Anonyme",
            chapters,
            readChapters: existing?.readChapters || [],
            pausedPositions: existing?.pausedPositions || {},
            lastIndex: existing ? Math.min(existing.lastIndex || 0, chapters.length - 1) : 0,
            updatedAt: Date.now()
        };

        if (book.visibility === 'public' && !await publishPublic(book)) book.visibility = 'private';
        if (await saveBookCloud(book)) renderLibrary(bookId);
    } catch (err) {
        alert("Erreur import : " + err.message);
    } finally {
        label.textContent = "+ Importer EPUB / TXT";
        $('file-input').value = '';
    }
}

async function parseEpub(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const parser = new DOMParser();
    const containerXml = await zip.file("META-INF/container.xml")?.async("text");
    if (!containerXml) throw new Error("EPUB invalide.");

    const opfPath = parser.parseFromString(containerXml, "application/xml").querySelector("rootfile")?.getAttribute("full-path");
    if (!opfPath) throw new Error("Fichier OPF introuvable dans l'EPUB.");

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
        chapters.push({ id: `chap_${num}`, chapterNum: num, label: `Chapitre ${num}${heading ? ` : ${heading}` : ""}`, text, wordCount });
    }
    return { bookTitle, chapters };
}

async function publishPublic(book) {
    if (!navigator.onLine) return false;
    try {
        const pubId = book.publicId || `${book.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 24)}_${Date.now()}`;
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
        $('start-btn').textContent = "Importez ou ajoutez un livre";
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
        row.className = `list-row ${book.id === current.id ? 'active' : ''}`;
        row.innerHTML = `
            <div class="row-main">
                <span class="row-title">${esc(book.title)}</span>
                <span class="row-meta">${isPub ? 'Public' : 'Privé'} · ${readCount}/${book.chapters.length} chapitres</span>
            </div>
            <div class="row-actions">
                ${(!isPub || isOwner) ? `<button type="button" class="ghost-btn btn-vis">${isPub ? 'Privé' : 'Publier'}</button>` : ''}
                <button type="button" class="ghost-btn danger-text btn-del">Supprimer</button>
            </div>
        `;

        row.querySelector('.row-main').onclick = () => renderLibrary(book.id);

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
            if (!confirm(`Supprimer "${book.title}" ?`)) return;
            await fb(`focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(book.id)}`, "DELETE");
            if (isPub && isOwner) await fb(`focus_read_public_books/${encodeURIComponent(book.publicId || book.id)}`, "DELETE").catch(() => {});
            accountBooks = accountBooks.filter(b => b.id !== book.id);
            renderLibrary();
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
        const pages = Math.max(1, Math.round((c.wordCount || 0) / 250));
        return `<option value="${i}">${tag}${esc(c.label)} (~${pages} p.)</option>`;
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
    const isRead = (activeBook.readChapters || []).includes(chap.id);
    $('start-btn').textContent = isPaused ? "Reprendre la lecture" : (isRead ? "Relire le chapitre" : "Commencer la lecture");

    if (save && activeBook.lastIndex !== currentChapterIndex) {
        activeBook.lastIndex = currentChapterIndex;
        await saveBookCloud(activeBook);
    }
}

// --- LECTURE & QUIZ ---

function startReading() {
    const chap = activeBook?.chapters[currentChapterIndex];
    if (!chap) return;
    activeText = chap.text;
    const qCount = questionCount(chap.wordCount || activeText.split(/\s+/).length);

    $('hud-chapter-title').textContent = chap.label;
    $('finish-reading-btn').textContent = `Terminer & Quiz (${qCount} questions)`;
    $('text-track').textContent = activeText;

    showView('game-screen');
    requestAnimationFrame(() => {
        window.scrollTo(0, activeBook.pausedPositions?.[chap.id] || 0);
        updateScroll();
    });
}

async function pauseReading() {
    const chap = activeBook?.chapters[currentChapterIndex];
    if (chap) {
        activeBook.pausedPositions = { ...(activeBook.pausedPositions || {}), [chap.id]: window.scrollY };
        activeBook.updatedAt = Date.now();
        await saveBookCloud(activeBook);
    }
    showView('setup-screen');
    renderLibrary(activeBook?.id);
}

function updateScroll() {
    if ($('game-screen').hidden) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    $('scroll-percent').textContent = max <= 0 ? "100%" : `${Math.min(100, Math.round((window.scrollY / max) * 100))}%`;
}

async function finishAndQuiz() {
    const apiKey = $('api-key').value.trim() || DEFAULT_API_KEY;
    if (!apiKey) {
        $('api-details-box').open = true;
        alert("Renseignez votre clé API Gemini pour générer le quiz (lecture mise en pause).");
        return pauseReading();
    }

    const chap = activeBook?.chapters[currentChapterIndex];
    const qCount = questionCount(chap?.wordCount || activeText.split(/\s+/).length);
    const btn = $('finish-reading-btn');
    btn.disabled = true;
    btn.textContent = "Génération du quiz...";

    try {
        const prompt = `Chapitre lu :\n"${activeText}"\nGénère exactement ${qCount} questions QCM (3 choix) couvrant l'ensemble du chapitre, avec un champ "explanation" court. Réponds UNIQUEMENT en JSON strict :\n[{"question":"...","options":["A","B","C"],"answer":0,"explanation":"..."}]`;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || "Erreur Gemini");

        const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("Format de réponse invalide.");
        generatedQuiz = JSON.parse(jsonMatch[0]);

        if (activeBook?.pausedPositions?.[chap?.id]) {
            delete activeBook.pausedPositions[chap.id];
            await saveBookCloud(activeBook);
        }
        renderQuiz();
    } catch (e) {
        alert("Erreur quiz : " + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = `Terminer & Quiz (${qCount} questions)`;
    }
}

function renderQuiz() {
    userAnswers = {};
    $('quiz-title').textContent = `Vérification (${generatedQuiz.length} questions)`;
    $('abandon-quiz-btn').hidden = false;
    $('submit-quiz-btn').hidden = false;
    $('retry-chapter-btn').hidden = true;
    $('next-chapter-btn').hidden = true;
    $('restart-btn').hidden = true;

    const box = $('quiz-container');
    box.innerHTML = '';
    generatedQuiz.forEach((q, qi) => {
        const div = document.createElement('div');
        div.className = 'quiz-question';
        div.innerHTML = `<p>${qi + 1}. ${esc(q.question)}</p>`;
        q.options.forEach((opt, oi) => {
            const b = document.createElement('button');
            b.className = 'quiz-option';
            b.textContent = opt;
            b.onclick = () => {
                userAnswers[qi] = oi;
                div.querySelectorAll('.quiz-option').forEach(x => x.classList.remove('selected'));
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

    let score = 0;
    document.querySelectorAll('.quiz-question').forEach((div, qi) => {
        const q = generatedQuiz[qi];
        const chosen = userAnswers[qi];
        const ok = chosen === q.answer;
        if (ok) score++;

        div.querySelectorAll('.quiz-option').forEach((b, i) => {
            b.disabled = true;
            b.classList.remove('selected');
            if (i === q.answer) { b.classList.add('correct'); b.textContent = `✓ ${q.options[i]}`; }
            else if (i === chosen) { b.classList.add('wrong'); b.textContent = `✗ ${q.options[i]}`; }
        });

        const exp = document.createElement('div');
        exp.className = `quiz-explanation ${ok ? '' : 'is-wrong'}`;
        exp.textContent = q.explanation || (ok ? "Bonne réponse." : `Réponse attendue : ${q.options[q.answer]}`);
        div.appendChild(exp);
    });

    const total = generatedQuiz.length;
    const perfect = score === total;
    const pts = score * 10 + (perfect ? 20 : 0);

    userStats.scoreTotal += pts;
    userStats.quizzesCompleted += 1;
    if (perfect) {
        userStats.perfectScores += 1;
        const chap = activeBook.chapters[currentChapterIndex];
        const isNew = chap && !(activeBook.readChapters || []).includes(chap.id);
        if (isNew) {
            activeBook.readChapters = [...(activeBook.readChapters || []), chap.id];
            userStats.totalChaptersRead += 1;
        }
        if (userStats.lastReadDate === dateKey(-1)) userStats.streakDays = (userStats.streakDays || 0) + 1;
        else if (userStats.lastReadDate !== dateKey(0)) userStats.streakDays = 1;
        userStats.lastReadDate = dateKey(0);
        await saveBookCloud(activeBook);
    }

    renderStats();
    await pushStats();

    $('quiz-container').insertAdjacentHTML('afterbegin', `
        <div class="score-card">
            <strong>${score} / ${total} (${Math.round((score / total) * 100)}%)</strong>
            <span class="muted">+${pts} pts · ${perfect ? 'Chapitre validé ✓' : '100 % requis pour valider'}</span>
        </div>
    `);

    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('abandon-quiz-btn').hidden = true;
    $('submit-quiz-btn').hidden = true;
    $('restart-btn').hidden = false;
    $('retry-chapter-btn').hidden = perfect;
    if (currentChapterIndex + 1 < activeBook.chapters.length) {
        $('next-chapter-btn').textContent = `Lire ${activeBook.chapters[currentChapterIndex + 1].label} →`;
        $('next-chapter-btn').hidden = false;
    }
}

// --- MODALES (COMMUNAUTÉ, CLASSEMENT, GUIDE) ---

async function openCommunity() {
    $('community-overlay').hidden = false;
    const list = $('community-list');
    list.innerHTML = '<div class="list-row"><span class="muted">Chargement...</span></div>';

    try {
        const data = await fb('focus_read_public_books');
        if (!data) return (list.innerHTML = '<div class="list-row"><span class="muted">Aucun livre partagé.</span></div>');

        const owned = new Set(accountBooks.flatMap(b => [b.id, b.publicId].filter(Boolean)));
        list.innerHTML = '';
        Object.values(data).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).forEach(pub => {
            const has = owned.has(pub.id) || owned.has(pub.localId);
            const row = document.createElement('div');
            row.className = 'list-row';
            row.innerHTML = `
                <div class="row-main">
                    <span class="row-title">${esc(pub.title)}</span>
                    <span class="row-meta">${esc(pub.sharedBy || "Anonyme")} · ${pub.chapterCount || "?"} ch.</span>
                </div>
                <button class="ghost-btn" ${has ? 'disabled' : ''}>${has ? 'Ajouté ✓' : '+ Ajouter'}</button>
            `;
            const btn = row.querySelector('button');
            if (!has) btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = "Ajout...";
                const chaps = (Array.isArray(pub.chapters) ? pub.chapters : Object.values(pub.chapters || {})).filter(c => c?.text);
                if (!chaps.length) {
                    btn.disabled = false;
                    btn.textContent = "+ Ajouter";
                    return alert("Livre vide.");
                }
                const ok = await saveBookCloud({
                    id: cleanKey(pub.localId || pub.id), publicId: pub.id, title: pub.title, fileName: pub.fileName,
                    visibility: 'public', sharedBy: pub.sharedBy, chapters: chaps, readChapters: [], pausedPositions: {}, lastIndex: 0, updatedAt: Date.now()
                });
                if (ok) { renderLibrary(cleanKey(pub.localId || pub.id)); btn.textContent = "Ajouté ✓"; }
                else { btn.disabled = false; btn.textContent = "+ Ajouter"; }
            };
            list.appendChild(row);
        });
    } catch (e) {
        list.innerHTML = `<div class="list-row"><span class="muted">Erreur : ${e.message}</span></div>`;
    }
}

async function openLeaderboard() {
    $('leaderboard-overlay').hidden = false;
    updateAccountUI();
    const list = $('leaderboard-list');
    list.innerHTML = '<div class="list-row"><span class="muted">Chargement...</span></div>';

    try {
        const data = await fb('focus_read_users');
        if (!data) return (list.innerHTML = '<div class="list-row"><span class="muted">Aucun lecteur.</span></div>');

        list.innerHTML = Object.entries(data)
            .map(([k, v]) => ({ k, pts: v.scoreTotal || 0, ch: v.totalChaptersRead || v.perfectScores || 0, st: getStreak(v) }))
            .sort((a, b) => b.pts - a.pts)
            .slice(0, 30)
            .map((p, i) => `
                <div class="list-row ${p.k === syncKey ? 'me' : ''}">
                    <div class="row-main">
                        <span class="row-title">#${i + 1} ${esc(p.k)}</span>
                        <span class="row-meta">Série ${p.st} j · ${p.ch} ch.</span>
                    </div>
                    <strong>${p.pts} pts</strong>
                </div>
            `).join('');
    } catch (e) {
        list.innerHTML = `<div class="list-row"><span class="muted">Erreur : ${e.message}</span></div>`;
    }
}

// --- ÉVÉNEMENTS & INIT ---

// --- ÉVÉNEMENTS & INIT ---

const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };

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
window.addEventListener('scroll', updateScroll, { passive: true });
on('finish-reading-btn', 'onclick', finishAndQuiz);

on('abandon-quiz-btn', 'onclick', () => confirm("Abandonner le quiz ?") && (showView('setup-screen'), renderLibrary(activeBook?.id)));
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
document.querySelectorAll('.overlay').forEach(ov => ov.onclick = e => { if (e.target === ov) ov.hidden = true; });

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
