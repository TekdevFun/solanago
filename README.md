# SolanaGO

Real SOL, hidden in the real world. Trading fees from the $SolanaGO coin arrive in a treasury wallet, the app hides them as drops on a map, and whoever walks to a drop gets it sent to their wallet.

This folder is the whole product: the app people open on their phones, the admin console you hide drops from, and the server behind both. There are no packages to install.

**Status.** Everything here has been run end to end on a test bench: a simulated phone walking to a drop, a pretend Solana node that checks every transaction's signature and contents, and 81 automated tests. The payout code then went through five rounds of independent review whose only job was to break it; what they found is fixed, and each fix has a test. It has **not** yet been run with real SOL on the real network, or on physical phones. Step 6 below is that test. It moves 0.05 SOL from the treasury to a wallet of your own, so all it costs is the network fee.

## What is in the folder

| Path | What it is |
| --- | --- |
| `public/` | The app (`index.html`, `app.js`, `app.css`, `tilemap.js`), the admin console (`admin.html`, `admin.js`), the play-money demo (`demo.html`), icons and the link-preview card |
| `server/` | The server: rules of the game, payouts, the web API |
| `scripts/` | `keygen.js` makes a wallet, `check.js` checks your settings before launch |
| `test/` | Automated tests (`npm test`) |
| `.env.example` | Every setting, explained |
| `Dockerfile` | For hosting |

## Try it on your computer first (no real money)

You need [Node](https://nodejs.org) 22.13 or newer.

1. Copy `.env.example` to `.env` and type any long password after `ADMIN_TOKEN=`.
2. Run `npm start`.
3. Open `http://localhost:8080/admin`, enter the password, tap the map and press **Hide batch**.
4. Open `http://localhost:8080` to see the app.

With no wallet key set, the app is in **practice mode**: the treasury holds 25 pretend SOL and payouts are pretend. Everything else behaves as it will live. Phones only share their location with sites on `https://`, so to walk a real hunt you need it hosted (step 4).

## Going live

### 1. Make the treasury wallet

This is the wallet that pays every drop. Make a new one that is used for nothing else.

- Run `npm run keygen`, or
- create a new account in Phantom and export its private key (Settings, Manage Accounts, Show Private Key).

The **secret key** goes into your host's settings in step 4 and nowhere else: not in a chat, an email, a screenshot or git. Whoever has it can empty the wallet. Keep one offline copy. Treat the wallet as a cash register and not a vault: keep in it what you plan to give away soon, and top it up as you go.

### 2. Get an RPC address

The server talks to Solana through an RPC provider. Sign up with one (Helius, QuickNode, Triton) and copy your address for **mainnet**. A free plan is enough for testing and for a small crowd. For a launch with hundreds of people on the map, take a paid plan: every payout takes about ten calls, and every open phone asks about its coins once every three minutes. The public default is slow and rate-limited and will not hold up on launch day. The provider has to be able to look up past transactions, which all the usual ones can; the start-up check in step 5 tells you if yours cannot.

### 3. Pick a map provider

Out of the box the map uses OpenStreetMap's free server. That is fine for testing, but it is not meant for a busy app and can be cut off without notice. Before launch, get a key from a map provider and set `MAP_TILE_URL`. `.env.example` shows the three lines for MapTiler.

### 4. Put it on a host

The host needs to:

- run a Docker container (or Node 22.13+),
- keep **exactly one** copy running all the time (no sleeping when idle, no second copy: two copies would each believe the treasury is theirs),
- give it a **disk that survives restarts**, attached at `/data` (the database lives there),
- hold secret settings, and serve your domain over `https://`.

Railway, Render, Fly.io or any small server with Docker will do. On Railway: put this folder in a private GitHub repository and create a project from it, or run `railway up` in this folder with Railway's command-line tool. The `Dockerfile` is picked up on its own. Add a volume with mount path `/data`, add the settings below under Variables, then attach your domain. On your own server:

```
docker build -t solanago .
docker run -d --name solanago --restart unless-stopped -p 127.0.0.1:8080:8080 -v solanago-data:/data --env-file .env solanago
```

and put Caddy or nginx in front of it for `https://`. The `127.0.0.1:` part matters: it keeps the app reachable only through that front door. Caddy passes each visitor's network address on by itself. nginx needs to be told, inside its `location` block:

```
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

If Cloudflare is in front of the site, also set `CLIENT_IP_HEADER=cf-connecting-ip`. The admin console shows a red notice at the top if the app cannot tell visitors apart, and says what to change.

Settings to enter on the host:

| Setting | Value |
| --- | --- |
| `TREASURY_SECRET_KEY` | The secret key from step 1 |
| `RPC_URL` | The address from step 2 |
| `ADMIN_TOKEN` | A long random password (30+ characters) for the admin console |
| `PUBLIC_URL` | Your site's address, for example `https://solanago.app` |
| `MAP_TILE_URL`, `MAP_ATTRIBUTION`, `MAP_ATTRIBUTION_URL` | From step 3 |
| `TOKEN_MINT` | Leave empty until the coin exists (step 7) |

Everything else has a sensible default. The full list is in `.env.example`.

The admin password guards the treasury just as the wallet key does: anyone who has it could hide a batch on their own doorstep and collect it.

### 5. Check it

When it starts, the server log should include these lines:

```
Treasury wallet: <your address>
Treasury balance: 0 SOL
The treasury wallet is empty. Send it some SOL, then restart to run the payout self-check.
```

Send the wallet **0.2 SOL** and restart. Now it should say `Wallet self-check passed`. That check signs a test payout and asks the network whether it would accept it, without sending anything. If it says `FAILED`, or that the provider cannot look up past transactions, do not hide drops; send me the line.

You can run the same checks from a terminal with the settings in `.env`: `npm run check`.

### 6. Hide your first real drop, and go get it

1. On your phone, open `https://your-site/admin` and unlock it.
2. Press **Go to my location**, set the radius to 20 m, the amount to `0.05`, and press **Hide batch**.
3. Open the app in Safari or Chrome, add a wallet address you own, pick the drop on the map and start the hunt.
4. When the camera opens, hold to claim. The SOL should be in your wallet within a few seconds, and the receipt links to the transaction.

If that works on an iPhone and an Android phone, the money path works.

### 7. Connect the coin

After you launch $SolanaGO on pump.fun, set `TOKEN_MINT` to the coin's address (the long string at the end of its pump.fun link) and restart. That switches on holder perks and the **Get $SolanaGO** button. `npm run check -- <a wallet address>` shows which tier a wallet is in.

| Tier | Holds at least | Perk |
| --- | --- | --- |
| 1 | 100,000 | Sees every batch, and can claim from it, 15 minutes before everyone else |
| 2 | 1,000,000 | Can claim holder-only (gold) drops |
| 3 | 5,000,000 | Can claim from 50 m away where everyone else needs 30 m |

Change the numbers with `TIER_LEVELS`. With a supply of 1 billion, the defaults are 0.01%, 0.1% and 0.5% of supply.

### 8. Send it the fees

The app counts **everything that arrives in the treasury wallet** as trading fees. The address is at the top of the admin console, with a Copy button.

- Simplest: claim your creator fees on pump.fun as usual, then send the share you want to give away to the treasury address. The app notices within a minute.
- If your coin uses pump.fun's fee sharing, you can add the treasury wallet as a recipient. Fees shared that way still have to be claimed by that wallet, which means importing its key into a wallet app to press Claim.

Claiming from pump.fun is the one step that is still by hand. Because every arrival is counted, a top-up from your own pocket will also show under "Trading fees collected".

### 9. Switch on the schedule

In the admin console, under **Fee drops on a schedule**: put the circle on the map over a place, give it a name, press **Add the circle on the map as a place**, repeat for every place you want, tick **Switched on**, and save. From then on, at each run, whatever is free in the treasury is split across those places and hidden. Tier 1 holders see it at once; everyone else after the head start.

## How the money moves

```
fees arrive  ->  free to hide  ->  hidden in live drops  ->  claimed (sent to hunters)
                      ^                    |
                      +--- batch ends: unfound drops go back
```

- A drop is only a record in the database until someone claims it. Hiding a batch moves no money, and ending a batch returns its unfound drops to "free to hide".
- A payout is a plain SOL transfer from the treasury to the hunter, signed by the server. The hunter never signs anything and never connects a wallet; they paste an address.
- The address has to be an ordinary wallet. If someone pastes the coin's address, a token account or a program by mistake, the app says so instead of sending SOL where it could never be got back.
- Every payout is rehearsed with the network before it is sent. If the network confirms it, the hunter sees the receipt in a second or two. If the network says no at the rehearsal, nothing was sent and the drop stays on the map.
- Once in a long while a payout is sent and the network never confirms it. The server then cannot be sure for a while whether it went through, so that drop is **held off the map for half an hour** while the server keeps asking. If the payout turns up, the drop is marked found. If not, the drop goes back on the map. This is what stops one drop being paid twice.
- `TREASURY_RESERVE_SOL` (0.02 by default) always stays in the wallet to pay network fees, about 0.000005 SOL per payout. That covers about 4,000 payouts. Raise it if you expect more than that between top-ups.
- The app shows the public the totals: fees collected, hidden, claimed, with a link to each payout's transaction.
- Do not move SOL out of the treasury while batches are live. End the batches first, or claims on them will fail.

## The admin console (`/admin`)

- **Top row:** the treasury address, what is in the wallet, what is hidden in live drops, and what is free to hide.
- **Hide a batch:** tap the map to set the centre, choose radius and amount. Drops land at random inside the circle, so keep the circle over places the public can walk. The preview shows how the amount splits into small, mid and big drops. "Holder-only share" turns that share of the mid and big drops into gold drops.
- **Batches:** what is live, how many have been found, and **End now**.
- **A red notice at the top** appears when something about the way requests reach the app needs a look, most often that the app cannot tell visitors apart. It says what is wrong and what to change. While visitors cannot be told apart, the daily allowance per network is not in force.
- **Recent claims:** wallet, amount, how far from the spot the phone said it was, GPS accuracy, and short codes for the phone and the network. The same phone or network code next to many different wallets usually means one person collecting for several.
- **Pause claims** (top right): the emergency brake. Nobody can claim while it is on. Drops and batches stay as they are.

## Cheating, and what the app does about it

Before paying, the server checks that the phone reports a position within 30 m of the drop with GPS accuracy of 65 m or better, and that it has reported a believable path for at least 20 seconds with no jumps. Each wallet and each phone gets one drop per batch, and each network address 30 paid claims a day. The server works out visitors' real network addresses by itself the first time you open the admin console through your site; on the usual hosts there is nothing to set up.

**What it cannot do:** a web page has to trust the location the phone gives it, and a technical person can feed it a fake one from their sofa. This is true of every location game on the web. Only the store apps can ask the phone to vouch for itself. So:

- Keep drops small and many. `DROP_SIZES_SOL=0.02,0.1,0.25` is a sensible launch setting.
- Put the bigger money in holder-only drops. Cheating then needs coins in every wallet.
- `MIN_WALLET_AGE_DAYS=7` refuses wallets made this week, which is what a farm of fresh wallets looks like. It also turns away real newcomers, so decide which matters more for your crowd.
- `MIN_WALLET_SOL=0.01` makes every claiming wallet hold a little SOL.
- Watch **Recent claims** in the first hours of a batch, and use **Pause claims** if something looks wrong.

Holder perks belong to the wallet that gets paid. Nobody proves they own the address they paste, so someone who types in a big holder's address sees what that holder sees, but any claim made with it pays that holder. Non-holders therefore cannot collect holder-only drops or claim during the head start. Where the early drops are is not a secret from them, though.

Perks look at what the wallet holds at the moment of the claim (the answer can be up to three minutes old). Someone can buy, claim a holder-only drop and sell again. If the coin balance cannot be checked because the RPC is failing, a claim that needs a perk is asked to try again in a moment. It is never refused as a non-holder, and it is not let through on a guess, except for a wallet that was seen holding within the last ten minutes.

The most a cheat can ever take is what you have hidden in live batches. The rest of the treasury cannot be claimed.

## Phones and browsers

- iPhone: Safari. Android: Chrome. The first hunt asks for location, then compass (iPhone calls it Motion & Orientation), then camera. If the camera is refused, the claim screen still works with a drawn background.
- Browsers inside other apps (X, Telegram, some wallet apps) often block location or the camera. If someone says it does not work, the fix is nearly always "open the link in Safari or Chrome".
- People can add it to their home screen and it opens like an app.

## Looking after it

- **Logs** say when a batch is hidden, when a payout fails and why, and when the schedule runs. A line saying a payout "was written off but the transfer landed after all; corrected" is the half-hour hold doing its job. A line asking you to check a transaction by hand means the network could not say what became of a payout for a whole day; look the signature up on Solscan.
- **Backups:** the database is a record; the money is in the wallet. Losing the database loses the list of live drops and the history, not the SOL. Copy `/data/solanago.db` now and then if you care about the history.
- **One wallet, one database.** If the server ever starts without its key, or with another wallet's key, it refuses to run on the live database and says so. Practice data is set aside by itself the first time you start with a real key.
- **Updating:** replace the files and redeploy. The disk at `/data` keeps the data.
- **Taking money out:** end the live batches, then send from the treasury with any wallet app that has its key.

## Before you promote it

I am not a lawyer; these are the things worth asking one.

- **Holder-only drops** are prizes for people who bought something. In some places that turns a free giveaway into a regulated prize promotion.
- **The name and logo** use "Solana" and its mark, which belong to the Solana Foundation. The app says it is not affiliated; that may not be enough for a commercial product.
- **Location data.** The server keeps each phone's recent positions in memory for 30 minutes. For every claim it stores the position, the wallet address, the random id the phone made for itself and a scrambled form of the network address. Say so in a short privacy note.
- **Safety.** Only place circles over public ground. People will go wherever the pin is.

## Not built yet

- Claiming fees from pump.fun automatically (step 8 is by hand).
- Players hiding their own SOL for strangers. The demo shows the idea; doing it for real needs an escrow contract, so that nobody has to trust the server with their money.
- App Store and Play Store apps, which is also what real protection against fake locations needs.

## For developers

No dependencies and no build step: Node 22.13+ with its built-in `http`, `sqlite`, `crypto` and `fetch`. Edit a file in `public/` and reload.

```
npm start         run the server (reads .env if present)
npm run dev       the same, restarting on changes
npm test          81 tests: game rules, transaction encoding, HTTP API
npm run check     check settings, RPC, wallet and coin without moving money
npm run keygen    print a new wallet
```

| File | Role |
| --- | --- |
| `server/index.js` | Start-up, background jobs (treasury watch about once a minute, payout reconciler 20 s, batch expiry and schedule 30 s) |
| `server/game.js` | Batches, drops, visibility, claims, holder tiers, fee ledger, schedule |
| `server/solana.js` | Keys, a hand-built legacy transfer transaction, send and confirm, token balances; `MockChain` for practice mode and tests |
| `server/http.js` | Static files, public API, admin API, rate limits, visitor addresses, security headers |
| `server/store.js` | SQLite schema and transactions |
| `server/geo.js`, `server/base58.js`, `server/config.js` | Helpers and settings |

API: `GET /api/config`, `GET /api/sync?lat&lng&acc&device&address`, `POST /api/claim`, `GET /api/me?address`, `GET /api/stats`, `GET /healthz`. Admin (header `Authorization: Bearer <ADMIN_TOKEN>`): `GET /api/admin/overview`, `POST /api/admin/preview`, `POST /api/admin/batches`, `POST /api/admin/batches/:id/end`, `POST /api/admin/auto`, `POST /api/admin/pause`.

How a claim stays safe:

- The drop and the hunter's one-per-batch slot are reserved in a single database transaction, together with the last checks: not paused, under the daily cap, no earlier paid claim in the batch, and the wallet covers this payout on top of every other one on its way.
- The order of a payout is: build, rehearse (`simulateTransaction`), store the signature, send, confirm. A failure before the signature is stored means nothing was sent, and the drop goes straight back on the map. Every payout is its own transaction: two equal payouts to one wallet never share a blockhash.
- After the signature is stored, only the chain's word counts. Confirmed: the claim is booked. Confirmed as failed: final, the drop goes back. Anything else (no answer, an unreadable answer, an unknown error, a refusal, the transaction's window passing unseen) leaves the outcome open: the claim is settled later by a reconciler, and if it has to be written off, the drop is held off the map for 30 minutes of second looks and released only when the chain has just answered "never happened". A written-off payout that turns out to have landed is booked, and its drop marked found.
- A repeated request from the same hunter returns the same receipt, never a second payout.
- The fee ledger compares the wallet with what the app has paid out. A wallet reading is used only if no payout started or finished while it was being fetched and it is not older, by chain slot, than the last payout booked. Money missing from the wallet is booked as an outflow except for the amount of payouts still under review.

Known limits: an RPC provider whose answers lag by more than half an hour could still get a drop paid twice, and one lagging by more than five minutes could make the fee counter book a payout as fresh fees. Visitors behind Cloudflare are told apart by `CLIENT_IP_HEADER`, which someone who reaches the host directly can forge, so lock the host to Cloudflare if you use it.

The test suite includes a pretend RPC node (`test/helpers.js`) that decodes each raw transaction independently of the code that built it and verifies the signature, so a change that breaks the encoding fails the tests instead of failing on mainnet.

Other settings not in `.env.example`: `SERVER_SECRET` (otherwise generated and kept in the database), `HOLDER_LOOKUPS_PER_MIN` (600; the ceiling on token-balance lookups made for visitors per minute), `PUBLIC_DIR`, `APP_NAME`, and `TRUST_PROXY`. That last one says how many proxies stand between visitors and the app, which decides whose entry in `X-Forwarded-For` is believed. Left alone, the server reads the number off the admin's own requests, which carry the password, so nobody else can stage one. It raises the number as soon as an admin request shows more proxies, because counting too few would make every visitor look like the proxy in front of them. It lowers the number only on an admin request that came in through the site's own address (`PUBLIC_URL`), because a look in through a side door says nothing about how visitors arrive; otherwise it shows a notice in the admin console and keeps the number it has. Set `TRUST_PROXY` by hand to fix the number, or set `0` to ignore the header altogether.
