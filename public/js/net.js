/* ============================================================
   NETWORK

   One WebSocket, a message dispatcher, and reconnection.

   This file knows nothing about caving. It moves JSON in both
   directions and keeps a clock offset so every player's
   countdown agrees with the server's.
   ============================================================ */

"use strict";

import { SERVER_HOST } from "./config.js";


/*
    The seat is remembered in sessionStorage rather than
    localStorage on purpose: sessionStorage is per tab, so two
    tabs in one browser are two different players. That is what
    makes local testing possible.
*/

const SEAT_KEY = "caving-seat";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;


export class Connection {

    constructor() {

        this.socket = null;
        this.handlers = new Map();

        /* Messages typed before the socket opened. */
        this.queue = [];

        /*
            serverNow minus our own clock. Added to Date.now()
            whenever the game needs the server's idea of time.
        */
        this.clockOffset = 0;

        this.seat = this.loadSeat();

        this.attempts = 0;
        this.closedByUs = false;
    }


    /* ------------------------------------------------------
       SEAT
       ------------------------------------------------------ */

    loadSeat() {

        try {
            return JSON.parse(sessionStorage.getItem(SEAT_KEY)) || null;
        } catch {
            return null;
        }
    }


    saveSeat(seat) {

        this.seat = seat;

        try {
            sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
        } catch {
            /* Private browsing. The game still works, reloads do not. */
        }
    }


    forgetSeat() {

        this.seat = null;

        try {
            sessionStorage.removeItem(SEAT_KEY);
        } catch {
            /* Ignored. */
        }
    }


    /* ------------------------------------------------------
       CLOCK

       Every server message carries serverNow, so the offset
       stays fresh without any extra traffic.
       ------------------------------------------------------ */

    now() {
        return Date.now() + this.clockOffset;
    }


    /* ------------------------------------------------------
       EVENTS
       ------------------------------------------------------ */

    on(type, handler) {

        if (!this.handlers.has(type)) {
            this.handlers.set(type, []);
        }

        this.handlers.get(type).push(handler);
    }


    emit(type, message) {

        for (const handler of this.handlers.get(type) || []) {
            handler(message);
        }
    }


    /* ------------------------------------------------------
       CONNECT
       ------------------------------------------------------ */

    connect() {

        this.closedByUs = false;

        const protocol =
            location.protocol === "https:" ? "wss:" : "ws:";

        this.socket = new WebSocket(`${protocol}//${SERVER_HOST}`);

        this.socket.addEventListener("open", () => {

            this.attempts = 0;

            this.emit("open", {});

            /*
                A reload lands here with a seat still in
                sessionStorage. Take it back before anything
                queued goes out.
            */

            if (this.seat) {
                this.sendNow("resume", {
                    code: this.seat.code,
                    playerId: this.seat.playerId,
                    token: this.seat.token
                });
            }

            for (const pending of this.queue.splice(0)) {
                this.sendNow(pending.type, pending.payload);
            }
        });


        this.socket.addEventListener("message", event => {

            let message;

            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }

            if (typeof message.serverNow === "number") {
                this.clockOffset = message.serverNow - Date.now();
            }

            this.emit(message.type, message);
            this.emit("*", message);
        });


        this.socket.addEventListener("close", () => {

            this.emit("close", {});

            if (this.closedByUs) {
                return;
            }

            /*
                Back off, but not so far that a two minute game
                ends before the tab notices it is back.
            */

            const delay = Math.min(
                RECONNECT_MAX_MS,
                RECONNECT_BASE_MS * 2 ** this.attempts
            );

            this.attempts++;

            setTimeout(() => this.connect(), delay);
        });


        this.socket.addEventListener("error", () => {
            /* The close handler does the reconnecting. */
        });
    }


    /* ------------------------------------------------------
       SEND
       ------------------------------------------------------ */

    sendNow(type, payload = {}) {

        this.socket.send(JSON.stringify({ type: type, ...payload }));
    }


    send(type, payload = {}) {

        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.queue.push({ type: type, payload: payload });
            return;
        }

        this.sendNow(type, payload);
    }


    close() {

        this.closedByUs = true;

        if (this.socket) {
            this.socket.close();
        }
    }
}
