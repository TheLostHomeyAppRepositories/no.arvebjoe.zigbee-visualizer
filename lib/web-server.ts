'use strict';

import fs from 'fs';
import http from 'http';
import path from 'path';
import toSafeJson from './safe-json';

/** What app.ts hands the server when it starts it. */
export type WebServerOptions = {
  port: number;
  log: (message: string) => void;
  /** The raw Zigbee state, fetched fresh for every request. */
  getState: () => Promise<unknown>;
  /** Every saved snapshot, oldest first, with the interval the page needs to label them. */
  listSnapshots: () => Promise<unknown>;
  /** One snapshot's JSON text, or null if there is no such snapshot. */
  readSnapshot: (id: string) => Promise<string | null>;
  /** Who was whose parent in every snapshot, oldest first. */
  listRoutes: () => Promise<unknown>;
  /** Validates and applies new snapshot settings; resolves to null when they are not valid. */
  saveSettings: (input: unknown) => Promise<unknown>;
};

/** The page, its styles and its scripts; web/ sits next to lib/ in the app. */
const WEB_ROOT = path.join(__dirname, '..', 'web');

/** The only file types the page is made of — anything else is a 404. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

/** Answers a request with a file from web/, and never with one outside it. */
function serveFile(req: http.IncomingMessage, res: http.ServerResponse) {
  // The page's own file names need no %-decoding, so a URL is used as it comes.
  let pathname = (req.url ?? '/').split('?')[0];
  if (pathname === '/') pathname = '/index.html';

  // path.join resolves any "..", so a path that climbs out ends up outside WEB_ROOT.
  const file = path.join(WEB_ROOT, pathname);
  const type = CONTENT_TYPES[path.extname(file)];
  if (!file.startsWith(WEB_ROOT + path.sep) || !type) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    else send(res, 200, type, data);
  });
}

/** Answers with the live Zigbee state, minus its secrets. */
function serveState(res: http.ServerResponse, { getState, log }: WebServerOptions) {
  getState()
    .then((state) => {
      send(res, 200, 'application/json; charset=utf-8', toSafeJson(state));
    })
    .catch((err: Error) => {
      log(`Could not read the Zigbee state: ${err.message}`);
      send(res, 502, 'text/plain; charset=utf-8', 'Could not read the Zigbee state');
    });
}

/** Answers with the list of snapshots, or with one snapshot when there is an id. */
function serveSnapshots(res: http.ServerResponse, id: string | undefined, options: WebServerOptions) {
  const { listSnapshots, readSnapshot, log } = options;
  const fail = (err: Error) => {
    log(`Could not read the snapshots: ${err.message}`);
    send(res, 500, 'text/plain; charset=utf-8', 'Could not read the snapshots');
  };

  if (!id) {
    listSnapshots()
      .then((list) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(list)))
      .catch(fail);
    return;
  }
  readSnapshot(id)
    .then((json) => {
      if (json === null) send(res, 404, 'text/plain; charset=utf-8', 'No such snapshot');
      else send(res, 200, 'application/json; charset=utf-8', json);
    })
    .catch(fail);
}

/** Answers with who was whose parent in every snapshot. */
function serveRoutes(res: http.ServerResponse, { listRoutes, log }: WebServerOptions) {
  listRoutes()
    .then((routes) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(routes)))
    .catch((err: Error) => {
      log(`Could not read the snapshot routes: ${err.message}`);
      send(res, 500, 'text/plain; charset=utf-8', 'Could not read the snapshot routes');
    });
}

/** Reads a small JSON request body; anything over 10 kB, or not JSON, is refused. */
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 10 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Saves new snapshot settings sent by the page, and answers with what was saved. */
function serveSettings(req: http.IncomingMessage, res: http.ServerResponse, { saveSettings, log }: WebServerOptions) {
  // Only a page on this server can send JSON here: another site's page cannot set
  // this Content-Type without a CORS preflight, which this server never approves.
  if (req.headers['content-type'] !== 'application/json') {
    send(res, 415, 'text/plain; charset=utf-8', 'Expected application/json');
    return;
  }
  readJson(req)
    .then((input) => saveSettings(input))
    .then((saved) => {
      if (saved === null) send(res, 400, 'text/plain; charset=utf-8', 'Invalid settings');
      else send(res, 200, 'application/json; charset=utf-8', JSON.stringify(saved));
    })
    .catch((err: Error) => {
      log(`Could not save the snapshot settings: ${err.message}`);
      send(res, 400, 'text/plain; charset=utf-8', 'Could not save the settings');
    });
}

/** A small web server on the local network, next to Homey's own. */
export function startWebServer(options: WebServerOptions): http.Server {
  const { port, log } = options;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/settings') {
      serveSettings(req, res, options);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    // /api/snapshots is the list, /api/snapshots/<id> is one of them.
    const snapshot = req.url?.match(/^\/api\/snapshots(?:\/([^/?]+))?$/);
    if (req.url === '/api/state') serveState(res, options);
    else if (snapshot) serveSnapshots(res, snapshot[1], options);
    else if (req.url === '/api/routes') serveRoutes(res, options);
    else serveFile(req, res);
  });

  // An unhandled 'error' event would crash the app, e.g. when the port is taken.
  server.on('error', (err) => log(`Web server error: ${err.message}`));

  server.listen(port, () => log(`Web server listening on port ${port}`));

  return server;
}
