'use strict';

/** Keys that hold the network's encryption secrets; never sent or stored. */
const SECRET_KEY = /^(network|link|tclink|trustcenterlink|preconfigured)_?key$/i;

/** JSON text of `value` with every secret key left out, at any depth. */
export default function toSafeJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => (SECRET_KEY.test(key) ? undefined : v));
}

/**
 * Deletes every secret key from `value` in place, at any depth, and returns the
 * names it removed: for a dump a user sends in, which may not have been redacted.
 */
export function stripSecrets(value: unknown, removed: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => stripSecrets(item, removed));
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    Object.keys(obj).forEach((key) => {
      if (SECRET_KEY.test(key)) {
        removed.push(key);
        delete obj[key];
      } else {
        stripSecrets(obj[key], removed);
      }
    });
  }
  return removed;
}
