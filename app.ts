'use strict';

import Homey from 'homey';
import { HomeyAPI } from 'homey-api';

/**
 * The shape of `GET /api/manager/zigbee/state`, as far as we rely on it.
 * Everything else the controller reports is passed through untouched.
 */
export type ZigbeeState = {
  zigbee_error: string | null;
  zigbee_ready: boolean;
  zigbee_state?: { currentCommand?: string };
  controllerState?: {
    channel?: number;
    panId?: string;
    extendedPanId?: string;
    IEEEAddress?: string;
    softwareVersion?: string;
    /** networkAddress -> ordered list of relays the controller routes through */
    routes?: Record<string, number[]>;
    [key: string]: unknown;
  };
  /** ieeeAddress -> node */
  nodes?: Record<string, {
    ieeeAddr?: string;
    nwkAddr?: number;
    type?: string;
    name?: string;
    modelId?: string;
    manufacturerName?: string;
    receiveWhenIdle?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

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

};
