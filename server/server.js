import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8080;

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

/**
 * Connections map
 * clientId -> { ws, role: 'site'|'operator', siteId?: string, name?: string }
 */
const clients = new Map();

/**
 * Active sites map
 * siteId -> siteClientId
 */
const sites = new Map();

/**
 * Watchers map (operators watching a site)
 * siteId -> Set<operatorClientId>
 */
const watchers = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function relay(toClientId, msg) {
  const target = clients.get(toClientId);
  if (target) send(target.ws, msg);
}

wss.on('connection', (ws) => {
  const clientId = randomUUID();
  clients.set(clientId, { ws });

  send(ws, { type: 'welcome', clientId });

  ws.on('message', (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const me = clients.get(clientId) || { ws };

    switch (msg.type) {
      case 'hello': {
        // { type, role: 'site'|'operator', siteId?, name? }
        me.role = msg.role;
        me.name = msg.name;
        me.siteId = msg.siteId;
        clients.set(clientId, me);

        if (me.role === 'site' && me.siteId) {
          sites.set(me.siteId, clientId);
          if (!watchers.has(me.siteId)) watchers.set(me.siteId, new Set());
          console.log(`[site online] ${me.siteId} (${clientId})`);
        } else {
          console.log(`[client] ${clientId} role=${me.role}`);
        }
        break;
      }

      case 'watch': {
        // Operator wants to watch a site
        // { type:'watch', siteId }
        if (me.role !== 'operator') return;
        const siteId = msg.siteId;
        const siteClientId = sites.get(siteId);
        if (!siteClientId) {
          send(ws, { type: 'site-offline', siteId });
          return;
        }
        if (!watchers.has(siteId)) watchers.set(siteId, new Set());
        watchers.get(siteId).add(clientId);

        relay(siteClientId, {
          type: 'incoming-viewer',
          operatorId: clientId,
          siteId,
        });
        break;
      }

      case 'offer': {
        // from site -> operator
        // { type:'offer', to: operatorId, siteId, sdp }
        const { to, siteId, sdp } = msg;
        relay(to, { type: 'offer', siteId, from: clientId, sdp });
        break;
      }

      case 'answer': {
        // from operator -> site
        // { type:'answer', siteId, sdp }
        const siteClientId = sites.get(msg.siteId);
        if (siteClientId) {
          relay(siteClientId, { type: 'answer', from: clientId, siteId: msg.siteId, sdp: msg.sdp });
        }
        break;
      }

      case 'ice': {
        // bidirectional
        // from operator -> site: {type:'ice', siteId, candidate}
        // from site -> operator: {type:'ice', to: operatorId, candidate}
        if (me.role === 'operator') {
          const siteClientId = sites.get(msg.siteId);
          if (siteClientId) relay(siteClientId, { type: 'ice', from: clientId, candidate: msg.candidate });
        } else if (me.role === 'site') {
          relay(msg.to, { type: 'ice', from: clientId, candidate: msg.candidate, siteId: me.siteId });
        }
        break;
      }

      case 'promote': {
        // operator promotes self to primary on a site
        // { type:'promote', siteId }
        if (me.role !== 'operator') return;
        const siteClientId = sites.get(msg.siteId);
        if (siteClientId) {
          relay(siteClientId, { type: 'promote', operatorId: clientId, siteId: msg.siteId });
        }
        break;
      }

      case 'bye': {
        ws.close();
        break;
      }
    }
  });

  ws.on('close', () => {
    const me = clients.get(clientId);
    if (me?.role === 'site' && me.siteId) {
      sites.delete(me.siteId);
      watchers.delete(me.siteId);
      console.log(`[site offline] ${me.siteId} (${clientId})`);
    } else {
      // remove from all watcher sets
      for (const set of watchers.values()) set.delete(clientId);
    }
    clients.delete(clientId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling WS server on ws://0.0.0.0:${PORT}`);
});
