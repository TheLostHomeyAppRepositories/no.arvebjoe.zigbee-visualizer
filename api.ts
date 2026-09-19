'use strict';

import type Homey from 'homey';

/** The app instance, as far as this API surface needs it. */
type ZigbeeVisualizerApp = {
  getZigbeeState(): Promise<unknown>;
};

type ApiRequest = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
  params: Record<string, string>;
};

module.exports = {

  /**
   * GET /api/app/no.arvebjoe.zigbee-visualizer/state
   * Returns the raw Zigbee network state for the settings page to render.
   */
  async getZigbeeState({ homey }: ApiRequest) {
    return (homey.app as unknown as ZigbeeVisualizerApp).getZigbeeState();
  },

};
