/* ============================================================
   CAVING WITH FRIENDS — ROOM SERVER

   Two jobs:

     1. Serve the game's files.
     2. Keep a registry of rooms and pass messages between the
        players in each one.

   It does not score anything and never loads the word lists.
   Puzzles are derived on every client from the room's seed, so
   the only puzzle data on the wire is a single integer.

   Rooms live in memory and disappear on restart, which is fine
   for a game that lasts two minutes.
   ============================================================ */

import http from "node:http";
import crypto from "node:crypto";

import { WebSocketServer } from "ws";

/* The engine is shared with the browser. The server only reads
   variant metadata from it — durations and the list of ids. */
import {
    VARIANTS,
    VARIANT_IDS,
    DEFAULT_PUZZLE_COUNT,
    isPuzzleCount,
    SCORING,
    calculateScore
} from "../public/js/engine.js";


const PORT = Number(process.env.PORT) || 8080;

const MODES = ["race", "shared"];

/*
    Round lengths the host can choose from. Each variant's own
    duration is the default; these are the alternatives.
*/
const ALLOWED_DURATIONS = [30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180];

/* Seconds between "everyone is in" and the first letter typed. */
const COUNTDOWN_SECONDS = 3;

/* How long a disconnected player's seat is held open. */
const RECONNECT_GRACE_MS = 90 * 1000;

/* Score broadcasts are batched to this interval per room. */
const SCORE_BROADCAST_MS = 250;

const MAX_PLAYERS = 8;
const MAX_NAME_LENGTH = 16;

/* Crude flood protection. Generous next to real play. */
const MAX_MESSAGES_PER_SECOND = 40;

/*
    How often the server pings every socket.

    Hosting platforms close connections that have been quiet
    for a while: an AWS load balancer defaults to 60 seconds,
    Azure App Service to about 230. A room sitting in the lobby
    sends nothing, so without this the players would be dropped
    while they were still there. Browsers answer a ping frame
    on their own, so no client code is involved.

    A socket that misses two pings in a row is considered gone
    and is closed, which hands it to the normal disconnect path
    and its reconnect grace period.
*/
const PING_INTERVAL_MS = 30 * 1000;


/* ============================================================
   HTTP

   GitHub Pages serves the game. This process only runs the
   rooms, so the one job left for plain HTTP is sending anyone
   who visits the old address to the new one.

   WebSocket handshakes never reach this handler: `ws` listens
   on the server's "upgrade" event, which fires instead of
   "request" for those connections.
   ============================================================ */

const SITE_URL = "https://asdf1434.github.io/caving-with-friends/";


function handleRequest(request, response) {

    /* Strip the query string and decode before doing anything else. */
    let urlPath;

    try {
        urlPath = decodeURIComponent(
            new URL(request.url, "http://localhost").pathname
        );
    } catch {
        response.writeHead(400).end("Bad request");
        return;
    }

    /*
        Azure's health probe hits this. It reports the room
        count as well, which is a cheap way to see whether
        anyone is playing.
    */
    if (urlPath === "/health") {

        response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        response.end(JSON.stringify({
            status: "ok",
            rooms: rooms.size,
            uptime: Math.round(process.uptime())
        }));

        return;
    }

    /*
        Room links used to be /ABCD, so old ones keep working:
        the code is carried over as a query parameter, which is
        the form a static host can serve.

        The destination is a fixed string, and the only part
        that varies is a code that has already matched the
        room-code shape. Nothing from the request is copied
        into the header, so this cannot be pointed at another
        site, and the pattern excludes the carriage returns
        that would be needed to inject a second header.
    */

    const code = urlPath.slice(1).toUpperCase();

    const target = /^[A-Z0-9]{4}$/.test(code)
        ? `${SITE_URL}?room=${code}`
        : SITE_URL;

    response.writeHead(302, {
        "Location": target,
        "Cache-Control": "no-store"
    });

    response.end();
}


/* ============================================================
   ROOM CODES
   ============================================================

   I, O, 0 and 1 are left out so a code can be read aloud
   without ambiguity.
*/

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";


function makeRoomCode() {

    let code;

    do {
        code = "";

        for (let i = 0; i < 4; i++) {
            code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        }

    } while (rooms.has(code));

    return code;
}


/* ============================================================
   ROOMS
   ============================================================ */

const rooms = new Map();


function emptyBoard(puzzleCount) {
    return new Array(puzzleCount).fill(null);
}


function emptySolves(puzzleCount) {
    return Array.from({ length: puzzleCount }, () => []);
}


function emptyMarks(puzzleCount) {
    return new Array(puzzleCount).fill("none");
}


function createRoom(variant, mode, settings) {

    const room = {
        code: makeRoomCode(),
        variant: variant,
        mode: mode,
        durationSeconds: settings.durationSeconds,

        /* How many puzzles a board has. See PUZZLE_COUNTS. */
        puzzleCount: settings.puzzleCount,

        /*
            When true a puzzle with few answers pays more than
            one with many. When false every puzzle pays the same
            and only rank and, if it is on, speed matter.
        */
        difficultyScoring: settings.difficultyScoring,

        /*
            When true a puzzle pays less the later it is solved.
            When false the clock only decides when the round
            stops, not what a solve is worth.
        */
        timeDecay: settings.timeDecay,

        hostId: null,

        /* lobby -> countdown -> playing -> over */
        phase: "lobby",

        seed: 0,
        startsAt: 0,
        endsAt: 0,

        players: new Map(),

        /*
            Who has solved each puzzle, in the order they did.
            A solver's position in this list is their rank.
        */
        solves: emptySolves(settings.puzzleCount),

        /*
            Players who want a fresh board. When everyone still
            here has asked, the round restarts.
        */
        refreshVotes: new Set(),

        /*
            How many answers each puzzle has, which the rarity
            term needs. Reported by the first client to finish
            generating the board, since the server never loads
            the word lists itself.
        */
        answerCounts: null,

        endTimer: null,
        phaseTimer: null,
        scoreTimer: null
    };

    rooms.set(room.code, room);

    return room;
}


function destroyRoom(room) {

    clearTimeout(room.endTimer);
    clearTimeout(room.phaseTimer);
    clearTimeout(room.scoreTimer);

    rooms.delete(room.code);
}


function createPlayer(name, puzzleCount) {

    return {
        id: crypto.randomUUID(),
        token: crypto.randomBytes(16).toString("hex"),

        name: name,
        socket: null,
        connected: true,
        ready: false,

        score: 0,

        /*
            One entry per puzzle, so the scoreboard can draw a
            column for each. Sized here as well as at the start
            of a round, because a player sitting in the lobby is
            already drawn on the board.
        */
        marks: emptyMarks(puzzleCount),

        /* Whether they were present when this round started. */
        inRound: false,

        dropTimer: null
    };
}


/* ============================================================
   SNAPSHOTS AND SENDING
   ============================================================ */

/*
    In race mode everyone plays their own board, so another
    player's word must stay hidden until the round is over.
    Their rank and score are public the whole time.
*/

function visibleSolve(room, solve, viewerId) {

    const hidden =
        room.mode === "race" &&
        room.phase !== "over" &&
        solve.playerId !== viewerId;

    return {
        index: solve.index,
        playerId: solve.playerId,
        name: solve.name,
        rank: solve.rank,
        elapsed: solve.elapsed,
        answerCount: solve.answerCount,
        points: solve.points,
        word: hidden ? null : solve.word
    };
}


function snapshot(room, viewerId) {

    return {
        code: room.code,
        variant: room.variant,
        mode: room.mode,
        durationSeconds: room.durationSeconds,
        puzzleCount: room.puzzleCount,
        difficultyScoring: room.difficultyScoring,
        timeDecay: room.timeDecay,
        hostId: room.hostId,
        phase: room.phase,
        seed: room.seed,
        startsAt: room.startsAt,
        endsAt: room.endsAt,
        scoring: SCORING,

        solves: room.solves.map(list =>
            list.map(solve => visibleSolve(room, solve, viewerId))
        ),

        refreshVotes: [...room.refreshVotes],

        players: [...room.players.values()].map(player => ({
            id: player.id,
            name: player.name,
            ready: player.ready,
            connected: player.connected,
            score: player.score,
            marks: player.marks
        }))
    };
}


function send(socket, type, payload = {}) {

    if (!socket || socket.readyState !== socket.OPEN) {
        return;
    }

    socket.send(JSON.stringify({
        type: type,
        serverNow: Date.now(),
        ...payload
    }));
}


function broadcast(room, type, payload = {}) {

    for (const player of room.players.values()) {
        send(player.socket, type, payload);
    }
}


function broadcastRoom(room) {

    /* Each player gets the board as they are allowed to see it. */

    for (const player of room.players.values()) {
        send(player.socket, "room", { room: snapshot(room, player.id) });
    }
}


function broadcastSolves(room, added) {

    for (const player of room.players.values()) {

        send(player.socket, "solved", {
            solves: added.map(solve => visibleSolve(room, solve, player.id))
        });
    }
}


/*
    Score updates arrive faster than anyone can read them, so
    they are collected and sent at most four times a second.
*/

function scheduleScoreBroadcast(room) {

    if (room.scoreTimer !== null) {
        return;
    }

    room.scoreTimer = setTimeout(() => {

        room.scoreTimer = null;

        broadcast(room, "scores", {
            players: [...room.players.values()].map(player => ({
                id: player.id,
                score: player.score,
                marks: player.marks
            }))
        });

    }, SCORE_BROADCAST_MS);
}


/* ============================================================
   ROUND LIFECYCLE
   ============================================================ */

function startRound(room) {

    const durationSeconds = room.durationSeconds;

    /* A fresh seed each round means fresh puzzles. */
    room.seed = crypto.randomInt(2 ** 32);

    room.phase = "countdown";
    room.startsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
    room.endsAt = room.startsAt + durationSeconds * 1000;

    room.solves = emptySolves(room.puzzleCount);
    room.answerCounts = null;
    room.refreshVotes.clear();

    for (const player of room.players.values()) {
        player.score = 0;
        player.marks = emptyMarks(room.puzzleCount);
        player.ready = false;
        player.inRound = true;
    }

    broadcast(room, "started", {
        seed: room.seed,
        variant: room.variant,
        mode: room.mode,
        durationSeconds: durationSeconds,
        puzzleCount: room.puzzleCount,
        difficultyScoring: room.difficultyScoring,
        timeDecay: room.timeDecay,
        scoring: SCORING,
        startsAt: room.startsAt,
        endsAt: room.endsAt
    });

    broadcastRoom(room);

    /*
        The server owns the clock. Clients render a countdown
        from endsAt, but the round ends when this fires.
    */

    clearTimeout(room.endTimer);

    room.endTimer = setTimeout(
        () => endRound(room),
        Math.max(0, room.endsAt - Date.now())
    );

    clearTimeout(room.phaseTimer);

    room.phaseTimer = setTimeout(() => {

        if (room.phase === "countdown") {
            room.phase = "playing";
            broadcastRoom(room);
        }

    }, Math.max(0, room.startsAt - Date.now()));
}


/*
    Everyone who is here has said they are ready, so start.

    A room of one is left alone: the host has to be able to sit
    in the lobby waiting for people to arrive.
*/

/*
    Restart the round if everyone still here has asked for a
    fresh board. Called when the room's membership changes, so
    one person leaving cannot leave a vote stranded.
*/

function maybeRefresh(room) {

    if (room.phase !== "playing" && room.phase !== "countdown") {
        return;
    }

    const present = [...room.players.values()].filter(
        player => player.connected && player.inRound
    );

    if (present.length === 0) {
        return;
    }

    if (present.every(player => room.refreshVotes.has(player.id))) {
        startRound(room);
    }
}


function maybeAutoStart(room) {

    if (room.phase === "countdown" || room.phase === "playing") {
        return;
    }

    const present =
        [...room.players.values()].filter(player => player.connected);

    if (present.length < 2) {
        return;
    }

    if (!present.every(player => player.ready)) {
        return;
    }

    startRound(room);
}


/*
    Shared mode gives the room one board, so once every puzzle
    has been taken there is nothing left for anyone to do and
    the round ends rather than running out a dead clock.

    Race mode is deliberately not included. There, every player
    solves their own copy, so a finished player does not mean a
    finished room, and cutting the round short would take points
    away from everyone still typing.
*/

function everythingSolved(room) {

    return room.mode === "shared" &&
        room.solves.every(list => list.length > 0);
}


function endRound(room) {

    if (room.phase !== "playing" && room.phase !== "countdown") {
        return;
    }

    room.phase = "over";

    clearTimeout(room.endTimer);
    room.endTimer = null;

    broadcast(room, "ended", {
        players: [...room.players.values()].map(player => ({
            id: player.id,
            name: player.name,
            score: player.score,
            marks: player.marks
        }))
    });

    broadcastRoom(room);
}


/* ============================================================
   SCORING

   A player's score is the sum of what their solves were worth
   when they made them. Nothing is ever taken away.
   ============================================================ */

function recalculateScores(room) {

    for (const player of room.players.values()) {
        player.score = 0;
        player.marks = emptyMarks(room.puzzleCount);
    }

    room.solves.forEach((list, index) => {

        for (const solve of list) {

            const player = room.players.get(solve.playerId);

            if (!player) {
                continue;
            }

            player.score += solve.points;
            player.marks[index] = "solved";
        }
    });

}


/*
    Seconds since the round began, which is what the time
    penalty is measured against.
*/

function elapsedSeconds(room) {
    return Math.max(0, (Date.now() - room.startsAt) / 1000);
}


/* ============================================================
   MESSAGE VALIDATION
   ============================================================ */

function cleanName(value) {

    const name = String(value ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, MAX_NAME_LENGTH);

    return name.length > 0 ? name : "Player";
}


function isPuzzleIndex(value, puzzleCount) {
    return Number.isInteger(value) && value >= 0 && value < puzzleCount;
}


function isWord(value) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= 40 &&
        /^[A-Z]+$/.test(value);
}


function isScore(value) {
    return Number.isFinite(value) && value >= 0 && value <= 1000000;
}


/* ============================================================
   CONNECTION HANDLING
   ============================================================ */

const server = http.createServer(handleRequest);


/*
    Which origins may open a socket.

    The page and the room server now live on different origins,
    so this endpoint is reachable from any web page on the
    internet. Without this check, a page someone else wrote
    could open a socket here and act inside a room.

    A browser always sends Origin on a WebSocket handshake and
    cannot fake it. A client that is not a browser can send
    anything it likes either way, so refusing a missing Origin
    would block the protocol tests without stopping an attacker.
*/

const ALLOWED_ORIGINS = new Set([
    "https://asdf1434.github.io"
]);

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;


function originAllowed(info) {

    const origin = info.req.headers.origin;

    if (origin === undefined) {
        return true;
    }

    return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);
}


/*
    Every message this game sends is a few hundred bytes: a
    name is capped at 16 characters, a word at 40, and a board
    holds at most 20 puzzles. The `ws` default is 100MB, which
    would let one connection make the server hold far more
    memory than the machine has.
*/
const MAX_MESSAGE_BYTES = 16 * 1024;


const websocketServer = new WebSocketServer({
    server: server,
    verifyClient: originAllowed,
    maxPayload: MAX_MESSAGE_BYTES
});


websocketServer.on("connection", socket => {

    /* Cleared by every pong. See PING_INTERVAL_MS. */
    socket.missedPings = 0;

    socket.on("pong", () => {
        socket.missedPings = 0;
    });

    /* Each socket belongs to at most one player in one room. */

    const session = {
        room: null,
        player: null,
        messageCount: 0,
        windowStart: Date.now()
    };


    function fail(message) {
        send(socket, "error", { message: message });
    }


    function attach(room, player) {

        session.room = room;
        session.player = player;

        player.socket = socket;
        player.connected = true;

        clearTimeout(player.dropTimer);
        player.dropTimer = null;

        send(socket, "welcome", {
            you: { id: player.id, token: player.token },
            room: snapshot(room, player.id)
        });

        /*
            Someone resuming mid-round needs the seed and the
            clock immediately. Someone who has just walked in on
            a running game does not: they wait in the lobby and
            the next round picks them up.
        */

        if (
            player.inRound &&
            (room.phase === "countdown" || room.phase === "playing")
        ) {

            send(socket, "started", {
                seed: room.seed,
                variant: room.variant,
                mode: room.mode,
                durationSeconds: room.durationSeconds,
                startsAt: room.startsAt,
                endsAt: room.endsAt,
                resumed: true
            });
        }

        broadcastRoom(room);
    }


    function handle(message) {

        switch (message.type) {

            /* ------------------------------------------------
               CREATE
               ------------------------------------------------ */

            case "create": {

                if (session.room) {
                    fail("Already in a room");
                    return;
                }

                const variant = VARIANT_IDS.includes(message.variant)
                    ? message.variant
                    : "blackjack";

                const mode = MODES.includes(message.mode)
                    ? message.mode
                    : "race";

                /* Each variant's own timer is the default. */
                const durationSeconds =
                    ALLOWED_DURATIONS.includes(message.durationSeconds)
                        ? message.durationSeconds
                        : VARIANTS[variant].durationSeconds;

                const puzzleCount = isPuzzleCount(message.puzzleCount)
                    ? message.puzzleCount
                    : DEFAULT_PUZZLE_COUNT;

                /* Both scoring terms are on unless the host says otherwise. */

                const room = createRoom(variant, mode, {
                    durationSeconds: durationSeconds,
                    puzzleCount: puzzleCount,
                    difficultyScoring: message.difficultyScoring !== false,
                    timeDecay: message.timeDecay !== false
                });
                const player = createPlayer(
                    cleanName(message.name),
                    room.puzzleCount
                );

                room.hostId = player.id;
                room.players.set(player.id, player);

                console.log(`room ${room.code} created (${variant}/${mode})`);

                attach(room, player);
                return;
            }


            /* ------------------------------------------------
               JOIN
               ------------------------------------------------ */

            case "join": {

                if (session.room) {
                    fail("Already in a room");
                    return;
                }

                const room = rooms.get(String(message.code ?? "").toUpperCase());

                if (!room) {
                    fail("No room with that code");
                    return;
                }

                if (room.players.size >= MAX_PLAYERS) {
                    fail("That room is full");
                    return;
                }

                const player = createPlayer(
                    cleanName(message.name),
                    room.puzzleCount
                );

                room.players.set(player.id, player);

                attach(room, player);
                return;
            }


            /* ------------------------------------------------
               RESUME

               A reload or a slept laptop reconnects here and
               keeps its seat, score and solutions.
               ------------------------------------------------ */

            case "resume": {

                if (session.room) {
                    return;
                }

                const room = rooms.get(String(message.code ?? "").toUpperCase());

                if (!room) {
                    fail("That room has closed");
                    return;
                }

                const player = room.players.get(message.playerId);

                if (!player || player.token !== message.token) {
                    fail("Could not rejoin that room");
                    return;
                }

                /* Drop any socket still attached to this seat. */
                if (player.socket && player.socket !== socket) {
                    player.socket.close();
                }

                attach(room, player);
                return;
            }


            /* ------------------------------------------------
               READY
               ------------------------------------------------ */

            case "ready": {

                if (!session.player) {
                    return;
                }

                session.player.ready = Boolean(message.ready);

                broadcastRoom(session.room);
                maybeAutoStart(session.room);
                return;
            }


            /* ------------------------------------------------
               SETTINGS  (host only)

               Rule, mode, round length, word count and the
               scoring switches, all changeable between rounds
               so a room can adjust after a game rather than
               start a new one.
               ------------------------------------------------ */

            case "settings": {

                const room = session.room;

                if (!room || !session.player) {
                    return;
                }

                if (room.hostId !== session.player.id) {
                    fail("Only the host can change the settings");
                    return;
                }

                if (room.phase === "countdown" || room.phase === "playing") {
                    return;
                }

                /*
                    Each setting is handled on its own, so a
                    message carrying only one of them works.
                */

                let changed = false;

                /*
                    The rule comes first: switching it brings
                    its own round length with it, which an
                    explicit length in the same message then
                    overrides.
                */

                if (
                    VARIANT_IDS.includes(message.variant) &&
                    message.variant !== room.variant
                ) {
                    room.variant = message.variant;
                    room.durationSeconds = VARIANTS[message.variant].durationSeconds;
                    changed = true;
                }

                if (MODES.includes(message.mode)) {
                    room.mode = message.mode;
                    changed = true;
                }

                if (ALLOWED_DURATIONS.includes(message.durationSeconds)) {
                    room.durationSeconds = message.durationSeconds;
                    changed = true;
                }

                /*
                    Changing the count resizes the board, which
                    means resizing every array that has an entry
                    per puzzle. Only reachable between rounds, so
                    there is never a solve to lose.
                */
                if (
                    isPuzzleCount(message.puzzleCount) &&
                    message.puzzleCount !== room.puzzleCount
                ) {
                    room.puzzleCount = message.puzzleCount;
                    room.solves = emptySolves(room.puzzleCount);
                    room.answerCounts = null;

                    for (const player of room.players.values()) {
                        player.marks = emptyMarks(room.puzzleCount);
                    }

                    changed = true;
                }

                if (typeof message.difficultyScoring === "boolean") {
                    room.difficultyScoring = message.difficultyScoring;
                    changed = true;
                }

                if (typeof message.timeDecay === "boolean") {
                    room.timeDecay = message.timeDecay;
                    changed = true;
                }

                if (!changed) {
                    return;
                }

                broadcastRoom(room);
                return;
            }


            /* ------------------------------------------------
               START  (host only)
               ------------------------------------------------ */

            case "start": {

                const room = session.room;

                if (!room || !session.player) {
                    return;
                }

                if (room.hostId !== session.player.id) {
                    fail("Only the host can start the game");
                    return;
                }

                if (room.phase === "countdown" || room.phase === "playing") {
                    return;
                }

                startRound(room);
                return;
            }


            /* ------------------------------------------------
               BOARD

               The server never loads the word lists, so it
               learns how many answers each puzzle has from the
               first client that finishes generating the board.
               Generation is deterministic, so every client
               would report the same numbers.
               ------------------------------------------------ */

            case "board": {

                const room = session.room;

                if (!room || room.answerCounts !== null) {
                    return;
                }

                if (
                    !Array.isArray(message.counts) ||
                    message.counts.length !== room.puzzleCount ||
                    !message.counts.every(
                        count => Number.isInteger(count) && count > 0
                    )
                ) {
                    return;
                }

                room.answerCounts = message.counts;
                return;
            }


            /* ------------------------------------------------
               SOLVE

               The client decides whether a word is valid; the
               server decides who got there first and what that
               was worth. Rank cannot be left to the clients,
               because they would disagree.
               ------------------------------------------------ */

            case "solve": {

                const room = session.room;

                if (!room || room.phase !== "playing") {
                    return;
                }

                if (!Array.isArray(message.indexes) || !isWord(message.word)) {
                    return;
                }

                const elapsed = elapsedSeconds(room);
                const added = [];

                for (const index of message.indexes.slice(0, room.puzzleCount)) {

                    if (!isPuzzleIndex(index, room.puzzleCount)) {
                        continue;
                    }

                    const list = room.solves[index];

                    /* Shared mode: the first solve locks the puzzle. */
                    if (room.mode === "shared" && list.length > 0) {
                        continue;
                    }

                    /* Nobody scores the same puzzle twice. */
                    if (list.some(solve => solve.playerId === session.player.id)) {
                        continue;
                    }

                    const rank = list.length + 1;

                    const answerCount =
                        room.answerCounts ? room.answerCounts[index] : 16;

                    const solve = {
                        index: index,
                        playerId: session.player.id,
                        name: session.player.name,
                        word: message.word,
                        rank: rank,

                        /*
                            Kept so a card can show how the award
                            was arrived at, not just the number.
                        */
                        elapsed: Math.round(elapsed * 10) / 10,
                        answerCount: answerCount,

                        points: calculateScore(answerCount, rank, elapsed, {
                            difficultyScoring: room.difficultyScoring,
                            timeDecay: room.timeDecay
                        })
                    };

                    list.push(solve);

                    added.push(solve);
                }

                if (added.length === 0) {
                    send(socket, "solveRejected", { word: message.word });
                    return;
                }

                recalculateScores(room);

                broadcastSolves(room, added);
                scheduleScoreBroadcast(room);

                if (everythingSolved(room)) {
                    endRound(room);
                }

                return;
            }


            /* ------------------------------------------------
               REFRESH

               Anyone can ask for a fresh board mid-round. When
               everyone still connected has asked, the round
               restarts with a new seed and a full clock.

               It needs to be unanimous because a reroll wipes
               the scores, so one player cannot use it to undo
               a bad start.
               ------------------------------------------------ */

            case "refresh": {

                const room = session.room;

                if (!room || !session.player) {
                    return;
                }

                if (room.phase !== "playing" && room.phase !== "countdown") {
                    return;
                }

                if (message.want === false) {
                    room.refreshVotes.delete(session.player.id);
                } else {
                    room.refreshVotes.add(session.player.id);
                }

                const present = [...room.players.values()].filter(
                    player => player.connected && player.inRound
                );

                const unanimous =
                    present.length > 0 &&
                    present.every(player => room.refreshVotes.has(player.id));

                if (unanimous) {
                    startRound(room);
                    return;
                }

                broadcastRoom(room);
                return;
            }


            default:
                return;
        }
    }


    socket.on("message", raw => {

        /* Flood protection. */

        const now = Date.now();

        if (now - session.windowStart > 1000) {
            session.windowStart = now;
            session.messageCount = 0;
        }

        if (++session.messageCount > MAX_MESSAGES_PER_SECOND) {
            return;
        }

        let message;

        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }

        if (!message || typeof message.type !== "string") {
            return;
        }

        handle(message);
    });


    /* ------------------------------------------------------
       DISCONNECT

       The seat is held open for a grace period so a reload
       does not cost anyone their game.
       ------------------------------------------------------ */

    socket.on("close", () => {

        const room = session.room;
        const player = session.player;

        if (!room || !player) {
            return;
        }

        /* A newer socket already took this seat. */
        if (player.socket !== socket) {
            return;
        }

        player.connected = false;
        player.socket = null;

        broadcastRoom(room);

        /* The people still here may now all be ready. */
        maybeAutoStart(room);

        /* Or may all have asked for a fresh board. */
        room.refreshVotes.delete(player.id);
        maybeRefresh(room);

        player.dropTimer = setTimeout(() => {

            room.players.delete(player.id);

            if (room.players.size === 0) {
                console.log(`room ${room.code} closed`);
                destroyRoom(room);
                return;
            }

            /* Promote someone if the host left for good. */
            if (room.hostId === player.id) {
                room.hostId = [...room.players.keys()][0];
            }

            recalculateScores(room);

            broadcastRoom(room);

        }, RECONNECT_GRACE_MS);
    });


    socket.on("error", () => {
        /* The close handler does the cleanup. */
    });
});


setInterval(() => {

    for (const socket of websocketServer.clients) {

        if (socket.readyState !== socket.OPEN) {
            continue;
        }

        if (socket.missedPings >= 2) {
            socket.terminate();
            continue;
        }

        socket.missedPings += 1;
        socket.ping();
    }

}, PING_INTERVAL_MS);


/* ============================================================
   START
   ============================================================ */

console.log("Caving With Friends");

server.listen(PORT, () => {
    console.log(`  listening on http://localhost:${PORT}`);
});
