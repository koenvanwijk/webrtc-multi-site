// Site (publisher) app
let ws, myClientId, siteId;
let localStream;
let mediaRecorder, recChunks = [], recTimer;
let peers = new Map(); // operatorId -> { pc, senders: {video, audio}, dcState, dcTeleop }
let primaryOperatorId = null;

const els = {
  wsUrl: document.getElementById('wsUrl'),
  siteId: document.getElementById('siteId'),
  cameraSelect: document.getElementById('cameraSelect'),
  micSelect: document.getElementById('micSelect'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  localVideo: document.getElementById('localVideo'),
  recToggle: document.getElementById('recToggle'),
  recChunkSec: document.getElementById('recChunkSec'),
  recordings: document.getElementById('recordings'),
  status: document.getElementById('status'),
  attentionBtn: document.getElementById('attentionBtn'),
};

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  const mics = devices.filter(d => d.kind === 'audioinput');
  els.cameraSelect.innerHTML = cams.map(d => `<option value="${d.deviceId}">${d.label || d.deviceId}</option>`).join('');
  els.micSelect.innerHTML = mics.map(d => `<option value="${d.deviceId}">${d.label || d.deviceId}</option>`).join('');
}

async function getLocalStream() {
  const video = els.cameraSelect.value ? { deviceId: { exact: els.cameraSelect.value }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } } :
                                         { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } };
  const audio = els.micSelect.value ? { deviceId: { exact: els.micSelect.value }, echoCancellation: true, noiseSuppression: true } :
                                      { echoCancellation: true, noiseSuppression: true };
  localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
  els.localVideo.srcObject = localStream;
}

function logStatus(s) {
  els.status.textContent = s;
}

function connectWS() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(els.wsUrl.value);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => onWSMessage(ev);
  });
}

function wsSend(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function rtcConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };
}

function applyCodecPreference(pc) {
  // Prefer H264 if available
  const transceivers = pc.getTransceivers();
  for (const t of transceivers) {
    if (t.sender && t.sender.track && t.sender.track.kind === 'video') {
      const cap = RTCRtpSender.getCapabilities('video');
      if (!cap?.codecs) continue;
      const h264 = cap.codecs.filter(c => /H264/.test(c.mimeType));
      if (h264.length) t.setCodecPreferences([...h264, ...cap.codecs.filter(c => !/H264/.test(c.mimeType))]);
    }
  }
}

function highParams() {
  return [{ maxBitrate: 2_000_000, maxFramerate: 30 }];
}
function lowParams() {
  return [{ maxBitrate: 300_000, maxFramerate: 10, scaleResolutionDownBy: 2 }];
}

async function updateEncodings() {
  for (const [opId, p] of peers) {
    if (!p.senders?.video) continue;
    const params = p.senders.video.getParameters() || {};
    params.encodings = (opId === primaryOperatorId) ? highParams() : lowParams();
    try {
      await p.senders.video.setParameters(params);
    } catch (e) {
      console.warn('setParameters failed', e);
    }
  }
  logStatus(`Primary: ${primaryOperatorId || 'none'} | Peers: ${peers.size}`);
}

async function handleIncomingViewer(operatorId) {
  const pc = new RTCPeerConnection(rtcConfig());
  const p = { pc, senders: {}, dcState: null, dcTeleop: null };
  peers.set(operatorId, p);

  // Add tracks
  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    if (track.kind === 'video') p.senders.video = sender;
    if (track.kind === 'audio') p.senders.audio = sender;
  }

  // Data channels (created by site so both ends can send)
  p.dcState = pc.createDataChannel('state', { ordered: true });
  p.dcTeleop = pc.createDataChannel('teleop', { ordered: true, maxRetransmits: 0 });
  p.dcTeleop.onopen = () => console.log('teleop dc open ->', operatorId);
  p.dcTeleop.onmessage = (ev) => {
    // handle teleop controls (placeholder)
    console.log('teleop msg from', operatorId, ev.data);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice', to: operatorId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      peers.delete(operatorId);
      if (primaryOperatorId === operatorId) primaryOperatorId = null;
      updateEncodings();
    }
  };

  applyCodecPreference(pc);

  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true
  });
  await pc.setLocalDescription(offer);
  wsSend({ type: 'offer', to: operatorId, siteId, sdp: offer });
}

async function onWSMessage(ev) {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'welcome':
      myClientId = msg.clientId;
      wsSend({ type: 'hello', role: 'site', siteId });
      break;

    case 'incoming-viewer':
      await handleIncomingViewer(msg.operatorId);
      break;

    case 'answer': {
      const p = peers.get(msg.from);
      if (p) {
        await p.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await updateEncodings();
      }
      break;
    }

    case 'ice': {
      const p = peers.get(msg.from);
      if (p && msg.candidate) {
        try { await p.pc.addIceCandidate(msg.candidate); } catch {}
      }
      break;
    }

    case 'promote': {
      primaryOperatorId = msg.operatorId;
      await updateEncodings();
      // Optionally notify all via state channel
      for (const [opId, p] of peers) {
        if (p.dcState?.readyState === 'open') {
          p.dcState.send(JSON.stringify({ type: 'primary', primary: primaryOperatorId }));
        }
      }
      break;
    }
  }
}

// Recording
function toggleRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    recChunks = [];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp8,opus';
    mediaRecorder = new MediaRecorder(localStream, { mimeType: mime, bitsPerSecond: 3_000_000 });

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `${siteId}-${ts}.webm`;
      a.textContent = `Download ${a.download}`;
      els.recordings.prepend(a);
      recChunks = [];
    };

    mediaRecorder.start(); // start continuous
    const chunkSec = Math.max(5, Math.min(600, Number(els.recChunkSec.value)||120));
    recTimer = setInterval(() => {
      if (mediaRecorder?.state === 'recording') {
        mediaRecorder.stop();
        mediaRecorder.start();
      }
    }, chunkSec * 1000);

    els.recToggle.textContent = 'Stop Recording';
  } else {
    clearInterval(recTimer); recTimer = null;
    mediaRecorder.stop();
    mediaRecorder = null;
    els.recToggle.textContent = 'Start Recording';
  }
}

els.startBtn.onclick = async () => {
  siteId = (els.siteId.value || '').trim();
  if (!siteId) return alert('Set a Site ID first');
  els.startBtn.disabled = true;

  await getLocalStream();
  await connectWS();

  els.stopBtn.disabled = false;
  els.recToggle.disabled = false;
  els.attentionBtn.disabled = false;
  logStatus('Publishing. Waiting for operators...');
};

els.stopBtn.onclick = async () => {
  try { ws?.close(); } catch {}
  for (const [,p] of peers) { try { p.pc.close(); } catch {} }
  peers.clear();
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    els.localVideo.srcObject = null;
  }
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.attentionBtn.disabled = true;
  logStatus('Stopped.');
};

els.recToggle.onclick = toggleRecording;

els.attentionBtn.onclick = () => {
  wsSend({ type: 'attention' });
  els.attentionBtn.disabled = true;
  setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) els.attentionBtn.disabled = false; }, 5000);
};

async function init() {
  await listDevices();
  // update device lists when permissions granted
  navigator.mediaDevices.addEventListener('devicechange', listDevices);
}
init();
