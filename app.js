import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, get, remove, push, child, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { PLAYERS_DATA } from './players.js';

/**
 * PRODUCTION-READY FIREBASE AUCTION MODULE
 * Optimized for real-time live interactions, state safety, and global resets.
 */

// --- Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyA70wenMaP3tF8mlWpKtggRZcvtH_DODu8",
    authDomain: "mejores-amigos-8e478.firebaseapp.com",
    projectId: "mejores-amigos-8e478",
    databaseURL: "https://mejores-amigos-8e478-default-rtdb.firebaseio.com",
    storageBucket: "mejores-amigos-8e478.firebasestorage.app",
    messagingSenderId: "498617796168",
    appId: "1:498617796168:web:ed0bbf9c89c94831a63a7d"
};

// --- Initial Safeguards ---
if (!PLAYERS_DATA || !Array.isArray(PLAYERS_DATA)) {
    console.error("CRITICAL: Players data failed to load or is invalid.");
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// --- Constants & Rules ---
const BUDGET_LAKHS = 1500;
const TEAM_SIZE = 18;
const MIN_PLAYERS_LOBBY = 2;
const BID_INC = 5;
const START_BID = 5;
const GOAT_LIST = ["Messi", "Ronaldo", "Pele", "Maradona", "Zidane", "Ronaldinho", "Neymar"];

// --- State Variables ---
let currentUser = JSON.parse(localStorage.getItem('ma_user')) || null;
let globalAuctionState = null;
let globalPlayerList = null;
let timerHandle = null;

// --- Global Logic Router ---
const router = () => {
    const p = window.location.pathname;
    if (p.endsWith('index.html') || p === '/' || p.endsWith('/')) initIndexPage();
    else if (p.endsWith('lobby.html')) initLobbyPage();
    else if (p.endsWith('auction.html')) initAuctionPage();
    else if (p.endsWith('results.html')) initResultsPage();
};

// --- GLOBAL STATE MONITOR ---
// Listen for database resets or kicks globally
const setupGlobalWatchers = () => {
    onValue(ref(db, 'gameState/resetSignal'), (snap) => {
        if (snap.exists() && snap.val() === true) {
            localStorage.removeItem('ma_user');
            if (!window.location.pathname.endsWith('index.html') && window.location.pathname !== '/') {
                window.location.href = 'index.html';
            }
        }
    });

    if (currentUser) {
        onValue(ref(db, `users/${currentUser.id}`), (snap) => {
            if (!snap.exists() && !window.location.pathname.endsWith('index.html') && window.location.pathname !== '/') {
                localStorage.removeItem('ma_user');
                window.location.href = 'index.html';
            }
        });
    }
};

// --- PAGE: INDEX ---
function initIndexPage() {
    setupGlobalWatchers();
    const joinBtn = document.getElementById('joinBtn');
    if (!joinBtn) return;

    joinBtn.addEventListener('click', async () => {
        const nameInput = document.getElementById('username');
        const pinInput = document.getElementById('adminPassword');
        const rawName = nameInput.value.trim();

        // FULL RESET FEATURE: "CANCEL"
        if (rawName.toUpperCase() === 'CANCEL') {
            if (confirm("⚠️ EXTREME ACTION: Reset entire game for everyone?")) {
                await performFullSystemReset();
                return;
            }
        }

        if (rawName.length < 2) return alert("Enter a valid name.");

        const isAdmin = rawName.toLowerCase().endsWith('admin');
        if (isAdmin && pinInput.value !== '123456') return alert("Wrong PIN.");

        const uid = (isAdmin ? rawName.slice(0, -5) : rawName).toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 999);
        const userObj = {
            id: uid,
            name: isAdmin ? rawName.slice(0, -5) : rawName,
            isAdmin: isAdmin,
            budget: BUDGET_LAKHS,
            teamCount: 0,
            positions: { GK: 0, DEF: 0, MID: 0, FWD: 0 }
        };

        await set(ref(db, `users/${uid}`), userObj);
        localStorage.setItem('ma_user', JSON.stringify(userObj));
        window.location.href = 'lobby.html';
    });
}

// --- PAGE: LOBBY ---
function initLobbyPage() {
    if (!currentUser) return window.location.href = 'index.html';
    setupGlobalWatchers();

    onValue(ref(db, 'users'), (snap) => {
        const users = Object.values(snap.val() || {});
        const listEl = document.getElementById('playerList');
        const countEl = document.getElementById('playerCount');
        if (!listEl) return;

        countEl.innerText = users.length;
        listEl.innerHTML = users.map(u => `
            <li class="p-4 flex justify-between items-center border-b border-gray-700 animate-fade-in">
                <span class="font-bold ${u.id === currentUser.id ? 'text-blue-400' : ''}">
                    ${u.name} ${u.isAdmin ? '👑' : ''}
                </span>
                ${u.id === currentUser.id ? '<span class="text-[10px] bg-blue-900 px-2 py-1 rounded">YOU</span>' : ''}
            </li>
        `).join('');

        if (currentUser.isAdmin) {
            const startBtn = document.getElementById('startAuctionBtn');
            startBtn.disabled = users.length < MIN_PLAYERS_LOBBY;
            startBtn.classList.toggle('opacity-50', startBtn.disabled);
        }
    });

    onValue(ref(db, 'gameState/phase'), (snap) => {
        if (snap.val() === 'auction') window.location.href = 'auction.html';
    });

    if (currentUser.isAdmin) {
        document.getElementById('startAuctionBtn').onclick = async () => {
            const list = shufflePlayers();
            await set(ref(db, 'auctionData/playerList'), list);
            await set(ref(db, 'auctionData/current'), {
                index: 0,
                bid: START_BID,
                highestBidder: null,
                highestBidderName: null,
                timerEndsAt: Date.now() + 15000
            });
            await update(ref(db, 'gameState'), { phase: 'auction', resetSignal: false });
        };

        document.getElementById('resetAuctionBtn').onclick = () => {
            if (confirm("Reset everything?")) performFullSystemReset();
        };
    }
}

// --- PAGE: AUCTION ---
function initAuctionPage() {
    if (!currentUser) return window.location.href = 'index.html';
    setupGlobalWatchers();
    setupNotificationToast();

    const els = {
        img: document.getElementById('playerImage'),
        name: document.getElementById('playerName'),
        pos: document.getElementById('playerPosition'),
        bid: document.getElementById('currentBidDisplay'),
        timer: document.getElementById('timerDisplay'),
        highest: document.getElementById('highestBidderName'),
        crown: document.getElementById('highestBidderCrown'),
        btn: document.getElementById('placeBidBtn'),
        nextBid: document.getElementById('nextBidAmount'),
        budget: document.getElementById('myBudgetDisplay'),
        teamCount: document.getElementById('teamCountDisplay'),
        progress: document.getElementById('progressDisplay'),
        error: document.getElementById('bidErrorMsg'),
        admin: document.getElementById('auctionAdminControls')
    };

    if (currentUser.isAdmin) els.admin.classList.remove('hidden');

    // Local state sync
    onValue(ref(db, `users/${currentUser.id}`), (snap) => {
        const u = snap.val(); if (!u) return;
        els.budget.innerText = formatMoney(u.budget);
        els.teamCount.innerText = u.teamCount;
        ['GK', 'DEF', 'MID', 'FWD'].forEach(p => {
            document.getElementById(`stat${p}`).innerText = u.positions[p] || 0;
        });
    });

    // Auction Core sync
    onValue(ref(db, 'auctionData'), (snap) => {
        const data = snap.val();
        if (!data || !data.current || !data.playerList) return;
        
        globalPlayerList = data.playerList;
        globalAuctionState = data.current;
        const player = globalPlayerList[globalAuctionState.index];

        if (!player) {
            if (currentUser.isAdmin) set(ref(db, 'gameState/phase'), 'results');
            return;
        }

        renderPlayer(player, globalAuctionState, els);
    });

    onValue(ref(db, 'gameState/phase'), (snap) => {
        if (snap.val() === 'results') window.location.href = 'results.html';
    });

    els.btn.onclick = () => handleBidClick(els);

    if (currentUser.isAdmin) {
        document.getElementById('adminForceNextBtn').onclick = () => skipPlayer();
        document.getElementById('adminPauseBtn').onclick = togglePause;
    }
}

// --- PAGE: RESULTS ---
function initResultsPage() {
    setupGlobalWatchers();
    onValue(ref(db, 'users'), (snap) => {
        const users = Object.values(snap.val() || {});
        const container = document.getElementById('teamsContainer');
        if (!container) return;

        container.innerHTML = users.map(u => `
            <div class="bg-gray-800 p-6 rounded-2xl border border-gray-700 shadow-xl">
                <h3 class="text-xl font-bold text-blue-400 border-b border-gray-700 pb-2 mb-4">${u.name}</h3>
                <p class="text-[10px] text-gray-500 mb-2 uppercase font-bold">Bank: ${formatMoney(u.budget)}</p>
                <div class="space-y-2">
                    ${Object.values(u.team || {}).map(p => `
                        <div class="flex justify-between text-sm bg-gray-900/50 p-2 rounded">
                            <span>${p.name}</span>
                            <span class="text-green-400 font-mono">${formatMoney(p.price)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    });

    document.getElementById('exportPdfBtn').onclick = exportToPDF;
}

// --- CORE UTILITIES ---

async function performFullSystemReset() {
    await update(ref(db, 'gameState'), { resetSignal: true, phase: 'lobby' });
    await remove(ref(db, 'users'));
    await remove(ref(db, 'auctionData'));
    await set(ref(db, 'auctionData/lastEvent'), {
        id: Date.now(),
        type: 'info',
        message: '❌ Game Reset by Admin',
        subtext: 'The auction has been cancelled.'
    });
    // Signal stays true for a moment, then false to allow new joins
    setTimeout(() => update(ref(db, 'gameState'), { resetSignal: false }), 2000);
}

function shufflePlayers() {
    const list = [...PLAYERS_DATA];
    const goats = [], normal = [];
    list.forEach(p => {
        if (GOAT_LIST.some(g => p.name.includes(g))) goats.push({...p, isGoat: true});
        else normal.push(p);
    });
    return [...normal.sort(() => Math.random() - 0.5), ...goats.sort(() => Math.random() - 0.5)];
}

function renderPlayer(player, state, els) {
    els.name.innerText = player.name;
    els.pos.innerText = player.position;
    els.img.src = player.image_url || `https://ui-avatars.com/api/?name=${player.name.replace(' ', '+')}&size=256&background=1e293b&color=fff&bold=true`;
    els.progress.innerText = `${state.index + 1}/${globalPlayerList.length}`;
    els.bid.innerText = formatMoney(state.bid);
    els.highest.innerText = state.highestBidderName || "No Bids";
    els.crown.classList.toggle('hidden', !state.highestBidderName);
    
    const nextVal = state.bid + (state.highestBidder ? BID_INC : 0);
    els.nextBid.innerText = `+ ${formatMoney(state.highestBidder ? BID_INC : 0)}`;

    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
        const left = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
        els.timer.innerText = left;
        if (left === 0 && currentUser.isAdmin) finalizeSale(state, player);
    }, 1000);

    // Validation
    const myBudget = parseInt(els.budget.innerText.replace(/[₹Cr Lakh Crore]/g, '')); 
    // Simplified validation logic
    const reserve = (TEAM_SIZE - (parseInt(els.teamCount.innerText) || 0) - 1) * 10;
    let err = "";
    if (myBudget < nextVal) err = "Insufficient Budget";
    else if (parseInt(els.teamCount.innerText) >= TEAM_SIZE) err = "Squad Complete";
    
    els.btn.disabled = !!err;
    els.error.innerText = err;
    els.error.style.opacity = err ? "1" : "0";
}

async function handleBidClick(els) {
    if (els.btn.disabled) return;
    const snap = await get(ref(db, 'auctionData/current'));
    const state = snap.val();
    const nextAmt = state.bid + (state.highestBidder ? BID_INC : 0);
    
    await update(ref(db, 'auctionData/current'), {
        bid: nextAmt,
        highestBidder: currentUser.id,
        highestBidderName: currentUser.name,
        timerEndsAt: Date.now() + 10000 // 10s reset
    });

    await set(ref(db, 'auctionData/lastEvent'), {
        id: Date.now(),
        type: 'bid',
        message: `${currentUser.name} bid ${formatMoney(nextAmt)}`
    });
}

async function finalizeSale(state, player) {
    if (timerHandle) clearInterval(timerHandle);
    if (state.highestBidder) {
        const uRef = ref(db, `users/${state.highestBidder}`);
        const user = (await get(uRef)).val();
        await push(child(uRef, 'team'), { name: player.name, price: state.bid, position: player.position });
        await update(uRef, {
            budget: user.budget - state.bid,
            teamCount: user.teamCount + 1,
            [`positions/${player.position}`]: (user.positions[player.position] || 0) + 1
        });
        await set(ref(db, 'auctionData/lastEvent'), { id: Date.now(), type: 'sold', message: `🔨 SOLD! ${player.name} to ${state.highestBidderName}` });
    }
    // Auto move to next
    setTimeout(() => {
        update(ref(db, 'auctionData/current'), {
            index: state.index + 1,
            bid: START_BID,
            highestBidder: null,
            highestBidderName: null,
            timerEndsAt: Date.now() + 12000
        });
    }, 2500);
}

function skipPlayer() {
    update(ref(db, 'auctionData/current'), {
        index: (globalAuctionState?.index || 0) + 1,
        bid: START_BID,
        highestBidder: null,
        highestBidderName: null,
        timerEndsAt: Date.now() + 12000
    });
}

function togglePause() {
    get(ref(db, 'gameState/paused')).then(snap => {
        const val = snap.val();
        update(ref(db, 'gameState'), { paused: !val });
    });
}

function formatMoney(amt) {
    if (amt < 100) return `₹${amt}L`;
    return `₹${(amt / 100).toFixed(2)}Cr`;
}

function setupNotificationToast() {
    onValue(ref(db, 'auctionData/lastEvent'), (snap) => {
        const e = snap.val(); if (!e) return;
        const area = document.getElementById('notificationArea');
        if (!area) return;
        const div = document.createElement('div');
        div.className = `w-full max-w-sm p-3 rounded-xl shadow-2xl border flex items-center gap-3 animate-slide-down mb-2 ${e.type === 'bid' ? 'bg-blue-900 border-blue-500' : 'bg-green-800 border-green-500'}`;
        div.innerHTML = `<div>📢</div><div><p class="font-bold text-sm">${e.message}</p></div>`;
        area.prepend(div);
        setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 500); }, 3000);
    });
}

async function exportToPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const users = Object.values((await get(ref(db, 'users'))).val() || {});
    
    doc.setFontSize(18);
    doc.text("Mejores Amigos Auction Results", 10, 20);
    
    let y = 30;
    users.forEach(u => {
        const team = Object.values(u.team || {});
        doc.setFontSize(14);
        doc.text(`${u.name} (Bank: ${formatMoney(u.budget)})`, 10, y);
        y += 5;
        doc.autoTable({
            startY: y,
            head: [['Player', 'Pos', 'Price']],
            body: team.map(p => [p.name, p.position, formatMoney(p.price)]),
            theme: 'grid'
        });
        y = doc.lastAutoTable.finalY + 15;
        if (y > 250) { doc.addPage(); y = 20; }
    });
    doc.save("MejoresAmigos_Results.pdf");
}

// Start
router();
