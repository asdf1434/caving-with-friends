# Caving With Friends

A multiplayer fork of [trangium's Blackjack Caving](https://github.com/trangium/trangium.github.io/tree/master/BlackjackCaving).

Letter racks, a countdown, and words that have to contain a rack's letters.
Create a room, send friends the link, and play the same puzzles at once.

**Play it: <https://asdf1434.github.io/caving-with-friends/>**

## Running it

The game and the room server are two separate pieces, so development takes two
terminals:

```sh
npm install
npm start          # the room server, on 8080
```

```sh
npm run serve      # the game's files, on 3000
```

Then open <http://localhost:3000>. To test multiplayer on one machine, open a
second tab — seats are kept in `sessionStorage`, which is per tab, so two tabs
are two players.

`npm run serve` is Python's built-in file server, which is already on macOS and
most Linux systems. Any static server will do; the page finds the room server on
port 8080 whenever it is loaded from `localhost`, which is decided in
`public/js/config.js`.

```sh
npm test
```

runs the engine and protocol tests. The protocol tests start a real server on
port 8137 and drive it with two WebSocket clients.

## Rules

Three matching rules:

| Variant | A word matches when | Default timer |
|---|---|---|
| Blackjack | the rack's letters appear in order, gaps allowed (CVG → CAVING) | 2:00 |
| Contiguous | the rack appears as an unbroken run (CAT → SCATHING) | 1:30 |
| Anagram | the word contains the rack's letters in any order (ACT → CHART) | 2:30 |

The host picks the rule, the mode, the round length (0:30 to 3:00, in 15-second
steps), how many words a board has (5, 10, 15 or 20) and the two scoring
switches (see Scoring). All of them can be changed
between rounds, from the lobby or from the final score page, so a room can
adjust after a game instead of starting a new one. Switching the rule brings its
own round length with it. Everyone else sees the settings filled in and
disabled.

Leaving is always one button: in the lobby, in the header while a round is
running, and beside Play again on the final score page. Leaving mid-round asks
first, since it costs you that round.

Any real word counts. `words_alpha.txt` decides whether something is a word;
`CEL22.txt` is used only to choose racks and to measure how hard a puzzle is.
There is no second class of word and nothing scores zero.

Mid-round, anyone can ask for a **new board**. When everyone still connected has
asked, the round restarts with fresh puzzles and a full clock. It has to be
unanimous because a reroll wipes the scores.

## Scoring

A puzzle is worth points for being solved **early** and for being solved
**before other people**. Which word you used does not matter.

```
points = (BASE
          - RANK_PENALTY * (rank - 1)
          - TIME_PENALTY * secondsElapsed)
         * rarity

floored at MIN_POINTS
```

`rank` is 1 for the first player to solve that puzzle, 2 for the next, and so
on. `secondsElapsed` counts from the start of the round. `rarity` scales the
award by how few answers the puzzle has, so a rack with 20 possible answers is
worth several times one with 900.

Two of those terms are room settings, each a switch the host can flip:

| Setting | Off means |
|---|---|
| Score harder puzzles higher | `rarity` is 1 for every puzzle, so a hard rack pays what an easy one pays |
| Lose points as the round goes on | `TIME_PENALTY * secondsElapsed` is 0, so a solve is worth the same at 0:05 and at 2:55 |

With both off, every puzzle pays `BASE` and only rank separates the players.

With the shipped constants, a puzzle of average difficulty is worth 960 to
whoever gets it after 20 seconds, 750 to the second player at 25 seconds, and
510 to the third at 45 seconds. Rank costs more than time: being second is a
200-point penalty, which is the same as being a hundred seconds slower.

During a round, every solved card shows the arithmetic that produced its number,
so the scoring is readable while playing rather than something to take on trust.
The final board leaves it out and lists the answers instead.

Every constant lives in one `SCORING` block at the top of
`public/js/engine.js`, with a comment explaining each. Edit and restart. The
server sends its values to every client, so a room always scores consistently.
Setting `RARITY_WEIGHT` to 0 makes every puzzle worth the same for every room,
which is what the per-room difficulty toggle does for one room.

## Modes

**Race** — everyone solves their own copy of the same board, and can solve every
puzzle. Getting somewhere first is what pays. The scoreboard shows each player's
total and a dot per puzzle for their progress; nobody sees anyone else's words
until the round ends. The final board then puts everyone's answers on the same
cards.

One wrinkle: the answer list revealed at the end comes from the common list, so
it will not include an obscure word someone played. Their own card still shows
it.

**Shared** — one board for the room. The first person to solve a puzzle takes it
and nobody else can score it. Once every puzzle has been taken there is nothing
left for anyone to do, so the round ends there rather than running out a dead
clock.

Race does not end early. Every player has their own copy of the board, so one
player finishing does not mean the room has finished, and cutting the round
short would take points from everyone still typing.

## How it works

The `/daily` page upstream generates its puzzles from a hash of the date, so
every player worldwide gets the same board. This fork does the same thing with a
room seed instead of a date. Every client generates the puzzles locally from
that one integer and the room's word count, so no puzzle data crosses the
network.

```
public/js/engine.js   rules only — matching, generation, scoring
public/js/net.js      one WebSocket, dispatch, reconnect
public/js/ui.js       all DOM rendering
public/js/main.js     application state and the two mode rules
public/js/config.js   which host to open the socket on
server/server.js      room registry and message relay
```

The server holds rooms in memory, owns the clock, decides who solved each puzzle
first, and works out what that was worth. It never loads the word lists: clients
report each puzzle's answer count once, which is enough for the rarity term.

Clients decide whether a submitted word is valid. Anyone who opens devtools can
claim to have solved something, which is a deliberate trade for a game played
among friends. Rank and points are not up to them.

## Deploying

The game is hosted in two halves, because the two have different needs:

| Half | Lives at | What runs there |
|---|---|---|
| `public/` | <https://asdf1434.github.io/caving-with-friends/> | the whole game, as static files on GitHub Pages |
| `server/` | `caving-with-friends.azurewebsites.net` | the room server, as a Node process on Azure |

Puzzles are generated on every client from the room's seed, so the game itself
needs no server and can be served as plain files. Only the rooms need a live
process, and GitHub Pages has none, which is why the server stays on Azure.

Visiting the Azure address in a browser redirects to the Pages site, including
old `/ABCD` room links, which arrive as `?room=ABCD`.

`server/server.js` is a standard Node program with one dependency and no build
step. It reads `PORT` from the environment.

Two requirements come from the network rather than the game:

- **TLS.** Browsers refuse an insecure WebSocket from a page served over HTTPS.
- **One instance, never more.** Rooms live in the memory of the process that
  created them, so a second copy of the app behind a load balancer would put
  two players who typed the same room code into two different rooms.

### Azure App Service

```sh
az login
./deploy/azure.sh
```

The first run creates the resource group, the plan and the app, then uploads the
code; later runs only upload. It prints the URL when it finishes. `APP_NAME`,
`LOCATION` and `SKU` can be overridden from the environment:

```sh
APP_NAME=caving-with-friends-2 ./deploy/azure.sh
```

The name has to be unique across all of Azure, since it becomes
`<APP_NAME>.azurewebsites.net`, and that hostname comes with a certificate, so
there is nothing to configure for HTTPS.

The B1 tier is the cheapest one that will work. WebSockets and Always On are
both unavailable on the free F1 tier, and without WebSockets the game cannot
run at all.

`./deploy/azure-down.sh` deletes the whole resource group when you are done, so
an idle plan stops spending credits.

### What the platform needs from the app

| Need | Where it is handled |
|---|---|
| A port to listen on | `PORT` in the environment, defaulting to 8080 |
| A health check | `GET /health`, which returns the room count and uptime |
| Connections that survive an idle lobby | The server pings every socket every 30 seconds; see `PING_INTERVAL_MS` |

The ping matters more than it looks. Hosting platforms close connections that
have gone quiet, after 60 seconds on an AWS load balancer and around 230 on
Azure. A room waiting in the lobby sends nothing at all, so without the ping the
players would be disconnected while sitting right there. Browsers answer a ping
frame themselves, so no client code takes part.

### GitHub Pages

`.github/workflows/pages.yml` publishes `public/` on every push to `main`. It
needs no secrets: GitHub authorises the deploy with a short-lived token minted
for that run.

Pages serves static files only, which shapes two things:

- **Room links are `?room=ABCD`, not `/ABCD`.** There is no server to route an
  unknown path back to the app.
- **Nothing is generated at deploy time.** The site is `public/` exactly as it
  sits in the repository.

### Talking to the room server

The page and the socket are on different origins, so two settings matter:

| Setting | Where | Why |
|---|---|---|
| Allowed origins | `ALLOWED_ORIGINS` in `server/server.js` | The room server is reachable from anywhere, so it accepts sockets only from the Pages site and from `localhost`. Without this, any web page could open a socket and act inside a room. |
| Server address | `ROOM_SERVER_HOST` in `public/js/config.js` | Where the page looks for the room server. |

Renaming the Azure app or the repository means changing both, plus `SITE_URL`
in `server/server.js`, which is where the redirect points.

## Credits

Game design, scoring and word lists by [trangium](https://github.com/trangium).
`words_alpha.txt` comes from [dwyl/english-words](https://github.com/dwyl/english-words).
