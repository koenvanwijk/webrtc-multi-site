# WebRTC Multi-Site P2P (No TURN) — Operator + Backups

Minimal, production-lean template to monitor **10–16 sites** and control one primary site with **low latency**, **no SFU/MCU**, and **no TURN** (STUN-only). 
Backups watch in **low tier**, the **primary** gets **high tier**. Includes **audio** and **on-site local recording**.

> ⚠️ No TURN means some NATs will **not** connect (e.g., symmetric/CGNAT). This repo intentionally keeps infra tiny: **WebSocket signaling** + **public STUN** only.

## Repo layout

```
webrtc-multi-site-p2p/
├─ server/             # WebSocket signaling server (Node + ws)
│  ├─ package.json
│  └─ server.js
├─ site/               # Site (publisher) — browser app
│  ├─ index.html
│  ├─ site.js
│  └─ style.css
├─ operator/           # Operator (viewer/controller) — browser app
│  ├─ index.html
│  ├─ operator.js
│  └─ style.css
└─ README.md
```

## How it works (high level)

- **Site (publisher)** captures **camera + mic** in the browser and locally **records** to WebM chunks.  
- **Operator** opens a grid and **watches 10–16 sites** concurrently (low tier).  
- When the operator clicks **Promote**, the **site upgrades bitrate/fps** for that operator, and **downgrades** others to low tier.  
- **DataChannel** is provided for control (unreliable for teleop) and state (reliable).  
- **Server** is **only** used to relay SDP/ICE/control messages; **no media** flows through it.

## Quickstart

### 0) Requirements
- Node 18+ (for the signaling server).
- Chrome/Edge/Firefox for the web apps.
- HTTPS is recommended for getUserMedia; for quick local tests, use `localhost` or `chrome://flags` insecure origins for testing (not for production).

### 1) Start signaling server
```bash
cd server
npm i
npm start
# default ws://localhost:8080
```

### 2) Start static hosting for /site and /operator
Use any static file server (e.g., Python http.server in each folder), or open `index.html` directly (some browsers block camera/mic on file://).

```bash
# In site/
python3 -m http.server 8001

# In operator/
python3 -m http.server 8002
```

### 3) Open the apps

- **Site**: http://localhost:8001 — set a **Site ID** (e.g., `warehouse-1`), choose camera/mic, click **Start Publishing**.
- **Operator**: http://localhost:8002 — enter **Signaling URL** (e.g., `ws://localhost:8080`) and a comma-separated list of site IDs, then **Connect**.
- Click a tile’s ⭐ **Primary** to take control. Only the primary tile plays **audio**.

## Design choices

- **STUN-only**: By design; keeps infra tiny. Expect occasional NAT failures.
- **Tiering**: Per-connection **`RTCRtpSender.setParameters()`** on the **site** (publisher) sets **high** for the primary operator and **low** for backups.
- **Audio**: Sent to all, but **muted** on non-primary tiles at the operator UI.
- **Recording (site)**: Uses **MediaRecorder** locally (rotating chunks). Download from the **Recordings** panel.
- **Control**: DataChannel `"teleop"` (unreliable, `maxRetransmits=0`) and `"state"` (reliable).

## Security notes

- Use HTTPS in production and a proper auth/token on the signaling server.
- This demo has **no authentication** and trusts `siteId`. Add auth before deploying.

## Known limitations

- No TURN ⇒ some peers won’t connect (symmetric NAT/CGNAT). Add a TURN (e.g., coturn on 443/TCP) if you need reliability.
- MediaRecorder typically saves **WebM** (not H.264). That’s fine for local evidence/archive.
- Browser capture encoders vary; for hardware encoders and tighter control, consider a headless publisher (GStreamer `webrtcbin`) reusing the same signaling contract.

## License

MIT
