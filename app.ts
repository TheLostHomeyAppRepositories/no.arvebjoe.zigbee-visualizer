'use strict';

import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import { buildGraph, Graph, ZigbeeState } from './lib/zigbee-graph';

/** The slice of the Web API client this app uses. */
type HomeyApiClient = {
  zigbee: {
    getState(): Promise<ZigbeeState>;
  };
};

module.exports = class ZigbeeVisualizerApp extends Homey.App {

  /** Resolves to a HomeyAPI instance; created once, reused after that. */
  private homeyApi?: Promise<HomeyApiClient>;

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Zigbee Visualizer has been initialized');
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

};
