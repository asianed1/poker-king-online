# POKER KING — Online

*Published by Crow New Media*

POKER KING Online is a multiplayer version of the single-player POKER KING game, for 2–8 poker
beginners anywhere in the world — or just you against the computer **Dealer** when nobody else is
around. Everyone gets five cards. On your turn you can ask for up to
three new face-up cards and swap them into your hand, and then everyone shows their hand. There
is no betting. The game explains in plain English why the winning hand won.

* One small Node.js program (`server.js`) serves the web page **and** runs the game over WebSockets.
* The server does everything that matters: it shuffles with `crypto`, deals, runs the turns and
  timers, and judges hands. Each browser only ever receives **its own** hidden cards. Other
  players' cards travel only once they are turned face up (a card taken from the table) or at the
  showdown.
* The client keeps the single-player look: a green felt table and CSS cards on a 1280×720 stage
  that scales to fit any screen. It reuses the single-player hand evaluator (`public/evaluator.js`
  is an unmodified copy).

---

## 1. Run it on your own computer

You need **Node.js 18 or newer**. Get it from <https://nodejs.org> and choose the "LTS" button.

```bash
cd poker-king-online
npm install          # downloads the one dependency (ws)
npm start            # prints: POKER KING online listening on port 3000
```

Then:

1. Open <http://localhost:3000>.
2. Type a name and press **Create a new table**.
3. Press **Copy invite link** and open that link in another browser window, such as a private or
   incognito window. Each window is a separate player.
4. Once two or more players are seated, the host (the table's creator) presses **Start game** — or, if
   you're on your own, **Play vs Dealer** to play against the computer.

You can also play with friends on the same Wi-Fi. They open `http://<your-computer's-IP>:3000`.
To play with people anywhere, deploy the game as described in section 2.

## 2. Put it on the internet for free with Render (step by step)

[Render](https://render.com) has a free plan that can host this game. You do not need to know
anything about servers.

1. **Put the code on GitHub.**
   1. Create a free account at <https://github.com>.
   2. Click **New repository**, name it `poker-king-online`, and click **Create repository**.
   3. On the new repository page, click **uploading an existing file**.
   4. Drag in **everything inside** the `poker-king-online` folder except `node_modules`. That
      includes `server.js`, `package.json`, `package-lock.json`, `render.yaml`, and the `lib`,
      `public` and `test` folders.
   5. Click **Commit changes**.

   If you know git, `git init && git add . && git commit -m "POKER KING" && git push` does the
   same thing.
2. **Create a Render account.** Go to <https://render.com> and sign up with your GitHub account.
3. **Create the web service.** You can use either option:
   * **Option A (easiest), using the Blueprint:**
     1. In the Render dashboard, click **New → Blueprint**.
     2. Pick your `poker-king-online` repository. Render reads `render.yaml` and fills in
        everything.
     3. Click **Apply**.
   * **Option B, by hand:** click **New → Web Service**, pick the repository, and set:
     * Language / Runtime: **Node**
     * Build Command: `npm install`
     * Start Command: `npm start`
     * Instance Type: **Free**
     * Advanced → Health Check Path: `/healthz` (optional)

     Then click **Create Web Service**.
4. **Wait for the first deploy.** It takes about 2–4 minutes. The log ends with
   `POKER KING online listening…` and the status turns green ("Live").
5. **Play.** Your game is at the address Render shows, for example
   `https://poker-king-online.onrender.com`. Create a table there and send the invite link to
   your friends.
6. **Update it later.** Change the files on GitHub and Render redeploys automatically.

Good to know about the free plan:

* **It sleeps.** After about 15 minutes with nobody connected, the service goes to sleep. The
  first visit after that takes 30–60 seconds while it wakes up, so open the page yourself before
  inviting friends.
* **Tables are lost on restart.** Tables live only in memory. If Render restarts or puts the
  service to sleep, open tables disappear and players just create a new one. Nothing else is
  stored.
* **Ports and HTTPS are automatic.** Render sets the `PORT` environment variable and provides
  HTTPS. The game picks both up automatically, using secure WebSockets (`wss://`) on HTTPS.

### Settings (environment variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on (Render sets this for you) |
| `TURN_SECONDS` | 45 | Time per decision. When it runs out, the player stands, or the offered card is discarded |
| `RECONNECT_SECONDS` | 60 | How long a disconnected player keeps their seat and cards |
| `DISCONNECT_TURN_GRACE_SECONDS` | 15 | If you drop during your own turn, how long the game waits before you auto-stand |
| `NEXT_HAND_SECONDS` | 40 | After a showdown, the next hand is dealt automatically if the host hasn't pressed Deal |
| `DEAL_MS` | 160 | Delay between dealt cards (animation pace) |
| `AUTO_STAND_MS` | 1500 | When the turn reaches a player who is offline, they auto-stand after this delay |

On Render, set these under **Environment** in the dashboard. Locally, run for example
`TURN_SECONDS=20 npm start`.

---

## 3. How to play

* **Lobby**
  * Enter a display name.
  * **Create a new table** gives you a 5-character code and an invite link (`…/?room=CODE`).
    Friends can open the link, or type the code and press **Join**.
  * A table holds up to 8 players. A 9th player gets a friendly "table is full" message.
* **Host**
  * The table's creator is the host and presses **Start game** once 2 or more players are seated
    (or **Play vs Dealer** when alone — see below).
  * If the host leaves, the next seated player clockwise (preferring someone online) becomes host.
  * People who join during a hand are dealt in on the next one.
* **Playing alone vs the Dealer**
  * If you're the only person at the table, the host button reads **Play vs Dealer**. It seats the
    computer **🤖 Dealer** (marked "computer") and deals straight away, just like the
    single-player game:
    * the Dealer gets 5 cards dealt alternately with yours, face down until the showdown;
    * the Dealer never draws — it always stands;
    * you get your usual 3 offers;
    * the showdown explains the result in the same beginner style ("…beats the Dealer's Pair of 7s").
  * Hands keep coming automatically while you play the Dealer.
  * Friends can still join with the invite link or code at any time. When a second person sits
    down, the current hand finishes normally and the Dealer steps aside from the next hand. If
    everyone else leaves again, **Play vs Dealer** comes back.
  * The Dealer has a row on the scoreboard while it's seated, and keeps its score if it comes
    back. It is never the host, never times out, and never takes a seat a person needs: up to 8
    people can always join.
  * The name "Dealer" is reserved for the computer (a person called Dealer becomes "Dealer 2").
  * If you lose your connection during a hand vs the Dealer, your turn auto-stands as usual and the
    hand ends normally. Your seat is held for 60 seconds.
* **Deal**
  * Every hand uses a fresh, freshly shuffled 52-card deck.
  * Cards are dealt one at a time, starting to the left of the dealer button, until everyone has
    five.
  * You only ever see your own cards.
* **Draw**
  * Players take turns clockwise, starting left of the button. The button moves one seat each
    hand.
  * On your turn you get up to **3 offers**: *"Do you want a new card? (Y/N)"*.
    * **N** means you stand.
    * **Y** turns a new card face up for everyone to see, and you go **straight to choosing**
      which of your cards to replace (the cursor starts on your first card):
      * use ← → or Tab or the mouse to choose, and Enter or click to swap the new card in;
      * or press **N** or **Esc** (or the **Reject card (N)** button) to reject the new card. It
        goes to the discards.
    * Either way, the offer counts toward your 3.
  * Each decision has a 45-second timer. Running out of time while choosing rejects the new card
    and ends your turn.
  * When the deck runs out, the discards are shuffled into a new deck, and the game announces it.
* **Showdown**
  * All hands are revealed and named, with the cards that make the hand highlighted.
  * Everyone is ranked, and the winner is explained in beginner terms, including how ties were
    broken.
  * Exact ties split the win. Suits never break ties.
  * The scoreboard counts hands won.
* **Keys**
  * **Y / N** answer the questions.
  * **H** shows or hides the hand-rankings panel. The panel marks your hand (YOU) and the
    winning hand (WIN).
  * **Enter** deals (host only).
  * Typing in the chat box never triggers game keys.
* **Chat** is below the table. Messages show the player's name in their colour and your local
  time. Messages are limited to 200 characters and 5 messages per 5 seconds. New players see the
  last 100 messages.
* **Reconnect.** If your connection drops, or you reload the page, you're back in your seat with
  the same cards as long as you return within 60 seconds.

---

## 4. Files

```
server.js            HTTP static server + WebSocket endpoint (/ws), rate limits, room registry
lib/room.js          One table: seats, host, button, dealing, turns, timers, showdown, chat
lib/cards.js         Card encoding ("Ts" = ten of spades) and crypto Fisher–Yates shuffle
lib/explain.js       Multi-way ranking + beginner explanations (uses public/evaluator.js)
public/index.html    Page layout (lobby, table, chat)
public/style.css     Green felt / CSS cards look, 1280×720 scale-to-fit stage
public/client.js     Browser client: rendering, keyboard/mouse, chat, reconnect
public/evaluator.js  Hand evaluator — unmodified copy from the single-player POKER KING
test/                unit.js, bots.js, solo.js, malicious.js, browser.js (+ helpers, reference evaluator)
screenshots/         1280×720 screenshots produced by the browser test
render.yaml          Render Blueprint
```

## 5. Tests

```bash
npm test                       # unit tests: evaluator, multi-way ranking, ties, explanations, room simulation
npm run test:bots -- 45        # real server + protocol bots: 14 tables of 2–8 players, ~45 showdowns per table
npm run test:solo -- 12        # solo vs the Dealer: 12 tables, ~12 solo showdowns each; friends join/leave mid-hand
npm run test:malicious         # hostile clients: junk/oversized/flood messages, out-of-turn, races, cleanup
# real browsers (headless Chrome via playwright-core):
mkdir -p /tmp/pw && (cd /tmp/pw && npm init -y && npm i playwright-core)
npm run test:browser -- 8      # ~60 hands across 2–8 players + solo vs Dealer; saves screenshots/ (incl. solo.png)
```

The browser test expects Chrome at `/usr/bin/google-chrome` (override with `CHROME=/path/to/chrome`), and finds playwright-core through
the `PW_PATH` environment variable (default `/tmp/pw/node_modules/playwright-core`).
