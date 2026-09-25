'use strict';

import type Homey from 'homey';
import type { Graph } from '../../lib/zigbee-graph';
import { buildWidgetView } from '../../lib/widget-view';

/** The app instance, as far as this widget needs it. */
type ZigbeeVisualizerApp = {
  getZigbeeGraph(): Promise<Graph>;
};

type WidgetRequest = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
};

module.exports = {

  /**
   * GET /?ghosts=1
   * The network laid out for the dashboard map. `ghosts=1` keeps the stale
   * route entries in the picture.
   */
  async getView({ homey, query }: WidgetRequest) {
    const app = homey.app as unknown as ZigbeeVisualizerApp;
    return buildWidgetView(await app.getZigbeeGraph(), { ghosts: query.ghosts === '1' });
  },

};
