let ws, myClientId;
const peers = new Map(); // siteId -> { pc, videoEl, dcState, dcTeleop, statsTimer, primary:boolean }

const els = {
  wsUrl: document.getElementById('wsUrl'),
  sites: document.getElementById('sites'),
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  grid: document.getElementById('grid'),
  tileTmpl: document.getElementById('tileTmpl'),
};

function rtcConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };
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

function createTile(siteId) {
  const frag = els.tileTmpl.content.cloneNode(true);
  const tile = frag.querySelector('.tile');
  const label = frag.querySelector('.siteLabel'); label.textContent = siteId;
  const video = frag.querySelector('.vid');
  const primaryBtn = frag.querySelector('.primaryBtn');
  const statsBtn = frag.querySelector('.statsBtn');
  const stats = frag.querySelector('.stats');
  // add attention badge placeholder
  let badge = document.createElement('span');
  badge.className = 'attentionBadge hidden';
  badge.textContent = 'ATTN';
  tile.querySelector('.tileHeader').appendChild(badge);
  // initialize primary button visual state
  if (primaryBtn) {
    primaryBtn.textContent = '☆';
    primaryBtn.title = 'Make primary';
  }
  primaryBtn.onclick = () => promote(siteId);
  statsBtn.onclick = () => stats.classList.toggle('hidden');
  els.grid.appendChild(tile);
  return { tile, video, stats, primaryBtn, badge };
}

async function watchSite(siteId) {
  const { tile, video, stats, primaryBtn, badge } = createTile(siteId);

  const pc = new RTCPeerConnection(rtcConfig());
  const p = { pc, videoEl: video, statsEl: stats, primary: false, dcState: null, dcTeleop: null, statsTimer: null, primaryBtn: primaryBtn, badge };
  peers.set(siteId, p);

  pc.ontrack = (ev) => {
    p.videoEl.srcObject = ev.streams[0];
    p.videoEl.muted = !p.primary; // only primary audio unmuted
  };

  pc.ondatachannel = (ev) => {
    if (ev.channel.label === 'state') {
      p.dcState = ev.channel;
      p.dcState.onmessage = (e) => {
        // optional: show state messages
        // console.log('state:', siteId, e.data);
      };
    } else if (ev.channel.label === 'teleop') {
      p.dcTeleop = ev.channel;
      // Example: send a ping when channel opens
      p.dcTeleop.onopen = () => {
        p.dcTeleop.send(JSON.stringify({ type: 'hello-teleop', t: Date.now() }));
      };
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice', siteId, candidate: e.candidate });
  };

  // Keep a small stats overlay (bitrate, rtt, fps)
  p.statsTimer = setInterval(async () => {
    try {
      let inbound, candidatePair;
      const stats = await pc.getStats();
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') inbound = report;
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          candidatePair = stats.get(report.selectedCandidatePairId);
        }
      });
      const lines = [];
      if (inbound) {
        // Bereken bitrate uit bytesReceived delta
        if (typeof inbound.bytesReceived === 'number' && typeof inbound.timestamp === 'number') {
          if (p._lastInboundBytes != null && p._lastInboundTs != null) {
            const bytesDelta = inbound.bytesReceived - p._lastInboundBytes;
            const timeDeltaSec = (inbound.timestamp - p._lastInboundTs) / 1000; // timestamps in ms
            if (timeDeltaSec > 0 && bytesDelta >= 0) {
              const kbps = Math.round((bytesDelta * 8 / timeDeltaSec) / 1000);
              lines.push(`bitrate: ~${kbps} kbps`);
            }
          }
          p._lastInboundBytes = inbound.bytesReceived;
          p._lastInboundTs = inbound.timestamp;
        }
        lines.push(`frames: ${inbound.framesDecoded || 0} dropped: ${inbound.framesDropped || 0}`);
        if (inbound.jitter != null) lines.push(`jitter: ${Number(inbound.jitter).toFixed(3)}`);
      }
      if (candidatePair) {
        const rtt = candidatePair.currentRoundTripTime || candidatePair.roundTripTime;
        lines.push(`rtt: ${rtt ? Math.round(rtt*1000) : '-'} ms`);
        lines.push(`local: ${candidatePair.localCandidateId} ↔ remote: ${candidatePair.remoteCandidateId}`);
      }
      p.statsEl.textContent = lines.join('\n');
    } catch {}
  }, 1000);

  // Request watch via signaling; site will initiate offer
  wsSend({ type: 'watch', siteId });
}

function onWSMessage(ev) {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'welcome':
      myClientId = msg.clientId;
      wsSend({ type: 'hello', role: 'operator', name: `op-${myClientId.slice(0, 6)}` });
      break;

    case 'site-offline':
      console.warn('Site offline:', msg.siteId);
      break;

    case 'offer':
      // from site -> operator
      onOffer(msg.siteId, msg.sdp);
      break;

    case 'ice':
      onRemoteIce(msg.siteId, msg.candidate);
      break;

    case 'attention': {
      const p = peers.get(msg.siteId);
      if (p) {
        p.tile?.classList.add('attentionPulse');
        p.badge?.classList.remove('hidden');
        // auto clear after 10s
        clearTimeout(p._attnTimer);
        p._attnTimer = setTimeout(() => {
          p.tile?.classList.remove('attentionPulse');
          p.badge?.classList.add('hidden');
        }, 10000);
      }
      break;
    }
  }
}

async function onOffer(siteId, sdp) {
  const p = peers.get(siteId);
  if (!p) return;
  await p.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await p.pc.createAnswer();
  await p.pc.setLocalDescription(answer);
  wsSend({ type: 'answer', siteId, sdp: answer });
}

async function onRemoteIce(siteId, cand) {
  const p = peers.get(siteId);
  if (!p || !cand) return;
  try { await p.pc.addIceCandidate(cand); } catch {}
}

function promote(siteId) {
  // Make this tile primary locally (unmute) and tell the site to upgrade us & downgrade others
  for (const [sid, p] of peers) {
    p.primary = (sid === siteId);
    if (p.videoEl) p.videoEl.muted = !p.primary;
    if (p.primaryBtn) {
      p.primaryBtn.textContent = p.primary ? '★' : '☆';
      p.primaryBtn.classList.toggle('is-primary', p.primary);
      p.primaryBtn.title = p.primary ? 'Primary stream' : 'Make primary';
    }
  }
  wsSend({ type: 'promote', siteId });
}

// Optional: basic keyboard teleop mapping (sends to the current primary site's teleop DC)
document.addEventListener('keydown', (e) => {
  const primaryEntry = [...peers.entries()].find(([,p]) => p.primary);
  if (!primaryEntry) return;
  const [sid, p] = primaryEntry;
  if (p.dcTeleop?.readyState === 'open') {
    p.dcTeleop.send(JSON.stringify({ type: 'key', key: e.key, t: Date.now() }));
  }
});

els.connectBtn.onclick = async () => {
  els.connectBtn.disabled = true;
  await connectWS();
  const ids = (els.sites.value || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const id of ids) await watchSite(id);
  els.disconnectBtn.disabled = false;
};

els.disconnectBtn.onclick = async () => {
  try { ws?.close(); } catch {}
  for (const [,p] of peers) {
    try { clearInterval(p.statsTimer); } catch {}
    try { p.pc.close(); } catch {}
  }
  peers.clear();
  els.disconnectBtn.disabled = true;
  els.connectBtn.disabled = false;
};
