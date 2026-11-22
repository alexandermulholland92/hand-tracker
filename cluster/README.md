# Pi Cluster

Your Raspberry Pis in one place, over Tailscale: how each one is doing, its camera rig, its updates
and its jobs. Each Pi runs Pi Cluster's service (`node/`). The **Pi Cluster** app shows them all.
It's an app of its own, built from Hand Tracker's code, on page `pi-cluster.html`:
- **Windows, Mac and Linux:** `scripts/dist.js --app cluster`.
- **Android:** the `cluster` flavor.
- **iPhone:** `scripts/ios-variant.js … cluster`.

The phones reach the Pis through the app's own Cluster plugin, `ClusterPlugin.java` on Android and
`RemoteLink.swift` on the iPhone (Tailscale has to be on). A phone finds the Pis by asking the
ones it knows; the first time, it asks the one called `pi`, or one named under **Add a Pi**. On a
phone, a job's results come as one zip in Downloads (the Files app on an iPhone).

**In a browser:** each Pi serves the same page itself, at `http://pi:47830/` (any Pi's name or
Tailscale address, port 47830). It works in any browser on a phone or computer signed in to your
Tailscale, and does everything the app does.
- **Who gets in:** your own Tailscale account only, as with the app. Anyone else, and anything not
  on Tailscale, is turned away.
- **Through one Pi:** the page asks the Pi it came from. That Pi passes the page's requests for the
  other Pis on to them (`X-HT-Cluster-To`), but only to Pis on your Tailscale.
- **A job's results** come as one zip, saved in the browser's downloads through a one-time link
  (`/api/ticket`, then `/api/download`). The link works once, for two minutes, from that device.
- **Kept safe from other websites:** another site's page can't use the service, because the page's
  requests carry the app's header and only the Pi's own page can send that. The page never opens
  inside another site's page either (`frame-ancestors 'none'`).
- **Where the page's files come from:** `pi-cluster.html` and the few files it loads, copied beside
  the service in `web/` by its update. The first update to a version that serves the page is done by
  the root helper from before it, so the service then has its new root helper fetch them for its own
  version (`ht-cluster-root page`).

**This phone's apps** (phones only), from GitHub's **Latest build**, the release the Pis update from:
- **Android:** Pi Cluster and this phone's other Hand Tracker apps (Hand Tracker, Hand Mouse, Remote
  Recording, Recording Converter) update by themselves.
  - **When:** usually within a few hours of a new build, on Wi-Fi (a build is over 200 MB), even while Pi Cluster
    is closed (`AppUpdateJob.java`). Pi Cluster updates itself only while it isn't open.
  - **Not while the phone records:** nothing updates while it's recording or saving a take (cameras
    on alone don't hold it). Hand Tracker and Remote Recording say so (the page every 30 seconds
    meanwhile, `remote-record-ui.js`; `AppStateProvider.java`, which only Hand Tracker's own apps may
    ask).
  - **Update** does it now, and **Install** puts on an app that isn't on the phone yet.
  - A notice at the top names the apps that have a newer build.
  - Each APK is checked against GitHub's size and SHA-256, then installed through Android's
    PackageInstaller (`AppUpdates.java`, `AppUpdatePlugin.java`). With **Update**, Pi Cluster updates
    itself last, and closes then.
  - **Android asks first:** once to allow Pi Cluster to install apps, and before it updates an app it
    didn't install itself, or installs one. Until then, those apps wait for **Update**, with a
    notification once for each build. From Android 12, an app Pi Cluster installed updates without
    asking after that.
  - Each app's build is in its manifest (`com.handtracker.build`, the GitHub commit it was made from;
    `android/app/build.gradle`). An app from before that shows as "an older build".
- **iPhone:** an app can't install apps there, so only a notice that a newer build is out (one with
  Pi Cluster's iPhone app in it). Installing it stays with AltServer. The page knows its own build
  from the meta tag `scripts/build-web.js` writes.

## Putting a Pi in

You need Raspberry Pi OS (64-bit) with Tailscale installed and logged in to your account. Then, on the
Pi, from your own account (not root):

```bash
curl -fsSL https://raw.githubusercontent.com/alexandermulholland92/hand-tracker/main/cluster/setup.sh | sudo bash
```

The Pi shows in the Pi Cluster app within a minute. To take it out again, unplug it and press
**Forget** in the app, or remove the service:

```bash
curl -fsSL https://raw.githubusercontent.com/alexandermulholland92/hand-tracker/main/cluster/setup.sh | sudo bash -s -- --remove
```

Pis come and go freely. A Pi that's unplugged, out of battery or off the Wi-Fi stays in the app,
faded, until it's back.

## Modules

Every module can be turned on or off for each Pi in the app (under ⚙), and has its own settings
for that Pi.

- **Health** (`modules/health.py`): reports
  - processor use and temperature, memory and drives
  - Wi-Fi signal and band
  - the supply voltage, and the firmware's under-voltage and heat flags
  - power: wall or battery. A PiSugar reports this through pisugar-server; otherwise the Pi's
    **Power** setting says.
- **Camera rig** (`modules/rig.py`): the Pi's Hand Tracker, reached through its remote recording
  server. It shows:
  - the build, cameras, recording and Sentry
  - **Start** and **Restart** Hand Tracker
  - Sentry on and off
- **Updates** (`modules/updates.py`): keeps the Pi up to date by itself. Each part has its own
  switch and its own "now" button.
  - **Hand Tracker:** the newest build from GitHub's
    [Latest build](https://github.com/alexandermulholland92/hand-tracker/releases/tag/latest-build),
    within about 10 minutes of it coming out. It waits while Hand Tracker is recording or saving a
    take. Afterwards Hand Tracker restarts, and Sentry comes back on if it was on.
  - **This service:** the same build's `cluster/node`; the service then restarts itself.
  - **Raspberry Pi OS:** apt's updates (never removing a package), checked every 6 hours. These also
    wait while Hand Tracker records. If they need a restart, the app says so with **Restart this
    Pi**; the Pi is never restarted by itself.

- **Fixes** (`modules/fixes.py`): the Raspberry Pi fixes in `pi/`, put on a Pi from the app. Each
  has its own switch for each Pi (under ⚙). They're all off on a Pi until switched on there; one
  that's already on a Pi (put in by hand) shows on, and isn't run again until a newer build changes
  its script.
  - **Wi-Fi recovery** (`pi/wifi-watchdog.sh`): the Wi-Fi chip's driver reloaded when the chip
    locks up, and the Pi restarted if that doesn't bring it back.
  - **Tailscale recovery** (`pi/tailscale-watchdog.sh`): Tailscale started again when it stays
    offline although the Pi has a network.
  - **Network tuning** (`pi/network-tuning.sh`): the Wi-Fi rejoin fix (no IPv6 in the saved Wi-Fi
    networks), BBR, and Tailscale's packets first on Wi-Fi.
  - **Freeze restart + kept logs** (`pi/freeze-restart.sh`): the Pi restarted when it freezes for
    30 seconds, 10 seconds after a kernel panic, or when something stays stuck in the kernel for 2
    minutes (a drive or a driver that stopped answering: the watchdog misses that, as systemd still
    answers it), and its log kept on its drive.
  - **USB power** (`pi/usb-current.sh`): a Raspberry Pi 5 that didn't find a 5 A supply (its
    "power to peripherals will be restricted": 0.6 A for its USB ports then) treated as if it had one.
    It uses two of Raspberry Pi's own settings: `usb_max_current_enable=1` in config.txt for the USB
    ports' 1.6 A, and `PSU_MAX_CURRENT=5000` in the bootloader's settings (its EEPROM, through
    `rpi-eeprom-config`) for no warning, which config.txt's setting alone leaves. Both take effect when
    the Pi restarts; until then, a warning says so. Use it only with a supply that can give that much:
    on a weaker one, USB devices drawing more can make the Pi lose power. Keep its power steady while
    it restarts. The Pi's line also shows the supply the Pi takes it has.
  - **On** puts the fix in, and puts it in again when a newer build changes its script. **Off**
    takes it away. Neither happens while Hand Tracker records or saves a take. A fix that didn't go
    in is tried again an hour later, or at once with **Try the fixes again**.
  - **Test the Wi-Fi recovery** (where it's on): the Wi-Fi driver reloaded once, 20 seconds later
    (the Pi is off the Wi-Fi for about half a minute), and how it went.
  - The scripts come with the service's own update (into its `fixes/` folder, checked against
    GitHub's list of the build's files), and the root helper runs them.

- **Jobs** (`modules/jobs.py`): work shared out across the Pis, managed on the app's **Jobs** tab.
  - **Where the list lives:** one Pi keeps the job list and the jobs' files (`~/ht-cluster-jobs/`;
    the app asks which Pi). Each Pi that takes jobs asks it for work, one file at a time, and sends
    back what it made.
  - **Kinds of job:**
    - **Find animals in clips:** each clip is cut to a picture every few seconds (1 by default),
      with the app's model's boxes on it (or a model file sent with the job). The result is laid
      out the way the label check pages read it (`images/train`, `labels-proposed/train`). There is
      also a list of the kinds in each clip and when (`clips/<clip>.json`; `finds.json` and
      `animals.json` for the whole job). It runs in a Python the Pi makes for it the first time
      (`~/.local/share/ht-cluster/jobs-env`: ONNX Runtime, NumPy, Pillow), through
      `node/jobs_animals.py`.
    - **Convert videos:** to any of the Recording Converter's formats, with its own ffmpeg settings.
    - **A command for each file:** `{in}` is the file, `{out}` the folder whose contents come back,
      and `{name}` / `{file}` its name without and with its ending.
    - **A copy every device plays** (`playable`, made by **Convert for every device** below): each
      file with its own plan, put beside its video as it comes back, never over a file.
  - **Files for a job:** recordings on any Pi (a Pi works on its own recordings first, so they
    don't cross the Wi-Fi; another takes them if it isn't taking jobs), files sent from the
    computer, or a folder on the Pi that keeps the list. The results stay on that Pi, and the app
    saves them to the computer. A job can be kept to the Pi each file is on ("here").
  - **Files in turns, as fast as the Pi keeping the list can go:** a Pi downloading a file from
    another, or sending back what it made, first asks the Pi that keeps the list for its turn and
    waits in line (its summary says so). Its own files need no turn.
    - **Staggered, then together:** a new link starts at most every 15 seconds, then runs beside
      the others.
    - **One more** while every 4 MB piece comes in within 20 seconds and the total speed grew with
      the last link let in. **As many as now** when another link would only share the same speed.
    - **One fewer** when a piece takes over 25 seconds: that Pi is straining.
    - **One at a time** while Transmission's turtle is on (someone's watching on Jellyfin).
    - Each Pi says how fast its pieces go every 15 seconds; a turn not said again for 45 seconds goes
      to the next in line. The Pi keeping the list says how fast files are moving in its summary.
  - **A stall on the Wi-Fi isn't the file's fault:** a piece that doesn't come through is tried
    again, up to 6 times, waiting longer each time (5 to 30 seconds). A file that still can't be
    moved goes back on the list, and is marked failed only after 3 rounds.
  - **Each Pi's switches:**
    - **Take jobs**
    - **while its cameras run** (off by default)
    - **on battery** (off by default; never under 25 %)
    - **high priority**
    - **Keep the job list here**
  - **Priority:** a job runs at low priority on two of the four cores. At high priority (the Pi's
    switch, or the job's own) it uses all the cores, ahead of everything else, so the cameras may
    stutter. A Pi that gets too hot (80 °C), short of memory, or whose cameras start (when they
    mustn't) pauses its job. If it's still paused after 5 minutes, it hands the job back for
    another Pi.

- **Convert for every device** (`modules/autoconvert.py`, off by default; on the Pi that keeps the
  job list): every video in `~/Videos` that some device would make Jellyfin convert while it plays
  gets a copy every device plays as it is, `<name> - converted.mp4` beside it (H.264 8-bit up to
  1080p, AAC stereo, its text subtitles); the original stays. It looks every 30 minutes (or at once:
  **Look for new videos now**), looks into a video once nothing has been written to it for 10
  minutes, and puts what's new in jobs, old formats first. Each kind has a switch:
  - **Old picture formats** (Xvid, DivX, MPEG-2, WMV, VP9, AV1, 10-bit H.264): re-encoded (on).
  - **HEVC / H.265:** re-encoded (off; hours a video).
  - **4K and bigger:** made 1080p, HDR's colours made SDR's (off; slowest).
  - **Sound only:** the picture copied, the sound made AAC, by that Pi alone (off).
  A video that failed is tried again a day later (or at once: **Try the failed ones again**).
  Names with "sample" in them are left alone, and picture subtitles (PGS, DVD) stay in the original.

- **Apps** (`modules/apps.py`): apps the cluster runs on whichever Pi is free, shown on the app's
  **Transmission** tab. The first is Transmission.
  - **Where its files live:** one Pi keeps its torrents, settings and files (its "Transmission's
    files and settings are here" switch; the app asks which).
  - **Where it runs:** on any Pi with "Can run Transmission" on that's free, that home first. A Pi
    isn't free while it records, gets too hot, runs short of memory or its battery runs low. When
    its Pi stops being free, or goes quiet, it moves on; it can also be moved by hand.
  - **On another Pi:** the home's folders are shared over NFS (only to Tailscale's addresses) and
    mounted there at their own paths, for Transmission alone, so every torrent keeps its folder.
  - **Its old address:** the home still answers there (port 9092, the window app's, from Tailscale
    and the home network) and passes it on.
  - **Its speeds:** its speed limits (the turtle's when on) are kept on that Pi's Wi-Fi by Linux.
  - **Moving in:** "Move the torrents in" copies the Transmission window app's torrents (their
    folders and progress) and settings into it; "Give them back" undoes it.
  - **New downloads:** they go into a folder you choose in your home, and a folder not shared yet
    is shared then.
  - **Each torrent** has a drop-down with its speeds on it (0 too). Inside it:
    - what the torrent has received and sent in all, and its peers;
    - **Ask for more peers**: its trackers asked now;
    - while it waits, its place in the queue (**Top**, **Up**, **Down**, **Bottom**);
    - its traffic over 1 hour, 24 hours or 7 days. The home reads every torrent's speeds every 10
      seconds, and keeps a reading a minute for 7 days
      (`~/.local/state/ht-cluster/transmission-traffic.jsonl`).
  - **How many at once:** how many torrents download and seed at once (a queue each, on or off), and
    how many peers Transmission takes, in all and for each torrent. Also **Ask for more peers (every
    torrent)**.
  - **On the Pis:** Debian's `transmission-daemon` runs as your account (`ht-cluster-transmission`,
    started by the root helper), with its settings in `~/.local/share/ht-cluster/transmission`.

A new module is a new file in `node/modules/` (what it needs is described in `node/ht_cluster.py`).
It reaches every Pi with the service's own updates. The app shows a module it doesn't know yet
too: its summary, its warnings, its buttons and its settings.

## How it fits together

- **The service** (`node/ht_cluster.py`, port 47830): runs as your account's own systemd service
  (`systemctl --user status ht-cluster`) and starts at boot.
  - It answers only your own Tailscale account (checked with `tailscale whois`).
  - Requests from the Pi itself can only read, not change anything.
  - Every request must carry the app's header and name the Pi in its Host. Another site's page can't
    send either; only the Pi Cluster page the Pi serves itself sends the header (see **In a
    browser** above).
  - What each Pi was set to, and what happened lately: `~/.local/state/ht-cluster/`.
- **The root helper** (`node/ht-cluster-root`, installed as `/usr/local/sbin/ht-cluster-root`): the
  few jobs that need root. Those are installing Hand Tracker, the system's updates and the
  service's own update, restarting the Pi, Transmission's jobs, and putting the Pi fixes in or
  taking them away.
  - sudo lets your account run it, and nothing else, without a password
    (`/etc/sudoers.d/ht-cluster`).
  - It takes no file or address from the service. It downloads what it installs itself and checks
    it against GitHub: the size and SHA-256 of the `.deb`, and the service's files (with the Pi
    fixes and the Pi Cluster page) against the commit's file list.
  - Its log: `/var/log/ht-cluster-root.log`.
- **The app** (`electron/cluster.js`): finds the Pis among the Linux computers on this computer's
  Tailscale network, and asks each one's service.
- **The page in a browser** (`pi-cluster.js`, browser mode): asks the Pi that served it, which lists
  the other Pis on its Tailscale and passes requests on to them.

## Checks

```bash
python3 cluster/test_cluster.py
```

This checks the service against stand-ins for Hand Tracker, GitHub and the root helper, and the
page in a browser: served by the Pi, requests passed on to a second Pi, and one-time download links.

```bash
python3 cluster/test_jobs.py
```

This checks the jobs with two Pis simulated on this computer. The animal model's part also needs
`HT_TEST_ANIMALS_PY`, a Python with ONNX Runtime, NumPy and Pillow, and `HT_TEST_MODEL`, the app's
`animals8.onnx`. Convert for every device's part needs ffprobe (`HT_TEST_FFPROBE`, else on the path
or beside ffmpeg).

```bash
python3 cluster/test_apps.py
```

This checks Transmission moving in, moving between two simulated Pis, its old address, new
downloads and giving the torrents back, with a stand-in Transmission and root helper.

```bash
npm run check:cluster
```

This checks the app with a Pi simulated on this computer.
