/* ============================================================
   DEPLOYMENT CONFIG

   The game is served from GitHub Pages, but the room server
   needs a live Node process and so runs on Azure. That means
   the page and the socket are on two different origins.

   Both values below are worked out at load time, so there is
   no build step and `npm start` keeps working unchanged.
   ============================================================ */

"use strict";


/* The Azure app that runs server/server.js. */
const ROOM_SERVER_HOST = "caving-with-friends.azurewebsites.net";


/*
    The port `npm start` listens on. In development the page
    comes from a plain static file server on some other port,
    so the socket has to be told where the room server is.
*/
const DEV_SERVER_PORT = 8080;

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1"];


/*
    Where to open the WebSocket.

    The page is static and the room server is a live process,
    so outside of a single machine they are never on the same
    origin. On Pages the socket reaches across to Azure; in
    development it reaches across to `npm start`.
*/
export const SERVER_HOST =
    LOCAL_HOSTNAMES.includes(location.hostname)
        ? `${location.hostname}:${DEV_SERVER_PORT}`
        : ROOM_SERVER_HOST;


/*
    The directory the app is served from, with a trailing
    slash: "/caving-with-friends/" on Pages, "/" locally.

    Derived from the address rather than hardcoded, so the
    repository could be renamed without touching this file.
    Dropping everything after the last slash turns both "/x/"
    and "/x/index.html" into "/x/".
*/
export const BASE_PATH = location.pathname.replace(/[^/]*$/, "");


/*
    The address of a room, as a path.

    Everything that writes a room address goes through here —
    the share box and the address bar — so the two cannot drift
    apart. Leaving out the base path produces a link that looks
    right and 404s on Pages, which is exactly what happened
    before this existed.
*/
export function roomPath(code) {
    return `${BASE_PATH}?room=${encodeURIComponent(code)}`;
}
