'use strict';

import type Homey from 'homey';

/** The app instance, as far as this API surface needs it. */
type NetworkVisualizerApp = {
  getZigbeeState(): Promise<unknown>;
  getGraph(network: unknown): Promise<unknown>;
  getVisualizerUrl(): Promise<string>;
};

type ApiRequest = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
  params: Record<string, string>;
};

const app = ({ homey }: ApiRequest) => homey.app as unknown as NetworkVisualizerApp;

export default {

  /**
   * GET /api/app/no.arvebjoe.network-visualizer/state
   * The raw Zigbee network state, for inspection and export.
   */
  async getZigbeeState(request: ApiRequest) {
    return app(request).getZigbeeState();
  },

  /**
   * GET /api/app/no.arvebjoe.network-visualizer/network?network=thread
   * The graph model the settings page renders, of one network: zigbee (the
   * default), thread or zwave.
   */
  async getGraph(request: ApiRequest) {
    return app(request).getGraph(request.query.network);
  },

  /**
   * GET /api/app/no.arvebjoe.network-visualizer/visualizer
   * Where the full visualizer opens on the local network.
   */
  async getVisualizerUrl(request: ApiRequest) {
    return app(request).getVisualizerUrl();
  },

};
