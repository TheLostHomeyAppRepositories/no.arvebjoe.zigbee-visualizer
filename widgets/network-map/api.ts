'use strict';

import type Homey from 'homey';
import type { Graph } from '../../lib/zigbee-graph.js';
import { buildWidgetView } from '../../lib/widget-view.js';

/** The app instance, as far as this widget needs it. */
type NetworkVisualizerApp = {
  getGraph(network: unknown): Promise<Graph>;
};

type WidgetRequest = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
};

export default {

  /**
   * GET /?network=thread&ghosts=1
   * One network laid out for the dashboard map: zigbee (the default), thread
   * or zwave. `ghosts=1` keeps Zigbee's stale route entries in the picture.
   */
  async getView({ homey, query }: WidgetRequest) {
    const app = homey.app as unknown as NetworkVisualizerApp;
    return buildWidgetView(await app.getGraph(query.network), { ghosts: query.ghosts === '1' });
  },

};
