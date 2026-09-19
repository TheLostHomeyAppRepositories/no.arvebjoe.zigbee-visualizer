'use strict';

import type Homey from 'homey';

/** The app instance, as far as this API surface needs it. */
type ZigbeeVisualizerApp = {
  getZigbeeState(): Promise<unknown>;
  getZigbeeGraph(): Promise<unknown>;
};

type ApiRequest = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
  params: Record<string, string>;
};

const app = ({ homey }: ApiRequest) => homey.app as unknown as ZigbeeVisualizerApp;

module.exports = {

  /**
   * GET /api/app/no.arvebjoe.zigbee-visualizer/state
   * The raw Zigbee network state, for inspection and export.
   */
  async getZigbeeState(request: ApiRequest) {
    return app(request).getZigbeeState();
  },

  /**
   * GET /api/app/no.arvebjoe.zigbee-visualizer/network
   * The parsed graph model the settings page renders.
   */
  async getZigbeeGraph(request: ApiRequest) {
    return app(request).getZigbeeGraph();
  },

};
