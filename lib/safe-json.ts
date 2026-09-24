'use strict';

/** Keys that hold the network's encryption secrets; never sent or stored. */
const SECRET_KEY = /^(network|link|tclink|trustcenterlink|preconfigured)_?key$/i;

/** JSON text of `value` with every secret key left out, at any depth. */
export default function toSafeJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => (SECRET_KEY.test(key) ? undefined : v));
}
