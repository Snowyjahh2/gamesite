# Word Spy

A real-time multiplayer party game for 3–12 players. Everyone gets a word
— except one player (the spy), who gets a similar but different word.
Players take turns giving vague clues about their word and then vote on
who they think the spy is.

Node + Express + Socket.IO backend. No external services required — just
run it and share the URL.

## How to play

1. One player opens the site and clicks **Create room**. They pick a room
   size (3–12), a discussion timer, and whether to show a category hint.
2. The game gives them a 4-character code like `A7FK`. Share it.
3. Friends open the same URL, click **Join room**, enter the code.
4. Host clicks **Start**. Each player taps their card to secretly see
   their word.
5. **Discussion phase**: timer counts down. Players take turns giving
   broad, vague clues about their word — vague enough that the spy can
   try to blend in, but specific enough that the other civilians recognise
   you're talking about the same thing.
6. **Vote**: everyone taps who they think is the spy.
7. **Results**: the spy is revealed. Civilians win +1 each if they catch
   the spy. The spy wins +2 if they escape.
8. **Next round** or **Back to lobby**.

## Deploy on Render

1. Push this repo to GitHub.
2. In the Render dashboard, click **New → Web Service**.
3. Connect your GitHub repo (`Snowyjahh2/gamesite`).
4. Fill in:
   - **Name:** anything (e.g. `word-spy`)
   - **Runtime / Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**. Render will install, boot the server,
   and give you a URL like `https://word-spy.onrender.com`.

That's it. No database, no env vars, no config — just push and play.

### Fixing an existing Render service

If you already created a Render service and it's failing with
`Could not read package.json`, go to **Settings** for the service and
make sure:

- **Build Command** = `npm install`
- **Start Command** = `npm start`
- **Publish Directory** = *(leave empty — this is a Web Service, not a
  Static Site)*

Then click **Manual Deploy → Deploy latest commit**.

### Note about Render's free tier

Render free-tier Web Services **spin down after 15 minutes of inactivity**.
The first request after that triggers a cold start of ~30–60 seconds. For
a party game that's usually fine — whoever creates the first room will
wait a bit, then everyone joins normally. If you want no cold starts,
upgrade to a paid instance (~$7/mo) or use a different host.

Also: game state is in-memory, so if the server restarts (which happens
on deploy or idle-shutdown), **active rooms are lost**. Rooms are cheap
to recreate — just have the host make a new one.

## Run locally

```sh
npm install
npm start
# open http://localhost:3000 in your browser
```

To simulate multiple players on one machine, open the URL in an incognito
window (each window gets its own socket).

## Files

- [server.js](server.js) — Express app, Socket.IO wiring, game state machine.
- [words.js](words.js) — Word pair database (~90 pairs across 15 categories). Add your own.
- [public/index.html](public/index.html) — Landing page (create/join).
- [public/room.html](public/room.html) — Game room UI (lobby/reveal/discuss/vote/results).
- [public/css/style.css](public/css/style.css) — All the visual styling.
- [public/js/index.js](public/js/index.js) — Landing page form handling.
- [public/js/room.js](public/js/room.js) — Socket.IO client and game UI logic.
- [package.json](package.json) — Dependencies and start script.
- [render.yaml](render.yaml) — Render Blueprint config (used if you deploy via Blueprint).
