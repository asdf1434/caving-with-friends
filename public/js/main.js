/* ============================================================
   MAIN

   Application state and the rules that differ between the two
   modes. Talks to the engine for rules, to net.js for the
   room, and to ui.js for everything on screen.

   Scoring lives on the server now, because rank depends on who
   solved a puzzle first and only one place can decide that.
   This file works out whether a word is valid and what it
   answers, then asks the server to record the solve.
   ============================================================ */

"use strict";

import { Connection } from "./net.js";
import { BASE_PATH } from "./config.js";
import * as ui from "./ui.js";

import {
    VARIANTS,
    DEFAULT_PUZZLE_COUNT,
    SCORING,
    prepareWordLists,
    generatePuzzles,
    classifyWord,
    scoreBreakdown
} from "./engine.js";


const MODE_DESCRIPTIONS = {
    race:
        "Everyone gets the same ten puzzles and solves their own board. " +
        "Being first to a puzzle is worth more than being fourth.",
    shared:
        "One board for the room. The first person to solve a puzzle takes " +
        "it, and nobody else can score it."
};


/* ============================================================
   STATE
   ============================================================ */

const state = {

    me: null,
    room: null,

    variant: "blackjack",
    mode: "race",
    durationSeconds: VARIANTS.blackjack.durationSeconds,

    /* Room setting: how many puzzles a board has. */
    puzzleCount: DEFAULT_PUZZLE_COUNT,

    /* Room setting: do harder puzzles pay more than easy ones? */
    difficultyScoring: true,

    /* Room setting: does a puzzle pay less the later it is solved? */
    timeDecay: true,

    /* The server's copy of the scoring constants. */
    scoring: SCORING,

    seed: null,
    startsAt: 0,
    endsAt: 0,

    puzzles: [],

    /* The board as I am allowed to see it, rebuilt from the room. */
    board: [],

    score: 0,
    currentWord: "",

    /* True between the countdown ending and time running out. */
    active: false,

    /* True once we are part of the current round. */
    inRound: false
};


let wordLists = null;
let tickTimer = null;
let lastRenderedSecond = -1;

const connection = new Connection();


/* ============================================================
   BOARD

   Derived from the room rather than kept separately, so what
   is on screen is always what the server last said.
   ============================================================ */

function emptyEntry() {

    return {
        word: null,
        points: null,
        rank: null,
        elapsed: null,
        answerCount: null,
        holderId: null,
        holderName: null
    };
}


function solvesAt(index) {

    return state.room && state.room.solves
        ? state.room.solves[index]
        : [];
}


function mySolveAt(index) {

    return solvesAt(index).find(
        solve => solve.playerId === state.me.id
    ) || null;
}


function boardFor(playerId) {

    return state.puzzles.map((puzzle, index) => {

        const entry = emptyEntry();
        const list = solvesAt(index);

        const theirs = list.find(solve => solve.playerId === playerId);

        /*
            Shared mode has one holder per puzzle, so an unsolved
            entry for me still shows whoever took it.
        */
        const shown =
            theirs || (state.mode === "shared" ? list[0] : null);

        if (shown) {

            entry.word = shown.word;
            entry.points = shown.points;
            entry.rank = shown.rank;
            entry.elapsed = shown.elapsed;
            entry.answerCount = shown.answerCount;
            entry.holderId = shown.playerId;
            entry.holderName = shown.name;

            return entry;
        }

        return entry;
    });
}


function renderBoard() {

    if (state.puzzles.length === 0) {
        return;
    }

    state.board = boardFor(state.me.id);

    ui.renderPuzzles(state);
}


function secondsRemaining() {

    return Math.max(
        0,
        Math.ceil((state.endsAt - connection.now()) / 1000)
    );
}


/* ============================================================
   WORD LISTS
   ============================================================ */

async function loadWordLists() {

    const [common, valid] = await Promise.all([
        fetch(BASE_PATH + "data/CEL22.txt").then(response => response.text()),
        fetch(BASE_PATH + "data/words_alpha.txt").then(response => response.text())
    ]);

    wordLists = prepareWordLists(common, valid);

    ui.element("loading-note").textContent = "";
    ui.element("create-button").disabled = false;
    ui.element("join-button").disabled = false;
}


/* ============================================================
   SUBMITTING A WORD

   Which word you used no longer affects the score, so this
   only has to establish that the word is real and which
   puzzles it answers.
   ============================================================ */

function openIndexes(indexes) {

    return indexes.filter(index => {

        /* Never score the same puzzle twice. */
        if (mySolveAt(index)) {
            return false;
        }

        /* Shared mode: the first solve locked it. */
        if (state.mode === "shared" && solvesAt(index).length > 0) {
            return false;
        }

        return true;
    });
}


function submitWord() {

    if (!state.active || state.currentWord.length === 0) {
        return;
    }

    const word = state.currentWord;

    state.currentWord = "";
    ui.renderCurrentWord("");

    const result = classifyWord(
        state.variant,
        state.puzzles,
        wordLists,
        word
    );

    if (result.kind === "not-a-word") {
        ui.showMessage("Not a word");
        return;
    }

    if (result.kind === "no-match") {
        ui.showMessage("Not an answer");
        return;
    }

    const targets = openIndexes(result.indexes);

    if (targets.length === 0) {
        ui.showMessage(
            state.mode === "shared" ? "Already taken" : "Already solved"
        );
        return;
    }

    connection.send("solve", { indexes: targets, word: word });
}


/* ============================================================
   ROUND LIFECYCLE
   ============================================================ */

function beginRound(message) {

    state.variant = message.variant;
    state.mode = message.mode;

    state.durationSeconds =
        message.durationSeconds || VARIANTS[message.variant].durationSeconds;

    state.puzzleCount = message.puzzleCount || DEFAULT_PUZZLE_COUNT;
    ui.applyPuzzleCount(state.puzzleCount);

    if (message.scoring) {
        state.scoring = message.scoring;
    }

    state.difficultyScoring = message.difficultyScoring !== false;
    state.timeDecay = message.timeDecay !== false;

    state.seed = message.seed;
    state.startsAt = message.startsAt;
    state.endsAt = message.endsAt;

    state.inRound = true;
    state.currentWord = "";
    state.score = 0;
    state.board = [];

    lastRenderedSecond = -1;

    ui.setView("game");
    ui.renderCurrentWord("");
    ui.renderTimer(secondsRemaining());
    ui.setCountdown(
        Math.max(1, Math.ceil((state.startsAt - connection.now()) / 1000))
    );

    /*
        Generating a board takes a few hundred milliseconds and
        blocks the page, so let the countdown paint first.
    */

    setTimeout(() => {

        state.puzzles = generatePuzzles(
            state.variant,
            state.seed,
            wordLists,
            state.puzzleCount
        );

        /*
            The server has no word lists, so it learns each
            puzzle's answer count from whichever client reports
            first. Generation is deterministic, so the numbers
            are the same from anyone.
        */

        connection.send("board", {
            counts: state.puzzles.map(puzzle => puzzle.answers.length)
        });

        ui.renderHeader(state);
        renderBoard();
        ui.renderScoreboard(state);
        ui.renderRefresh(state);

        startTicking();

    }, 30);
}


function startTicking() {

    clearInterval(tickTimer);

    tickTimer = setInterval(() => {

        const now = connection.now();

        if (now < state.startsAt) {
            ui.setCountdown(Math.ceil((state.startsAt - now) / 1000));
            return;
        }

        ui.setCountdown(null);

        state.active = now < state.endsAt;

        const remaining = secondsRemaining();

        ui.renderTimer(remaining);

        /*
            The board only changes when a solve arrives, so it
            is redrawn at most once a second rather than on
            every tick.
        */

        if (remaining !== lastRenderedSecond) {
            lastRenderedSecond = remaining;
            renderBoard();
        }

        if (!state.active) {
            clearInterval(tickTimer);
            tickTimer = null;
        }

    }, 100);
}


function finishRound() {

    state.active = false;
    state.inRound = false;

    ui.renderRefresh(state);

    clearInterval(tickTimer);
    tickTimer = null;

    ui.setCountdown(null);
}


/* ============================================================
   RESULTS
   ============================================================ */

function showResults() {

    ui.setView("results");

    /* One board for the room; my own solves colour the cards. */

    ui.renderResults(state, {
        board: boardFor(state.me.id)
    });
}


/* ============================================================
   ROOM UPDATES
   ============================================================ */

function applyRoom(room) {

    state.room = room;

    /* The room moved, so a pending settings change went through. */
    clearTimeout(settingsTimer);
    settingsTimer = null;

    if (room.scoring) {
        state.scoring = room.scoring;
    }

    state.difficultyScoring = room.difficultyScoring !== false;
    state.timeDecay = room.timeDecay !== false;

    /*
        Set here as well as at the start of a round, so the
        scoreboard in the lobby matches the count the host has
        just picked.
    */
    state.puzzleCount = room.puzzleCount || DEFAULT_PUZZLE_COUNT;
    ui.applyPuzzleCount(state.puzzleCount);

    const me = room.players.find(player => player.id === state.me.id);

    if (me) {
        state.score = me.score;
    }

    if (room.phase === "over" && state.inRound) {
        finishRound();
    }

    if (state.inRound) {
        ui.renderHeader(state);
        renderBoard();
        ui.renderScoreboard(state);
        ui.renderRefresh(state);
        return;
    }

    if (room.phase === "over" && state.puzzles.length > 0) {
        showResults();
        return;
    }

    ui.setView("lobby");
    ui.renderLobby(state);
}


/* ============================================================
   SERVER MESSAGES
   ============================================================ */

connection.on("welcome", message => {

    state.me = message.you;

    connection.saveSeat({
        code: message.room.code,
        playerId: message.you.id,
        token: message.you.token
    });

    history.replaceState(null, "", `/${message.room.code}`);

    applyRoom(message.room);
});


connection.on("room", message => {

    if (!state.me) {
        return;
    }

    applyRoom(message.room);
});


connection.on("started", message => {

    if (!state.me) {
        return;
    }

    beginRound(message);
});


connection.on("solved", message => {

    if (!state.room || !state.room.solves) {
        return;
    }

    let mine = 0;
    let gained = 0;

    for (const solve of message.solves) {

        const list = state.room.solves[solve.index];

        const already = list.some(
            existing => existing.playerId === solve.playerId
        );

        if (!already) {
            list.push(solve);
        }

        if (solve.playerId === state.me.id) {
            mine++;
            gained += solve.points;
        }
    }

    renderBoard();

    if (mine > 0) {

        const first = message.solves.find(
            solve => solve.playerId === state.me.id
        );

        const points = scoreBreakdown(
            first.answerCount,
            first.rank,
            first.elapsed,
            {
                difficultyScoring: state.difficultyScoring,
                timeDecay: state.timeDecay
            }
        );

        /* Say where the number came from, not just the number. */

        const parts = [`${points.base} base`];

        if (points.rankPenalty > 0) {
            parts.push(`−${points.rankPenalty} ${ui.ordinal(points.rank)}`);
        }

        if (points.timeDecay) {
            parts.push(`−${points.timePenalty} time`);
        }

        if (Math.abs(points.rarity - 1) > 0.005) {
            parts.push(`×${points.rarity.toFixed(2)} difficulty`);
        }

        ui.showMessage(
            `${first.word} +${gained} — ${parts.join("  ")}`
        );

    } else if (state.mode === "shared") {

        const taken = message.solves[0];

        ui.showMessage(
            `${taken.name} took puzzle ${taken.index + 1}`
        );
    }
});


connection.on("solveRejected", () => {
    ui.showMessage("Already taken");
});


connection.on("scores", message => {

    if (!state.room) {
        return;
    }

    for (const update of message.players) {

        const player = state.room.players.find(
            entry => entry.id === update.id
        );

        if (!player) {
            continue;
        }

        player.score = update.score;
        player.marks = update.marks;

        if (update.id === state.me.id) {
            state.score = update.score;
            ui.renderHeader(state);
        }
    }

    ui.renderScoreboard(state);
});


connection.on("ended", () => {

    if (state.inRound) {
        finishRound();
    }
});


connection.on("error", message => {

    ui.element("home-error").textContent = message.message;
    ui.element("lobby-error").textContent = message.message;

    /*
        A stale seat from a closed room would otherwise keep
        failing on every reconnect.
    */

    if (/closed|rejoin/.test(message.message)) {
        connection.forgetSeat();
    }
});


connection.on("open", () => ui.setConnectionWarning(false));
connection.on("close", () => ui.setConnectionWarning(true));


/* ============================================================
   INPUT
   ============================================================ */

function typeKey(key) {

    if (!state.active) {
        return;
    }

    if (key === "ENTER") {
        submitWord();
        return;
    }

    if (key === "BACKSPACE") {
        state.currentWord = state.currentWord.slice(0, -1);
        ui.renderCurrentWord(state.currentWord);
        return;
    }

    state.currentWord += key;
    ui.renderCurrentWord(state.currentWord);
}


document.addEventListener("keydown", event => {

    /* Let the lobby and home forms behave normally. */
    if (event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement) {
        return;
    }

    if (!state.active) {
        return;
    }

    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        typeKey("ENTER");
        return;
    }

    if (event.key === "Backspace") {
        event.preventDefault();
        typeKey("BACKSPACE");
        return;
    }

    if (/^[a-zA-Z]$/.test(event.key)) {
        event.preventDefault();
        typeKey(event.key.toUpperCase());
    }
});


for (const key of document.querySelectorAll(".mobile-key")) {

    key.addEventListener("click", event => {
        event.preventDefault();
        typeKey(key.dataset.key);
    });
}


/* ============================================================
   HOME
   ============================================================ */

function playerName() {

    const name = ui.element("name-input").value.trim();

    try {
        localStorage.setItem("caving-name", name);
    } catch {
        /* Ignored. */
    }

    return name || "Player";
}


function fillVariantSelect() {

    const select = ui.element("variant-select");

    ui.fillVariants(select);

    function describe() {

        const variant = VARIANTS[select.value];

        ui.element("variant-description").textContent = variant.example;

        /* Each rule's own timer becomes the suggested length. */
        ui.element("duration-select").value =
            String(variant.durationSeconds);
    }

    select.addEventListener("change", describe);
    describe();
}


function fillModeSelect() {

    const select = ui.element("mode-select");

    function describe() {
        ui.element("mode-description").textContent =
            MODE_DESCRIPTIONS[select.value];
    }

    select.addEventListener("change", describe);
    describe();
}


ui.element("create-button").addEventListener("click", () => {

    ui.element("home-error").textContent = "";

    connection.send("create", {
        name: playerName(),
        variant: ui.element("variant-select").value,
        mode: ui.element("mode-select").value,
        durationSeconds: Number(ui.element("duration-select").value),
        puzzleCount: Number(ui.element("words-select").value),
        difficultyScoring: ui.element("difficulty-toggle").checked,
        timeDecay: ui.element("timedecay-toggle").checked
    });
});


ui.element("join-button").addEventListener("click", () => {

    const code = ui.element("code-input").value.trim().toUpperCase();

    if (code.length !== 4) {
        ui.element("home-error").textContent = "Room codes are four characters";
        return;
    }

    ui.element("home-error").textContent = "";

    connection.send("join", { name: playerName(), code: code });
});


ui.element("code-input").addEventListener("keydown", event => {
    if (event.key === "Enter") {
        ui.element("join-button").click();
    }
});


/* ============================================================
   LOBBY AND RESULTS CONTROLS
   ============================================================ */

ui.element("ready-button").addEventListener("click", () => {

    const me = state.room.players.find(
        player => player.id === state.me.id
    );

    connection.send("ready", { ready: !(me && me.ready) });
});


/*
    The same four settings appear in the lobby and on the
    results page, so a room can change the rules after a game
    instead of starting a new room. The server decides what a
    non-host is allowed to send.
*/

let settingsTimer = null;


/*
    A control shows the new value the moment it is moved, but
    the room is what everyone else plays. If no room update
    comes back the change did not happen, so the control is put
    back and the reason is said out loud rather than leaving the
    host looking at a setting nobody else has.
*/

function sendSetting(prefix, change) {

    connection.send("settings", change);

    clearTimeout(settingsTimer);

    settingsTimer = setTimeout(() => {
        settingsTimer = null;
        ui.renderSettings(state, prefix);
        ui.noteSettingRefused(prefix);
    }, 2000);
}


for (const prefix of ["lobby", "results"]) {

    ui.element(`${prefix}-variant`).addEventListener("change", event => {
        sendSetting(prefix, { variant: event.target.value });
    });

    ui.element(`${prefix}-mode`).addEventListener("change", event => {
        sendSetting(prefix, { mode: event.target.value });
    });

    ui.element(`${prefix}-duration`).addEventListener("change", event => {
        sendSetting(prefix, {
            durationSeconds: Number(event.target.value)
        });
    });

    ui.element(`${prefix}-words`).addEventListener("change", event => {
        sendSetting(prefix, {
            puzzleCount: Number(event.target.value)
        });
    });

    ui.element(`${prefix}-difficulty`).addEventListener("change", event => {
        sendSetting(prefix, {
            difficultyScoring: event.target.checked
        });
    });

    ui.element(`${prefix}-timedecay`).addEventListener("change", event => {
        sendSetting(prefix, {
            timeDecay: event.target.checked
        });
    });
}


ui.element("start-button").addEventListener("click", () => {
    ui.element("lobby-error").textContent = "";
    connection.send("start");
});


ui.element("again-button").addEventListener("click", () => {
    connection.send("start");
});


ui.element("copy-link").addEventListener("click", async () => {

    try {
        await navigator.clipboard.writeText(ui.element("share-link").value);
        ui.element("copy-link").textContent = "Copied";
        setTimeout(() => {
            ui.element("copy-link").textContent = "Copy";
        }, 1500);
    } catch {
        ui.element("share-link").select();
    }
});


ui.element("share-button").addEventListener("click", async () => {

    try {
        await navigator.clipboard.writeText(ui.buildShareText(state));
        ui.element("share-button").textContent = "Copied";
        setTimeout(() => {
            ui.element("share-button").textContent = "Share";
        }, 1500);
    } catch {
        /* Clipboard unavailable. */
    }
});


/*
    Leaving. The game view has its own button because a round
    is otherwise a one-way door: the seat is remembered, so
    even a reload puts you back in the room.
*/

for (const id of ["leave-button", "results-leave", "game-leave"]) {

    ui.element(id).addEventListener("click", event => {

        event.target.blur();

        /* Walking out mid-round costs the round, so say so. */
        if (
            state.active &&
            !window.confirm("Leave the room? You lose this round's score.")
        ) {
            return;
        }

        connection.forgetSeat();
        location.href = BASE_PATH;
    });
}


ui.element("refresh-button").addEventListener("click", () => {

    const votes = (state.room && state.room.refreshVotes) || [];

    connection.send("refresh", { want: !votes.includes(state.me.id) });
});


/* ============================================================
   START
   ============================================================ */

function restoreName() {

    try {
        const saved = localStorage.getItem("caving-name");

        if (saved) {
            ui.element("name-input").value = saved;
        }
    } catch {
        /* Ignored. */
    }
}


function readCodeFromAddress() {

    /*
        Room links are "?room=ABCD". GitHub Pages serves static
        files only, so it cannot route "/ABCD" to the app the
        way the Node server used to.
    */

    const code = new URLSearchParams(location.search).get("room");

    if (code && /^[A-Za-z0-9]{4}$/.test(code)) {
        ui.element("code-input").value = code.toUpperCase();
    }
}


ui.element("create-button").disabled = true;
ui.element("join-button").disabled = true;

ui.fillDurations(ui.element("duration-select"));
ui.fillPuzzleCounts(ui.element("words-select"));
ui.element("words-select").value = String(DEFAULT_PUZZLE_COUNT);
ui.applyPuzzleCount(DEFAULT_PUZZLE_COUNT);

fillVariantSelect();
fillModeSelect();
restoreName();
readCodeFromAddress();

ui.setView("home");

connection.connect();

loadWordLists().catch(error => {
    console.error(error);
    ui.element("loading-note").textContent =
        "Could not load the word lists. Reload to try again.";
});
