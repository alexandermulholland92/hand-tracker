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
  - **Files for a job:** recordings on any Pi (a Pi works on its own recordings first, so they
    don't cross the Wi-Fi; another takes them if it isn't taking jobs), files sent from the
    computer, or a folder on the Pi that keeps the list. The results stay on that Pi, and the app
    saves them to the computer.
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

A new module is a new file in `node/modules/` (what it needs is described in `node/ht_cluster.py`).
It reaches every Pi with the service's own updates. The app shows a module it doesn't know yet
too: its summary, its warnings, its buttons and its settings.

## How it fits together

- **The service** (`node/ht_cluster.py`, port 47830): runs as your account's own systemd service
  (`systemctl --user status ht-cluster`) and starts at boot.
  - It answers only your own Tailscale account (checked with `tailscale whois`).
  - Requests from the Pi itself can only read, not change anything.
  - Every request must carry the app's header and name the Pi in its Host. A web page can't send
    either.
  - What each Pi was set to, and what happened lately: `~/.local/state/ht-cluster/`.
- **The root helper** (`node/ht-cluster-root`, installed as `/usr/local/sbin/ht-cluster-root`): the
  few jobs that need root. Those are installing Hand Tracker, the system's updates and the
  service's own update, and restarting the Pi.
  - sudo lets your account run it, and nothing else, without a password
    (`/etc/sudoers.d/ht-cluster`).
  - It takes no file or address from the service. It downloads what it installs itself and checks
    it against GitHub: the size and SHA-256 of the `.deb`, and the service's files against the
    commit's file list.
  - Its log: `/var/log/ht-cluster-root.log`.
- **The app** (`electron/cluster.js`): finds the Pis among the Linux computers on this computer's
  Tailscale network, and asks each one's service.

## Checks

```bash
python3 cluster/test_cluster.py
```

This checks the service against stand-ins for Hand Tracker, GitHub and the root helper.

```bash
python3 cluster/test_jobs.py
```

This checks the jobs with two Pis simulated on this computer. The animal model's part also needs
`HT_TEST_ANIMALS_PY`, a Python with ONNX Runtime, NumPy and Pillow, and `HT_TEST_MODEL`, the app's
`animals8.onnx`.

```bash
npm run check:cluster
```

This checks the app with a Pi simulated on this computer.
