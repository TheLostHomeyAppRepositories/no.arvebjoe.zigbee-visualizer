# TODO: ideas from the community thread

Source: <https://community.homey.app/t/zigbee-network-visualizer/159739> (50 posts, read 2026-09-25).
Post numbers (#n) point back to the thread.

## Wishes we can build

### 1. Dashboard widget with the map (#4, #32)
**Done** on branch `dashboard-widget` (`widgets/network-map/`, `lib/widget-view.ts`), tested on a Homey
in light and dark mode. Left:
- The settings page still has its own copy of the radial layout; switch it to `lib/widget-view.ts`.
- Release: version bump and a `.homeychangelog.json` entry for the widget.
- Maybe later: a separate summary-only widget for small sizes.

Original notes:
Drako74 asked twice: "a widget you could add to a Dashboard to show the map", and "the map and link
quality stats on a widget". Homey SDK 3 supports app widgets (`widgets/<id>/widget.compose.json` +
`public/index.html`, which gets `Homey.api` just like the settings page), so the existing API routes can
feed it.
- A **map widget**: a smaller copy of the settings page's radial map, read-only or with tap to select.
- A **summary widget**: counts of Good / Fair / Weak / Bad / Too little traffic, stale routes, and the
  channel. Cheaper to draw and fits small widget sizes.
- Open questions: widget sizes and height, refresh interval, dark/light theme, how much of
  `settings/index.html` can be shared and how much would be copied (keep `buildGraph()` the only graph
  builder).

### 2. A device with capabilities, for Insights graphs (#32)
"A device card you could add, with a setting of Update Interval in minutes, and stats/insights for Weak,
Fair, Good, Too Little Traffic, and N° of Stale Routes … to spot trends, like at a certain time of day
interference might be causing a problem."
- A virtual "Zigbee network" driver with one device, `measure_*` number capabilities per grade and for
  stale routes, and maybe the device count and the average TX success rate.
- Insights would then log history for free, and Flows could react to it (e.g. "weak links went above 5").
- It is a big step for the app (so far there are no drivers). It overlaps with the snapshots, so maybe
  update it on the same schedule.
- Possible per-device extras: a Flow trigger "a device lost its route / got a stale route".

### 3. Zigbee channel and Wi-Fi overlap chart (#4)
"Showed the Zigbee channel in a spectrum bar chart, but in grey in the background showed the WiFi channels
that overlap (and maybe even which WiFi channel your Homey Pro/Bridge was using)."
- We already have the Zigbee channel (`Channel` in the overview). A static chart of 2.4 GHz with Wi-Fi
  channels 1–13 and Zigbee channels 11–26, with ours highlighted, is easy.
- Homey's own Wi-Fi channel: check whether the Web API exposes it (ManagerNetwork?). If not, leave it out
  or let the user enter it.
- We can't scan the spectrum, so no real interference readings, just the overlap.

### 4. Traffic overview: errors on top of messages per device (#31, #33)
**Mostly done.** DaneedeKruyff's PR (collapsible panes + traffic overview) was merged upstream and the
browser view has both (`renderTrafficTab`, `.collapsible`). Left to decide:
- The settings page has neither the traffic tab nor collapsible panes. Port them?
- Show more than the top 12, or sort by error rate as well as by TX (the "chatty device" case with the
  Ikea Vindstyrka).
- Traffic over time from the snapshots (a device that suddenly got chatty), since counters reset only at
  restart.

### 5. Collapsible legend and link-quality pane (#5)
**Done in the browser view** (see 4). Check the settings page as well.

## Bugs / questions to check

### 6. Router → end device links shown as "0 transmissions" / too little traffic (#27)
SingKT: "The website says 0 transmissions whereas the stats say rx: 11626 … Stats from routers to end
devices only the ones with values above 10k have a not dotted line … seem to consider 13123 tx as too
little traffic."
- Grade comes from the child's TX counters only (`lib/zigbee-graph.ts`, `gradeFor(successRate, tx)`,
  `MIN_SAMPLE = 30`). Check what a sleepy end device reports: maybe `tx` is 0 or missing while `rx` is large.
- Check the stroke width / dotted-line thresholds against the numbers he quotes.
- Written about the GitHub version; test the app with a dump that has the same shape.

### 7. Devices with "?" routes float unconnected (#5, #7, #12, #13, #27)
Several users see devices with no route (`?` in the developer tools) since 2–3 firmware versions. It's
Homey's data, not ours, but we could handle it better:
- Place them near the router they most likely use (last known route from a snapshot, i.e. route
  history) instead of floating, drawn as "last known" with a dashed line.
- Say plainly in the panel that Homey has no current route for it and that it may still work fine (#13).

### 8. Homey Bridge shows as offline with no children (#4, #34, #41, #43)
Drako74 and Rick_Heath both see their Bridge in satellite mode doing nothing. Check whether the Bridge
appears in the Zigbee state at all (as a router node, or not at all), and whether we could label it
("Homey Bridge") when it does. At least note it in the docs/FAQ if nothing useful can be shown.

### 9. Ghost / stale devices from failed pairings (#5, #7, #12)
We already mark stale route entries and link them to the device that most likely left them. Possible
extra: show nodes that are in the Zigbee table but not a Homey device (failed pairing, "Unknown Zigbee
device") as their own category, with a hint on how to clean them up.

## Probably not possible

### 10. Full mesh / neighbour tables (#3, #6, #14–#19)
robertklep: routers keep neighbour tables that Zigbee2MQTT queries (Mgmt_Lqi_req) to draw a true mesh;
Homey only shows one route per device. We only have what the Web API gives us. Worth checking once
whether the Zigbee state has anything neighbour-like that we ignore today; if not, explain the limitation
in the app (the "why is each router connected to only one other" question comes up again and again).

### 11. How Homey picks the route (#3)
Unknown (last used? best LQI?). Route history across snapshots could hint at it, e.g. show how often a
device changes parent. That is more insight than feature.

## Other

- DaneedeKruyff (#46) is working on more features in the GitHub version ("a preview of what I'm testing"),
  image only. Keep an eye on PRs upstream at `arvebjoe/homey-zigbee-visualizer` and port the good ones.
- Memory: Drako74 had to uninstall apps because his Homey Pro was short on memory (#45). Check how much
  memory this app uses, especially with the web server and snapshots on.
- The rest of the thread (Thread/Matter on the Bridge, INNR GU10 / ZLL problems, powering bulbs off at the
  switch) is about Zigbee in general. Only a "tips" section could help there: e.g. a note that router bulbs
  must stay powered, or a warning when a router disappears and comes back often (route history).
