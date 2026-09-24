'use strict';

import { promises as fs } from 'fs';
import path from 'path';
import type Homey from 'homey';
import toSafeJson from './safe-json';
import { buildGraph, ZigbeeState } from './zigbee-graph';

/** One "hour" of the interval. Set it to 60 * 1000 to test in minutes instead. */
export const HOUR_MS = 60 * 60 * 1000;

/** What the user can change in the visualizer's settings panel (the gear). */
export type SnapshotSettings = {
  enabled: boolean;
  /** 1, 2, 4 or 8 */
  intervalHours: number;
  /** 2 to 24 */
  keep: number;
};

export const DEFAULT_SETTINGS: SnapshotSettings = { enabled: false, intervalHours: 1, keep: 24 };

/** The intervals the user can pick from. */
export const INTERVAL_HOURS = [1, 2, 4, 8];

/** `input` as settings when every field is valid, otherwise null. */
export function toSettings(input: unknown): SnapshotSettings | null {
  const s = input as Partial<SnapshotSettings> | null;
  if (!s || typeof s.enabled !== 'boolean') return null;
  if (!INTERVAL_HOURS.includes(s.intervalHours as number)) return null;
  if (!Number.isInteger(s.keep) || (s.keep as number) < 2 || (s.keep as number) > 24) return null;
  return { enabled: s.enabled, intervalHours: s.intervalHours as number, keep: s.keep as number };
}

/** What app.ts hands the snapshots when it starts them. */
export type SnapshotOptions = {
  /** For its timers and its clock: slots follow Homey's local time. */
  homey: Homey.App['homey'];
  dir: string;
  settings: SnapshotSettings;
  getState: () => Promise<unknown>;
  log: (message: string) => void;
};

export type SnapshotInfo = {
  id: string;
  takenAt: string;
};

/** Who was whose parent in one snapshot, by IEEE address. */
export type SnapshotRoutes = SnapshotInfo & {
  /** device -> its parent, or null when the controller had no route to it */
  parents: Record<string, string | null>;
  /** every device's name, parents included */
  names: Record<string, string>;
};

/** The parents and names in one Zigbee state, as SnapshotRoutes carries them. */
function routesOf(state: ZigbeeState): Pick<SnapshotRoutes, 'parents' | 'names'> {
  const graph = buildGraph(state);
  const byAddr = new Map(graph.nodes.map((n) => [n.addr, n]));
  const parents: Record<string, string | null> = {};
  const names: Record<string, string> = {};
  graph.nodes.forEach((n) => {
    if (!n.ieeeAddr || n.isGhost) return;
    names[n.ieeeAddr] = n.name;
    if (n.isCoordinator) return;
    const parent = n.parent === undefined ? undefined : byAddr.get(n.parent);
    parents[n.ieeeAddr] = parent?.ieeeAddr ?? null;
  });
  return { parents, names };
}

// A snapshot's id is the UTC time it was taken, e.g. 2026-09-24T12-00-00Z, and
// its file is <id>.json. Sorting by name is sorting by time, so no index is needed.
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function idFor(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
}

function dateOf(id: string): Date {
  const [day, time] = id.slice(0, -1).split('T');
  return new Date(`${day}T${time.replace(/-/g, ':')}Z`);
}

/** How far into the day `date` is on the clock in `timeZone`, in ms. */
function msSinceLocalMidnight(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return ((part('hour') * 60 + part('minute')) * 60 + part('second')) * 1000 + date.getMilliseconds();
}

/** Saves the Zigbee state on every clock slot, and keeps only the newest few. */
export class Snapshots {

  private options: SnapshotOptions;

  private timer?: NodeJS.Timeout;

  /** routesOf() per snapshot id: a saved snapshot never changes, so it is worked out once. */
  private routeCache = new Map<string, Pick<SnapshotRoutes, 'parents' | 'names'>>();

  constructor(options: SnapshotOptions) {
    this.options = options;
  }

  /** Takes a snapshot now if the latest is older than one slot, then one per slot. */
  async start(): Promise<void> {
    const { dir, settings, log } = this.options;
    if (!settings.enabled) {
      log('Snapshots are off');
      return;
    }
    await fs.mkdir(dir, { recursive: true });

    const latest = (await this.list()).pop();
    const slot = settings.intervalHours * HOUR_MS;
    if (!latest || Date.now() - Date.parse(latest.takenAt) >= slot) await this.take();

    log(`Snapshots every ${settings.intervalHours} h, keeping ${settings.keep}`);
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) this.options.homey.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Every snapshot on disk, oldest first. */
  async list(): Promise<SnapshotInfo[]> {
    const names = await fs.readdir(this.options.dir).catch(() => [] as string[]);
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => ID_PATTERN.test(id))
      .sort()
      .map((id) => ({ id, takenAt: dateOf(id).toISOString() }));
  }

  /** The list plus what the page needs around it: the settings, and how long an hour is. */
  async overview(): Promise<SnapshotSettings & { hourMs: number; snapshots: SnapshotInfo[] }> {
    return { ...this.options.settings, hourMs: HOUR_MS, snapshots: await this.list() };
  }

  /**
   * Switches to new settings. A new interval clears the history, since its
   * snapshots would no longer line up; a lower `keep` trims it right away.
   */
  async update(settings: SnapshotSettings): Promise<void> {
    const { dir, log } = this.options;
    const intervalChanged = settings.intervalHours !== this.options.settings.intervalHours;
    this.stop();
    this.options.settings = settings;

    if (intervalChanged) {
      const all = await this.list();
      await Promise.all(all.map((s) => fs.unlink(path.join(dir, `${s.id}.json`))));
      if (all.length) log(`Snapshots cleared: the interval is now ${settings.intervalHours} h`);
    }
    await this.prune();
    await this.start();
  }

  /** Who was whose parent in every snapshot, oldest first. */
  async routes(): Promise<SnapshotRoutes[]> {
    const all = await this.list();
    const routes = await Promise.all(all.map(async (s) => {
      let r = this.routeCache.get(s.id);
      if (!r) {
        const json = await this.read(s.id);
        if (json === null) return null;
        r = routesOf(JSON.parse(json) as ZigbeeState);
        this.routeCache.set(s.id, r);
      }
      return { ...s, ...r };
    }));
    // Snapshots that were pruned meanwhile need no cache entry any more.
    const ids = new Set(all.map((s) => s.id));
    [...this.routeCache.keys()].filter((id) => !ids.has(id)).forEach((id) => this.routeCache.delete(id));
    return routes.filter((r): r is SnapshotRoutes => r !== null);
  }

  /** Every snapshot, parsed, oldest first. */
  async states(): Promise<Array<{ takenAt: string; state: ZigbeeState }>> {
    const all = await this.list();
    const states = await Promise.all(all.map(async (s) => {
      const json = await this.read(s.id);
      return json === null ? null : { takenAt: s.takenAt, state: JSON.parse(json) as ZigbeeState };
    }));
    return states.filter((s): s is { takenAt: string; state: ZigbeeState } => s !== null);
  }

  /** One snapshot's JSON text, or null if there is no such snapshot. */
  async read(id: string): Promise<string | null> {
    // The pattern also keeps an id like "../app" from reaching outside the folder.
    if (!ID_PATTERN.test(id)) return null;
    return fs.readFile(path.join(this.options.dir, `${id}.json`), 'utf8').catch(() => null);
  }

  private scheduleNext(): void {
    const slot = this.options.settings.intervalHours * HOUR_MS;
    let wait = slot - (msSinceLocalMidnight(new Date(), this.options.homey.clock.getTimezone()) % slot);
    // A timer can fire a moment early; don't let that turn into a second snapshot.
    if (wait < 1000) wait += slot;

    this.timer = this.options.homey.setTimeout(() => {
      this.take()
        .catch((err: Error) => this.options.log(`Snapshot failed: ${err.message}`))
        .finally(() => this.scheduleNext());
    }, wait);
  }

  private async take(): Promise<void> {
    const { dir, getState, log } = this.options;
    const id = idFor(new Date());
    const file = path.join(dir, `${id}.json`);

    // Written under a temporary name first, so a half-written file never shows up in the list.
    await fs.writeFile(`${file}.tmp`, toSafeJson(await getState()));
    await fs.rename(`${file}.tmp`, file);
    log(`Snapshot saved: ${id}`);

    await this.prune();
  }

  /** Deletes the oldest snapshots until only `keep` are left. */
  private async prune(): Promise<void> {
    const { dir, settings, log } = this.options;
    const all = await this.list();
    const extra = all.slice(0, Math.max(0, all.length - settings.keep));
    await Promise.all(extra.map((s) => fs.unlink(path.join(dir, `${s.id}.json`))));
    if (extra.length) log(`Snapshots removed: ${extra.map((s) => s.id).join(', ')}`);
  }

}
