const $ = id => document.getElementById(id);

const FIREBASE_DB_URL = (typeof ENV !== 'undefined' && ENV.FIREBASE_DB_URL) 
    ? ENV.FIREBASE_DB_URL 
    : "https://antibrainrotting-4f194-default-rtdb.europe-west1.firebasedatabase.app";

const DEFAULT_API_KEY = (typeof ENV !== 'undefined' && ENV.DEFAULT_GEMINI_API_KEY) 
    ? ENV.DEFAULT_GEMINI_API_KEY 
    : "";

// ÉTAT EN MÉMOIRE LIÉ AU COMPTE ACTIF (ZÉRO CATALOGUE EN LOCALSTORAGE)
let accountBooks = []; // Catalogue chargé directement depuis Firebase pour syncKey
let activeBook = null;
let currentChapterIndex = 0;
let activeText = "";
let activeChapterLabel = "";
let generatedQuiz = [];
let userAnswers = {};

// ÉTAT COMPTE FIREBASE & STATISTIQUES
let syncKey = localStorage.getItem("focus_read_sync_key") || null;
let currentKeyPassword = localStorage.getItem("focus_read_sync_pwd") || "";
let userStats = {
    scoreTotal: 0,
    quizzesCompleted: 0,
    perfectScores: 0,
    totalChaptersRead: 0,
    streakDays: 0,
    lastReadDate: null
};

// ==========================================
// 1. GESTION DE LA STREAK & STATS GLOBALES
// ==========================================

function getLocalDateKey(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function getEffectiveStreak(stats) {
    if (!stats || !stats.lastReadDate || !stats.streakDays) return 0;
    const today = getLocalDateKey(0);
    const yesterday = getLocalDateKey(-1);
    if (stats.lastReadDate === today || stats.lastReadDate === yesterday) {
        return stats.streakDays;
    }
    return 0;
}

function recordValidatedChapterStats(isNewlyValidatedChapter) {
    const today = getLocalDateKey(0);
    const yesterday = getLocalDateKey(-1);

    if (userStats.lastReadDate === today) {
        if (!userStats.streakDays || userStats.streakDays < 1) {
            userStats.streakDays = 1;
        }
    } else if (userStats.lastReadDate === yesterday) {
        userStats.streakDays = (userStats.streakDays || 0) + 1;
    } else {
        userStats.streakDays = 1;
    }

    userStats.lastReadDate = today;

    if (isNewlyValidatedChapter) {
        userStats.totalChaptersRead = (userStats.totalChaptersRead || 0) + 1;
    }
}

function renderGlobalStatsUI() {
    const activeStreak = getEffectiveStreak(userStats);
    const chaptersRead = userStats.totalChaptersRead || 0;
    const score = userStats.scoreTotal || 0;

    if ($('stat-streak')) $('stat-streak').innerText = `${activeStreak} j`;
    if ($('stat-chapters')) $('stat-chapters').innerText = `${chaptersRead}`;
    if ($('stat-score')) $('stat-score').innerText = `${score}`;
}

// ==========================================
// 2. DENSITÉ DE QUESTIONS CALIBRÉE PAR PAGES
// ==========================================

function estimatePageCount(wordCount) {
    // Standard édition : ~250 mots par page
    return Math.max(1, Math.round((wordCount || 0) / 250));
}

function calculateQuestionCount(wordCount) {
    const pages = (wordCount || 0) / 250;
    if (pages <= 2) return 3;      // <= 500 mots (~1-2 pages)
    if (pages <= 5) return 4;      // 500 - 1250 mots (~3-5 pages)
    if (pages <= 9) return 6;      // 1250 - 2250 mots (~6-9 pages)
    if (pages <= 15) return 8;     // 2250 - 3750 mots (~10-15 pages)
    if (pages <= 22) return 10;    // 3750 - 5500 mots (~16-22 pages)
    return 12;                     // > 22 pages (plafonné pour rester digeste)
}

// ==========================================
// 3. CATALOGUE CLOUD PROPRE À LA CLÉ FIREBASE
// ==========================================

async function verifyWriteAccess() {
    const checkRes = await fetch(
        `${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}/passwordHash.json`
    );
    if (checkRes.ok) {
        const distantHash = await checkRes.json();
        if (distantHash) {
            const localHash = await hashPassword(currentKeyPassword);
            if (distantHash !== localHash) {
                return false;
            }
        }
    }
    return true;
}

async function saveAccountBookToCloud(bookRecord) {
    if (!navigator.onLine) {
        alert("Connexion Internet requise pour enregistrer ce livre sur votre compte.");
        return false;
    }

    if (!syncKey) {
        syncKey = genererNouvelleCle();
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
    }

    const safeBookId = sanitizeFirebaseKey(bookRecord.id || `book_${Date.now()}`);
    bookRecord.id = safeBookId;

    updateSyncStatus("Sauvegarde du livre...", false);
    try {
        const canWrite = await verifyWriteAccess();
        if (!canWrite) {
            alert("Écriture refusée : vérifiez le mot de passe de votre compte.");
            updateSyncStatus("Écriture refusée", false);
            return false;
        }

        const baseUrl = `${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(safeBookId)}`;

        // 1. Envoi des métadonnées du livre (sans le texte lourd)
        const metaPayload = {
            id: safeBookId,
            publicId: bookRecord.publicId || null,
            title: bookRecord.title || "Sans titre",
            fileName: bookRecord.fileName || "livre.epub",
            visibility: bookRecord.visibility || 'public',
            sharedBy: bookRecord.sharedBy || syncKey,
            readChapters: bookRecord.readChapters || [],
            pausedPositions: bookRecord.pausedPositions || {},
            lastIndex: bookRecord.lastIndex || 0,
            updatedAt: bookRecord.updatedAt || Date.now()
        };

        const metaRes = await fetch(`${baseUrl}.json`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metaPayload)
        });

        if (!metaRes.ok) {
            const errTxt = await metaRes.text();
            throw new Error(`Métadonnées refusées (HTTP ${metaRes.status}) : ${errTxt}`);
        }

        // 2. Envoi des chapitres par lots de 5 pour éviter toute limite de taille Firebase
        const BATCH_SIZE = 5;
        for (let i = 0; i < bookRecord.chapters.length; i += BATCH_SIZE) {
            const batchUpdates = {};
            const slice = bookRecord.chapters.slice(i, i + BATCH_SIZE);

            slice.forEach((chap, offset) => {
                const chapIdx = i + offset;
                batchUpdates[`chapters/${chapIdx}`] = {
                    id: chap.id || `chap_${chapIdx + 1}`,
                    chapterNum: chap.chapterNum || (chapIdx + 1),
                    label: chap.label || `Chapitre ${chapIdx + 1}`,
                    text: chap.text,
                    wordCount: chap.wordCount || chap.text.split(/\s+/).filter(Boolean).length
                };
            });

            updateSyncStatus(`Envoi chapitres ${Math.min(i + BATCH_SIZE, bookRecord.chapters.length)}/${bookRecord.chapters.length}...`, false);

            const batchRes = await fetch(`${baseUrl}.json`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(batchUpdates)
            });

            if (!batchRes.ok) {
                const errTxt = await batchRes.text();
                throw new Error(`Échec sur les chapitres ${i + 1}-${i + slice.length} (HTTP ${batchRes.status}) : ${errTxt}`);
            }
        }

        const fullRecord = { ...metaPayload, chapters: bookRecord.chapters };
        const idx = accountBooks.findIndex(b => b.id === safeBookId);
        if (idx >= 0) {
            accountBooks[idx] = fullRecord;
        } else {
            accountBooks.unshift(fullRecord);
        }

        updateSyncStatus("À jour", true);
        return true;
    } catch (e) {
        console.error("Erreur sauvegarde catalogue compte:", e);
        alert("Impossible d'ajouter ce livre au catalogue : " + e.message);
        updateSyncStatus("Erreur sync", false);
        return false;
    }
}

async function deleteAccountBookFromCloud(bookId) {
    if (!navigator.onLine || !syncKey) return false;

    updateSyncStatus("Suppression...", false);
    try {
        const canWrite = await verifyWriteAccess();
        if (!canWrite) {
            updateSyncStatus("Suppression refusée", false);
            return false;
        }

        const res = await fetch(
            `${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}/library/${encodeURIComponent(bookId)}.json`,
            { method: "DELETE" }
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        accountBooks = accountBooks.filter(b => b.id !== bookId);
        if (activeBook && activeBook.id === bookId) {
            activeBook = null;
        }

        updateSyncStatus("À jour", true);
        return true;
    } catch (e) {
        console.error("Erreur suppression livre compte:", e);
        updateSyncStatus("Erreur sync", false);
        return false;
    }
}

// ==========================================
// 4. CLÉ API GEMINI (PARAMÈTRE D'APPAREIL)
// ==========================================

function loadLocalPreferences() {
    const savedKey = localStorage.getItem("focus_read_gemini_key");
    if (savedKey) {
        $('api-key').value = savedKey;
    } else if (DEFAULT_API_KEY) {
        $('api-key').value = DEFAULT_API_KEY;
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
// 5. IMPORTATION EPUB / TXT (PUBLIC PAR DÉFAUT)
// ==========================================

function sanitizeFirebaseKey(rawKey) {
    return String(rawKey).replace(/[.#$\[\]/]/g, '_').trim();
}

function buildSafeFirebaseBookId(bookRecord) {
    const cleanTitle = (bookRecord.title || "livre")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .substring(0, 24);
    const sizeTag = bookRecord.id.split('_').pop() || Date.now();
    return `${cleanTitle}_${sizeTag}`;
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const label = $('file-label');
    label.innerText = `Analyse de "${file.name}"...`;

    try {
        const bookId = sanitizeFirebaseKey(`book_${file.name}_${file.size}`);
        let bookTitle = file.name.replace(/\.(epub|txt)$/i, '');
        let chapters = [];

        if (file.name.toLowerCase().endsWith('.epub')) {
            const epubData = await extractChaptersFromEPUB(file);
            bookTitle = epubData.bookTitle;
            chapters = epubData.chapters;
        } else {
            const rawTxt = await file.text();
            const clean = rawTxt
                .replace(/\r\n/g, '\n')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (clean.length < 30) throw new Error("Le fichier texte est trop court.");
            chapters = [{
                id: "chap_1",
                chapterNum: 1,
                label: `Chapitre 1 : ${bookTitle}`,
                text: clean,
                wordCount: clean.split(/\s+/).filter(Boolean).length
            }];
        }

        if (chapters.length === 0) {
            throw new Error("Aucun chapitre lisible trouvé dans ce fichier.");
        }

        const existing = accountBooks.find(b => b.id === bookId);
        const readChapters = existing ? (existing.readChapters || []) : [];
        const pausedPositions = existing ? (existing.pausedPositions || {}) : {};
        const targetVisibility = existing ? (existing.visibility || 'public') : 'public';

        const bookRecord = {
            id: bookId,
            publicId: existing?.publicId || null,
            title: bookTitle,
            fileName: file.name,
            visibility: targetVisibility,
            sharedBy: syncKey || "Anonyme",
            chapters,
            readChapters,
            pausedPositions,
            lastIndex: existing ? Math.min(existing.lastIndex || 0, chapters.length - 1) : 0,
            updatedAt: Date.now()
        };

        if (bookRecord.visibility === 'public') {
            label.innerText = `Publication commune...`;
            const ok = await publishBookToPublicLibrary(bookRecord);
            if (!ok) {
                bookRecord.visibility = 'private';
            }
        }

        label.innerText = `Enregistrement sur le compte...`;
        const saved = await saveAccountBookToCloud(bookRecord);
        if (saved) {
            renderAccountLibraryUI(bookId);
        }

        label.innerText = `Importer EPUB / TXT`;
        $('file-input').value = '';
    } catch (err) {
        alert("Impossible d'importer ce fichier : " + err.message);
        label.innerText = "Erreur. Réessayez.";
    }
}

async function extractChaptersFromEPUB(file) {
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
    const chapters = [];
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

        const titleSuffix = detectedTitle ? ` : ${detectedTitle}` : "";
        chapters.push({
            id: `chap_${chapterCounter}`,
            chapterNum: chapterCounter,
            label: `Chapitre ${chapterCounter}${titleSuffix}`,
            text: chapterText,
            wordCount
        });
        chapterCounter++;
    }

    return { bookTitle, chapters };
}

// ==========================================
// 6. PUBLICATION PUBLIC / PRIVÉ SUR FIREBASE
// ==========================================

async function publishBookToPublicLibrary(bookRecord) {
    if (!navigator.onLine) {
        return false;
    }

    try {
        const fbBookId = bookRecord.publicId || buildSafeFirebaseBookId(bookRecord);
        bookRecord.publicId = fbBookId;

        const metaPayload = {
            id: fbBookId,
            localId: bookRecord.id,
            title: bookRecord.title || "Sans titre",
            fileName: bookRecord.fileName || "livre.epub",
            sharedBy: syncKey || bookRecord.sharedBy || "Anonyme",
            chapterCount: bookRecord.chapters.length,
            publishedAt: Date.now()
        };

        const metaRes = await fetch(
            `${FIREBASE_DB_URL}/focus_read_public_books/${encodeURIComponent(fbBookId)}.json`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(metaPayload)
            }
        );

        if (!metaRes.ok) {
            const errText = await metaRes.text();
            throw new Error(`HTTP ${metaRes.status} (${errText})`);
        }

        for (let i = 0; i < bookRecord.chapters.length; i++) {
            const chap = bookRecord.chapters[i];
            const chapRes = await fetch(
                `${FIREBASE_DB_URL}/focus_read_public_books/${encodeURIComponent(fbBookId)}/chapters/${i}.json`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: chap.id,
                        chapterNum: chap.chapterNum,
                        label: chap.label,
                        text: chap.text,
                        wordCount: chap.wordCount
                    })
                }
            );
            if (!chapRes.ok) {
                throw new Error(`Échec sur le chapitre ${i + 1} (HTTP ${chapRes.status})`);
            }
        }

        return true;
    } catch (e) {
        console.error("Erreur publication publique:", e);
        alert("Impossible de publier en public (sauvegardé en privé) : " + e.message);
        return false;
    }
}

async function deletePublicBookFromFirebase(bookRecord) {
    if (!navigator.onLine) return true;
    const targetId = bookRecord.publicId || bookRecord.id;

    try {
        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_public_books/${encodeURIComponent(targetId)}.json`, {
            method: "DELETE"
        });
        return res.ok;
    } catch (e) {
        console.error("Erreur suppression publique:", e);
        return false;
    }
}

function renderAccountLibraryUI(selectedBookId = null) {
    const books = [...accountBooks].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const libBox = $('library-box');
    const libList = $('library-list');

    if (books.length === 0) {
        libBox.style.display = 'none';
        $('chapter-selector-box').style.display = 'none';
        $('start-btn').disabled = true;
        $('start-btn').innerText = "Importez ou téléchargez un livre";
        activeBook = null;
        return;
    }

    libBox.style.display = 'block';
    const targetId = selectedBookId || (activeBook && activeBook.id) || books[0].id;
    const foundBook = books.find(b => b.id === targetId) || books[0];

    libList.innerHTML = '';
    books.forEach(book => {
        const total = book.chapters.length;
        const readCount = (book.readChapters || []).filter(id => book.chapters.some(c => c.id === id)).length;
        const pct = total > 0 ? Math.round((readCount / total) * 100) : 0;
        const isPublic = book.visibility === 'public';
        const isOwner = !book.sharedBy || book.sharedBy === syncKey || book.sharedBy === "Anonyme";

        const item = document.createElement('div');
        item.className = `lib-item ${book.id === foundBook.id ? 'active' : ''}`;
        item.innerHTML = `
            <div class="lib-info">
                <span class="lib-title">${escapeHtml(book.title)}</span>
                <span class="lib-sub">
                    <span class="vis-pill ${isPublic ? 'pub' : 'priv'}">${isPublic ? 'Public' : 'Privé'}</span>
                    <span>${readCount}/${total} lus (${pct}%)</span>
                </span>
            </div>
            <div class="lib-actions">
                ${!isPublic ? `<button class="lib-del-btn btn-toggle-vis" title="Rendre public">Passer public</button>` : ""}
                ${(isPublic && isOwner) ? `<button class="lib-del-btn btn-toggle-vis" title="Garder uniquement sur votre compte">Passer privé</button>` : ""}
                <button class="lib-del-btn btn-del-book" title="Supprimer">Suppr.</button>
            </div>
        `;

        item.querySelector('.lib-info').onclick = () => {
            renderAccountLibraryUI(book.id);
        };

        const visBtn = item.querySelector('.btn-toggle-vis');
        if (visBtn) {
            visBtn.onclick = async (e) => {
                e.stopPropagation();
                if (!isPublic) {
                    if (confirm(`Publier "${book.title}" dans la bibliothèque commune ?`)) {
                        visBtn.disabled = true;
                        visBtn.innerText = "Envoi...";
                        book.visibility = 'public';
                        book.sharedBy = syncKey || "Anonyme";
                        const ok = await publishBookToPublicLibrary(book);
                        if (ok) {
                            await saveAccountBookToCloud(book);
                        } else {
                            book.visibility = 'private';
                        }
                        renderAccountLibraryUI(book.id);
                    }
                } else {
                    if (confirm(`Passer "${book.title}" en mode Privé (il sera retiré de la bibliothèque commune) ?`)) {
                        visBtn.disabled = true;
                        visBtn.innerText = "Retrait...";
                        await deletePublicBookFromFirebase(book);
                        book.visibility = 'private';
                        await saveAccountBookToCloud(book);
                        renderAccountLibraryUI(book.id);
                    }
                }
            };
        }

        item.querySelector('.btn-del-book').onclick = async (e) => {
            e.stopPropagation();
            const msg = (isPublic && isOwner)
                ? `Supprimer "${book.title}" de votre compte et de la bibliothèque commune ?`
                : `Supprimer "${book.title}" de votre compte ?`;

            if (confirm(msg)) {
                await deleteAccountBookFromCloud(book.id);
                if (isPublic && isOwner) {
                    await deletePublicBookFromFirebase(book);
                }
                renderAccountLibraryUI();
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
    $('book-progress-text').innerText = `${readCount}/${total} (${pct}%)`;
    $('book-progress-bar-fill').style.width = `${pct}%`;

    let defaultIdx = book.lastIndex || 0;
    if (defaultIdx >= total) defaultIdx = 0;

    const select = $('chapter-select');
    select.innerHTML = '';
    book.chapters.forEach((chap, idx) => {
        const isRead = readSet.has(chap.id);
        const isPaused = book.pausedPositions && book.pausedPositions[chap.id] > 0;
        const statusTag = isRead ? "✓ " : (isPaused ? "⏸ " : "");
        const pages = estimatePageCount(chap.wordCount || 0);
        const qCount = calculateQuestionCount(chap.wordCount || 0);
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${statusTag}${chap.label} · ~${pages} p. (${qCount} Q)`;
        select.appendChild(opt);
    });

    $('chapter-selector-box').style.display = 'block';
    $('start-btn').disabled = false;

    selectChapter(defaultIdx, false);
}

async function selectChapter(index, persistToCloud = true) {
    if (!activeBook) return;
    currentChapterIndex = parseInt(index, 10) || 0;
    const chap = activeBook.chapters[currentChapterIndex];
    if (!chap) return;

    $('chapter-select').value = currentChapterIndex;
    activeChapterLabel = chap.label;

    const isAlreadyRead = (activeBook.readChapters || []).includes(chap.id);
    const isPaused = activeBook.pausedPositions && activeBook.pausedPositions[chap.id] > 0;

    if (isPaused) {
        $('start-btn').innerText = "Reprendre la lecture";
    } else if (isAlreadyRead) {
        $('start-btn').innerText = "Relire ce chapitre";
    } else {
        $('start-btn').innerText = "Commencer la lecture";
    }

    if (persistToCloud && activeBook.lastIndex !== currentChapterIndex) {
        activeBook.lastIndex = currentChapterIndex;
        await saveAccountBookToCloud(activeBook);
    }
}

// ==========================================
// 7. BIBLIOTHÈQUE COMMUNE (LIVRES PUBLICS)
// ==========================================

async function ouvrirBibliothequeCommune() {
    $('community-overlay').classList.remove('hidden');
    const listEl = $('community-list');
    listEl.innerHTML = '<div class="lb-row">Chargement des livres partagés...</div>';

    try {
        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_public_books.json`);
        if (!res.ok) throw new Error("Impossible d'accéder à la bibliothèque commune");

        const data = await res.json();
        if (!data) {
            listEl.innerHTML = '<div class="lb-row">Aucun livre partagé pour le moment.</div>';
            return;
        }

        const accountIds = new Set(accountBooks.flatMap(b => [b.id, b.publicId].filter(Boolean)));
        const publicBooks = Object.values(data).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

        listEl.innerHTML = '';
        publicBooks.forEach(pubBook => {
            const alreadyInLib = accountIds.has(pubBook.id) || (pubBook.localId && accountIds.has(pubBook.localId));
            const row = document.createElement('div');
            row.className = 'lb-row';
            row.innerHTML = `
                <div class="lb-rank-name">
                    <span class="lb-name">${escapeHtml(pubBook.title)}</span>
                    <span class="lb-meta">Par ${escapeHtml(pubBook.sharedBy || "Anonyme")} · ${pubBook.chapterCount || "?"} chapitres</span>
                </div>
                <button class="pill-btn btn-add-pub" ${alreadyInLib ? "disabled" : ""}>
                    ${alreadyInLib ? "Ajouté ✓" : "+ Ajouter"}
                </button>
            `;

            const addBtn = row.querySelector('.btn-add-pub');
            if (!alreadyInLib) {
                addBtn.onclick = async () => {
                    addBtn.disabled = true;
                    addBtn.innerText = "Ajout...";
                    const success = await telechargerLivrePublic(pubBook);
                    if (success) {
                        addBtn.innerText = "Ajouté ✓";
                    } else {
                        addBtn.disabled = false;
                        addBtn.innerText = "+ Ajouter";
                    }
                };
            }

            listEl.appendChild(row);
        });
    } catch (e) {
        listEl.innerHTML = `<div class="lb-row">Erreur : ${e.message}</div>`;
    }
}

async function telechargerLivrePublic(pubBook) {
    const rawSource = pubBook?.chapters || pubBook?.rawChapters || [];
    const rawList = (Array.isArray(rawSource) ? rawSource : Object.values(rawSource))
        .filter(ch => ch && typeof ch.text === 'string' && ch.text.trim().length > 0);

    if (!pubBook || rawList.length === 0) {
        alert("Ce livre de la bibliothèque commune ne contient aucun chapitre valide.");
        return false;
    }

    const formattedChapters = rawList.map((ch, idx) => ({
        id: ch.id || `chap_${idx + 1}`,
        chapterNum: ch.chapterNum || (idx + 1),
        label: ch.label || `Chapitre ${idx + 1}${ch.title ? ` : ${ch.title}` : ''}`,
        text: ch.text,
        wordCount: ch.wordCount || ch.text.split(/\s+/).filter(Boolean).length
    }));

    const accountBookId = sanitizeFirebaseKey(pubBook.localId || pubBook.id || `pub_${Date.now()}`);
    const bookRecord = {
        id: accountBookId,
        publicId: pubBook.id,
        title: pubBook.title || "Sans titre",
        fileName: pubBook.fileName || `${pubBook.title || "livre"}.epub`,
        visibility: 'public',
        sharedBy: pubBook.sharedBy || "Anonyme",
        chapters: formattedChapters,
        readChapters: [],
        pausedPositions: {},
        lastIndex: 0,
        updatedAt: Date.now()
    };

    const ok = await saveAccountBookToCloud(bookRecord);
    if (ok) {
        renderAccountLibraryUI(bookRecord.id);
    }
    return ok;
}

// ==========================================
// 8. LECTURE IMMÉDIATE, PAUSE & QUIZ À LA FIN
// ==========================================

function startReadingSession() {
    if (!activeBook) {
        alert("Veuillez d'abord importer ou ajouter un livre.");
        return;
    }

    const chap = activeBook.chapters[currentChapterIndex];
    if (!chap || !chap.text) {
        alert("Chapitre introuvable.");
        return;
    }

    activeText = chap.text;
    activeChapterLabel = chap.label;
    const qCount = calculateQuestionCount(chap.wordCount || activeText.split(/\s+/).filter(Boolean).length);

    $('setup-screen').style.display = 'none';
    $('quiz-screen').style.display = 'none';
    $('game-screen').style.display = 'flex';

    $('hud-chapter-title').innerText = activeChapterLabel;
    $('finish-reading-btn').innerText = `Terminer & Générer le quiz (${qCount} questions)`;

    const track = $('text-track');
    track.innerText = activeText;

    const viewport = $('viewport');
    const savedScroll = (activeBook.pausedPositions && activeBook.pausedPositions[chap.id]) || 0;
    viewport.scrollTop = savedScroll;
    updateScrollProgress();
}

async function pauseReadingSession() {
    if (!activeBook) return;
    const chap = activeBook.chapters[currentChapterIndex];
    const viewport = $('viewport');

    if (chap) {
        if (!activeBook.pausedPositions) activeBook.pausedPositions = {};
        activeBook.pausedPositions[chap.id] = viewport.scrollTop;
        activeBook.updatedAt = Date.now();
        await saveAccountBookToCloud(activeBook);
    }

    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'none';
    $('setup-screen').style.display = 'block';
    renderAccountLibraryUI(activeBook.id);
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

async function finishChapterAndGenerateQuiz() {
    const inputKey = $('api-key').value.trim();
    saveGeminiKey(inputKey);
    const apiKey = inputKey || DEFAULT_API_KEY;

    const chap = activeBook?.chapters[currentChapterIndex];
    const wordCount = chap?.wordCount || activeText.split(/\s+/).filter(Boolean).length;
    const questionCount = calculateQuestionCount(wordCount);

    if (!apiKey) {
        alert("Veuillez renseigner votre clé API Gemini sur l'écran principal (votre lecture est mise en pause).");
        await pauseReadingSession();
        return;
    }

    const finishBtn = $('finish-reading-btn');
    finishBtn.disabled = true;
    finishBtn.innerText = `Génération de ${questionCount} questions...`;

    try {
        generatedQuiz = await generateQuizFromText(apiKey, activeText, questionCount);

        if (activeBook && chap && activeBook.pausedPositions && activeBook.pausedPositions[chap.id]) {
            delete activeBook.pausedPositions[chap.id];
            await saveAccountBookToCloud(activeBook);
        }

        showQuizScreen();
    } catch (err) {
        alert("Erreur lors de la génération du quiz : " + err.message);
    } finally {
        finishBtn.disabled = false;
        finishBtn.innerText = `Terminer & Générer le quiz (${questionCount} questions)`;
    }
}

async function generateQuizFromText(apiKey, text, questionCount) {
    const prompt = `Voici un chapitre de livre que l'utilisateur vient de terminer :
    "${text}"
    Pose exactement ${questionCount} questions de compréhension de difficulté équilibrée (portant sur les événements clés, les personnages, leurs motivations et les actions importantes réparties sur l'ensemble du chapitre), avec 3 choix de réponse chacune.
    Pour chaque question, ajoute un champ "explanation" d'une à deux phrases claires qui explique pourquoi la bonne réponse est exacte en s'appuyant directement sur le texte.
    Réponds UNIQUEMENT en JSON strict sans balises markdown :
    [
        {
            "question": "Question 1 ?",
            "options": ["Choix A", "Choix B", "Choix C"],
            "answer": 0,
            "explanation": "Explication courte et précise tirée du chapitre."
        }
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

// ==========================================
// 9. CORRECTION EXPLICATIVE & SCORE EN ÉVIDENCE
// ==========================================

function showQuizScreen() {
    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'block';
    $('quiz-title').innerText = `Vérification · ${generatedQuiz.length} questions`;
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
        qDiv.innerHTML = `<p>${qIndex + 1}. ${escapeHtml(q.question)}</p>`;

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
        const qDiv = questionDivs[qIndex];
        const optionsBtns = qDiv.querySelectorAll('.quiz-option');
        const chosen = userAnswers[qIndex];
        const isCorrect = chosen === q.answer;

        optionsBtns.forEach((btn, idx) => {
            btn.disabled = true;
            btn.classList.remove('selected');
            if (idx === q.answer) {
                btn.classList.add('correct');
                btn.innerText = `✓ ${q.options[idx]}`;
            } else if (idx === chosen) {
                btn.classList.add('wrong');
                btn.innerText = `✗ ${q.options[idx]}`;
            }
        });

        if (isCorrect) correctCount++;

        // Affichage de l'explication détaillée sous chaque question
        const expBox = document.createElement('div');
        expBox.className = `quiz-explanation ${isCorrect ? '' : 'is-wrong'}`;
        const statusTitle = isCorrect
            ? "✓ Bonne réponse"
            : `✗ Mauvaise réponse — Réponse attendue : « ${escapeHtml(q.options[q.answer])} »`;
        const detailText = q.explanation
            ? escapeHtml(q.explanation)
            : (isCorrect ? "Vous avez bien retenu ce passage du chapitre." : "Relisez ce passage du chapitre pour vérifier ce détail.");

        expBox.innerHTML = `
            <span class="quiz-explanation-header">${statusTitle}</span>
            <span>${detailText}</span>
        `;
        qDiv.appendChild(expBox);
    });

    const totalQuestions = generatedQuiz.length;
    const percentage = Math.round((correctCount / totalQuestions) * 100);
    const isPerfect = correctCount === totalQuestions;
    const pointsGagnes = (correctCount * 10) + (isPerfect ? 20 : 0);

    userStats.scoreTotal = (userStats.scoreTotal || 0) + pointsGagnes;
    userStats.quizzesCompleted = (userStats.quizzesCompleted || 0) + 1;
    if (isPerfect) {
        userStats.perfectScores = (userStats.perfectScores || 0) + 1;
    }

    let validationStatusMsg = "";
    const chap = activeBook.chapters[currentChapterIndex];

    if (isPerfect && chap) {
        if (!activeBook.readChapters) activeBook.readChapters = [];
        const isFirstTimeChapterValidated = !activeBook.readChapters.includes(chap.id);
        if (isFirstTimeChapterValidated) {
            activeBook.readChapters.push(chap.id);
        }

        recordValidatedChapterStats(isFirstTimeChapterValidated);
        activeBook.updatedAt = Date.now();
        await saveAccountBookToCloud(activeBook);

        const currentStreak = getEffectiveStreak(userStats);
        validationStatusMsg = `Chapitre validé comme lu · Streak : ${currentStreak} j (${userStats.totalChaptersRead} lus)`;
    } else {
        validationStatusMsg = `Chapitre non validé · 100 % requis pour le marquer comme lu`;
    }

    renderGlobalStatsUI();
    await pushStatsToCloud();

    // Carte de score bien mise en évidence en haut des résultats
    const container = $('quiz-container');
    const scoreHero = document.createElement('div');
    scoreHero.className = 'score-hero-card';
    scoreHero.innerHTML = `
        <span class="score-hero-badge ${isPerfect ? '' : 'failed'}">
            ${isPerfect ? 'CHAPITRE VALIDÉ ✓' : 'À REVOIR'}
        </span>
        <div class="score-hero-value">${correctCount} / ${totalQuestions} <span style="font-size:1.15rem; font-weight:600; color:var(--muted);">(${percentage}%)</span></div>
        <div class="score-hero-sub">
            <strong>+${pointsGagnes} pts</strong> ajoutés à votre compte (Total : ${userStats.scoreTotal} pts)<br>
            ${validationStatusMsg}
        </div>
    `;
    container.insertBefore(scoreHero, container.firstChild);

    // Remonte tout en haut pour voir immédiatement le score
    const quizPanel = $('quiz-screen');
    if (quizPanel) quizPanel.scrollTo({ top: 0, behavior: 'smooth' });

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
}

async function launchNextChapter() {
    if (!activeBook || currentChapterIndex + 1 >= activeBook.chapters.length) return;
    await selectChapter(currentChapterIndex + 1, true);
    startReadingSession();
}

function resetToMenu() {
    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'none';
    $('setup-screen').style.display = 'block';
    renderGlobalStatsUI();
    renderAccountLibraryUI(activeBook ? activeBook.id : null);
}

// ==========================================
// 10. SYNCHRONISATION COMPTE FIREBASE (STATS + CATALOGUE)
// ==========================================

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
    const dot = $('syncDot');
    if (el) {
        el.textContent = `Sync : ${msg}`;
        el.style.color = isSuccess ? "#f7f7f7" : "#888888";
    }
    if (dot) {
        dot.classList.toggle('online', isSuccess);
    }
}

function updateSyncKeyUI() {
    const labelEl = $('syncKeyLabel');
    if (labelEl) {
        const isLocked = Boolean(currentKeyPassword);
        labelEl.textContent = syncKey ? `${syncKey}${isLocked ? " · 🔒" : ""}` : "Définir un compte";
    }
    if ($('current-lb-key')) {
        $('current-lb-key').textContent = syncKey || "Non définie";
    }
}

function genererNouvelleCle() {
    return "READ-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function resetAccountStateInMemory() {
    userStats = {
        scoreTotal: 0,
        quizzesCompleted: 0,
        perfectScores: 0,
        totalChaptersRead: 0,
        streakDays: 0,
        lastReadDate: null
    };
    accountBooks = [];
    activeBook = null;
    renderGlobalStatsUI();
    renderAccountLibraryUI();
}

async function changerOuCopierCle() {
    const action = prompt(
        `Clé actuelle (votre compte) : ${syncKey || "Aucune"}\n\n` +
        `1. Changer ou créer un compte (ex: votre prénom ou pseudo)\n` +
        `2. Définir / modifier le mot de passe de ce compte\n` +
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
        await pushStatsToCloud();
        return;
    }

    let rawNouvelleCle = (saisie === "1") ? (prompt("Entrez le nom de votre clé :") || "") : saisie;
    let nouvelleCle = sanitizeFirebaseKey(rawNouvelleCle);

    // Remise à zéro immédiate en mémoire (compte vierge)
    resetAccountStateInMemory();

    if (!nouvelleCle) {
        syncKey = genererNouvelleCle();
        currentKeyPassword = "";
        localStorage.removeItem("focus_read_sync_pwd");
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
        await pushStatsToCloud();
        return;
    }

    syncKey = nouvelleCle;
    currentKeyPassword = "";
    localStorage.removeItem("focus_read_sync_pwd");
    localStorage.setItem("focus_read_sync_key", syncKey);
    updateSyncKeyUI();
    await pullAccountFromCloud();
}

async function pullAccountFromCloud() {
    if (!navigator.onLine) {
        updateSyncStatus("Hors ligne", false);
        return;
    }

    if (!syncKey) {
        syncKey = genererNouvelleCle();
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
        resetAccountStateInMemory();
        await pushStatsToCloud();
        return;
    }

    updateSyncStatus("Chargement du compte...", false);
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const payload = await res.json();
        if (!payload) {
            // Nouveau compte vierge sur Firebase
            resetAccountStateInMemory();
            await pushStatsToCloud();
            return;
        }

        if (payload.passwordHash) {
            let tentatives = 0;
            let hashLocal = await hashPassword(currentKeyPassword);

            while (hashLocal !== payload.passwordHash && tentatives < 3) {
                const saisie = prompt(`Le compte "${syncKey}" est protégé par un mot de passe :`);
                if (saisie === null) {
                    resetAccountStateInMemory();
                    updateSyncStatus("Accès refusé", false);
                    return;
                }
                currentKeyPassword = saisie.trim();
                hashLocal = await hashPassword(currentKeyPassword);
                tentatives++;
            }

            if (hashLocal !== payload.passwordHash) {
                resetAccountStateInMemory();
                updateSyncStatus("Mot de passe incorrect", false);
                return;
            }

            localStorage.setItem("focus_read_sync_pwd", currentKeyPassword);
            updateSyncKeyUI();
        }

        // Chargement des statistiques du compte
        userStats = {
            scoreTotal: payload.scoreTotal || 0,
            quizzesCompleted: payload.quizzesCompleted || 0,
            perfectScores: payload.perfectScores || 0,
            totalChaptersRead: payload.totalChaptersRead || payload.perfectScores || 0,
            streakDays: payload.streakDays || 0,
            lastReadDate: payload.lastReadDate || null
        };
        renderGlobalStatsUI();

        // Chargement exclusif du catalogue de livres de ce compte Firebase
        const cloudLib = payload.library || {};
        accountBooks = Object.values(cloudLib)
            .filter(b => b && b.chapters)
            .map(b => {
                const normalizedChapters = (Array.isArray(b.chapters) ? b.chapters : Object.values(b.chapters))
                    .filter(ch => ch && typeof ch.text === 'string');
                return {
                    ...b,
                    chapters: normalizedChapters,
                    readChapters: b.readChapters || [],
                    pausedPositions: b.pausedPositions || {}
                };
            })
            .filter(b => b.chapters.length > 0);

        renderAccountLibraryUI();
        updateSyncStatus("À jour", true);
    } catch (e) {
        console.error("Erreur lecture compte Firebase:", e);
        updateSyncStatus("Erreur lecture", false);
    }
}

async function pushStatsToCloud() {
    if (!navigator.onLine) return;

    if (!syncKey) {
        syncKey = genererNouvelleCle();
        localStorage.setItem("focus_read_sync_key", syncKey);
        updateSyncKeyUI();
    }

    updateSyncStatus("Envoi...", false);
    try {
        const canWrite = await verifyWriteAccess();
        if (!canWrite) {
            updateSyncStatus("Écriture refusée", false);
            return;
        }

        const hash = await hashPassword(currentKeyPassword);
        const payload = {
            ...userStats,
            streakDays: getEffectiveStreak(userStats),
            passwordHash: hash || null,
            updatedAt: Date.now()
        };

        const res = await fetch(`${FIREBASE_DB_URL}/focus_read_users/${encodeURIComponent(syncKey)}.json`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        updateSyncStatus("Synchronisé", true);
    } catch (e) {
        console.error("Erreur écriture Firebase:", e);
        updateSyncStatus("Erreur envoi", false);
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
            listEl.innerHTML = '<div class="lb-row">Aucun lecteur classé pour le moment.</div>';
            return;
        }

        const players = Object.entries(data)
            .map(([key, val]) => ({
                key,
                scoreTotal: val.scoreTotal || 0,
                chaptersRead: val.totalChaptersRead || val.perfectScores || 0,
                streakDays: getEffectiveStreak(val)
            }))
            .sort((a, b) => b.scoreTotal - a.scoreTotal)
            .slice(0, 30);

        listEl.innerHTML = players.map((p, index) => {
            const isMe = p.key === syncKey;
            const rank = `#${index + 1} `;
            return `
                <div class="lb-row ${isMe ? 'me' : ''}">
                    <div class="lb-rank-name">
                        <span class="lb-name">${rank}${escapeHtml(p.key)} ${isMe ? "(Vous)" : ""}</span>
                        <span class="lb-meta">Streak ${p.streakDays} j · ${p.chaptersRead} chapitres lus</span>
                    </div>
                    <span class="lb-score">${p.scoreTotal} pts</span>
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
// 11. ÉVÉNEMENTS & INITIALISATION PWA
// ==========================================

$('api-key').addEventListener('input', e => saveGeminiKey(e.target.value));

$('file-drop-zone').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', handleFileUpload);
$('chapter-select').addEventListener('change', e => selectChapter(e.target.value, true));

$('start-btn').addEventListener('click', startReadingSession);
$('pause-reading-btn').addEventListener('click', pauseReadingSession);
$('viewport').addEventListener('scroll', updateScrollProgress);
$('finish-reading-btn').addEventListener('click', finishChapterAndGenerateQuiz);

$('submit-quiz-btn').addEventListener('click', evaluateQuiz);
$('retry-chapter-btn').addEventListener('click', startReadingSession);
$('next-chapter-btn').addEventListener('click', launchNextChapter);
$('restart-btn').addEventListener('click', resetToMenu);

// Firebase, Communauté & Classement events
$('btnSyncKey').addEventListener('click', changerOuCopierCle);
$('btnCommunity').addEventListener('click', ouvrirBibliothequeCommune);
$('btnCloseCommunity').addEventListener('click', () => $('community-overlay').classList.add('hidden'));
$('btnLeaderboard').addEventListener('click', ouvrirClassement);
$('btnCloseLeaderboard').addEventListener('click', () => $('leaderboard-overlay').classList.add('hidden'));

// Enregistrement du Service Worker PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then(reg => {
            reg.update();
        }).catch(err => console.warn('SW non enregistré:', err));

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                window.location.reload();
            }
        });
    });
}

// Démarrage : charge les préférences d'appareil puis le compte Firebase
(async () => {
    loadLocalPreferences();
    updateSyncKeyUI();
    renderGlobalStatsUI();
    await pullAccountFromCloud();
})();
