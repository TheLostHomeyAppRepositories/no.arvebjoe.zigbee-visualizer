'use strict';

import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';

/**
 * What app.ts hands the server when it starts it. The page gets graphs, never
 * raw Zigbee state: the graph is built here, by the same code as the settings page's.
 */
export type WebServerOptions = {
  port: number;
  log: (message: string) => void;
  /** The live network as a graph, built fresh for every request. */
  getGraph: () => Promise<unknown>;
  /** Every saved snapshot, oldest first, with the interval the page needs to label them. */
  listSnapshots: () => Promise<unknown>;
  /** One snapshot or imported dump as a graph, or null if there is no such thing. */
  readGraph: (id: string) => Promise<unknown | null>;
  /** Who was whose parent in every snapshot, oldest first. */
  listRoutes: () => Promise<unknown>;
  /** Every snapshot plus the live state, summarised for analysis, as JSON text. */
  getExport: () => Promise<string>;
  /** Validates and applies new snapshot settings; resolves to null when they are not valid. */
  saveSettings: (input: unknown) => Promise<unknown>;
  /** Every imported dump kept on the Homey, oldest first. */
  listImports: () => Promise<unknown>;
  /**
   * Strips a dump the user loaded of its secrets and builds its graph, keeping
   * it when `remember` is set; resolves to null when it is not a Zigbee dump.
   */
  importDump: (input: unknown, remember: boolean) => Promise<unknown | null>;
  /** Deletes one imported dump; false when there is no such import. */
  deleteImport: (id: string) => Promise<boolean>;
};

/** The most a settings change may send. */
const SETTINGS_LIMIT = 10 * 1024;

/** The most a dump may weigh: a large network's is a few MB. */
const DUMP_LIMIT = 16 * 1024 * 1024;

/** The page, its styles and its scripts; web/ sits next to lib/ in the app. */
const WEB_ROOT = path.join(__dirname, '..', 'web');

/** The only file types the page is made of — anything else is a 404. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Top-level names no public DNS answers for, so no outside site can point one at this Homey. */
const PRIVATE_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal'];

/**
 * Whether the Host header names this server the way only the local network can:
 * an IP address, localhost, a single-label name, or a name under a private suffix.
 *
 * This is what stops DNS rebinding. A site on the internet can point its own
 * domain at this Homey's address, and the browser then treats the Homey as that
 * site: it may read every answer and POST whatever it likes. But the browser keeps
 * sending that domain in the Host header, and a public domain is never allowed here.
 */
function isLocalHost(header: string | undefined): boolean {
  if (!header) return false;
  // "[fe80::1]:8154" -> "fe80::1", "192.168.1.50:8154" -> "192.168.1.50"
  const name = (header.startsWith('[') ? header.slice(1, header.indexOf(']')) : header.replace(/:\d+$/, ''))
    .toLowerCase()
    .replace(/\.$/, '');
  if (net.isIP(name) !== 0 || name === 'localhost') return true;
  if (!name.includes('.')) return name.length > 0;
  return PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

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

/** Answers with the live network as a graph. */
function serveGraph(res: http.ServerResponse, { getGraph, log }: WebServerOptions) {
  getGraph()
    .then((graph) => {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(graph));
    })
    .catch((err: Error) => {
      log(`Could not read the Zigbee state: ${err.message}`);
      send(res, 502, 'text/plain; charset=utf-8', 'Could not read the Zigbee state');
    });
}

/** Answers with the list of snapshots, or with one snapshot's graph when there is an id. */
function serveSnapshots(res: http.ServerResponse, id: string | undefined, options: WebServerOptions) {
  const { listSnapshots, readGraph, log } = options;
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
  readGraph(id)
    .then((graph) => {
      if (graph === null) send(res, 404, 'text/plain; charset=utf-8', 'No such snapshot');
      else send(res, 200, 'application/json; charset=utf-8', JSON.stringify(graph));
    })
    .catch(fail);
}

/** Answers with the imported dumps kept on the Homey. */
function serveImports(res: http.ServerResponse, { listImports, log }: WebServerOptions) {
  listImports()
    .then((list) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(list)))
    .catch((err: Error) => {
      log(`Could not read the imports: ${err.message}`);
      send(res, 500, 'text/plain; charset=utf-8', 'Could not read the imports');
    });
}

/** Deletes one imported dump. */
function serveDeleteImport(res: http.ServerResponse, id: string, { deleteImport, log }: WebServerOptions) {
  deleteImport(id)
    .then((deleted) => {
      if (deleted) send(res, 200, 'application/json; charset=utf-8', '{}');
      else send(res, 404, 'text/plain; charset=utf-8', 'No such import');
    })
    .catch((err: Error) => {
      log(`Could not delete the import: ${err.message}`);
      send(res, 500, 'text/plain; charset=utf-8', 'Could not delete the import');
    });
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

/** Answers with the whole history, summarised, as a file to save. */
function serveExport(res: http.ServerResponse, { getExport, log }: WebServerOptions) {
  getExport()
    .then((json) => {
      const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="zigbee-history-${stamp}Z.json"`,
      });
      res.end(json);
    })
    .catch((err: Error) => {
      log(`Could not build the export: ${err.message}`);
      send(res, 500, 'text/plain; charset=utf-8', 'Could not build the export');
    });
}

/** Reads a JSON request body; anything over `limit` characters, or not JSON, is refused. */
function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
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

/**
 * Whether a POST carries JSON, answering 415 when it doesn't. Only a page on this
 * server can send JSON here: another site's page cannot set this Content-Type
 * without a CORS preflight, which this server never approves. A site that rebinds
 * its own domain to this Homey gets past that, but not past isLocalHost, which
 * already turned it away.
 */
function isJsonPost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.headers['content-type'] === 'application/json') return true;
  send(res, 415, 'text/plain; charset=utf-8', 'Expected application/json');
  return false;
}

/** Saves new snapshot settings sent by the page, and answers with what was saved. */
function serveSettings(req: http.IncomingMessage, res: http.ServerResponse, { saveSettings, log }: WebServerOptions) {
  if (!isJsonPost(req, res)) return;
  // 400 only for what the page sent; a failure on this side is a 500, so the
  // page doesn't tell the user to fix settings that were fine.
  readJson(req, SETTINGS_LIMIT).then(
    (input) => saveSettings(input).then(
      (saved) => {
        if (saved === null) send(res, 400, 'text/plain; charset=utf-8', 'Invalid settings');
        else send(res, 200, 'application/json; charset=utf-8', JSON.stringify(saved));
      },
      (err: Error) => {
        log(`Could not apply the snapshot settings: ${err.message}`);
        send(res, 500, 'text/plain; charset=utf-8', 'Could not apply the settings');
      },
    ),
    () => send(res, 400, 'text/plain; charset=utf-8', 'Expected a small JSON body'),
  );
}

/** Builds the graph of a dump the user loaded, keeping the dump when asked to. */
function serveImport(
  req: http.IncomingMessage, res: http.ServerResponse, remember: boolean, { importDump, log }: WebServerOptions,
) {
  if (!isJsonPost(req, res)) return;
  readJson(req, DUMP_LIMIT).then(
    (input) => importDump(input, remember).then(
      (result) => {
        if (result === null) send(res, 400, 'text/plain; charset=utf-8', 'That does not look like a Homey Zigbee dump');
        else send(res, 200, 'application/json; charset=utf-8', JSON.stringify(result));
      },
      (err: Error) => {
        log(`Could not import the dump: ${err.message}`);
        send(res, 500, 'text/plain; charset=utf-8', 'Could not import the dump');
      },
    ),
    () => send(res, 400, 'text/plain; charset=utf-8', 'That is not valid JSON, or it is over 16 MB'),
  );
}

/** A small web server on the local network, next to Homey's own. */
export function startWebServer(options: WebServerOptions): http.Server {
  const { port, log } = options;
  const server = http.createServer((req, res) => {
    if (!isLocalHost(req.headers.host)) {
      send(res, 403, 'text/plain; charset=utf-8', 'Open the visualizer by the Homey\'s IP address');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    // /api/snapshots is the list, /api/snapshots/<id> is one of them; the same for imports.
    const snapshot = pathname.match(/^\/api\/snapshots(?:\/([^/]+))?$/);
    const imported = pathname.match(/^\/api\/imports(?:\/([^/]+))?$/);

    if (req.method === 'POST' && pathname === '/api/settings') {
      serveSettings(req, res, options);
      return;
    }
    if (req.method === 'POST' && imported && !imported[1]) {
      serveImport(req, res, url.searchParams.get('remember') === '1', options);
      return;
    }
    if (req.method === 'DELETE' && imported?.[1]) {
      serveDeleteImport(res, imported[1], options);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    if (pathname === '/api/graph') serveGraph(res, options);
    else if (snapshot) serveSnapshots(res, snapshot[1], options);
    else if (imported?.[1]) serveSnapshots(res, imported[1], options);
    else if (imported) serveImports(res, options);
    else if (pathname === '/api/routes') serveRoutes(res, options);
    else if (pathname === '/api/export') serveExport(res, options);
    else serveFile(req, res);
  });

  // An unhandled 'error' event would crash the app, e.g. when the port is taken.
  server.on('error', (err) => log(`Web server error: ${err.message}`));

  server.listen(port, () => log(`Web server listening on port ${port}`));

  return server;
}
