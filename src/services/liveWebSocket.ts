import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config/env';
import type { Db } from '../db';
import { getCompanyBySlug } from '../models/companies';
import { activeOrigins } from '../models/origins';
import { findPublicSession } from '../models/public';
import { hashToken } from '../utils/crypto';
import type { LiveBus, LiveEvent } from './liveEvents';
import { publicConversation } from './liveChat';

const reject = (socket: Socket, status: number, message: string) => {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

/** WebSocket público: autentica origen y token enviado como subprotocolo, nunca en la URL. */
export function attachLiveWebSocket(server: Server, deps: { cfg: Config; db: Db; live: LiveBus }) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => p.has('fontanachat') ? 'fontanachat' : false });
  const upgrade = async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = /^\/api\/v1\/public\/([^/]+)\/live$/.exec(url.pathname);
      if (!match) return;
      const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim());
      const token = protocols.find((value) => value.startsWith('fc-token.'))?.slice('fc-token.'.length);
      const origin = req.headers.origin?.toLowerCase();
      if (!token || !origin) return reject(socket, 401, 'Unauthorized');
      const company = await getCompanyBySlug(deps.db, decodeURIComponent(match[1]));
      if (!company?.active || !(await activeOrigins(deps.db, company.id)).includes(origin)) return reject(socket, 403, 'Forbidden');
      const session = await findPublicSession(deps.db, company.id, hashToken(deps.cfg.sessionSecret, token));
      if (!session || session.origin !== origin) return reject(socket, 401, 'Unauthorized');
      const initial = await publicConversation(deps.db, company.id, session.id);
      if (!initial.conversation) return reject(socket, 404, 'Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => {
        let off: (() => void) | null = null;
        const refresh = async (event: LiveEvent) => {
          if (event.data.conversationId !== initial.conversation!.id || ws.readyState !== WebSocket.OPEN) return;
          const snapshot = await publicConversation(deps.db, company.id, session.id);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
        };
        ws.send(JSON.stringify({ type: 'snapshot', data: initial }));
        off = deps.live.subscribe(company.id, { send: (event) => void refresh(event), close: () => ws.close(1012, 'Reinicio') });
        if (!off) ws.close(1013, 'Capacidad agotada');
        ws.on('close', () => off?.());
        ws.on('error', () => off?.());
      });
    } catch { reject(socket, 400, 'Bad Request'); }
  };
  server.on('upgrade', upgrade);
  return { close: () => { server.off('upgrade', upgrade); for (const client of wss.clients) client.close(1001, 'Servidor cerrado'); wss.close(); } };
}

