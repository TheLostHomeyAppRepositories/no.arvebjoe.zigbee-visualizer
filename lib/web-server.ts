'use strict';

import fs from 'fs';
import http from 'http';
import path from 'path';

/** What app.ts hands the server when it starts it. */
export type WebServerOptions = {
  port: number;
  log: (message: string) => void;
  /** The raw Zigbee state, fetched fresh for every request. */
  getState: () => Promise<unknown>;
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

/** Keys that hold the network's encryption secrets; never sent to a browser. */
const SECRET_KEY = /^(network|link|tclink|trustcenterlink|preconfigured)_?key$/i;

/** Answers with the live Zigbee state, minus its secrets. */
function serveState(res: http.ServerResponse, { getState, log }: WebServerOptions) {
  getState()
    .then((state) => {
      // The replacer drops a secret key wherever it sits, without touching `state`.
      const json = JSON.stringify(state, (key, value) => (SECRET_KEY.test(key) ? undefined : value));
      send(res, 200, 'application/json; charset=utf-8', json);
    })
    .catch((err: Error) => {
      log(`Could not read the Zigbee state: ${err.message}`);
      send(res, 502, 'text/plain; charset=utf-8', 'Could not read the Zigbee state');
    });
}

/** A small web server on the local network, next to Homey's own. */
export function startWebServer(options: WebServerOptions): http.Server {
  const { port, log } = options;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    if (req.url === '/api/state') serveState(res, options);
    else serveFile(req, res);
  });

  // An unhandled 'error' event would crash the app, e.g. when the port is taken.
  server.on('error', (err) => log(`Web server error: ${err.message}`));

  server.listen(port, () => log(`Web server listening on port ${port}`));

  return server;
}
