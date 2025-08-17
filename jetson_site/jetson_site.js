#!/usr/bin/env node
import minimist from 'minimist';
import WebSocket from 'ws';
import { RTCPeerConnection, nonstandard } from 'wrtc';

const { RTCVideoSource, RTCVideoFrame } = nonstandard;

const args = minimist(process.argv.slice(2), {
  string: ['siteId', 'signal', 'video', 'name', 'maxHigh', 'maxLow'],
  alias: { s: 'siteId', u: 'signal' },
  default: {
    signal: 'ws://localhost:8080',
    maxHigh: '2000000',
    maxLow: '300000'
  }
});

if (!args.siteId) {
  console.error('Missing --siteId');
  process.exit(1);
}

const SITE_ID = args.siteId;
const SIGNAL_URL = args.signal;
const DISPLAY_NAME = args.name || SITE_ID;
const MAX_HIGH = parseInt(args.maxHigh, 10);
const MAX_LOW = parseInt(args.maxLow, 10);

let ws;
let peers = new Map(); // operatorId -> { pc, dcState, dcTeleop, videoSender }
let primaryOperatorId = null;

// Video source (synthetic for now)
const videoSource = new RTCVideoSource();
const track = videoSource.createTrack();

// Generate synthetic frames (~10 fps)
let frameTimer = setInterval(() => {
  const width = 640, height = 360;
  const data = Buffer.alloc(width * height * 1.5, 0x80); // gray-ish
  const ts = Date.now();
  // Simple moving bar to show motion
  const barX = Math.floor((ts / 50) % width);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    if (barX < width) {
      data[rowStart + barX] = 0xff; // Y plane bright pixel
    }
  }
  videoSource.onFrame(new RTCVideoFrame(data, width, height));
}, 100);

function connectWS() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(SIGNAL_URL);
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('message', onWSMessage);
  });
}

function wsSend(msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function rtcConfig() {
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
}

async function handleIncomingViewer(operatorId) {
  const pc = new RTCPeerConnection(rtcConfig());
  const p = { pc, dcState: null, dcTeleop: null, videoSender: null };
  peers.set(operatorId, p);

  p.videoSender = pc.addTrack(track);

  p.dcState = pc.createDataChannel('state');
  p.dcTeleop = pc.createDataChannel('teleop');
  p.dcTeleop.onmessage = (ev) => {
    // placeholder teleop handling
    console.log('teleop from', operatorId, ev.data);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice', to: operatorId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      peers.delete(operatorId);
      if (primaryOperatorId === operatorId) primaryOperatorId = null;
      applyBitrates();
    }
  };

  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  wsSend({ type: 'offer', to: operatorId, siteId: SITE_ID, sdp: offer });
}

async function applyBitrates() {
  for (const [opId, p] of peers) {
    if (!p.videoSender) continue;
    try {
      const params = p.videoSender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = (opId === primaryOperatorId) ? MAX_HIGH : MAX_LOW;
      await p.videoSender.setParameters(params);
    } catch (e) {
      console.warn('setParameters failed', e.message);
    }
  }
  process.stdout.write(`Primary: ${primaryOperatorId || 'none'} | Peers: ${peers.size}\n`);
}

async function onWSMessage(data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  switch (msg.type) {
    case 'welcome':
      wsSend({ type: 'hello', role: 'site', siteId: SITE_ID, name: DISPLAY_NAME });
      break;
    case 'incoming-viewer':
      await handleIncomingViewer(msg.operatorId);
      break;
    case 'answer': {
      const p = peers.get(msg.from);
      if (p) {
        await p.pc.setRemoteDescription(msg.sdp);
        await applyBitrates();
      }
      break; }
    case 'ice': {
      const p = peers.get(msg.from);
      if (p && msg.candidate) {
        try { await p.pc.addIceCandidate(msg.candidate); } catch {}
      }
      break; }
    case 'promote':
      primaryOperatorId = msg.operatorId;
      await applyBitrates();
      // notify operators of primary change
      for (const [opId, p] of peers) {
        if (p.dcState?.readyState === 'open') {
          p.dcState.send(JSON.stringify({ type: 'primary', primary: primaryOperatorId }));
        }
      }
      break;
  }
}

(async () => {
  console.log(`Starting Jetson site client siteId=${SITE_ID} signal=${SIGNAL_URL}`);
  await connectWS();
  console.log('Connected to signaling');
})();
