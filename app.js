const $ = id => document.getElementById(id);

// Chargement depuis config.js (équivalent .env)
const FIREBASE_DB_URL = (typeof ENV !== 'undefined' && ENV.FIREBASE_DB_URL) 
    ? ENV.FIREBASE_DB_URL 
    : "https://antibrainrotting-4f194-default-rtdb.europe-west1.firebasedatabase.app";

const DEFAULT_API_KEY = (typeof ENV !== 'undefined' && ENV.DEFAULT_GEMINI_API_KEY) 
    ? ENV.DEFAULT_GEMINI_API_KEY 
    : "";

// ÉTAT DE L'APPLICATION
let currentMode = 'ai';
let activeText = "";
let generatedQuiz = [];
let userAnswers = {};

// ÉTAT FIREBASE & CLASSEMENT
let syncKey = localStorage.getItem("focus_read_sync_key") || null;
let currentKeyPassword = localStorage.getItem("focus_read_sync_pwd") || "";
let userStats = JSON.parse(localStorage.getItem("focus_read_stats") || "null") || {
    pseudo: "Lecteur",
    scoreTotal: 0,
    quizzesCompleted: 0,
    perfectScores: 0
};

const fallbackData = {
    text: "Depuis trois semaines, la mer n'a pas rendu un seul navire à l'horizon. Le gardien note chaque heure dans son registre humide, écoutant le vent frapper la vitre épaisse. Ici, le silence n'est jamais total ; il ressemble plutôt à une respiration lente derrière les murs de pierre.\n\nHier soir, une sirène lointaine a déchiré la brume, mais ce n'était qu'une illusion sonore. La science explique ces mirages auditifs par l'isolement prolongé. Pourtant, lorsque le calme retombe sur la tour de granit, il devient impossible de détacher son regard de l'obscurité. Chaque ombre sur l'escalier en colimaçon semble attendre un mouvement, une preuve que le monde extérieur existe encore au-delà de l'océan.",
    quiz: [
        {
            question: "Depuis combien de temps le gardien n'a-t-il vu aucun navire ?",
            options: ["Trois jours", "Trois semaines", "Trois mois"],
            answer: 1
        },
        {
            question: "En quoi la tour du phare est-elle construite ?",
            options: ["En bois", "En brique", "En granit"],
            answer: 2
        },
        {
            question: "Comment le texte explique-t-il la sirène entendue hier soir ?",
            options: ["Un bateau en détresse", "Un mirage auditif dû à l'isolement", "Le bruit du vent dans l'escalier"],
            answer: 1
        }
    ]
};

// ==========================================
// 1. GESTION DES ONGLETS & IMPORT EPUB / TXT
// ==========================================

function switchTab(mode) {
    currentMode = mode;
    $('tab-ai').classList.toggle('active', mode === 'ai');
    $('tab-file').classList.toggle('active', mode === 'file');
    $('mode-ai').style.display = mode === 'ai' ? 'block' : 'none';
    $('mode-file').style.display = mode === 'file' ? 'block' : 'none';
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const label = $('file-label');
    label.innerText = `Extraction de "${file.name}"...`;

    try {
        let extracted = "";
        if (file.name.toLowerCase().endsWith('.epub')) {
            extracted = await extractTextFromEPUB(file);
        } else {
            extracted = await file.text();
        }

        // Nettoyage des espaces multiples tout en gardant les sauts de paragraphe
        extracted = extracted
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const wordsArray = extracted.split(/\s+/);
        if (wordsArray.length > 350) {
            extracted = wordsArray.slice(0, 350).join(' ') + "...";
        }

        $('custom-text').value = extracted;
        $('preview-box').style.display = 'block';
        label.innerText = `Fichier prêt : ${file.name} (${Math.min(wordsArray.length, 350)} mots)`;
    } catch (err) {
        alert("Impossible de lire ce fichier : " + err.message);
        label.innerText = "Erreur lors du chargement. Réessayez.";
    }
}

async function extractTextFromEPUB(file) {
    if (typeof JSZip === 'undefined') {
        throw new Error("Bibliothèque JSZip non chargée.");
    }

    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. Lire META-INF/container.xml pour localiser le fichier .opf
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

    // 2. Construire la carte manifest (id -> href)
    const manifestMap = {};
    opfDoc.querySelectorAll("manifest > item").forEach(item => {
        manifestMap[item.getAttribute("id")] = item.getAttribute("href");
    });

    // 3. Suivre le spine (ordre de lecture des chapitres)
    const spineItems = opfDoc.querySelectorAll("spine > itemref");
    let fullText = "";

    for (const itemref of spineItems) {
        const idref = itemref.getAttribute("idref");
        const href = manifestMap[idref];
        if (!href) continue;

        const fullChapterPath = decodeURIComponent(opfDir + href);
        const chapterFile = zip.file(fullChapterPath);
        if (!chapterFile) continue;

        const xhtml = await chapterFile.async("text");
        const doc = parser.parseFromString(xhtml, "text/html");
        
        // Supprimer les styles et scripts éventuels
        doc.querySelectorAll("style, script").forEach(el => el.remove());
        
        const bodyText = doc.body ? doc.body.textContent.trim() : "";
        if (bodyText.length > 20) {
            fullText += bodyText + "\n\n";
        }

        // Arrêter dès qu'on a largement assez de matière (~500 mots)
        if (fullText.split(/\s+/).length > 500) break;
    }

    if (!fullText.trim()) {
        throw new Error("Aucun texte exploitable trouvé dans cet EPUB.");
    }

    return fullText;
}

// ==========================================
// 2. GÉNÉRATION IA (GEMINI) & LECTURE LIBRE
// ==========================================

async function initGame() {
    const inputKey = $('api-key').value.trim();
    const apiKey = inputKey || DEFAULT_API_KEY;
    const btn = $('start-btn');

    btn.disabled = true;
    btn.innerText = "PRÉPARATION EN COURS...";

    try {
        if (currentMode === 'file') {
            const customTxt = $('custom-text').value.trim();
            if (!customTxt || customTxt.length < 30) {
                throw new Error("Veuillez importer un fichier EPUB/TXT valide ou saisir un texte.");
            }
            if (!apiKey) {
                throw new Error("Veuillez renseigner votre clé API Gemini pour générer les questions sur votre document.");
            }
            activeText = customTxt;
            generatedQuiz = await generateQuizFromText(apiKey, activeText);
        } else {
            const theme = $('theme').value.trim();
            if (apiKey) {
                const data = await fetchTextAndQuizFromGemini(apiKey, theme);
                activeText = data.text;
                generatedQuiz = data.quiz;
            } else {
                activeText = fallbackData.text;
                generatedQuiz = fallbackData.quiz;
            }
        }

        startReadingSession();
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "COMMENCER LA LECTURE";
    }
}

async function fetchTextAndQuizFromGemini(apiKey, theme) {
    const prompt = `Écris un texte riche et captivant d'environ 180 mots en français sur le thème : "${theme}".
    Aère le texte en 2 ou 3 paragraphes.
    Crée ensuite 3 questions à choix multiples (QCM) précises sur des détails du texte pour vérifier que le lecteur a bien lu l'intégralité du passage.
    Réponds UNIQUEMENT en JSON strict sans balises markdown :
    {
        "text": "Paragraphe 1...\n\nParagraphe 2...",
        "quiz": [
            {"question": "Question 1 ?", "options": ["Choix A", "Choix B", "Choix C"], "answer": 0}
        ]
    }`;

    return await callGeminiJSON(apiKey, prompt);
}

async function generateQuizFromText(apiKey, text) {
    const prompt = `Voici un texte que l'utilisateur vient de lire :
    "${text}"
    Crée 3 questions à choix multiples (QCM) précises et pertinentes sur les informations contenues dans ce texte pour vérifier qu'il l'a bien lu attentivement.
    Réponds UNIQUEMENT en JSON strict sans balises markdown :
    [
        {"question": "Question 1 ?", "options": ["Choix A", "Choix B", "Choix C"], "answer": 0}
    ]`;

    return await callGeminiJSON(apiKey, prompt);
}

async function callGeminiJSON(apiKey, prompt) {
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
// 3. QUIZ & ATTRIBUTION DES POINTS
// ==========================================

function showQuizScreen() {
    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'block';
    $('submit-quiz-btn').style.display = 'block';
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

    // Calcul des points : 10 pts par bonne réponse + 20 pts bonus si sans-faute
    const isPerfect = correctCount === generatedQuiz.length;
    const pointsGagnes = (correctCount * 10) + (isPerfect ? 20 : 0);

    userStats.scoreTotal += pointsGagnes;
    userStats.quizzesCompleted += 1;
    if (isPerfect) userStats.perfectScores += 1;

    saveLocalStats();
    await pushToCloud();

    $('submit-quiz-btn').style.display = 'none';
    $('restart-btn').style.display = 'block';

    const finalMsg = document.createElement('div');
    finalMsg.className = 'result-box';
    finalMsg.innerHTML = `
        SCORE : <strong>${correctCount} / ${generatedQuiz.length}</strong><br>
        POINTS GAGNÉS : <strong>+${pointsGagnes} PTS</strong> (Total : ${userStats.scoreTotal} pts)
    `;
    $('quiz-container').appendChild(finalMsg);
}

function resetToMenu() {
    $('game-screen').style.display = 'none';
    $('quiz-screen').style.display = 'none';
    $('setup-screen').style.display = 'block';
}

// ==========================================
// 4. FIREBASE SYNC, CLASSEMENT & SÉCURITÉ
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
}

function genererNouvelleCle() {
    return "READ-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function changerOuCopierCle() {
    const action = prompt(
        `Clé actuelle : ${syncKey || "Aucune"}\n\n` +
        `1. Changer ou créer une clé\n` +
        `2. Définir / modifier le mot de passe de cette clé\n` +
        `Entrez 1, 2 ou directement une nouvelle clé :`
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

    let nouvelleCle = (saisie === "1") ? (prompt("Entrez la clé :") || "").trim() : saisie;

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
                const saisie = prompt(`La clé ${syncKey} est protégée par un mot de passe :`);
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

        // Fusion des stats (on conserve le meilleur score)
        userStats = {
            pseudo: payload.pseudo || userStats.pseudo,
            scoreTotal: Math.max(userStats.scoreTotal || 0, payload.scoreTotal || 0),
            quizzesCompleted: Math.max(userStats.quizzesCompleted || 0, payload.quizzesCompleted || 0),
            perfectScores: Math.max(userStats.perfectScores || 0, payload.perfectScores || 0)
        };

        saveLocalStats();
        $('pseudo-input').value = userStats.pseudo;
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
    $('pseudo-input').value = userStats.pseudo;
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
                pseudo: val.pseudo || "Anonyme",
                scoreTotal: val.scoreTotal || 0,
                quizzesCompleted: val.quizzesCompleted || 0
            }))
            .sort((a, b) => b.scoreTotal - a.scoreTotal)
            .slice(0, 25); // Top 25

        listEl.innerHTML = players.map((p, index) => {
            const isMe = p.key === syncKey;
            return `
                <div class="lb-row ${isMe ? 'me' : ''}">
                    <span>#${index + 1} ${escapeHtml(p.pseudo)} (${p.quizzesCompleted} quiz)</span>
                    <span>${p.scoreTotal} PTS</span>
                </div>
            `;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<div class="lb-row">Erreur : ${e.message}</div>`;
    }
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

async function sauvegarderPseudo() {
    const val = $('pseudo-input').value.trim();
    if (!val) return;
    userStats.pseudo = val;
    saveLocalStats();
    await pushToCloud();
    ouvrirClassement();
}

// ==========================================
// 5. ÉVÉNEMENTS, ANTI-ZOOM & INITIALISATION PWA
// ==========================================

$('tab-ai').addEventListener('click', () => switchTab('ai'));
$('tab-file').addEventListener('click', () => switchTab('file'));
$('file-drop-zone').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', handleFileUpload);
$('start-btn').addEventListener('click', initGame);
$('viewport').addEventListener('scroll', updateScrollProgress);
$('finish-reading-btn').addEventListener('click', showQuizScreen);
$('submit-quiz-btn').addEventListener('click', evaluateQuiz);
$('restart-btn').addEventListener('click', resetToMenu);

// Firebase & Classement events
$('btnSyncKey').addEventListener('click', changerOuCopierCle);
$('btnLeaderboard').addEventListener('click', ouvrirClassement);
$('btnCloseLeaderboard').addEventListener('click', () => $('leaderboard-overlay').classList.add('hidden'));
$('btnSavePseudo').addEventListener('click', sauvegarderPseudo);

// Protection anti-zoom (identique à votre projet)
document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
});
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
}, false);

// Enregistrement du Service Worker PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW non enregistré:', err));
    });
}

// Démarrage
updateSyncKeyUI();
pullFromCloud();
