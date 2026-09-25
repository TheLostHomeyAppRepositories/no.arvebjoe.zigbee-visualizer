'use strict';

import type http from 'http';
import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import { buildGraph, Graph, ZigbeeState } from './lib/zigbee-graph';
import { startWebServer, urlHost } from './lib/web-server';
import {
  DEFAULT_SETTINGS, SnapshotSettings, Snapshots, toSettings,
} from './lib/snapshots';
import buildExport from './lib/export';
import { stripSecrets } from './lib/safe-json';

/** The visualizer's port: 8154, after IEEE 802.15.4, the radio under Zigbee. */
const WEB_PORT = 8154;

/** Where the snapshots are kept: /userdata is the one folder an app may write to, and it survives updates. */
const SNAPSHOT_DIR = '/userdata/snapshots';

/** The key the snapshot settings are stored under in Homey's app settings. */
const SETTINGS_KEY = 'snapshots';

/**
 * The key of the switch for the browser view, set from the settings page. The
 * view is served to anyone on the local network, without a login, so it is off
 * until the user turns it on.
 */
const WEB_SERVER_KEY = 'webServer';

/** The slice of the Web API client this app uses. */
type HomeyApiClient = {
  zigbee: {
    getState(): Promise<ZigbeeState>;
  };
};

module.exports = class ZigbeeVisualizerApp extends Homey.App {

  /** Resolves to a HomeyAPI instance; created once, reused after that. */
  private homeyApi?: Promise<HomeyApiClient>;

  /** The history of the Zigbee state; set up in onInit. */
  private snapshots?: Snapshots;

  /** The visualizer's web server, while the browser view is switched on. */
  private webServer?: http.Server;

  /** Every start or stop of the web server, in order, so switching quickly can't overlap them. */
  private webServerChange: Promise<void> = Promise.resolve();

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Zigbee Visualizer has been initialized');

    this.snapshots = new Snapshots({
      homey: this.homey,
      dir: SNAPSHOT_DIR,
      settings: toSettings(this.homey.settings.get(SETTINGS_KEY)) ?? DEFAULT_SETTINGS,
      getState: () => this.getZigbeeState(),
      log: this.log.bind(this),
    });
    this.snapshots.start()
      .catch((err: Error) => this.log(`Snapshots could not start: ${err.message}`));

    // The settings page flips the switch; the server follows it without a restart.
    const onSetting = (key: string) => {
      if (key === WEB_SERVER_KEY) this.applyWebServerSetting();
    };
    this.homey.settings.on('set', onSetting);
    this.homey.settings.on('unset', onSetting);
    this.applyWebServerSetting();
  }

  /**
   * onUninit is called when the app is stopped or updated.
   */
  async onUninit() {
    this.snapshots?.stop();
    this.webServerChange = this.webServerChange.then(() => this.closeWebServer());
    await this.webServerChange;
  }

  /** Starts or stops the web server to match its switch, once any change under way is done. */
  private applyWebServerSetting(): void {
    this.webServerChange = this.webServerChange
      .then(() => (this.homey.settings.get(WEB_SERVER_KEY) === true ? this.openWebServer() : this.closeWebServer()))
      .catch((err: Error) => this.log(`Could not switch the web server: ${err.message}`));
  }

  private async openWebServer(): Promise<void> {
    if (this.webServer) return;
    this.webServer = startWebServer({
      port: WEB_PORT,
      log: this.log.bind(this),
      getGraph: () => this.getZigbeeGraph(),
      listSnapshots: async () => this.snapshots?.overview() ?? { snapshots: [] },
      readGraph: (id) => this.getSnapshotGraph(id),
      listRoutes: async () => this.snapshots?.routes() ?? [],
      getExport: () => this.getHistoryExport(),
      saveSettings: (input) => this.saveSnapshotSettings(input),
      listImports: async () => this.snapshots?.imports() ?? [],
      importDump: (input, remember) => this.importDump(input, remember),
      deleteImport: async (id) => this.snapshots?.deleteImport(id) ?? false,
    });

    try {
      this.log(`Visualizer: ${await this.getVisualizerUrl()}`);
    } catch (err) {
      this.log(`Could not read Homey's local address: ${(err as Error).message}`);
    }
  }

  private async closeWebServer(): Promise<void> {
    const server = this.webServer;
    this.webServer = undefined;
    if (!server) return;
    // close() only stops new connections; an open keep-alive one would hold it up.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.log('Web server stopped');
  }

  /**
   * The Web API client, scoped to this app. Requires the `homey:manager:api`
   * permission — no token or login is needed, the SDK authenticates us.
   */
  private async getApi(): Promise<HomeyApiClient> {
    if (!this.homeyApi) {
      this.homeyApi = (HomeyAPI.createAppAPI({ homey: this.homey }) as Promise<HomeyApiClient>)
        .catch((err: Error) => {
          // Don't cache a failed attempt — let the next call retry.
          this.homeyApi = undefined;
          throw err;
        });
    }
    return this.homeyApi;
  }

  /**
   * The raw Zigbee network state as the controller reports it: controller
   * settings, the routing table, and every node that has joined.
   */
  async getZigbeeState(): Promise<ZigbeeState> {
    const api = await this.getApi();
    const state = await api.zigbee.getState();

    this.log(`Fetched Zigbee state: ${Object.keys(state?.nodes ?? {}).length} nodes, `
      + `${Object.keys(state?.controllerState?.routes ?? {}).length} routes`);

    return state;
  }

  /**
   * The same data as a graph: every device, the links between them, the route
   * the controller uses to reach each one, and a quality grade per hop.
   */
  async getZigbeeGraph(): Promise<Graph> {
    const graph = buildGraph(await this.getZigbeeState());

    this.log(`Built graph: ${graph.meta.deviceCount} devices, ${graph.links.length} links, `
      + `${graph.meta.weakLinkCount} weak`);

    return graph;
  }

  /** A saved snapshot or imported dump as a graph; null when there is none by that id. */
  async getSnapshotGraph(id: string): Promise<Graph | null> {
    const json = await this.snapshots?.read(id);
    return json == null ? null : buildGraph(JSON.parse(json) as ZigbeeState);
  }

  /**
   * The graph of a dump the user loaded in the browser. It is stripped of its
   * secrets first, then kept beside the snapshots when `remember` is set. Null
   * when it is not a Homey Zigbee dump.
   */
  async importDump(input: unknown, remember: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const dump = input as ZigbeeState;
    if (!dump.nodes && !dump.controllerState) return null;

    const stripped = stripSecrets(dump);
    let graph: Graph;
    try {
      graph = buildGraph(dump);
    } catch {
      return null; // shaped like a dump, but not one buildGraph can read
    }
    const saved = remember ? await this.snapshots?.saveImport(dump) : undefined;
    return { graph, stripped, id: saved?.id ?? null };
  }

  /** Validates, stores and applies new snapshot settings; null when they are not valid. */
  async saveSnapshotSettings(input: unknown): Promise<SnapshotSettings | null> {
    const settings = toSettings(input);
    if (!settings) return null;
    this.homey.settings.set(SETTINGS_KEY, settings);
    this.log(`Snapshot settings saved: ${JSON.stringify(settings)}`);
    await this.snapshots?.update(settings);
    return settings;
  }

  /** Every snapshot plus the live state, summarised for analysis, as the text of a JSON file. */
  async getHistoryExport(): Promise<string> {
    const saved = (await this.snapshots?.states()) ?? [];
    const points = [
      ...saved.map((s) => ({ ...s, live: false })),
      { takenAt: new Date().toISOString(), live: true, state: await this.getZigbeeState() },
    ];
    const { intervalHours } = toSettings(this.homey.settings.get(SETTINGS_KEY)) ?? DEFAULT_SETTINGS;
    return JSON.stringify(buildExport(points, { timezone: this.homey.clock.getTimezone(), intervalHours }), null, 2);
  }

  /** Where the visualizer opens on the local network, e.g. http://192.168.1.50:8154/. */
  async getVisualizerUrl(): Promise<string> {
    const address = await this.homey.cloud.getLocalAddress();
    return `http://${urlHost(address)}:${WEB_PORT}/`;
  }

};
