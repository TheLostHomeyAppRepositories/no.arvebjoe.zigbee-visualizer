'use strict';

import type http from 'http';
import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import { buildGraph, Graph, ZigbeeState } from './lib/zigbee-graph.js';
import { isNetworkId, NetworkId } from './lib/graph.js';
import { buildThreadGraph, ThreadInput, trimThreadInput } from './lib/thread-graph.js';
import { buildZwaveGraph, trimZwaveInput, ZwaveInput } from './lib/zwave-graph.js';
import {
  buildNetworkGraph, fetchStates, isProbe, NetworkApi, probeStates,
} from './lib/networks.js';
import { startWebServer, urlHost } from './lib/web-server.js';
import {
  DEFAULT_SETTINGS, moveSnapshots, SnapshotSettings, Snapshots, toSettings,
} from './lib/snapshots.js';
import buildExport, { ExportPoint } from './lib/export.js';
import { stripSecrets } from './lib/safe-json.js';
import buildProbe, { ProbeApi } from './lib/probe.js';

/** The visualizer's port: 8154, after IEEE 802.15.4, the radio under Zigbee. */
const WEB_PORT = 8154;

/**
 * Where the snapshots are kept, one folder per network: /userdata is the one
 * folder an app may write to, and it survives updates. Up to 1.4.0 Zigbee's were
 * in this folder itself; onInit moves them into zigbee/.
 */
const SNAPSHOT_ROOT = '/userdata/snapshots';

/** The networks that keep a history: every one there is. */
const HISTORY_NETWORKS: NetworkId[] = ['zigbee', 'thread', 'zwave'];

/** The key one network's snapshot settings are stored under in Homey's app settings. */
const settingsKey = (network: NetworkId) => `snapshots.${network}`;

/** Where every network's settings were, together, up to 1.4.0; onInit moves them. */
const LEGACY_SETTINGS_KEY = 'snapshots';

/**
 * The key of the switch for the browser view, set from the settings page. The
 * view is served to anyone on the local network, without a login, so it is off
 * until the user turns it on.
 */
const WEB_SERVER_KEY = 'webServer';

/** The slice of the Web API client this app uses. */
type HomeyApiClient = NetworkApi;

export default class NetworkVisualizerApp extends Homey.App {

  /** Resolves to a HomeyAPI instance; created once, reused after that. */
  private homeyApi?: Promise<HomeyApiClient>;

  /** Each network's history, on its own settings; Zigbee's also holds the imported dumps. Set up in onInit. */
  private histories: Partial<Record<NetworkId, Snapshots>> = {};

  /** The visualizer's web server, while the browser view is switched on. */
  private webServer?: http.Server;

  /** Every start or stop of the web server, in order, so switching quickly can't overlap them. */
  private webServerChange: Promise<void> = Promise.resolve();

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Network Visualizer has been initialized');

    this.migrateSettings();
    // Before Zigbee's history starts, so its first look at the folder finds what it had.
    await moveSnapshots(SNAPSHOT_ROOT, `${SNAPSHOT_ROOT}/zigbee`)
      .then((moved) => {
        if (moved) this.log(`Moved ${moved} Zigbee snapshots and imports into their own folder`);
      })
      .catch((err: Error) => this.log(`Could not move the Zigbee snapshots: ${err.message}`));

    const sources: Record<NetworkId, { label: string; getState: () => Promise<unknown | null> }> = {
      zigbee: { label: 'Zigbee', getState: () => this.getZigbeeState() },
      thread: { label: 'Thread', getState: () => this.getThreadSnapshotState() },
      zwave: { label: 'Z-Wave', getState: () => this.getZwaveSnapshotState() },
    };
    HISTORY_NETWORKS.forEach((network) => {
      const history = new Snapshots({
        homey: this.homey,
        dir: `${SNAPSHOT_ROOT}/${network}`,
        settings: this.snapshotSettings(network),
        getState: sources[network].getState,
        toGraph: (state) => this.snapshotGraph(network, state),
        log: (message) => this.log(`${sources[network].label}: ${message}`),
      });
      this.histories[network] = history;
      history.start().catch((err: Error) => this.log(`${sources[network].label} snapshots could not start: ${err.message}`));
    });

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
    Object.values(this.histories).forEach((history) => history.stop());
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
      getGraph: (network) => this.getGraph(network),
      listSnapshots: async (network) => this.historyOf(network)?.overview() ?? { snapshots: [] },
      readGraph: (id, network) => this.getSnapshotGraph(id, network),
      listRoutes: async (network) => this.historyOf(network)?.routes() ?? [],
      getExport: () => this.getHistoryExport(),
      saveSettings: (input, network) => this.saveSnapshotSettings(input, network),
      listImports: async () => this.histories.zigbee?.imports() ?? [],
      importDump: (input, remember) => this.importDump(input, remember),
      deleteImport: async (id) => this.histories.zigbee?.deleteImport(id) ?? false,
      getProbe: () => this.getProbe(),
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
    const state = await api.zigbee.getState() as ZigbeeState;

    this.log(`Fetched Zigbee state: ${Object.keys(state?.nodes ?? {}).length} nodes, `
      + `${Object.keys(state?.controllerState?.routes ?? {}).length} routes`);

    return state;
  }

  /**
   * One network as a graph: every device, the links between them, the route
   * Homey uses to reach each one, and a quality grade per hop. Anything that
   * isn't a network id is taken as Zigbee, as it was before there were others.
   */
  async getGraph(network: unknown = 'zigbee'): Promise<Graph> {
    const id: NetworkId = isNetworkId(network) ? network : 'zigbee';
    const graph = id === 'zigbee'
      ? buildGraph(await this.getZigbeeState())
      : buildNetworkGraph(id, await fetchStates(await this.getApi(), id));

    this.log(`Built ${id} graph: ${graph.meta.deviceCount} devices, ${graph.links.length} links, `
      + `${graph.meta.weakLinkCount} weak`);

    return graph;
  }

  /** The Zigbee network as a graph; kept for the widget and the settings page's older route. */
  async getZigbeeGraph(): Promise<Graph> {
    return this.getGraph('zigbee');
  }

  /** The history of one network; anything that isn't a network id is taken as Zigbee, which also holds the imported dumps. */
  private historyOf(network: unknown): Snapshots | undefined {
    return this.histories[isNetworkId(network) ? network : 'zigbee'];
  }

  /** One network's snapshot settings, as stored; the defaults (off) when there are none. */
  private snapshotSettings(network: NetworkId): SnapshotSettings {
    return toSettings(this.homey.settings.get(settingsKey(network))) ?? DEFAULT_SETTINGS;
  }

  /**
   * Up to 1.4.0 one set of settings drove Zigbee's and Thread's histories
   * together. Both keep them now, each as its own; Z-Wave, which kept none, starts off.
   */
  private migrateSettings(): void {
    const legacy = toSettings(this.homey.settings.get(LEGACY_SETTINGS_KEY));
    if (legacy) {
      (['zigbee', 'thread'] as NetworkId[]).forEach((network) => {
        if (this.homey.settings.get(settingsKey(network)) == null) this.homey.settings.set(settingsKey(network), legacy);
      });
      this.log(`Snapshot settings split per network: ${JSON.stringify(legacy)}`);
    }
    if (this.homey.settings.get(LEGACY_SETTINGS_KEY) != null) this.homey.settings.unset(LEGACY_SETTINGS_KEY);
  }

  /** A saved state of one network as a graph. */
  private snapshotGraph(network: NetworkId, state: unknown): Graph {
    if (network === 'thread') return buildThreadGraph(state as ThreadInput);
    if (network === 'zwave') return buildZwaveGraph(state as ZwaveInput);
    return buildGraph(state as ZigbeeState);
  }

  /**
   * The Thread & Matter state as a snapshot keeps it: cut down to what the
   * graph needs. Null on a Homey without Thread or Matter, so it keeps no
   * history of nothing.
   */
  async getThreadSnapshotState(): Promise<ThreadInput | null> {
    const { thread } = await fetchStates(await this.getApi(), 'thread');
    if (!thread || (!thread.topology?.length && !Object.keys(thread.matterNodes ?? {}).length)) return null;
    return trimThreadInput(thread);
  }

  /**
   * The Z-Wave state as a snapshot keeps it: cut down to what the graph needs.
   * Null on a Homey without Z-Wave devices.
   */
  async getZwaveSnapshotState(): Promise<ZwaveInput | null> {
    const { zwave } = await fetchStates(await this.getApi(), 'zwave');
    return zwave ? trimZwaveInput(zwave) : null;
  }

  /** A saved snapshot or imported dump as a graph; null when there is none by that id. */
  async getSnapshotGraph(id: string, network: unknown = 'zigbee'): Promise<Graph | null> {
    const json = await this.historyOf(network)?.read(id);
    if (json == null) return null;
    return this.snapshotGraph(isNetworkId(network) ? network : 'zigbee', JSON.parse(json));
  }

  /**
   * The graph of a dump the user loaded in the browser. It is stripped of its
   * secrets first, then kept beside the snapshots when `remember` is set. Null
   * when it is not a Homey Zigbee dump.
   */
  async importDump(input: unknown, remember: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (isProbe(input)) return this.importProbe(input);
    const dump = input as ZigbeeState;
    if (!dump.nodes && !dump.controllerState) return null;

    const stripped = stripSecrets(dump);
    let graph: Graph;
    try {
      graph = buildGraph(dump);
    } catch {
      return null; // shaped like a dump, but not one buildGraph can read
    }
    const saved = remember ? await this.histories.zigbee?.saveImport(dump) : undefined;
    return { graph, stripped, id: saved?.id ?? null };
  }

  /**
   * The graphs of a probe dump (lib/probe.ts), one per network in it: how a
   * Thread or Z-Wave network from someone else's Homey is looked at. A probe is
   * already stripped of its secrets, and is not kept on the Homey.
   */
  importProbe(input: object) {
    // A probe leaves secrets out already, but this one may not have come from this app.
    const stripped = stripSecrets(input);
    const states = probeStates(input);
    const graphs: Partial<Record<NetworkId, Graph>> = {};
    if (states.zigbee) graphs.zigbee = buildGraph(states.zigbee);
    if (states.thread?.topology || states.thread?.matterNodes) graphs.thread = buildNetworkGraph('thread', states);
    if (states.zwave?.state) graphs.zwave = buildNetworkGraph('zwave', states);
    return { graphs, stripped, id: null };
  }

  /** Validates, stores and applies one network's new snapshot settings; null when they are not valid. */
  async saveSnapshotSettings(input: unknown, network: unknown): Promise<SnapshotSettings | null> {
    const settings = toSettings(input);
    if (!settings || !isNetworkId(network)) return null;
    this.homey.settings.set(settingsKey(network), settings);
    this.log(`${network} snapshot settings saved: ${JSON.stringify(settings)}`);
    await this.histories[network]?.update(settings);
    return settings;
  }

  /** Every snapshot plus the live state, summarised for analysis, as the text of a JSON file. */
  async getHistoryExport(): Promise<string> {
    const saved = ((await this.histories.zigbee?.states()) ?? []) as Array<Omit<ExportPoint, 'live'>>;
    const points = [
      ...saved.map((s) => ({ ...s, live: false })),
      { takenAt: new Date().toISOString(), live: true, state: await this.getZigbeeState() },
    ];
    const { intervalHours } = this.snapshotSettings('zigbee');
    return JSON.stringify(buildExport(points, { timezone: this.homey.clock.getTimezone(), intervalHours }), null, 2);
  }

  /** Every network's raw state, secrets left out, as the text of a JSON file: see lib/probe.ts. */
  async getProbe(): Promise<string> {
    const api = (await this.getApi()) as unknown as ProbeApi;
    this.log('Building a raw network probe');
    return buildProbe(api, { appVersion: this.homey.manifest.version, homeyVersion: this.homey.version });
  }

  /** Where the visualizer opens on the local network, e.g. http://192.168.1.50:8154/. */
  async getVisualizerUrl(): Promise<string> {
    const address = await this.homey.cloud.getLocalAddress();
    return `http://${urlHost(address)}:${WEB_PORT}/`;
  }

}
