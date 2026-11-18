const $ = id => document.getElementById(id);

const FIREBASE_DB_URL = (typeof ENV !== 'undefined' && ENV.FIREBASE_DB_URL) 
    ? ENV.FIREBASE_DB_URL 
    : "https://antibrainrotting-4f194-default-rtdb.europe-west1.firebasedatabase.app";

const DEFAULT_API_KEY = (typeof ENV !== 'undefined' && ENV.DEFAULT_GEMINI_API_KEY) 
    ? ENV.DEFAULT_GEMINI_API_KEY 
    : "";

// CONFIGURATION DIFFICULTÉ & TAILLE DES SEGMENTS
const DIFFICULTY_CONFIG = {
    easy: {
        label: "FACILE",
        questionCount: 3,
        choicesCount: 3,
        multiplier: 1,
        promptRule: "Pose 3 questions simples et directes sur les événements ou idées principales du texte, avec 3 choix de réponse chacune."
    },
    medium: {
        label: "MOYEN",
        questionCount: 4,
        choicesCount: 3,
        multiplier: 1.5,
        promptRule: "Pose 4 questions précises portant sur des détails concrets et des faits secondaires du texte, avec 3 choix de réponse chacune."
    },
    hard: {
        label: "DIFFICILE",
        questionCount: 5,
        choicesCount: 4,
        multiplier: 2,
        promptRule: "Pose 5 questions exigeantes et pointues (détails subtils, chronologie exacte, déductions fines, pièges plausibles) avec 4 choix de réponse chacune."
    }
};

const LENGTH_CONFIG = {
    short: { maxWordsPerPart: 250 },
    medium: { maxWordsPerPart: 550 },
    long: { maxWordsPerPart: 950 }
};

// ÉTAT DE L'APPLICATION & BIBLIOTHÈQUE
let activeBook = null; // { id, title, fileName, rawChapters, chapters, readChapters: [], lastIndex: 0 }
let currentChapterIndex = 0;
let activeText = "";
let activeChapterLabel = "";
let generatedQuiz = [];
let userAnswers = {};

// ÉTAT FIREBASE & CLASSEMENT
let syncKey = localStorage.getItem("focus_read_sync_key") || null;
let currentKeyPassword = localStorage.getItem("focus_read_sync_pwd") || "";
let userStats = JSON.parse(localStorage.getItem("focus_read_stats") || "null") || {
    scoreTotal: 0,
    quizzesCompleted: 0,
    perfectScores: 0
};

// ==========================================
// 1. BASE DE DONNÉES LOCALE (INDEXEDDB)
// ==========================================

const DB_NAME = "FocusReadLibraryDB";
const DB_VERSION = 1;
const STORE_NAME = "books";

function openLibraryDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

async function dbSaveBook(bookRecord) {
    const db = await openLibraryDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(bookRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
    });
}

async function dbGetAllBooks() {
    const db = await openLibraryDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = e => reject(e.target.error);
    });
}

async function dbGetBook(id) {
    const db = await openLibraryDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = e => reject(e.target.error);
    });
}

async function dbDeleteBook(id) {
    const db = await openLibraryDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
    });
}

// ==========================================
// 2. PRÉFÉRENCES LOCALES (CLÉ GEMINI, DIFFICULTÉ, TAILLE)
// ==========================================

function loadLocalPreferences() {
    const savedKey = localStorage.getItem("focus_read_gemini_key");
    if (savedKey) {
        $('api-key').value = savedKey;
    } else if (DEFAULT_API_KEY) {
        $('api-key').value = DEFAULT_API_KEY;
    }

    const savedDiff = localStorage.getItem("focus_read_difficulty");
    if (savedDiff && DIFFICULTY_CONFIG[savedDiff]) {
        $('difficulty').value = savedDiff;
    }

    const savedLen = localStorage.getItem("focus_read_length");
    if (savedLen && LENGTH_CONFIG[savedLen]) {
        $('text-length').value = savedLen;
    }
}

function saveGeminiKey(val) {
    const trimmed = val.trim();
    if (trimmed) {
        localStorage.setItem("focus_read_gemini_key", trimmed);
    } else {
        localStorage.removeItem("focus_read_gemini_key");
    }
}

// ==========================================
// 3. IMPORTATION EPUB / TXT & GESTION BIBLIOTHÈQUE
// ==========================================

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const label = $('file-label');
    label.innerText = `Analyse et sauvegarde de "${file.name}"...`;

    try {
        const bookId = `book_${file.name}_${file.size}`;
        let bookTitle = file.name.replace(/\.(epub|txt)$/i, '');
        let rawChapters = [];

        if (file.name.toLowerCase().endsWith('.epub')) {
            const epubData = await extractRawChaptersFromEPUB(file);
            bookTitle = epubData.bookTitle;
            rawChapters = epubData.rawChapters;
        } else {
            const rawTxt = await file.text();
            const clean = rawTxt
                .replace(/\r\n/g, '\n')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (clean.length < 30) throw new Error("Le fichier texte est trop court.");
            rawChapters = [{ chapterNum: 1, title: bookTitle, text: clean }];
        }

        if (rawChapters.length === 0) {
            throw new Error("Aucun chapitre lisible trouvé dans ce fichier.");
        }

        const segments = buildSegmentsFromRawChapters(rawChapters);

        // Conserver les chapitres déjà lus si le livre existait déjà
        const existing = await dbGetBook(bookId);
        const readChapters = existing ? (existing.readChapters || []) : [];

        const bookRecord = {
            id: bookId,
            title: bookTitle,
            fileName: file.name,
            rawChapters,
            chapters: segments,
            readChapters,
            lastIndex: existing ? Math.min(existing.lastIndex || 0, segments.length - 1) : 0,
            updatedAt: Date.now()
        };

        await dbSaveBook(bookRecord);
        localStorage.setItem("focus_read_active_book_id", bookId);

        await refreshLibraryUI(bookId);
        label.innerText = `+ Importer un autre fichier EPUB ou TXT`;
        $('file-input').value = '';
    } catch (err) {
        alert("Impossible d'importer ce fichier : " + err.message);
        label.innerText = "Erreur lors du chargement. Réessayez.";
    }
}

function buildSegmentsFromRawChapters(rawChapters) {
    const lenKey = $('text-length').value || 'medium';
    const MAX_WORDS_PER_PART = LENGTH_CONFIG[lenKey].maxWordsPerPart;
    const segments = [];

    for (const rc of rawChapters) {
        const paragraphs = rc.text.split(/\n\n+/);
        const totalWords = rc.text.split(/\s+/).filter(Boolean).length;
        const titleSuffix = rc.title ? ` : ${rc.title}` : "";

        if (totalWords <= MAX_WORDS_PER_PART) {
            segments.push({
                id: `c${rc.chapterNum}_p1`,
                label: `Chapitre ${rc.chapterNum}${titleSuffix}`,
                text: rc.text,
                wordCount: totalWords
            });
            continue;
        }

        const parts = [];
        let currentPart = [];
        let currentWords = 0;

        for (const p of paragraphs) {
            const pWords = p.split(/\s+/).filter(Boolean).length;
            if (currentWords + pWords > MAX_WORDS_PER_PART && currentPart.length > 0) {
                parts.push(currentPart.join('\n\n'));
                currentPart = [p];
                currentWords = pWords;
            } else {
                currentPart.push(p);
                currentWords += pWords;
            }
        }
        if (currentPart.length > 0) {
            parts.push(currentPart.join('\n\n'));
        }

        parts.forEach((partText, idx) => {
            segments.push({
                id: `c${rc.chapterNum}_p${idx + 1}`,
                label: `Chapitre ${rc.chapterNum}${titleSuffix} — Partie ${idx + 1}/${parts.length}`,
                text: partText,
                wordCount: partText.split(/\s+/).filter(Boolean).length
            });
        });
    }

    return segments;
}

async function extractRawChaptersFromEPUB(file) {
    if (typeof JSZip === 'undefined') {
        throw new Error("Bibliothèque JSZip non chargée.");
    }

    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) throw new Error("Fichier EPUB invalide (container.xml manquant).");

    const containerXml = await containerFile.async("text");
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerXml, "application/xml");
    const rootfile = containerDoc.querySelector("rootfile");
    const opfPath = rootfile ? rootfile.getAttribute("full-path") : null;
    if (!opfPath) throw new Error("Chemin OPF introuvable dans l'EPUB.");

    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfContent = await zip.file(opfPath).async("text");
    const opfDoc = parser.parseFromString(opfContent, "application/xml");

    const titleEl = opfDoc.querySelector("metadata title, dc\\:title");
    const bookTitle = titleEl ? titleEl.textContent.trim() : file.name.replace(/\.epub$/i, '');

    const manifestMap = {};
    opfDoc.querySelectorAll("manifest > item").forEach(item => {
        manifestMap[item.getAttribute("id")] = item.getAttribute("href");
    });

    const spineItems = opfDoc.querySelectorAll("spine > itemref");
    const rawChapters = [];
    let chapterCounter = 1;

    for (const itemref of spineItems) {
        const idref = itemref.getAttribute("idref");
        const href = manifestMap[idref];
        if (!href) continue;

        const fullChapterPath = decodeURIComponent(opfDir + href.split('#')[0]);
        const chapterFile = zip.file(fullChapterPath);
        if (!chapterFile) continue;

        const xhtml = await chapterFile.async("text");
        const doc = parser.parseFromString(xhtml, "text/html");

        doc.querySelectorAll("style, script, nav").forEach(el => el.remove());

        let detectedTitle = "";
        const heading = doc.querySelector("h1, h2, h3");
        if (heading) {
            detectedTitle = heading.textContent.replace(/\s+/g, ' ').trim();
            if (/^chapitre\s*\d+/i.test(detectedTitle)) {
                detectedTitle = detectedTitle.replace(/^chapitre\s*\d+\s*[:.-]?\s*/i, '').trim();
            }
            if (detectedTitle.length > 42) {
                detectedTitle = detectedTitle.substring(0, 39) + "...";
            }
        }

        const blocks = Array.from(doc.querySelectorAll("p, div"))
            .filter(el => el.children.length === 0 || el.tagName.toLowerCase() === 'p')
            .map(el => el.textContent.replace(/\s+/g, ' ').trim())
            .filter(txt => txt.length > 0);

        let chapterText = blocks.length > 0 
            ? blocks.join('\n\n') 
            : (doc.body ? doc.body.textContent.replace(/\s+/g, ' ').trim() : "");

        const wordCount = chapterText.split(/\s+/).filter(Boolean).length;
        if (wordCount < 45) continue;

        rawChapters.push({
            chapterNum: chapterCounter,
            title: detectedTitle,
            text: chapterText
        });
        chapterCounter++;
    }

    return { bookTitle, rawChapters };
}

async function refreshLibraryUI(selectedBookId = null) {
    const books = await dbGetAllBooks();
    books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const libBox = $('library-box');
    const libList = $('library-list');

    if (books.length === 0) {
        libBox.style.display = 'none';
        $('chapter-selector-box').style.display = 'none';
        $('preview-box').style.display = 'none';
        $('start-btn').disabled = true;
        $('start-btn').innerText = "Importez un livre EPUB / TXT";
        activeBook = null;
        return;
    }

    libBox.style.display = 'block';
    const targetId = selectedBookId || localStorage.getItem("focus_read_active_book_id") || books[0].id;
    const foundBook = books.find(b => b.id === targetId) || books[0];

    libList.innerHTML = '';
    books.forEach(book => {
        const total = book.chapters.length;
        const readCount = (book.readChapters || []).filter(id => book.chapters.some(c => c.id === id)).length;
        const pct = total > 0 ? Math.round((readCount / total) * 100) : 0;

        const item = document.createElement('div');
        item.className = `lib-item ${book.id === foundBook.id ? 'active' : ''}`;
        item.innerHTML = `
            <div class="lib-info">
                <span class="lib-title">${escapeHtml(book.title)}</span>
                <span class="lib-sub">${readCount}/${total} lus (${pct}%)</span>
            </div>
            <button class="lib-del-btn" title="Supprimer ce livre">SUPPR.</button>
        `;

        item.querySelector('.lib-info').onclick = async () => {
            localStorage.setItem("focus_read_active_book_id", book.id);
            await refreshLibraryUI(book.id);
        };

        item.querySelector('.lib-del-btn').onclick = async (e) => {
            e.stopPropagation();
            if (confirm(`Supprimer "${book.title}" de votre bibliothèque locale ?`)) {
                await dbDeleteBook(book.id);
                await refreshLibraryUI();
            }
        };

        libList.appendChild(item);
    });

    loadActiveBookIntoUI(foundBook);
}

function loadActiveBookIntoUI(book) {
    activeBook = book;
    const total = book.chapters.length;
    const readSet = new Set(book.readChapters || []);
    const readCount = book.chapters.filter(c => readSet.has(c.id)).length;
    const pct = total > 0 ? Math.round((readCount / total) * 100) : 0;

    $('book-title-label').innerText = book.title;
    $('book-progress-text').innerText = `${readCount}/${total} LUS (${pct}%)`;
    $('book-progress-bar-fill').style.width = `${pct}%`;

    // Sélectionner par défaut le dernier chapitre utilisé, ou le premier non lu
    let defaultIdx = book.lastIndex || 0;
    if (defaultIdx >= total) defaultIdx = 0;

    const select = $('chapter-select');
    select.innerHTML = '';
    book.chapters.forEach((chap, idx) => {
        const isRead = readSet.has(chap.id);
        const statusTag = isRead ? "[✓ LU] " : "[À LIRE] ";
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${statusTag}${chap.label} (${chap.wordCount} mots)`;
        select.appendChild(opt);
    });

    $('chapter-selector-box').style.display = 'block';
    $('preview-box').style.display = 'block';
    $('start-btn').disabled = false;

    selectChapter(defaultIdx);
}

async function selectChapter(index) {
    if (!activeBook) return;
    currentChapterIndex = parseInt(index, 10) || 0;
    const chap = activeBook.chapters[currentChapterIndex];
    if (!chap) return;

    $('chapter-select').value = currentChapterIndex;
    $('custom-text').value = chap.text;
    activeChapterLabel = chap.label.toUpperCase();

    const isAlreadyRead = (activeBook.readChapters || []).includes(chap.id);
    $('start-btn').innerText = isAlreadyRead ? "Relire ce chapitre" : "Commencer la lecture";

    activeBook.lastIndex = currentChapterIndex;
    await dbSaveBook(activeBook);
}

// ==========================================
// 4. GÉNÉRATION DU QUIZ IA (GEMINI) & LECTURE
// ==========================================

async function initGame() {
    if (!activeBook) {
        alert("Veuillez d'abord importer un livre EPUB ou TXT.");
        return;
    }

    const inputKey = $('api-key').value.trim();
    saveGeminiKey(inputKey);
    const apiKey = inputKey || DEFAULT_API_KEY;
    const diffKey = $('difficulty').value || 'medium';
    const btn = $('start-btn');

    const chap = activeBook.chapters[currentChapterIndex];
    if (!chap || !chap.text) {
        alert("Chapitre introuvable.");
        return;
    }

    if (!apiKey) {
        alert("Veuillez renseigner votre clé API Gemini pour générer les questions sur ce chapitre.");
        return;
    }

    btn.disabled = true;
    btn.innerText = "GÉNÉRATION DU QUIZ EN COURS...";

    try {
        activeText = chap.text;
        generatedQuiz = await generateQuizFromText(apiKey, activeText, diffKey);
        startReadingSession();
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
        const isAlreadyRead = (activeBook.readChapters || []).includes(chap.id);
        btn.innerText = isAlreadyRead ? "Relire ce chapitre" : "Commencer la lecture";
    }
}

async function generateQuizFromText(apiKey, text, diffKey) {
    const diff = DIFFICULTY_CONFIG[diffKey];

    const prompt = `Voici un passage de livre que l'utilisateur vient de lire :
    "${text}"
    ${diff.promptRule}
    Réponds UNIQUEMENT en JSON strict sans balises markdown :
    [
        {"question": "Question 1 ?", "options": ["Choix A", "Choix B", "Choix C"], "answer": 0}
    ]`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || "Erreur API Gemini");

    let raw = json.candidates[0].content.parts[0].text;
    raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(raw);
}

function startReadingSession() {
    $('setup-screen').style.display = 'none';
    $('quiz-screen').style.display = 'none';
    $('game-screen').style.display = 'flex';

    $('hud-chapter-title').innerText = activeChapterLabel;
    const track = $('text-track');
    track.innerText = activeText;

    const viewport = $('viewport');
    viewport.scrollTop = 0;
    updateScrollProgress();
}

function updateScrollProgress() {
    const viewport = $('viewport');
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    if (maxScroll <= 0) {
        $('scroll-percent').innerText = "100%";
        return;
    }
    const percent = Math.min(100, Math.max(0, Math.round((viewport.scrollTop / maxScroll) * 100)));
    $('scroll-percent').innerText = `${percent}%`;
}

// ==========================================
// 5. VALIDATION DU CHAPITRE ("LU" SI 100%) & SCORE
// ==========================================

function showQuizScreen() {
    const diffKey = $('difficulty').value || 'medium';
    const diff = DIFFICULTY_CONFIG[diffKey];

    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'block';
    $('quiz-title').innerText = `Interrogatoire — ${diff.label} (×${diff.multiplier})`;
    $('submit-quiz-btn').style.display = 'block';
    $('retry-chapter-btn').style.display = 'none';
    $('next-chapter-btn').style.display = 'none';
    $('restart-btn').style.display = 'none';

    userAnswers = {};
    const container = $('quiz-container');
    container.innerHTML = '';

    generatedQuiz.forEach((q, qIndex) => {
        const qDiv = document.createElement('div');
        qDiv.className = 'quiz-question';
        qDiv.innerHTML = `<p>${qIndex + 1}. ${q.question}</p>`;

        q.options.forEach((opt, optIndex) => {
            const btn = document.createElement('button');
            btn.className = 'quiz-option';
            btn.innerText = opt;
            btn.onclick = () => selectOption(qIndex, optIndex, btn);
            qDiv.appendChild(btn);
        });

        container.appendChild(qDiv);
    });
}

function selectOption(qIndex, optIndex, btnElement) {
    userAnswers[qIndex] = optIndex;
    const siblings = btnElement.parentElement.querySelectorAll('.quiz-option');
    siblings.forEach(s => s.classList.remove('selected'));
    btnElement.classList.add('selected');
}

async function evaluateQuiz() {
    if (Object.keys(userAnswers).length < generatedQuiz.length) {
        alert("Veuillez répondre à toutes les questions.");
        return;
    }

    let correctCount = 0;
    const questionDivs = document.querySelectorAll('.quiz-question');

    generatedQuiz.forEach((q, qIndex) => {
        const optionsBtns = questionDivs[qIndex].querySelectorAll('.quiz-option');
        const chosen = userAnswers[qIndex];

        optionsBtns.forEach((btn, idx) => {
            btn.disabled = true;
            btn.classList.remove('selected');
            if (idx === q.answer) {
                btn.classList.add('correct');
            } else if (idx === chosen) {
                btn.classList.add('wrong');
            }
        });

        if (chosen === q.answer) correctCount++;
    });

    const diffKey = $('difficulty').value || 'medium';
    const diff = DIFFICULTY_CONFIG[diffKey];
    const isPerfect = correctCount === generatedQuiz.length;

    const basePoints = (correctCount * 10) + (isPerfect ? 20 : 0);
    const pointsGagnes = Math.round(basePoints * diff.multiplier);

    userStats.scoreTotal += pointsGagnes;
    userStats.quizzesCompleted += 1;
    if (isPerfect) userStats.perfectScores += 1;

    saveLocalStats();
    await pushToCloud();

    // Si 100% de réussite, marquer ce chapitre comme "LU" dans IndexedDB
    let validationStatusMsg = "";
    const chap = activeBook.chapters[currentChapterIndex];

    if (isPerfect && chap) {
        if (!activeBook.readChapters) activeBook.readChapters = [];
        if (!activeBook.readChapters.includes(chap.id)) {
            activeBook.readChapters.push(chap.id);
        }
        activeBook.updatedAt = Date.now();
        await dbSaveBook(activeBook);
        validationStatusMsg = `<span style="color:#fff;">✓ CHAPITRE VALIDÉ COMME LU</span>`;
    } else {
        validationStatusMsg = `<span style="color:#aaa;">✗ NON VALIDÉ (100% requis pour marquer comme lu)</span>`;
    }

    $('submit-quiz-btn').style.display = 'none';
    $('restart-btn').style.display = 'block';

    if (!isPerfect) {
        $('retry-chapter-btn').style.display = 'block';
    }

    if (currentChapterIndex + 1 < activeBook.chapters.length) {
        const nextChap = activeBook.chapters[currentChapterIndex + 1];
        $('next-chapter-btn').innerText = `Lire ${nextChap.label} →`;
        $('next-chapter-btn').style.display = 'block';
    }

    const finalMsg = document.createElement('div');
    finalMsg.className = 'result-box';
    finalMsg.innerHTML = `
        ${validationStatusMsg}<br>
        SCORE : <strong>${correctCount} / ${generatedQuiz.length}</strong> (${diff.label} ×${diff.multiplier})<br>
        POINTS GAGNÉS : <strong>+${pointsGagnes} PTS</strong> (Total : ${userStats.scoreTotal} pts)
    `;
    $('quiz-container').appendChild(finalMsg);
}

async function launchNextChapter() {
    if (!activeBook || currentChapterIndex + 1 >= activeBook.chapters.length) return;
    await selectChapter(currentChapterIndex + 1);
    await initGame();
}

async function resetToMenu() {
    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'none';
    $('setup-screen').style.display = 'block';
    if (activeBook) {
        await refreshLibraryUI(activeBook.id);
    }
}

// ==========================================
// 6. FIREBASE SYNC & CLASSEMENT PAR CLÉ
// ==========================================

function saveLocalStats() {
    localStorage.setItem("focus_read_stats", JSON.stringify(userStats));
}

async function hashPassword(str) {
    if (!str) return null;
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

function updateSyncStatus(msg, isSuccess = false) {
    const el = $('syncStatus');
    if (!el) return;
    el.textContent = `SYNC : ${msg}`;
    el.style.borderColor = isSuccess ? "#f5f5f5" : "#444";
    el.style.color = isSuccess ? "#f5f5f5" : "#aaa";
}

function updateSyncKeyUI() {
    const el = $('btnSyncKey');
    if (!el) return;
    const isLocked = Boolean(currentKeyPassword);
    el.textContent = syncKey ? `${syncKey} ${isLocked ? "🔒" : ""}` : "CLÉ";
    if ($('current-lb-key')) {
        $('current-lb-key').textContent = syncKey || "Non définie";
    }
}

function genererNouvelleCle() {
    return "READ-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function sanitizeFirebaseKey(rawKey) {
    return rawKey.replace(/[.#$\[\]/]/g, '_').trim();
}

async function changerOuCopierCle() {
    const action = prompt(
        `Clé actuelle (votre nom dans le classement) : ${syncKey || "Aucune"}\n\n` +
        `1. Changer ou créer une clé (ex: votre prénom ou pseudo)\n` +
        `2. Définir / modifier le mot de passe de cette clé\n` +
        `Entrez 1, 2 ou directement le nom de votre nouvelle clé :`
    );

    if (action === null) return;
    const saisie = action.trim();

    if (saisie === "2") {
        if (!syncKey) {
            alert("Veuillez d'abord générer ou charger une clé.");
            return;
        }
        const nouveauMdp = prompt("Définissez un mot de passe (laissez vide pour retirer le verrou) :");
        if (nouveauMdp === null) return;

        currentKeyPassword = nouveauMdp.trim();
        if (currentKeyPassword) {
            localStorage.setItem("focus_read_sync_pwd", currentKeyPassword);
        } else {
            localStorage.removeItem("focus_read_sync_pwd");
        }
        updateSyncKeyUI();
        await pushToCloud();
        return;
    }

    let rawNouvelleCle = (saisie === "1") ? (prompt("Entrez le nom de votre clé :") || "") : saisie;
    let nouvelleCle = sanitizeFirebaseKey(rawNouvelleCle);

    userStats = { scoreTotal: 0, quizzesCompleted: 0, perfectScores: 0 };
    saveLocalStats();

    if (!nouvelleCle) {
        syncKey = genererNouvelleCle();
        currentKeyPassword = "";
        localStorage.removeItem("focus_read_sync_pwd");
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
        await pushToCloud();
        return;
    }

    syncKey = nouvelleCle;
    currentKeyPassword = "";
    localStorage.removeItem("focus_read_sync_pwd");
    localStorage.setItem("focus_read_sync_key", syncKey);
    updateSyncKeyUI();
    await pullFromCloud();
}

async function pullFromCloud() {
    if (!navigator.onLine) {
        updateSyncStatus("HORS LIGNE");
        return;
    }

    if (!syncKey) {
        syncKey = genererNouvelleCle();
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
        await pushToCloud();
        return;
    }

    updateSyncStatus("CHARGEMENT...");
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const payload = await res.json();
        if (!payload) {
            await pushToCloud();
            return;
        }

        if (payload.passwordHash) {
            let tentatives = 0;
            let hashLocal = await hashPassword(currentKeyPassword);

            while (hashLocal !== payload.passwordHash && tentatives < 3) {
                const saisie = prompt(`La clé "${syncKey}" est protégée par un mot de passe :`);
                if (saisie === null) {
                    updateSyncStatus("ACCÈS REFUSÉ");
                    return;
                }
                currentKeyPassword = saisie.trim();
                hashLocal = await hashPassword(currentKeyPassword);
                tentatives++;
            }

            if (hashLocal !== payload.passwordHash) {
                updateSyncStatus("MDP INCORRECT");
                return;
            }

            localStorage.setItem("focus_read_sync_pwd", currentKeyPassword);
            updateSyncKeyUI();
        }

        userStats = {
            scoreTotal: Math.max(userStats.scoreTotal || 0, payload.scoreTotal || 0),
            quizzesCompleted: Math.max(userStats.quizzesCompleted || 0, payload.quizzesCompleted || 0),
            perfectScores: Math.max(userStats.perfectScores || 0, payload.perfectScores || 0)
        };

        saveLocalStats();
        updateSyncStatus("À JOUR", true);
    } catch (e) {
        console.error("Erreur lecture Firebase:", e);
        updateSyncStatus("ERREUR LECTURE");
    }
}

async function pushToCloud() {
    if (!navigator.onLine) return;

    if (!syncKey) {
        syncKey = genererNouvelleCle();
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
    }

    updateSyncStatus("ENVOI...");
    try {
        const checkRes = await fetch(`${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}/passwordHash.json`);
        if (checkRes.ok) {
            const distantHash = await checkRes.json();
            if (distantHash) {
                const localHash = await hashPassword(currentKeyPassword);
                if (distantHash !== localHash) {
                    updateSyncStatus("ÉCRITURE REFUSÉE");
                    return;
                }
            }
        }

        const hash = await hashPassword(currentKeyPassword);
        const payload = {
            ...userStats,
            passwordHash: hash || null,
            updatedAt: Date.now()
        };

        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        updateSyncStatus("SYNCHRONISÉ", true);
    } catch (e) {
        console.error("Erreur écriture Firebase:", e);
        updateSyncStatus("ERREUR ENVOI");
    }
}

async function ouvrirClassement() {
    $('leaderboard-overlay').classList.remove('hidden');
    updateSyncKeyUI();
    const listEl = $('leaderboard-list');
    listEl.innerHTML = '<div class="lb-row">Chargement du classement...</div>';

    try {
        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_users.json`);
        if (!res.ok) throw new Error("Impossible de charger le classement");

        const data = await res.json();
        if (!data) {
            listEl.innerHTML = '<div class="lb-row">Aucun joueur classé pour le moment.</div>';
            return;
        }

        const players = Object.entries(data)
            .map(([key, val]) => ({
                key,
                scoreTotal: val.scoreTotal || 0,
                quizzesCompleted: val.quizzesCompleted || 0,
                perfectScores: val.perfectScores || 0
            }))
            .sort((a, b) => b.scoreTotal - a.scoreTotal)
            .slice(0, 30);

        listEl.innerHTML = players.map((p, index) => {
            const isMe = p.key === syncKey;
            const medal = index === 0 ? "🥇 " : index === 1 ? "🥈 " : index === 2 ? "🥉 " : `#${index + 1} `;
            return `
                <div class="lb-row ${isMe ? 'me' : ''}">
                    <div class="lb-rank-name">
                        <span class="lb-name">${medal}${escapeHtml(p.key)} ${isMe ? "(Vous)" : ""}</span>
                        <span class="lb-meta">${p.perfectScores} chapitres validés · ${p.quizzesCompleted} tentatives</span>
                    </div>
                    <span class="lb-score">${p.scoreTotal} PTS</span>
                </div>
            `;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<div class="lb-row">Erreur : ${e.message}</div>`;
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// ==========================================
// 7. ÉVÉNEMENTS & INITIALISATION PWA
// ==========================================

$('api-key').addEventListener('input', e => saveGeminiKey(e.target.value));
$('difficulty').addEventListener('change', e => localStorage.setItem("focus_read_difficulty", e.target.value));

// Si on change la taille des segments, re-découper le livre actif proprement
$('text-length').addEventListener('change', async e => {
    localStorage.setItem("focus_read_length", e.target.value);
    if (activeBook && activeBook.rawChapters) {
        activeBook.chapters = buildSegmentsFromRawChapters(activeBook.rawChapters);
        activeBook.lastIndex = 0;
        await dbSaveBook(activeBook);
        await refreshLibraryUI(activeBook.id);
    }
});

$('file-drop-zone').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', handleFileUpload);
$('chapter-select').addEventListener('change', e => selectChapter(e.target.value));

$('start-btn').addEventListener('click', initGame);
$('viewport').addEventListener('scroll', updateScrollProgress);
$('finish-reading-btn').addEventListener('click', showQuizScreen);
$('submit-quiz-btn').addEventListener('click', evaluateQuiz);
$('retry-chapter-btn').addEventListener('click', startReadingSession);
$('next-chapter-btn').addEventListener('click', launchNextChapter);
$('restart-btn').addEventListener('click', resetToMenu);

// Firebase & Classement events
$('btnSyncKey').addEventListener('click', changerOuCopierCle);
$('btnLeaderboard').addEventListener('click', ouvrirClassement);
$('btnCloseLeaderboard').addEventListener('click', () => $('leaderboard-overlay').classList.add('hidden'));

// Enregistrement du Service Worker PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW non enregistré:', err));
    });
}

// Démarrage
(async () => {
    loadLocalPreferences();
    updateSyncKeyUI();
    await refreshLibraryUI();
    pullFromCloud();
})();
