/* ============================================================
   PROTOCOL TESTS

   Starts the real server on a spare port and drives it with
   two WebSocket clients, which is the same thing two browser
   tabs would do.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "server.js");

const PORT = 8137;
const ORIGIN = `http://localhost:${PORT}`;


/* ============================================================
   HARNESS
   ============================================================ */

function startServer() {

    const child = spawn("node", [SERVER], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "pipe", "inherit"]
    });

    return new Promise((resolve, reject) => {

        const timer = setTimeout(
            () => reject(new Error("server did not start")),
            15000
        );

        child.stdout.on("data", chunk => {

            if (chunk.toString().includes("listening")) {
                clearTimeout(timer);
                resolve(child);
            }
        });
    });
}


class Client {

    constructor() {
        this.socket = new WebSocket(`ws://localhost:${PORT}`);
        this.received = [];
        this.waiters = [];

        this.socket.on("message", raw => {

            const message = JSON.parse(raw);

            this.received.push(message);

            this.waiters = this.waiters.filter(waiter => {

                if (waiter.type !== message.type) {
                    return true;
                }

                if (waiter.predicate && !waiter.predicate(message)) {
                    return true;
                }

                waiter.resolve(message);
                return false;
            });
        });
    }

    open() {
        return new Promise(resolve => this.socket.on("open", resolve));
    }

    send(type, payload = {}) {
        this.socket.send(JSON.stringify({ type, ...payload }));
    }

    /*
        Resolves with the next message of this type, including
        one already buffered.

        A client sees its own broadcasts too, so an optional
        predicate picks out the one the test actually means.
    */

    next(type, predicate = null, timeoutMs = 8000) {

        const matches = message =>
            message.type === type && (!predicate || predicate(message));

        const seen = this.received.find(matches);

        if (seen) {
            this.received = this.received.filter(message => message !== seen);
            return Promise.resolve(seen);
        }

        return new Promise((resolve, reject) => {

            const timer = setTimeout(
                () => reject(new Error(`timed out waiting for ${type}`)),
                timeoutMs
            );

            this.waiters.push({
                type,
                predicate,
                resolve: message => {
                    clearTimeout(timer);
                    resolve(message);
                }
            });
        });
    }

    close() {
        this.socket.close();
    }
}


let server;

test.before(async () => {
    server = await startServer();
});

test.after(() => {
    server.kill();
});


/* ============================================================
   TESTS
   ============================================================ */

const SITE_URL = "https://asdf1434.github.io/caving-with-friends/";


test("sends browsers to the site, keeping old room links good", async () => {

    const root = await fetch(ORIGIN, { redirect: "manual" });

    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), SITE_URL);

    /* A room link from before the move still reaches its room. */
    const room = await fetch(`${ORIGIN}/ABCD`, { redirect: "manual" });

    assert.equal(room.status, 302);
    assert.equal(room.headers.get("location"), `${SITE_URL}?room=ABCD`);

    /* Anything else is not a room code, so it goes to the front page. */
    const other = await fetch(`${ORIGIN}/data/CEL22.txt`, {
        redirect: "manual"
    });

    assert.equal(other.status, 302);
    assert.equal(other.headers.get("location"), SITE_URL);
});


test("the health probe still answers", async () => {

    const response = await fetch(`${ORIGIN}/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
});


test("cannot be pointed at another site", async () => {

    /*
        A path that looks like an absolute URL must not end up
        in the Location header, or the old address could be
        used to send people somewhere else.
    */

    for (const attack of [
        "//evil.example.com",
        "/https://evil.example.com",
        "/%2F%2Fevil.example.com"
    ]) {

        const response = await fetch(`${ORIGIN}${attack}`, {
            redirect: "manual"
        });

        const location = response.headers.get("location");

        if (location !== null) {
            assert.ok(
                location.startsWith(SITE_URL),
                `${attack} redirected to ${location}`
            );
        }
    }
});


test("refuses a socket from an origin that is not the site", async () => {

    const socket = new WebSocket(`ws://localhost:${PORT}`, {
        origin: "https://evil.example.com"
    });

    const outcome = await new Promise(resolve => {
        socket.on("open", () => resolve("open"));
        socket.on("error", () => resolve("refused"));
    });

    socket.close();

    assert.equal(outcome, "refused");
});


test("two players share a room, a seed and a clock", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");
    const code = welcome.room.code;

    assert.match(code, /^[A-Z0-9]{4}$/);
    assert.equal(welcome.room.hostId, welcome.you.id);
    assert.equal(welcome.room.phase, "lobby");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: code });

    const guestWelcome = await guest.next("welcome");

    assert.equal(guestWelcome.room.players.length, 2);

    /* Only the host may start. */
    guest.send("start");
    assert.match((await guest.next("error")).message, /host/i);

    host.send("start");

    const hostStart = await host.next("started");
    const guestStart = await guest.next("started");

    assert.equal(hostStart.seed, guestStart.seed);
    assert.equal(hostStart.endsAt, guestStart.endsAt);
    assert.equal(hostStart.endsAt - hostStart.startsAt, 120 * 1000);

    host.close();
    guest.close();
});


test("race mode ranks solvers and hides their words until the end", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");
    const hostId = welcome.you.id;

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });

    const guestId = (await guest.next("welcome")).you.id;

    host.send("start");
    await host.next("started");

    /* Wait out the three second countdown. */
    await new Promise(resolve => setTimeout(resolve, 3300));

    /* The server learns the answer counts from a client. */
    host.send("board", { counts: new Array(10).fill(16) });

    host.send("solve", { indexes: [0], word: "CAVING" });

    const mine = await host.next("solved");

    assert.equal(mine.solves[0].rank, 1);
    assert.equal(mine.solves[0].word, "CAVING");
    assert.ok(mine.solves[0].points > 900);

    /* The same event reaches the guest without the word. */
    const theirs = await guest.next(
        "solved",
        message => message.solves[0].playerId === hostId
    );

    assert.equal(theirs.solves[0].word, null, "the word leaked to a rival");
    assert.equal(theirs.solves[0].rank, 1);

    /* Second to the same puzzle scores less. */
    guest.send("solve", { indexes: [0], word: "CAVERN" });

    const second = await guest.next(
        "solved",
        message => message.solves[0].playerId === guestId
    );

    assert.equal(second.solves[0].rank, 2);

    assert.ok(
        second.solves[0].points < mine.solves[0].points,
        "being second was not worth less"
    );

    /* Nobody scores the same puzzle twice. */
    host.send("solve", { indexes: [0], word: "CAVING" });
    await host.next("solveRejected");

    host.close();
    guest.close();
});


/*
    The slow one. The reveal happens when the round ends, and
    the shortest round on offer is sixty seconds, so this test
    waits one out. It is worth the wall clock: if this breaks,
    race mode quietly hands everyone their rivals' answers.
*/

test("race mode reveals every word once the round is over", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "race",
        durationSeconds: 60
    });

    const welcome = await host.next("welcome");
    const hostId = welcome.you.id;

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    host.send("start");

    const started = await host.next("started");

    await new Promise(resolve => setTimeout(resolve, 3300));

    host.send("board", { counts: new Array(10).fill(16) });
    host.send("solve", { indexes: [0], word: "CAVING" });

    await host.next("solved");

    /* Wait for the round to end on the server's clock. */
    const remaining = started.endsAt - Date.now();

    await guest.next("ended", null, remaining + 10000);

    const after = await guest.next(
        "room",
        message => message.room.phase === "over",
        10000
    );

    assert.equal(after.room.solves[0][0].word, "CAVING");
    assert.equal(after.room.solves[0][0].playerId, hostId);

    host.close();
    guest.close();
});


test("shared mode locks a puzzle to whoever solves it first", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "shared" });

    const welcome = await host.next("welcome");
    const hostId = welcome.you.id;

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });

    const guestId = (await guest.next("welcome")).you.id;

    host.send("start");
    await host.next("started");
    await new Promise(resolve => setTimeout(resolve, 3300));

    host.send("board", { counts: new Array(10).fill(16) });

    host.send("solve", { indexes: [0], word: "CAVING" });

    const taken = await guest.next("solved");

    assert.equal(taken.solves[0].playerId, hostId);
    assert.equal(taken.solves[0].rank, 1);

    /* A shared board has one holder, so the second is refused. */
    guest.send("solve", { indexes: [0], word: "CAVERN" });

    await guest.next("solveRejected");

    const scores = await host.next(
        "scores",
        message => message.players.some(player => player.score > 0)
    );

    const byId = Object.fromEntries(
        scores.players.map(player => [player.id, player.score])
    );

    assert.ok(byId[hostId] > 900);
    assert.equal(byId[guestId], 0);

    host.close();
    guest.close();
});


test("a room with difficulty scoring off pays every puzzle the same", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "race",
        difficultyScoring: false
    });

    const welcome = await host.next("welcome");

    assert.equal(welcome.room.difficultyScoring, false);

    host.send("start");
    await host.next("started");
    await new Promise(resolve => setTimeout(resolve, 3300));

    /* Puzzle 0 has few answers, puzzle 1 has many. */
    const counts = new Array(10).fill(16);
    counts[1] = 900;

    host.send("board", { counts: counts });

    host.send("solve", { indexes: [0, 1], word: "CAVING" });

    const solved = await host.next("solved");

    const hard = solved.solves.find(solve => solve.index === 0);
    const easy = solved.solves.find(solve => solve.index === 1);

    assert.equal(
        hard.points,
        easy.points,
        "difficulty still changed the award"
    );

    host.close();
});


test("the host turns the scoring switches off from the lobby", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    /* On unless the host says otherwise. */
    assert.equal(welcome.room.difficultyScoring, true);

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    /* Guests cannot change it. */
    guest.send("settings", { difficultyScoring: false });

    host.send("settings", { difficultyScoring: false });

    const updated = await host.next(
        "room",
        message => message.room.difficultyScoring === false
    );

    assert.equal(updated.room.difficultyScoring, false);

    /* The two scoring switches are independent. */
    assert.equal(updated.room.timeDecay, true);

    host.send("settings", { timeDecay: false });

    const both = await host.next(
        "room",
        message => message.room.timeDecay === false
    );

    assert.equal(both.room.difficultyScoring, false);

    /* The round carries the setting to the clients. */
    host.send("start");

    const started = await host.next("started");

    assert.equal(started.difficultyScoring, false);
    assert.equal(started.timeDecay, false);

    host.close();
    guest.close();
});


test("a room with time decay off pays the same however late a solve is", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "race",
        timeDecay: false
    });

    const welcome = await host.next("welcome");

    assert.equal(welcome.room.timeDecay, false);
    assert.equal(welcome.room.difficultyScoring, true);

    host.send("start");
    await host.next("started");

    /* Well past the countdown, so the clock has visibly moved. */
    await new Promise(resolve => setTimeout(resolve, 5000));

    host.send("board", { counts: new Array(10).fill(16) });
    host.send("solve", { indexes: [0], word: "CAVING" });

    const solved = await host.next("solved");
    const solve = solved.solves[0];

    assert.ok(solve.elapsed > 1, "the round clock did not run");

    /* Base, no rank penalty, no time penalty, average rarity. */
    assert.equal(solve.points, 1000);

    host.close();
});


test("the host changes the rule and mode after a round", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "race",
        durationSeconds: 60
    });

    const welcome = await host.next("welcome");

    assert.equal(welcome.room.variant, "blackjack");
    assert.equal(welcome.room.mode, "race");

    /* A rule the server does not know is ignored. */
    host.send("settings", { variant: "nonsense" });

    host.send("settings", { mode: "shared" });

    const switched = await host.next(
        "room",
        message => message.room.mode === "shared"
    );

    assert.equal(switched.room.variant, "blackjack");

    /* A new rule brings its own round length with it. */
    host.send("settings", { variant: "anagram" });

    const ruled = await host.next(
        "room",
        message => message.room.variant === "anagram"
    );

    assert.equal(
        ruled.room.durationSeconds,
        150,
        "the round length did not follow the new rule"
    );

    /* An explicit length in the same message still wins. */
    host.send("settings", { variant: "contiguous", durationSeconds: 180 });

    const both = await host.next(
        "room",
        message => message.room.variant === "contiguous"
    );

    assert.equal(both.room.durationSeconds, 180);

    /* The next round is played under the new rules. */
    host.send("start");

    const started = await host.next("started");

    assert.equal(started.variant, "contiguous");
    assert.equal(started.mode, "shared");
    assert.equal(started.durationSeconds, 180);

    host.close();
});


test("only the host changes the rule", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    guest.send("settings", { variant: "anagram" });

    const error = await guest.next("error");

    assert.match(error.message, /host/i);

    host.close();
    guest.close();
});


test("a harder puzzle is worth more than an easy one", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    await host.next("welcome");

    host.send("start");
    await host.next("started");
    await new Promise(resolve => setTimeout(resolve, 3300));

    /* Puzzle 0 has few answers, puzzle 1 has many. */
    const counts = new Array(10).fill(16);
    counts[0] = 16;
    counts[1] = 900;

    host.send("board", { counts: counts });

    host.send("solve", { indexes: [0, 1], word: "CAVING" });

    const solved = await host.next("solved");

    const hard = solved.solves.find(solve => solve.index === 0);
    const easy = solved.solves.find(solve => solve.index === 1);

    assert.ok(
        hard.points > easy.points,
        "the rarer puzzle was not worth more"
    );

    host.close();
});


test("a reload keeps its seat, score and place in the round", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    host.send("start");
    await host.next("started");
    await new Promise(resolve => setTimeout(resolve, 3300));

    host.send("board", { counts: new Array(10).fill(16) });
    host.send("solve", { indexes: [0], word: "CAVING" });

    const solved = await host.next("solved");
    const earned = solved.solves[0].points;

    await host.next("scores");

    host.close();

    /* The same seat, from a new socket. */
    const returning = new Client();
    await returning.open();

    returning.send("resume", {
        code: welcome.room.code,
        playerId: welcome.you.id,
        token: welcome.you.token
    });

    const resumed = await returning.next("welcome");

    const me = resumed.room.players.find(
        player => player.id === welcome.you.id
    );

    assert.equal(me.score, earned, "the score did not survive the reload");

    /* A resumed player is handed the running round, not the lobby. */
    const started = await returning.next("started");

    assert.equal(started.resumed, true);
    assert.equal(started.seed, resumed.room.seed);

    returning.close();
});


test("someone arriving mid-round waits for the next one", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    host.send("start");
    await host.next("started");

    const latecomer = new Client();
    await latecomer.open();

    latecomer.send("join", { name: "Late", code: welcome.room.code });

    const joined = await latecomer.next("welcome");

    assert.equal(joined.room.phase, "countdown");

    /* No "started" should reach them for the round already running. */
    await assert.rejects(() => latecomer.next("started", null, 1200));

    host.close();
    latecomer.close();
});


test("the round ends on the server's clock", async () => {

    const host = new Client();
    await host.open();

    /*
        Contiguous is the shortest variant at 90 seconds, still
        too long to wait for, so this checks the schedule rather
        than the elapsed time.
    */

    host.send("create", { name: "Host", variant: "contiguous", mode: "race" });

    await host.next("welcome");

    host.send("start");

    const started = await host.next("started");

    assert.equal(started.endsAt - started.startsAt, 90 * 1000);

    host.close();
});


test("a round starts on its own once everyone is ready", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    /* One of two ready is not enough. */
    host.send("ready", { ready: true });

    await assert.rejects(() => host.next("started", null, 800));

    /* The second one triggers it, with nobody pressing start. */
    guest.send("ready", { ready: true });

    const started = await host.next("started");

    /* Three seconds of countdown before anyone can type. */
    assert.ok(started.startsAt - started.serverNow > 2000);
    assert.ok(started.startsAt - started.serverNow <= 3000);

    /* Ready flags are cleared, so the next round needs them again. */
    const room = await host.next(
        "room",
        message => message.room.phase === "countdown"
    );

    assert.ok(room.room.players.every(player => !player.ready));

    host.close();
    guest.close();
});


test("the host can still start early over an unready room", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    /* Nobody is ready. The host overrides. */
    host.send("start");

    assert.ok((await guest.next("started")).seed > 0);

    host.close();
    guest.close();
});


test("a lone host is left in the lobby even when ready", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });
    await host.next("welcome");

    host.send("ready", { ready: true });

    await assert.rejects(() => host.next("started", null, 800));

    host.close();
});


test("the round length is chosen at creation and by the host afterwards", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "race",
        durationSeconds: 60
    });

    const welcome = await host.next("welcome");

    assert.equal(welcome.room.durationSeconds, 60);

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    /* Only the host may change it. */
    guest.send("settings", { durationSeconds: 180 });

    assert.match((await guest.next("error")).message, /host/i);

    /* Values outside the offered list are ignored. */
    host.send("settings", { durationSeconds: 7 });
    host.send("settings", { durationSeconds: 180 });

    const updated = await host.next(
        "room",
        message => message.room.durationSeconds === 180
    );

    assert.equal(updated.room.durationSeconds, 180);

    host.send("start");

    const started = await host.next("started");

    assert.equal(started.durationSeconds, 180);
    assert.equal(started.endsAt - started.startsAt, 180 * 1000);

    host.close();
    guest.close();
});


test("an unspecified round length falls back to the variant's own", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "anagram", mode: "race" });

    const welcome = await host.next("welcome");

    assert.equal(welcome.room.durationSeconds, 150);

    host.close();
});


test("a new board needs everyone to agree", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    host.send("start");

    const first = await host.next("started");

    await new Promise(resolve => setTimeout(resolve, 3300));

    /* Something to lose, so the reset is visible. */
    host.send("board", { counts: new Array(10).fill(16) });
    host.send("solve", { indexes: [0], word: "CAVING" });
    await host.next("solved");

    /* One vote is not enough. */
    host.send("refresh", { want: true });

    const waiting = await guest.next(
        "room",
        message => message.room.refreshVotes.length === 1
    );

    assert.equal(waiting.room.phase, "playing");

    /* A vote can be taken back. */
    host.send("refresh", { want: false });

    await guest.next(
        "room",
        message => message.room.refreshVotes.length === 0
    );

    /* Both agreeing rerolls the board. */
    host.send("refresh", { want: true });
    guest.send("refresh", { want: true });

    const second = await host.next(
        "started",
        message => message.seed !== first.seed,
        8000
    );

    assert.notEqual(second.seed, first.seed, "the board did not change");

    /* A reroll wipes the scores and the votes. */
    const fresh = await host.next(
        "room",
        message => message.room.seed === second.seed
    );

    assert.equal(fresh.room.refreshVotes.length, 0);
    assert.deepEqual(fresh.room.solves[0], []);
    assert.ok(fresh.room.players.every(player => player.score === 0));

    host.close();
    guest.close();
});


test("a new board cannot be called from the lobby", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });
    await host.next("welcome");

    host.send("refresh", { want: true });

    await assert.rejects(() => host.next("started", null, 800));

    host.close();
});


test("the host sets the word count and everyone's board follows", async () => {

    const host = new Client();
    await host.open();

    host.send("create", { name: "Host", variant: "blackjack", mode: "race" });

    const welcome = await host.next("welcome");

    /* Unasked for, so it is the default. */
    assert.equal(welcome.room.puzzleCount, 10);

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    host.send("settings", { puzzleCount: 20 });

    const wider = await guest.next(
        "room",
        message => message.room.puzzleCount === 20
    );

    /* The board resized, so every row of marks resized with it. */
    for (const player of wider.room.players) {
        assert.equal(player.marks.length, 20);
    }

    assert.equal(wider.room.solves.length, 20);

    /* A count that is not on offer is ignored. */
    host.send("settings", { puzzleCount: 7 });

    await assert.rejects(
        () => host.next("room", message => message.room.puzzleCount === 7, 800)
    );

    /* And it is the host's to set. */
    guest.send("settings", { puzzleCount: 5 });

    await guest.next("error");

    host.close();
    guest.close();
});


test("a room can be created with a word count", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "shared",
        puzzleCount: 5
    });

    const welcome = await host.next("welcome");

    assert.equal(welcome.room.puzzleCount, 5);
    assert.equal(welcome.room.solves.length, 5);

    host.send("start");

    const started = await host.next("started");

    assert.equal(started.puzzleCount, 5);

    host.close();
});


test("shared mode ends the round once every puzzle is taken", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "shared",
        puzzleCount: 5,

        /* Long enough that the clock cannot be what ends it. */
        durationSeconds: 180
    });

    const welcome = await host.next("welcome");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    host.send("start");
    await host.next("started");

    await new Promise(resolve => setTimeout(resolve, 3300));

    host.send("board", { counts: new Array(5).fill(16) });

    /* Four of five leaves one puzzle open, so nothing ends. */
    host.send("solve", { indexes: [0, 1, 2, 3], word: "CAVING" });
    await host.next("solved");

    await assert.rejects(() => guest.next("ended", null, 800));

    /* The last one finishes the board. */
    guest.send("solve", { indexes: [4], word: "CAVERN" });

    await guest.next("ended", null, 2000);

    const over = await host.next(
        "room",
        message => message.room.phase === "over",
        2000
    );

    assert.equal(over.room.phase, "over");

    host.close();
    guest.close();
});


test("race mode runs the full clock even when a player is done", async () => {

    const host = new Client();
    await host.open();

    host.send("create", {
        name: "Host",
        variant: "blackjack",
        mode: "race",
        puzzleCount: 5,
        durationSeconds: 180
    });

    const welcome = await host.next("welcome");

    const guest = new Client();
    await guest.open();

    guest.send("join", { name: "Guest", code: welcome.room.code });
    await guest.next("welcome");

    host.send("start");
    await host.next("started");

    await new Promise(resolve => setTimeout(resolve, 3300));

    host.send("board", { counts: new Array(5).fill(16) });

    /*
        Everyone solves everything. In shared mode that would
        end the round; in race it deliberately does not, because
        each player has their own copy of the board.
    */

    host.send("solve", { indexes: [0, 1, 2, 3, 4], word: "CAVING" });
    await host.next("solved");

    guest.send("solve", { indexes: [0, 1, 2, 3, 4], word: "CAVERN" });
    await guest.next("solved");

    await assert.rejects(() => host.next("ended", null, 1500));

    host.close();
    guest.close();
});
