'use strict';

import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import { buildGraph, Graph, ZigbeeState } from './lib/zigbee-graph';
import { startWebServer } from './lib/web-server';
import {
  DEFAULT_SETTINGS, SnapshotSettings, Snapshots, toSettings,
} from './lib/snapshots';

/** The visualizer's port: 8154, after IEEE 802.15.4, the radio under Zigbee. */
const WEB_PORT = 8154;

/** Where the snapshots are kept: /userdata is the one folder an app may write to, and it survives updates. */
const SNAPSHOT_DIR = '/userdata/snapshots';

/** The key the snapshot settings are stored under in Homey's app settings. */
const SETTINGS_KEY = 'snapshots';

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

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Zigbee Visualizer has been initialized');
    startWebServer({
      port: WEB_PORT,
      log: this.log.bind(this),
      getState: () => this.getZigbeeState(),
      listSnapshots: async () => this.snapshots?.overview() ?? { snapshots: [] },
      readSnapshot: async (id) => this.snapshots?.read(id) ?? null,
      listRoutes: async () => this.snapshots?.routes() ?? [],
      saveSettings: (input) => this.saveSnapshotSettings(input),
    });

    try {
      this.log(`Visualizer: ${await this.getVisualizerUrl()}`);
    } catch (err) {
      this.log(`Could not read Homey's local address: ${(err as Error).message}`);
    }

    this.snapshots = new Snapshots({
      homey: this.homey,
      dir: SNAPSHOT_DIR,
      settings: toSettings(this.homey.settings.get(SETTINGS_KEY)) ?? DEFAULT_SETTINGS,
      getState: () => this.getZigbeeState(),
      log: this.log.bind(this),
    });
    this.snapshots.start()
      .catch((err: Error) => this.log(`Snapshots could not start: ${err.message}`));
  }

  /**
   * onUninit is called when the app is stopped or updated.
   */
  async onUninit() {
    this.snapshots?.stop();
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

  /** Validates, stores and applies new snapshot settings; null when they are not valid. */
  async saveSnapshotSettings(input: unknown): Promise<SnapshotSettings | null> {
    const settings = toSettings(input);
    if (!settings) return null;
    this.homey.settings.set(SETTINGS_KEY, settings);
    this.log(`Snapshot settings saved: ${JSON.stringify(settings)}`);
    await this.snapshots?.update(settings);
    return settings;
  }

  /** Where the visualizer opens on the local network, e.g. http://192.168.1.50:8154/. */
  async getVisualizerUrl(): Promise<string> {
    const address = await this.homey.cloud.getLocalAddress();
    return `http://${address.split(':')[0]}:${WEB_PORT}/`;
  }

};
