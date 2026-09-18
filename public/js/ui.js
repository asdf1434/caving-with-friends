/* ============================================================
   USER INTERFACE

   Everything that touches the DOM. Given the application state
   it draws the lobby, the board, the scoreboard and the
   results. It never decides anything about the game.
   ============================================================ */

"use strict";

import {
    VARIANTS,
    PUZZLE_COUNTS,
    DEFAULT_PUZZLE_COUNT,
    scoreBreakdown
} from "./engine.js";

import { roomPath } from "./config.js";


/* 1 -> "1st", 2 -> "2nd", and so on. */

export function ordinal(number) {

    const tens = number % 100;

    if (tens >= 11 && tens <= 13) {
        return `${number}th`;
    }

    switch (number % 10) {
        case 1: return `${number}st`;
        case 2: return `${number}nd`;
        case 3: return `${number}rd`;
        default: return `${number}th`;
    }
}


const VIEWS = ["home", "lobby", "game", "results"];


/* Round lengths on offer. The server accepts exactly these. */
export const DURATION_CHOICES = [30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180];


export function fillDurations(select) {

    select.innerHTML = "";

    for (const seconds of DURATION_CHOICES) {

        const option = document.createElement("option");

        option.value = String(seconds);

        option.textContent =
            `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

        select.appendChild(option);
    }
}


export function fillPuzzleCounts(select) {

    select.innerHTML = "";

    for (const count of PUZZLE_COUNTS) {

        const option = document.createElement("option");

        option.value = String(count);
        option.textContent = String(count);

        select.appendChild(option);
    }
}


/*
    The board's shape follows the word count, so the two grids
    that have one cell per puzzle read it from a CSS variable
    rather than being rebuilt: the puzzle cards, which keep five
    columns and take as many rows as they need, and the
    scoreboard, which is one column per puzzle.
*/

export function applyPuzzleCount(count) {

    const root = document.documentElement;

    root.style.setProperty("--puzzle-count", String(count));
    root.style.setProperty("--puzzle-rows", String(Math.ceil(count / 5)));
}


export function fillVariants(select) {

    select.innerHTML = "";

    for (const id of Object.keys(VARIANTS)) {

        const option = document.createElement("option");

        option.value = id;
        option.textContent = `${VARIANTS[id].name} — ${VARIANTS[id].rule}`;

        select.appendChild(option);
    }
}


/*
    The room's settings for the next round.

    The lobby and the results page carry the same controls, so
    a room can change the rules after a game without starting a
    new room. Only the host can move them, and not while a
    round is running; everyone else sees them filled in and
    disabled.

    `prefix` is "lobby" or "results", matching the element ids.
*/

export function renderSettings(state, prefix) {

    const room = state.room;

    const isHost = room.hostId === state.me.id;

    const running =
        room.phase === "countdown" || room.phase === "playing";

    const locked = !isHost || running;

    const variant = element(`${prefix}-variant`);

    if (variant.options.length === 0) {
        fillVariants(variant);
    }

    variant.value = room.variant;
    variant.disabled = locked;

    const mode = element(`${prefix}-mode`);

    mode.value = room.mode;
    mode.disabled = locked;

    const duration = element(`${prefix}-duration`);

    if (duration.options.length === 0) {
        fillDurations(duration);
    }

    duration.value = String(room.durationSeconds);
    duration.disabled = locked;

    const words = element(`${prefix}-words`);

    if (words.options.length === 0) {
        fillPuzzleCounts(words);
    }

    words.value = String(room.puzzleCount || DEFAULT_PUZZLE_COUNT);
    words.disabled = locked;

    const difficulty = element(`${prefix}-difficulty`);

    difficulty.checked = room.difficultyScoring !== false;
    difficulty.disabled = locked;

    const timeDecay = element(`${prefix}-timedecay`);

    timeDecay.checked = room.timeDecay !== false;
    timeDecay.disabled = locked;

    element(`${prefix}-settings-note`).textContent =
        !isHost
            ? "The host sets the rules."
            : running
                ? "The rules are fixed while a round is running."
                : VARIANTS[room.variant].example;
}


/*
    Said when a settings change produced no room update, which
    means the server did not take it.
*/

export function noteSettingRefused(prefix) {

    element(`${prefix}-settings-note`).textContent =
        "That change did not take. The server may need restarting.";
}


export function element(id) {
    return document.getElementById(id);
}


export function setView(name) {

    for (const view of VIEWS) {
        element(`${view}-view`).classList.toggle("active", view === name);
    }

    element("mobile-keyboard").classList.toggle("visible", name === "game");
}


/* ============================================================
   TRANSIENT MESSAGE
   ============================================================ */

let messageTimeout = null;


export function showMessage(text) {

    const message = element("message");

    message.textContent = text;

    clearTimeout(messageTimeout);

    messageTimeout = setTimeout(() => {
        message.textContent = "";
    }, 1400);
}


/* ============================================================
   HEADER
   ============================================================ */

export function renderHeader(state) {

    const variant = VARIANTS[state.variant];

    element("game-title").textContent =
        `${variant.name} · ${state.mode === "race" ? "Race" : "Shared"} · ${state.room.code}`;

    element("score").textContent = state.score;
}


export function renderTimer(secondsRemaining) {

    const minutes = Math.floor(secondsRemaining / 60);
    const seconds = secondsRemaining % 60;

    const timer = element("timer");

    timer.textContent =
        `${minutes}:${String(seconds).padStart(2, "0")}`;

    timer.classList.toggle("low", secondsRemaining <= 10);
}


export function renderCurrentWord(word) {
    element("current-word").textContent = word;
}


export function setCountdown(number) {

    const overlay = element("countdown-overlay");

    if (number === null) {
        overlay.classList.remove("visible");
        return;
    }

    overlay.classList.add("visible");
    element("countdown-number").textContent = number;
}


export function setConnectionWarning(visible) {
    element("connection-warning").classList.toggle("visible", visible);
}


/* ============================================================
   LOBBY
   ============================================================ */

export function renderLobby(state) {

    const room = state.room;
    const variant = VARIANTS[room.variant];

    element("lobby-code").textContent = room.code;

    element("lobby-setup").textContent =
        `${variant.name} — ${variant.rule}. ` +
        `${room.mode === "race" ? "Race" : "Shared board"}.`;

    element("share-link").value =
        location.origin + roomPath(room.code);

    const list = element("lobby-players");

    list.innerHTML = "";

    for (const player of room.players) {

        const item = document.createElement("li");

        const name = document.createElement("span");

        name.textContent =
            player.name + (player.id === state.me.id ? " (you)" : "");

        const tags = document.createElement("span");

        tags.className = "player-tags";

        const parts = [];

        if (player.id === room.hostId) {
            parts.push("host");
        }

        if (!player.connected) {
            parts.push('<span class="away">away</span>');
        } else if (player.ready) {
            parts.push('<span class="ready">ready</span>');
        }

        tags.innerHTML = parts.join(" · ");

        item.appendChild(name);
        item.appendChild(tags);

        list.appendChild(item);
    }

    const isHost = room.hostId === state.me.id;
    const me = room.players.find(player => player.id === state.me.id);

    /*
        A round already running is the late-joiner case: the
        lobby stays put and the next round picks them up.
    */

    const running =
        room.phase === "countdown" || room.phase === "playing";

    renderSettings(state, "lobby");

    const readyButton = element("ready-button");

    readyButton.textContent = me && me.ready ? "Not ready" : "I'm ready";

    const startButton = element("start-button");

    startButton.style.display = isHost ? "block" : "none";

    startButton.disabled = running;

    startButton.textContent =
        room.phase === "over" ? "Play again" : "Start game";

    const waiting = room.players.filter(
        player => player.connected && !player.ready
    ).length;

    element("lobby-status").textContent =
        running
            ? "A round is in progress. You will join the next one."
            : room.players.length < 2
                ? "Send someone the link. The round starts on its own once everyone is ready."
                : waiting > 0
                    ? `Waiting on ${waiting} ${waiting === 1 ? "player" : "players"} to be ready.`
                    : "Starting...";
}


/* ============================================================
   PUZZLE CARDS

   One renderer for both modes and for the results view. The
   caller decides what goes in each board entry.
   ============================================================ */

function scoreLine(label, value) {

    const line = document.createElement("div");

    line.className = "score-line";

    const labelElement = document.createElement("span");

    labelElement.className = "score-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");

    valueElement.textContent = value;

    line.appendChild(labelElement);
    line.appendChild(valueElement);

    return line;
}


function renderBreakdown(points) {

    const breakdown = document.createElement("div");

    breakdown.className = "score-breakdown";

    breakdown.appendChild(scoreLine("base", points.base));

    /* First to a puzzle pays no rank penalty, so skip the zero. */
    if (points.rankPenalty > 0) {
        breakdown.appendChild(
            scoreLine(`${ordinal(points.rank)} to solve`, `−${points.rankPenalty}`)
        );
    }

    /* With time decay off there is nothing to say about the clock. */
    if (points.timeDecay) {
        breakdown.appendChild(
            scoreLine(
                `after ${Math.round(points.elapsed)}s`,
                `−${points.timePenalty}`
            )
        );
    }

    /* A puzzle of average difficulty neither gains nor loses. */
    if (Math.abs(points.rarity - 1) > 0.005) {
        breakdown.appendChild(
            scoreLine("difficulty", `×${points.rarity.toFixed(2)}`)
        );
    }

    if (points.floored) {
        breakdown.appendChild(scoreLine("minimum", points.total));
    }

    return breakdown;
}


/*
    Race mode: who has this puzzle so far, in the order they
    got it. Names only — the words stay hidden until the round
    is over — so the board itself answers "who has solved what"
    without counting dots in the scoreboard.
*/

function makeSolverChips(state, solves) {

    const line = document.createElement("div");

    line.className = "solver-chips";

    const ordered = [...solves].sort((a, b) => a.rank - b.rank);

    ordered.forEach((solve, position) => {

        if (position > 0) {

            const dot = document.createElement("span");

            dot.className = "solver-chip-gap";
            dot.textContent = "·";

            line.appendChild(dot);
        }

        const chip = document.createElement("span");

        chip.className = "solver-chip";

        if (solve.playerId === state.me.id) {
            chip.classList.add("mine");
        }

        chip.textContent =
            solve.playerId === state.me.id ? "You" : solve.name;

        line.appendChild(chip);
    });

    return line;
}


/*
    Who solved this puzzle and with what, best rank first.
    Used by the results view, where every player's answers sit
    on the same board.
*/

function makeSolverList(state, solves) {

    const container = document.createElement("div");

    container.className = "solvers";

    if (solves.length === 0) {

        const empty = document.createElement("div");

        empty.className = "solvers-empty";
        empty.textContent = "Nobody solved this";

        container.appendChild(empty);

        return container;
    }

    const ordered = [...solves].sort((a, b) => a.rank - b.rank);

    for (const solve of ordered) {

        const row = document.createElement("div");

        row.className = "solver";

        if (solve.playerId === state.me.id) {
            row.classList.add("mine");
        }

        const name = document.createElement("span");

        name.className = "solver-name";
        name.textContent = solve.name;

        const word = document.createElement("span");

        word.className = "solver-word";
        word.textContent = solve.word === null ? "?????" : solve.word;

        const points = document.createElement("span");

        points.className = "solver-points";
        points.textContent = solve.points === null ? "" : `+${solve.points}`;

        row.appendChild(name);
        row.appendChild(word);
        row.appendChild(points);

        container.appendChild(row);
    }

    return container;
}


function makePuzzleCard(state, index, options = {}) {

    const puzzle = state.puzzles[index];
    const entry = (options.board || state.board)[index];

    const card = document.createElement("div");

    card.className = "puzzle";

    if (entry.word !== null && entry.holderId) {

        if (state.mode === "shared") {
            card.classList.add(
                entry.holderId === state.me.id ? "mine" : "theirs"
            );
        } else {
            card.classList.add("solved");
        }
    }


    const number = document.createElement("div");

    number.className = "puzzle-number";
    number.textContent = `PUZZLE ${index + 1}`;

    card.appendChild(number);


    const rack = document.createElement("div");

    rack.className = "puzzle-word";
    rack.textContent = puzzle.rack;

    card.appendChild(rack);


    const status = document.createElement("div");

    status.className = "puzzle-status";

    /* How many answers the common word list has for this rack. */

    status.textContent = `${puzzle.answers.length} words`;

    card.appendChild(status);


    /*
        Race mode: everyone can solve every puzzle, so the card
        carries the list of who already has.
    */

    const solvers =
        (state.room && state.room.solves && state.room.solves[index]) || [];

    if (!options.solves && state.mode === "race" && solvers.length > 0) {
        card.appendChild(makeSolverChips(state, solvers));
    }


    /* Shared mode: say who holds it. */

    if (
        !options.solves &&
        entry.word &&
        entry.holderName &&
        state.mode === "shared"
    ) {

        const holder = document.createElement("div");

        holder.className = "puzzle-holder";

        /* Your own name on your own card reads oddly. */
        holder.textContent =
            entry.holderId === state.me.id ? "You got it" : entry.holderName;

        card.appendChild(holder);
    }


    /*
        The results view shows every player's answer on one
        card, so there is no board to choose between and no
        scoring breakdown to read.
    */

    if (options.solves) {
        card.appendChild(makeSolverList(state, options.solves));
    } else if (entry.word) {

        /*
            Shared mode: a puzzle can be held by somebody else,
            and then the award on the card is theirs. Showing it
            reads as points you scored, so the card says who has
            it and what they played, and nothing more.
        */

        const isMine = entry.holderId === state.me.id;

        const solution = document.createElement("div");

        solution.className = "solution";

        const word = document.createElement("div");

        word.className = "solution-word";

        /* Race mode hides other people's words until the end. */
        word.textContent = entry.word === null ? "?????" : entry.word;

        solution.appendChild(word);

        if (isMine) {

            const total = document.createElement("div");

            total.className = "solution-total";

            total.textContent =
                entry.points === null ? "" : `+${entry.points}`;

            solution.appendChild(total);
        }

        if (isMine && entry.rank) {

            const rank = document.createElement("div");

            rank.className = "solution-rank";
            rank.textContent = `${ordinal(entry.rank)} to solve`;

            solution.appendChild(rank);
        }

        /*
            Where the number came from. Without this the score
            is unexplainable while you are playing.
        */

        if (isMine && entry.answerCount) {

            solution.appendChild(
                renderBreakdown(
                    scoreBreakdown(
                        entry.answerCount,
                        entry.rank,
                        entry.elapsed,
                        {
                            difficultyScoring: state.difficultyScoring,
                            timeDecay: state.timeDecay
                        }
                    )
                )
            );
        }

        card.appendChild(solution);
    }


    /* Results view only: reveal the answer list. */

    if (options.withAnswers) {
        card.appendChild(makeAnswerReveal(state, puzzle, index));
    }

    return card;
}


/*
    Which answer lists are open, and for which round.

    The results view is rebuilt from scratch on every room
    update — someone leaving, the host changing a setting — so
    without this a revealed list would close under the reader.
*/

const revealed = { seed: null, indexes: new Set() };


function makeAnswerReveal(state, puzzle, index) {

    if (revealed.seed !== state.seed) {
        revealed.seed = state.seed;
        revealed.indexes = new Set();
    }

    const container = document.createElement("div");

    container.className = "answers-container";

    const button = document.createElement("button");

    button.className = "show-answers";
    button.textContent = "Show answers";

    const list = document.createElement("div");

    list.className = "answers";
    list.style.display = "none";

    function reveal() {

        /*
            Every answer is worth the same now, so they are
            simply listed shortest first.
        */

        const words = [...puzzle.answers].sort((a, b) =>
            a.length - b.length || a.localeCompare(b)
        );

        list.textContent = words.join(", ");

        list.style.display = "block";
        button.style.display = "none";
    }

    button.addEventListener("click", () => {
        revealed.indexes.add(index);
        reveal();
    });

    if (revealed.indexes.has(index)) {
        reveal();
    }

    container.appendChild(button);
    container.appendChild(list);

    return container;
}


export function renderPuzzles(state) {

    const container = element("puzzles");

    container.innerHTML = "";

    state.puzzles.forEach((puzzle, index) => {
        container.appendChild(makePuzzleCard(state, index));
    });
}


/* ============================================================
   SCOREBOARD

   Score plus ten dots. The dots say which puzzles a player has
   without revealing any words.
   ============================================================ */

/*
    The board can be rerolled mid-round, but only if everyone
    still connected asks for it.
*/

export function renderRefresh(state) {

    const button = element("refresh-button");

    if (!state.room || !state.inRound) {
        button.style.display = "none";
        return;
    }

    const votes = state.room.refreshVotes || [];

    const present = state.room.players.filter(
        player => player.connected
    ).length;

    button.style.display = "block";

    button.classList.toggle("voted", votes.includes(state.me.id));

    button.textContent =
        votes.length > 0
            ? `New board (${votes.length}/${present})`
            : "New board";
}


export function renderScoreboard(state) {

    /*
        A column per puzzle, numbered, with every player's row
        on the same columns. Reading down column 3 says who has
        puzzle 3, which a loose row of dots could not.
    */

    const legend = element("scoreboard-legend");

    legend.innerHTML = "";

    const puzzleCount = state.room.puzzleCount || DEFAULT_PUZZLE_COUNT;

    for (let index = 0; index < puzzleCount; index++) {

        const number = document.createElement("div");

        number.className = "mark-number";
        number.textContent = String(index + 1);

        legend.appendChild(number);
    }

    const list = element("scoreboard-list");

    list.innerHTML = "";

    const players = [...state.room.players]
        .sort((a, b) => b.score - a.score);

    for (const player of players) {

        const item = document.createElement("li");

        if (player.id === state.me.id) {
            item.classList.add("you");
        }

        if (!player.connected) {
            item.classList.add("away");
        }

        const row = document.createElement("div");

        row.className = "scoreboard-row";

        const name = document.createElement("span");

        name.className = "scoreboard-name";
        name.textContent = player.name;

        const score = document.createElement("span");

        score.className = "scoreboard-score";
        score.textContent = player.score;

        row.appendChild(name);
        row.appendChild(score);

        const marks = document.createElement("div");

        marks.className = "marks";

        player.marks.forEach((mark, index) => {

            const dot = document.createElement("div");

            dot.className = `mark ${mark}`;

            /* Readable to a screen reader, and on hover. */
            dot.title =
                `Puzzle ${index + 1}: ` +
                (mark === "solved" ? "solved" : "not yet");

            marks.appendChild(dot);
        });

        item.appendChild(row);
        item.appendChild(marks);

        list.appendChild(item);
    }
}


/* ============================================================
   RESULTS
   ============================================================ */

export function renderResults(state, options = {}) {

    const standings = [...state.room.players]
        .sort((a, b) => b.score - a.score);

    const list = element("results-list");

    list.innerHTML = "";

    for (const player of standings) {

        const item = document.createElement("li");

        const name = document.createElement("span");

        name.textContent =
            player.name + (player.id === state.me.id ? " (you)" : "");

        const score = document.createElement("span");

        score.className = "results-score";
        score.textContent = player.score;

        item.appendChild(score);
        item.appendChild(name);

        list.appendChild(item);
    }

    /* The next round's rules, changeable here by the host. */

    renderSettings(state, "results");

    /*
        One board for the whole room: each card carries every
        player's answer, so there is nothing to switch between.
    */

    const board = element("results-board");

    board.innerHTML = "";

    const solves = (state.room && state.room.solves) || [];

    state.puzzles.forEach((puzzle, index) => {
        board.appendChild(
            makePuzzleCard(state, index, {
                withAnswers: true,
                board: options.board,
                solves: solves[index] || []
            })
        );
    });

    const isHost = state.room.hostId === state.me.id;

    element("again-button").style.display = isHost ? "block" : "none";

    element("results-status").textContent =
        isHost ? "" : "Waiting for the host to start another round.";
}


/* ============================================================
   SHARE TEXT
   ============================================================ */

export function buildShareText(state) {

    const variant = VARIANTS[state.variant];

    const standings = [...state.room.players]
        .sort((a, b) => b.score - a.score);

    const place =
        standings.findIndex(player => player.id === state.me.id) + 1;

    const rows = [];

    for (let start = 0; start < state.board.length; start += 5) {

        let row = "";

        for (let index = start; index < start + 5; index++) {

            const entry = state.board[index];

            if (entry.word !== null && entry.holderId === state.me.id) {
                /* First to a puzzle is the one worth showing off. */
                row += entry.rank === 1 ? "🎯" : "🟩";
            } else {
                row += "⬛";
            }
        }

        rows.push(row);
    }

    return [
        `Caving With Friends — ${variant.name} ${state.mode === "race" ? "race" : "shared"}`,
        `${state.score} points, ${place} of ${standings.length}`,
        "",
        rows.join("\n")
    ].join("\n");
}
