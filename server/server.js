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
          console.log(`[site online] ${me.siteId} (${clientId}) name=${me.name || 'unnamed'}`);
        } else {
          console.log(`[client] ${clientId} role=${me.role} siteId=${me.siteId || 'none'} name=${me.name || 'unnamed'}`);
        }
        break;
      }

      case 'watch': {
        // Accept watch even if hello missing: assume operator
        if (!me.role) {
          me.role = 'operator';
          clients.set(clientId, me);
          console.log(`[auto-hello] ${clientId} assumed role=operator (watch before hello)`);
        }
        if (me.role !== 'operator') {
          send(ws, { type: 'error', error: 'not-operator' });
          return;
        }
        const siteId = msg.siteId;
        const siteClientId = sites.get(siteId);
        if (!siteClientId) {
          console.log(`[watch] ${clientId} -> site ${siteId} (OFFLINE)`);
          send(ws, { type: 'site-offline', siteId });
          return;
        }
        if (!watchers.has(siteId)) watchers.set(siteId, new Set());
        watchers.get(siteId).add(clientId);
        console.log(`[watch] ${clientId} -> site ${siteId} (${siteClientId})`);
        relay(siteClientId, { type: 'incoming-viewer', operatorId: clientId, siteId });
        break;
      }

      case 'offer': {
        // from site -> operator
        // { type:'offer', to: operatorId, siteId, sdp }
        const { to, siteId, sdp } = msg;
        console.log(`[offer] site ${clientId} (${siteId}) -> operator ${to}`);
        relay(to, { type: 'offer', siteId, from: clientId, sdp });
        break;
      }

      case 'answer': {
        // from operator -> site
        // { type:'answer', siteId, sdp }
        const siteClientId = sites.get(msg.siteId);
        if (siteClientId) {
          console.log(`[answer] operator ${clientId} -> site ${siteClientId} (${msg.siteId})`);
          relay(siteClientId, { type: 'answer', from: clientId, siteId: msg.siteId, sdp: msg.sdp });
        } else {
          console.log(`[answer] operator ${clientId} -> site ${msg.siteId} (NOT FOUND)`);
        }
        break;
      }

      case 'ice': {
        // bidirectional
        // from operator -> site: {type:'ice', siteId, candidate}
        // from site -> operator: {type:'ice', to: operatorId, candidate}
        if (me.role === 'operator') {
          const siteClientId = sites.get(msg.siteId);
          if (siteClientId) {
            console.log(`[ice] operator ${clientId} -> site ${siteClientId} (${msg.siteId})`);
            relay(siteClientId, { type: 'ice', from: clientId, candidate: msg.candidate });
          } else {
            console.log(`[ice] operator ${clientId} -> site ${msg.siteId} (NOT FOUND)`);
          }
        } else if (me.role === 'site') {
          console.log(`[ice] site ${clientId} (${me.siteId}) -> operator ${msg.to}`);
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
          console.log(`[promote] operator ${clientId} -> site ${siteClientId} (${msg.siteId})`);
          relay(siteClientId, { type: 'promote', operatorId: clientId, siteId: msg.siteId });
        } else {
          console.log(`[promote] operator ${clientId} -> site ${msg.siteId} (NOT FOUND)`);
        }
        break;
      }

      case 'bye': {
        ws.close();
        break;
      }

      case 'attention': {
        // site requests operator attention
        if (me.role === 'site' && me.siteId) {
          const ops = watchers.get(me.siteId);
            if (ops) {
              console.log(`[attention] site ${me.siteId} -> ${ops.size} operators`);
              for (const opId of ops) {
                relay(opId, { type: 'attention', siteId: me.siteId, at: Date.now() });
              }
            }
        }
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
    } else if (me?.role === 'operator') {
      // remove from all watcher sets
      for (const set of watchers.values()) set.delete(clientId);
      console.log(`[operator disconnect] ${clientId} name=${me.name || 'unnamed'}`);
    } else {
      console.log(`[client disconnect] ${clientId}`);
    }
    clients.delete(clientId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling WS server on ws://0.0.0.0:${PORT}`);
});
