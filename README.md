# PulseCast Adaptive

Broadcast text, images, audio and video to several simulated receivers. Each receiver gets the richest
format its (simulated) connection can carry, and the text announcement always arrives.

- **Frontend:** React 18 + Vite, plain CSS, Recharts
- **Backend:** Python FastAPI + WebSockets, Pillow for image compression
- **Optional AI:** Groq summarises long announcements and translates between English and Tamil (templates/manual editing remain available without a key)
- **QR tools:** Local text-to-QR generation; secret sharing is not part of the dashboard broadcast workflow

```
pulsecast-adaptive/
├── README.md
├── DEMO_SCRIPT.md
├── backend/
│   ├── requirements.txt
│   ├── .env.example
│   ├── app/
│   │   ├── main.py      FastAPI routes + WebSocket endpoints
│   │   ├── hub.py       receivers, per-tier delivery plans, simulated link, byte accounting
│   │   ├── tiers.py     tier thresholds and rules (single source of truth)
│   │   ├── compact.py   very-low-tier text compaction + "did the numbers survive?" check
│   │   ├── media.py     image compression (Pillow)
│   │   └── ai.py        optional Groq summariser with offline fallback
│   └── tests/test_core.py
└── frontend/
    ├── package.json, vite.config.js, index.html
    └── src/
        ├── App.jsx, main.jsx, styles.css
        ├── components/  NetworkControl, Composer, Dashboard, ReceiverPanel, SecureQrSharing, TierBadge
        ├── hooks/       useConfig, useDashboardSocket, useReceiverSocket, useRecorder
        └── lib/         tiers, format, socket, media
```

## Run it

You need Python 3.10+ and Node 18+. Use two terminals.

**Terminal 1: backend**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # optional: add GROQ_API_KEY for summaries/translations
uvicorn app.main:app --port 8000 --reload
```

**Terminal 2: frontend**

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/ws` to port 8000, so nothing else needs configuring.
Camera and microphone capture work on `localhost`; on any other host the browser requires HTTPS.

Run the backend tests (they need only Pillow, no FastAPI):

```bash
cd backend && python -m unittest discover -s tests -v
```

## How adaptation works

The master slider (and each receiver's own slider) sets a simulated capacity in kbps. The receiver reports it
over its WebSocket and the server picks a tier with a plain threshold rule (`backend/app/tiers.py`):

| Tier | Capacity | What the receiver gets |
|---|---|---|
| High | 1,000 kbps and up | Text, audio, original image, original video |
| Medium | 300 to 999 | Text, audio, image compressed to 480 px JPEG, a single compressed frame in place of the video |
| Low | 64 to 299 | Text and audio. No images, no video |
| Very low | below 64 | One compact text frame (about 160 characters). Attachments are counted but not sent |

Delivery order per receiver is: announcement text first, then audio, then image, then video. Receivers are
independent, so a slow one never delays a fast one.

**Message priorities.** The composer treats the existing announcement field as the required primary message and
also supports separately editable secondary and tertiary messages. Primary is sent first on every tier. Secondary
text is sent on medium and low tiers when enabled; tertiary text is reserved for high-tier capacity. Very-low
receivers receive only the compact primary summary, with withheld priorities reported in the receiver panel.
Priority frames are accounted for separately in live dashboard snapshots (`priority_bytes`) while aggregate byte
counts and savings remain unchanged.

**Graceful fallback.** The text frame is always sent first and on its own. After it, any media that fails is
replaced by a small `media_failed` frame with a reason, and the receiver shows the reason next to the text.
Media fails when: the "fail all media" test box is ticked, the simulated transfer would take over 20 seconds,
or the socket drops mid-delivery. A receiver whose socket drops while the server stays up reconnects with backoff and fetches any
announcements it missed as plain text from `GET /api/announcements`.

**AI configuration.** The backend always loads `backend/.env` from its own project path, so it works whether
Uvicorn is started from the repository root or from `backend/`. Set `GROQ_API_KEY` there and restart the backend.
`GET /api/config` reports only `ai_configured`/`ai_enabled` booleans and the model name; the key is never returned.
Both summarization and translation use this same backend-only key and send it as a Bearer token. Missing keys,
authentication failures, and provider failures are reported explicitly; summarization still uses the safe offline
fallback, while translation requires a reviewed template or manual text when Groq is unavailable.

**AI summary (optional).** "Summarize for very low bandwidth" calls Groq (`GROQ_MODEL`, default
`llama-3.1-8b-instant`) with a prompt that requires keeping numbers, times, places, names and actions. The
backend then checks that every number or time in the original still appears in the summary and warns about
any that do not. You can edit the summary before sending. Without a key, or if the call fails, it falls back
to a rule-based extractive summary and says so. If you send without summarising, very-low receivers get the
same extractive compaction.

## Twilio SMS notifications

The existing **Send Announcement** action keeps its local WebSocket broadcast and additionally submits the
announcement text to configured team members through the backend-only Twilio service. Configure these
variables in `backend/.env` using real local values, and never commit them:

```dotenv
TWILIO_ACCOUNT_SID=your_actual_account_sid
TWILIO_AUTH_TOKEN=your_actual_auth_token
TWILIO_PHONE_NUMBER=+15005550006
Kabil_number=+91XXXXXXXXXX
Monesh_number=+91XXXXXXXXXX
```

The variable names, including the capitalization of `Kabil_number` and `Monesh_number`, are required.
The existing `.gitignore` excludes `.env`, and no Twilio credential or phone number is sent to React.
`/api/config` reports only whether SMS is configured and the recipient display names.

The composer reports each recipient as **accepted** only when Twilio accepts the API request. This is not
the same as handset delivery; no delivery claim is shown unless a provider status callback is configured.
Missing configuration, invalid E.164 numbers, invalid credentials, provider errors, and rate limits are
reported per recipient while the local announcement remains available.

For a manual live test, which can incur Twilio charges, start the backend and frontend, configure the
real values above, enter an announcement, and click **Send Announcement** once. Automated tests mock
Twilio and do not send SMS.

## What the numbers mean

- **Bytes sent** is the UTF-8 length of every frame the server passed to `send_text`. Media travels as base64
  inside JSON, and that 33% overhead is counted. Each receiver panel also counts the bytes it received itself,
  so you can compare the two.
- **Estimated savings** compare bytes actually sent with what a high-tier receiver would have been sent for the
  same broadcasts (original media, same framing). That baseline is a counterfactual, hence "estimated".
  Only deliveries that completed are compared.
- **Bitrate** is the capacity you set on the slider. It is simulated, not measured. Each frame waits
  `size × 8 / capacity` seconds before sending (real waiting is capped at 3 s per frame to keep demos
  quick; the uncapped figure is what the receiver reports as "about N s at X kbps").
- Nothing in the dashboard is pre-filled. With no broadcasts every counter is zero.

## WebSocket and REST reference

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Tiers, slider range, limits, whether AI is enabled |
| `POST /api/broadcast` | Multipart: `text` (required), `summary`, `image`, `audio`, `video`, `poster`, `simulate_media_failure` |
| `POST /api/summarize` | `{ "text": "..." }` returns `{ summary, source, warning, missing }` |
| `GET /api/announcements?since=N` | Text-only recovery for reconnecting receivers |
| `POST /api/reset` | Zero all counters |
| `WS /ws/receiver/{id}?kbps=N` | A receiver. Send `{"type":"set_bandwidth","kbps":N}` to change capacity |
| `WS /ws/dashboard` | Live `snapshot` messages: receivers, totals, per-broadcast history |

Frames to receivers: `announcement` (text + attachment plan), `media` (base64 payload), `media_failed`, and the
compact very-low frame `{"t":"a","i":id,"m":"text","x":withheldCount}`.

## Design decisions and limits

- **Simulated receivers.** Receivers are panels in the same browser, each with its own WebSocket. The network
  is simulated by delays on the server; no real throttling happens.
- **Video is not transcoded.** As requested, adaptation is rule-based. "Occasional video frames" means the
  browser grabs one frame from the video with a canvas and the server compresses it. If the browser cannot
  decode the video, the medium tier simply skips it.
- **Uploaded and recorded clips, not live streams.** Audio and video clips record for up to 10 s at low
  bitrates (32 kbps audio, 500 kbps video).
- **Single process, in-memory state.** Restarting the backend clears stats and restarts broadcast numbering at 1, so
  keep receivers' feeds and the server in step by refreshing the page after a restart. Fine for a demo, not for production.
- **Recovery traffic is not counted** in the dashboard, since it travels over HTTP rather than the receiver socket.
- Uploads are limited to 25 MB each and announcements to 5,000 characters.

## Troubleshooting

- *"The backend is not reachable"* in the browser: start uvicorn on port 8000, then click Retry.
- *Record buttons do nothing / permission error*: allow camera and microphone for `localhost`, or upload files instead.
- *Video never shows a preview frame at medium tier*: some codecs cannot be decoded for frame capture. Try an MP4 (H.264) or WebM.
- *AI button says "Offline summary"*: set `GROQ_API_KEY` in `backend/.env` and restart uvicorn.

## Multilingual announcements

The Broadcast composer labels each announcement as English or Tamil, provides reviewed flood, cyclone,
evacuation, transport-cancellation, and public-safety templates in both languages, and can ask the
backend Groq integration to translate the current draft. Translation results remain editable until Send.
If Groq is unavailable, the composer reports the error without guessing a translation; choose a template
or enter the message manually instead. Configure the existing backend integration with `GROQ_API_KEY`
and optionally `GROQ_MODEL` in `backend/.env`. The key is never sent to the frontend.

## Targeted delivery

Use the **Send to Receivers** panel to choose exactly which simulated receivers should receive the
announcement. Select All and Deselect All are available, and the panel reports per-receiver results.
“Sent to connected receiver” confirms WebSocket transmission to that receiver; it does not claim that a
person has read the message. Offline or failed receivers are reported instead of being shown as successful.
Targeted announcements are also filtered from reconnect recovery feeds for receivers that were not selected.

## QR Code Generator

The dashboard's **QR Code Generator** is a local-only utility. Enter an announcement, URL,
short string, or code snippet and choose **Generate QR Code**. The frontend uses `qrcode.react` to create a
standard QR code locally from the exact input; no Groq call or backend request is needed. The generated canvas
can be scanned by a compatible phone or QR reader, copied as text, or downloaded as a PNG. Code is rendered
as text only and is never executed. Empty input is rejected, and content over the conservative QR capacity
limit is rejected with a size message. Physical-phone scanning depends on the phone's camera/scanner.

Beside the standard QR portal, **Enter Recipient Details** opens an independent recipient manager. Add any
number of recipients with unique IDs, then generate one QR per recipient or download individual PNGs. These
codes contain only the recipient name/ID, a browser-generated opaque access token, and a 15-minute expiry;
optional contact and demo credential fields are never encoded. Treat the recipient token as demo access data
and share real credentials through a separate trusted channel.

## Delivery visibility and missed alerts

The dashboard now includes **Adaptive Delivery Summary**, which reports the actual tier and payload choice
for each receiver using the existing simulated bandwidth thresholds. It also includes **Live Reachability**,
which separates WebSocket connection state from delivery state and shows connected, weak, disconnected,
pending, delivered, and acknowledged statuses.

If a selected receiver is offline or its connection fails during delivery, the backend queues the alert with
a bounded retry count and replays it after that receiver reconnects using the receiver's current bandwidth
tier. Recovered messages show an **Acknowledge** action in the receiver panel. The acknowledgement is an
explicit receiver event and is not inferred from connection or server-send success. Eligible recovered
messages also expose **Retry Now**. Pending queue and retry metadata are held in memory, so they are cleared
when the backend process restarts; the existing text recovery history remains bounded as before.
