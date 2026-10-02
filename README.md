# Hand Tracker

Real-time tracking of **both hands** from a webcam (MediaPipe Hands, 21 landmarks per hand), with a live 3D view, gesture and finger-curl readouts, **motion capture export in 7 formats**, **video recording**, and a **video converter** that opens nearly any video format and exports **36 formats**. Runs as a Windows or Linux desktop app, an Android app, or in a browser.

## Run it

**On the web:** open **https://hand-tracker.pages.dev** in Chrome, Edge or Safari, on a computer or a phone. Nothing to install, and tracking runs entirely on your device; no video leaves it.

**Windows app:** double-click `dist/HandTracker-1.1.0-portable.exe`. Nothing to install; it works offline.

**Linux app** (Ubuntu, Debian, Mint and others that install `.deb` packages): run `sudo apt install ./dist/hand-tracker_1.1.0_amd64.deb`, then open **Hand Tracker** from the app menu or run `hand-tracker`. It works offline and does everything the Windows app does except open OptiTrack `.tak` takes, which needs Motive, and Motive only runs on Windows (export a take from Motive as C3D and open that instead). Motive's live data does work. To remove it: `sudo apt remove hand-tracker`.

**Raspberry Pi** (Pi 4 or 5 with 64-bit Raspberry Pi OS, and other 64-bit ARM Linux boards): the same, with the ARM package: `sudo apt install ./hand-tracker_1.1.0_arm64.deb` from the [Latest build](https://github.com/alexandermulholland92/hand-tracker/releases/tag/latest-build) release. Tracking uses the Pi's GPU and starts with the Lite model (it's quicker on a Pi; Full is in Model). OAK cameras work on a Pi too. The hand mouse and floating keyboard need an X11 session: Raspberry Pi OS starts in Wayland, so switch it in `sudo raspi-config` → Advanced Options → Wayland → X11, and install xdotool (`sudo apt install xdotool`). A Pi 5 is recommended; a Pi 4 tracks more slowly.

**Download the latest build:** every change to `main` rebuilds the Windows, Linux and Android apps on GitHub and puts them on the [Latest build](https://github.com/alexandermulholland92/hand-tracker/releases/tag/latest-build) release (`.github/workflows/build-apps.yml`). Each APK built there installs over the last one, but it's signed with a different key from one built on your PC, so Android only installs it over a PC-built copy after that copy is uninstalled (and the other way round). The same happens whenever GitHub drops the saved key (after a week with no builds, or sooner when its cache fills up). To fix the key for good, save a `debug.keystore` as the repository secret `ANDROID_DEBUG_KEYSTORE` (base64; *Settings → Secrets and variables → Actions → New repository secret*): every build is then signed with it, and saving your PC's own (`%USERPROFILE%\.android\debug.keystore`; in Git Bash, `base64 -w0 ~/.android/debug.keystore | clip` copies it) makes GitHub's and your PC's APKs install over each other. The build's log shows which key it signed with (*Signing key in use*).

**Android app:** install `dist/HandTracker-1.1.0.apk` on your phone (see [Android app](#android-app) below).

**From source** (Node.js 18+):

```bash
npm install
```

```bash
npm start
```

**In a browser, from source:** run `npm run web` and open http://localhost:8080. Browsers only allow the camera on `localhost` or `https`, so opening `index.html` directly from disk won't work.

Video import and export work in all three: the Windows and Linux app converts with its bundled ffmpeg; the website and the Android app use ffmpeg.wasm, which runs on the device (nothing is uploaded) and downloads once, about 32 MB, the first time it's needed, together with the device's own video encoders for HEVC, AV1 and AVIF (most phones have an HEVC one; Chrome has an AV1 one). The desktop app is faster. Only the Windows app can open OptiTrack `.tak` takes.

## Features

- **Two hands at once**: each hand gets its own card (Left in blue, Right in orange), an on-screen label with its gesture, a 3D skeleton and a simulated robot gripper. A *Both Hands* panel shows the distance between the wrists. Choose *Track: 1 hand* for a little extra speed.
  - The Left/Right labels are their normal size with a hand at arm's length or closer (a little bigger on a phone, whose screen is small), and grow as it moves further away (up to twice the normal size; 1.6 times on a phone, where the picture is small), so they can still be read from across the room. How far away is judged from the hand's size in the picture.
  - A hand's card stays in place, with its values blank, while the hand is out of view, so the cards and the Both Hands panel don't jump about as hands come and go.
- **Steady tracking**: every landmark is smoothed with a One Euro filter, which holds a still hand steady but follows fast movement closely, so the skeleton doesn't shake and gesture labels don't flicker. It was tuned on recorded hand movement: the skeleton trails a moving hand by about 50 ms (it used to be about 160 ms), with about 30% less error. Each hand keeps its Left/Right label unless MediaPipe disagrees for several frames in a row and, on average, over the whole time the hand has been tracked, so a few doubtful frames never swap it.
- **Far-away hands**: MediaPipe's hand detector was trained on hands within about 2 m. Turn on *Far-away hands* and a body model (MediaPipe Pose, lite) finds your wrists first, then the hand detector looks just around them, so hands are found up to about 5 m away. *Look for* picks both hands, the higher hand, or one side; *Raised hands only* ignores a hand hanging below its elbow (handy for gestures). Once a hand is found, a square follows it and the body model rests. Left and right come from the body, which is far more reliable at a distance. Adapted from depthai_hand_tracker's Body Pre Focusing.
- **Black gloves** (More settings): MediaPipe's hand detector learned hands from skin and hardly ever finds one in a black or dark glove. With *Black gloves* on, it's given a copy of the picture in which each spot shows how much darker it is than its surroundings, in skin colour, so a dark glove looks like a light, shaded hand in dim or bright light alike. The picture on screen doesn't change. On photos of real hands turned into black gloves it found 29 of 32 hands (none without it), with Left and Right right and the joints within about 4% of the hand's length. Bare hands are found less well while it's on, so turn it off without gloves. It's remembered, and doesn't apply to OAK cameras (they find hands on the camera).
- **Rotate**: turn the picture 90° right, 180° or 90° left (or press `T` to turn it another 90° right), for a camera mounted on its side or upside down. It's turned before tracking, so gestures, the hand mouse, recordings and motion capture all follow the turned view. Remembered for each camera and each video, and it works for webcams, windows, video files and OAK cameras.
- **Square crop**: track only the centre square of the picture. The hand detector works on squares, so a small or distant hand in the middle gets a bigger view.
- **Pause** (Space or the button) freezes the live picture and tracking.
- **What's drawn** (the *Show* buttons, keys 1–7 and F): a box around each hand turned with it, the skeleton, left/right, confidence (how sure the tracker is of left or right, on average since the hand was found; with an OAK camera, also of the hand itself), the gesture, the distance to each hand (OAK-D depth cameras), the body and search area in far-away mode, and the FPS counter. Recorded video shows the same.
- **Camera controls**: choose the camera, resolution (640×480 to 1920×1080) and model (Lite for speed, Full for accuracy). Full is the default on a PC: on real hands it lost them in a third as many frames as Lite, for a few milliseconds more per frame. Phones and a Raspberry Pi start with Lite. Settings are remembered.
- **Several cameras at once**: with two or more cameras connected, choose *Several cameras at once…* in the camera list and pick up to four (every camera found is ticked, OAK cameras first, except one you've unticked before; only the ticked ones start). Their grid takes the main view's place while they run (*Close* brings it back). Each gets its own tile and its own tracker, and a **role**: where the camera is worn (*Head*, *Chest*, *Left wrist* or *Right wrist*, given in order at first; pick another under its tile, and a camera that had it swaps; remembered for each camera). The tiles sit in a grid by role, two to a row: head, chest, left wrist, right wrist, so changing a camera's role moves it; a single camera takes the whole grid, and the roles with no camera are listed under it (*Not connected: …*). Each tile takes its camera's shape: a phone held upright gives a tall tile, not a wide one with black bars. Under each tile, **⟳** turns that camera's picture (and its tracking) 90° at a time and **Flip** mirrors it, each camera on its own and remembered for it: every camera starts mirrored like a selfie, OAK cameras too (flipping only changes the look: the left hand stays the left). Motion capture records them all together on one clock, each hand named after its camera's role (*Head Left*, *Chest Right*…; *Cam 1 Left* for a camera set to *No role*), and the recording lists each camera with its role. Each camera runs slower than one camera alone would. Luxonis OAK cameras can be among them (Windows and Linux app, after the [OAK setup](#luxonis-oak-cameras)): each one plugged in is listed, its hands are found on the camera itself, and they're started one after another.
- **Track a video file** instead of the camera: *Open Video…* accepts MP4, MOV, MKV, WebM, AVI, MPEG, WMV, FLV, 3GP, Ogg, MPEG-TS, MXF, DV, ProRes, GIF and more; see [Tracking a video file](#tracking-a-video-file). Android phone selfie videos, which are saved mirrored, are flipped back automatically; for any other video where Left and Right come out swapped, turn on *Mirrored video*.
- **Several videos at once**: choose more than one video in *Open Video…* (a capture rig's cameras, say) and they're tracked in turn and synced from the hand movement in them, their motion capture saved on one shared clock. Videos that don't line up can go to a motion capture queue and to the Recording Viewer's export queue instead; see [Several videos at once](#several-videos-at-once).
- **Convert any video**: the Recording Viewer's *Open Video…* opens nearly any video and converts it to any of 36 formats, one at a time or several in a queue; see [Converting videos](#converting-videos).
- **Mirror view with readable text**: front (selfie) cameras and webcams are shown mirrored so movements feel natural; rear cameras and video files are shown as they are. The Mirror button switches it, and the app remembers your choice for each camera. Times in the picture, like a clock or a timestamp, are always shown the right way round: the app finds them with on-device OCR (tesseract.js, bundled) and flips them back. Other text (signs, screens, printing) reads backwards unless you turn on the optional **Readable text** button (off by default; your choice is remembered), which flips all text back. The app's own labels are always drawn the right way round. To avoid flipping things that only look like text (cloth, shadows, stripes), an area is only shown the right way round once it has been read as text in three scans running, so real text straightens about a second after it appears. Anything read on or right next to a hand is ignored too (OCR takes an OK sign's ring for an "O"), so no flipped patch is left behind when the hand moves away.
- **Gestures**: pinch, OK sign (thumb and index in a ring, the other fingers out), thumbs up, fist, open palm, finger counting (*Two*: thumb and index out, like an L; *Three*: thumb, index and middle; *Four*: four fingers up with the thumb folded in; one is *Point* and five is *Open Palm*), peace (at any angle, upright, leaning or on its side), rock on, call me, shaka, point, thumbs down, *live long and prosper* (the Vulcan salute: fingers in two pairs with a V between the middle and ring fingers) and *the bird* (only the middle finger raised, pointing up or sideways but not down, with the hand facing the camera rather than side-on; sideways counts so it still works on a phone held on its side), plus palm yaw/pitch/roll and per-finger curl. Call Me and Shaka are the same hand shape: rocking the wrist back and forth makes it Shaka, holding it still is Call Me. A label must hold for a few frames before it changes, so it doesn't flicker. Gestures are judged mostly by how far each fingertip reaches from the wrist (in palm lengths), which holds up on real hands better than finger-bend angles do; the rules are checked against 202 hands measured from real photos (`scripts/fixtures/gesture-hands.json`) and were tuned on a live webcam session.
- **Recording Viewer** (header link or *File → Open Recording Viewer*): opens hand recordings (JSON, CSV, BVH, NPZ, GLB), **C3D** and TRC files, and **OptiTrack `.tak`** takes. You can play them back, browse the frames, and convert them to every other motion format, or to any of the 36 video formats, one at a time or several in a queue; see [Viewing and converting recordings](#viewing-and-converting-recordings).
- **Recovers from camera dropouts**: if the camera stops sending frames, the app shows a notice and reconnects automatically.
- **3D view**: *Hand shape: Real size* draws each hand at its real size and shape in metres (MediaPipe's world landmarks), and with an OAK-D at its measured distance; *From the picture* shows it as the camera sees it. *View* can rotate or swing back and forth by itself.
- **Control your PC** (Windows and Linux app): a hand mouse, a floating keyboard and gesture actions. The Android app can do the same to a PC over Wi-Fi, or to the phone itself; see [Control your PC](#control-your-pc).
- **Luxonis OAK cameras** (Windows and Linux app): tracking on the camera itself, with each hand's distance on an OAK-D; see [Luxonis OAK cameras](#luxonis-oak-cameras).

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `R` | Start / stop video recording |
| `M` | Start / stop motion capture |
| `O` | Toggle the skeleton overlay |
| `Space` | Pause / resume |
| `T` | Turn the picture another 90° right |
| `1`–`7`, `F` | Show or hide: hand box, skeleton, left/right, confidence, gesture, distance, body & search area, FPS |
| `Ctrl+Alt+M` | Hand mouse on / off (from any app, even with Hand Tracker minimized) |
| `Ctrl+Alt+K` | Floating keyboard on / off (from any app) |

## Motion capture export

Press **Start Motion Capture**, do the movement, press **Stop**, then pick formats in the *Export Motion Capture* panel. Both hands are recorded on one shared clock.

| Format | Opens in | Contents |
| --- | --- | --- |
| **JSON** | Anything; the Recording Viewer | Everything: 21 joints per frame with position, orientation, velocity and acceleration, plus trajectories and task phases; each frame also has `world_joints`, the hand's real shape in metres, and with an OAK-D `distance_mm` |
| **CSV** | Excel, Google Sheets, pandas, MATLAB | One row per hand per frame. Columns: `hand, frame, t, phase`, the wrist's camera-frame position (`wrist_world_x/y/z`), the palm quaternion, x/y/z for all 21 joints relative to the wrist (`wrist_x` … `pinky_tip_z`), and `image_width, image_height`; then the real shape in metres (`wrist_real_x` … `pinky_tip_real_z`) and, with an OAK-D, `distance_x_mm, distance_y_mm, distance_z_mm`. Can be imported back (see below) |
| **BVH** | Blender, Maya, MotionBuilder, Cinema 4D; Unity/Unreal via Blender | Animated skeleton, one file per hand (`…-left.bvh`, `…-right.bvh`) |
| **GLB** (glTF 2.0) | Blender, three.js, Unity, Unreal, Windows 3D Viewer | Animated 3D hands (joints and bones) that play straight away |
| **C3D** | Vicon Nexus, Qualisys, Visual3D, Mokka, ezc3d | 42 3D markers (21 per hand); frames where a hand wasn't visible are marked invalid |
| **TRC** | OpenSim | The same 42 markers as a text table |
| **NPZ** | Python / NumPy (`np.load`) | Per hand: `left_t`, `left_joints` (T×21×3), `left_wrist`, `left_palm_quat`, `left_phase`, `left_real_joints` (T×21×3, metres), with an OAK-D `left_distance_mm` (T×3); plus `joint_names`, `parents` |

Units and axes:

- **JSON, CSV and NPZ** keep MediaPipe's raw units: x and y as fractions of the image width/height, and z as relative depth. The joint positions are relative to the wrist.
- **BVH, GLB, C3D and TRC** are converted to real-world-style units: BVH in cm, GLB in m, C3D and TRC in mm. They use right-handed axes: Y-up for BVH, GLB and TRC; Z-up for C3D.
- The real shape (`world_joints`, `…_real_…`) is MediaPipe's own estimate of the hand in metres, around the hand's centre (x right, y down, z away from the camera). An OAK-D's `distance_mm` is measured: the wrist's position from the camera in mm (x right, y down, z forward).
- A single webcam can't measure distance, so the size is **estimated** by assuming an average adult hand (wrist to middle fingertip ≈ 19 cm). Treat absolute distances as approximate; relative motion and angles are what's reliable.
- The 3D formats show the hands as the camera saw them (not mirrored), so a left hand stays a left hand.

## Control your PC

In the Windows and Linux app, the **Control your PC** card turns your hands into a mouse and keyboard. Nothing happens until you turn each part on.

- **Hand mouse** (`Ctrl+Alt+M` from anywhere): the pointer follows the centre of your palm, which hardly moves when a finger curls.
  - A quick curl of the **index finger** is a left click; curl it and hold to **drag** (the button stays down until the finger straightens).
  - A quick curl of the **middle finger** is a right click.
  - Curl both, or make a fist, to **hold the pointer still** while you move your hand back to the middle.
  - Pick the hand to follow, how far you move for the pointer to cross the screen, and the main screen or all screens. It keeps working with Hand Tracker minimized.
- **Floating keyboard** (`Ctrl+Alt+K` from anywhere): a keyboard that stays on top of every window and never takes the focus, so what you click on it is typed into the app you were using, like Windows' on-screen keyboard. Click its keys with the hand mouse (or a mouse). Shift applies to the next key; Ctrl, Alt and Win make shortcuts with the next key (Ctrl, then C, copies). Its *Hand mouse* button turns the hand mouse on and off.
- **Gesture actions**: make a gesture press keys (`ctrl+c`, `volumeup`, `playpause`, `f5`…), type text, click, double-click, right-click, drag, scroll, or call a web address (for smart-home hubs such as Home Assistant, IFTTT or Node-RED; POST sends the gesture, hand and time as JSON). For each action choose the gesture, the hand, and when it fires:
  - when the gesture starts;
  - when it starts and ends (keys and the mouse button are held down while it lasts);
  - repeatedly while it's held;
  - on every frame.

  Also set how long the gesture must be held first; a few misread frames don't end it. The **Keyboard**, **Mouse** and **Web requests** switches turn whole kinds of action off, and each action has its own switch. Three examples (volume up and down with thumbs up and down, play/pause with a fist) are there but switched off. Adapted from depthai_hand_tracker's HandController.

On Windows this uses Windows' own input functions (nothing to install). On Linux it needs **xdotool** (`sudo apt install xdotool`) and an X11 (Xorg) session: Wayland desktops don't let apps move the pointer or type into other apps.

### From your phone

The Android app's **Control your PC** card controls a PC over Wi-Fi with the phone's camera: the same hand mouse, gesture actions and floating keyboard, carried out on the PC.

1. On the PC, turn on **Let a phone control this PC** (at the bottom of the card). It shows a QR code. Allow Hand Tracker through the firewall if Windows asks.
2. On the phone, tap **Scan the PC's code** and point the camera at it (or **Type the code…** and enter the text under the QR code).
3. Turn on the hand mouse or gesture actions on the phone.

The phone and PC must be on the same network. Only a phone that has read the code can send input: every message is signed with the code's key, and a new connection gets a new session, so recorded messages can't be played back. **New code** on the PC unpairs every phone. The phone remembers the PC (the key in the Android Keystore) until you tap **Forget this PC**.

### The phone itself

**Control this phone** (Android app) moves a pointer over any app with your hand, like the hand mouse on a PC: a curl of the index finger taps (however long you hold it, so a slow tap doesn't become a long press), curl it and move your hand to drag (to scroll or swipe), a quick curl of the middle finger is a long press. The area your hand moves in slides along when you push past its edge, and a fist holds the pointer still while you move your hand, so the whole screen is in reach wherever your hand is in the picture (*Moves: small* needs the least movement). It follows one hand, which keeps tracking at the camera's full rate (unless a gesture action is for the other hand). Gesture actions can press Back, Home, Recents, Notifications, volume and media keys, take a screenshot, or type into the text box in use.

It needs two permissions, each one tap away in the card: **Display over other apps** (for the pointer and a small camera window) and Hand Tracker's **hand control** in Android's Accessibility settings (to tap, swipe and type). Then tap **Start controlling this phone** and switch to any app. A small window in a corner shows the camera while it runs, and a notification says it's on; tap the window's × or the notification's **Stop** to end it. Hand control does nothing unless this is running, and reads nothing on screen except the text box being typed into.

## Remote recording

In the Windows and Linux app, a phone can start and stop motion capture with *Several cameras at once*, and show a live preview of each camera with its hands drawn. It's made for a camera rig on a computer nobody's sitting at, a Raspberry Pi with no screen say. The Android app can be the rig too, with its own cameras (front and back, and any plugged into it; tested on a OnePlus 9 Pro: both at once at 14 and 20 fps): the same page, listing them to pick, start and stop, from the PC's Hand Tracker or any browser. It still opens other computers' pages as well.

1. In the **Record** card, turn on **Remote recording**.
2. Open the computer's remote recording page:
   - **From the apps**: *Remote recording* at the top of the Android app or the Windows and Linux app remembers your computers' names; the page opens right there in the app (the app reaches the computer for it).
   - **Over Tailscale** (from anywhere, no code needed): `http://<the computer's Tailscale name>:47821`, for example `http://pi:47821`, in any browser, or that name in the apps. The card shows the full address. Only your own devices can reach the computer over Tailscale, and it encrypts everything.
   - **On the computer's own hotspot** (a Raspberry Pi set up with `pi/hotspot-setup.sh`, below; no code needed): join its Wi-Fi, then `http://10.42.0.1:47821`.
   - **On the same Wi-Fi**: scan the QR code in the card with a phone's camera, or paste the address under it (it ends in `#k=` and a code) into the apps. The page keeps the code, so next time just open it again. **New code** stops phones that have the old one. This page isn't encrypted on the way, like most devices' own pages on a home network, so use it on a network you trust.
   - **From the website**: [hand-tracker.pages.dev/remote.html](https://hand-tracker.pages.dev/remote.html) (*Remote recording* at the top of the web version) remembers your computers' names too, and opens the computer's own page: browsers don't let a website talk to a device on your network directly.

The page has:

- **Mode**: **Ego** needs all four cameras (*Head*, *Chest*, *Left wrist* and *Right wrist*), **Stereo** needs a *Head* camera (any others picked record with it), **Freeform** takes any. Start cameras and Start recording wait for what the mode needs, and say what's missing.
- **Cameras**: every camera the computer can start, any kind (OAK cameras and webcams), to tick and give a role; one picked that isn't plugged in says so. The picks and roles are the same as *Several cameras at once…* (every camera found is ticked, up to four, unless it's been unticked; only the ticked ones start). While the cameras run the list stays on show, locked: *Stop cameras* to choose others. Why OAK cameras can't be listed (OAK support not set up, say) is said, rather than them just missing.
- **Start cameras**, **Start recording** (which starts the cameras first if need be), **Stop recording** and **Stop cameras**. Only the cameras picked that are plugged in start. Nothing starts by itself: the cameras run only once the phone (or someone at the computer) asks. On the computer, the cameras' grid takes the main view's place while they run.
- **Take details**: *Contributor*, *Location* and *Task*, all three needed before a recording starts (the page points out any that are empty). Tapping *Take details* five times shows a switch that makes them optional (and needed again), for every phone. The computer keeps them (every phone sees the same), so fill them in once and change only what changes between takes. From **Start recording** until the take is saved they're locked: each take keeps the details it started with, and they can't be changed for it afterwards either (at the computer, a saved take's export card keeps its name). The previews carry on as usual.
- A box per camera in the same grid by role (one camera takes the whole grid; the roles with none are listed under it), each in its camera's shape, with its frame rate and hands, a few preview pictures a second (hands drawn) while the page is open, and its role, **⟳** and **Flip**, so the cameras can be set up without the computer's screen. Tap a camera's picture to see it alone, full screen, bigger and about 15 pictures a second (the computer sends only that one meanwhile); tap it again, **✕** or Back to go back.
- **Pictures on its screen** (OAK cameras): *Off* stops the computer drawing the cameras' pictures on its own screen, which on a Raspberry Pi with four cameras is most of its work: the hands are still tracked and recorded on every frame, and this page still shows the cameras (pictures are then made only as often as it asks for them). *Hide pictures* under the tiles does the same at the computer.
- **Wi-Fi** (on the computer's hotspot or over Tailscale only, where the password is encrypted on the way): the computer's network, and **Change** to see the ones around it and have it join one (a saved one needs no password). One that can't be joined (a wrong password) isn't kept.

Each take is saved by itself when you stop, in the export card's formats (JSON unless you've picked others), into `Documents/Hand Tracker recordings` (**Change…** picks another folder), named after its details and length: `Sam-Smith_Lab-2_Pick-up-cup_1m05s_2026-10-01_16-30-00.json` (`robot-motion_1m05s_…` without details). The JSON also holds them as `metadata`: `{ contributor, location, task, length: "1:05", length_s: 65.2 }`. The page shows the file's name. A take still waiting to be exported on the computer is saved the same way before a new one starts, rather than asking there.

**With no screen**: tick **Open Hand Tracker when this computer starts** (installed app only). It then opens at login with Remote recording on and no camera running, waiting for the phone. On a Raspberry Pi this needs the desktop to log in by itself, which Raspberry Pi OS does unless you've changed it. The page uses port 47821 (the next free one if that's taken), so it doesn't get in the way of other servers on the computer, such as Jellyfin's 8096.

**A hotspot of its own** (Raspberry Pi): `sudo bash pi/hotspot-setup.sh` (on the Pi) gives it a Wi-Fi hotspot, `HandTracker-<its name>`, on from boot alongside its normal Wi-Fi, so a phone can always reach it, whatever Wi-Fi there is (or none). You choose its password (or get a random one). The Pi's Wi-Fi chip runs both on one channel, so the hotspot follows the network's (phones on it drop off for a moment when the Pi joins a network on another channel); with no network it's on 2.4 GHz channel 6, and every two minutes, a saved network in range gets a moment to be joined. A 5 GHz network on a radar (DFS) channel can't have the hotspot beside it. `sudo bash pi/hotspot-setup.sh --remove` takes it away.

## Luxonis OAK cameras

With a Luxonis OAK camera (OAK-D, OAK-D Lite, OAK-1…), pick **Luxonis OAK camera** in the camera list. The hands are found on the camera itself, using depthai_hand_tracker's Edge mode, and an OAK-D also measures each hand's distance (Show → Distance). Everything else works as with any camera: gestures, recording, motion capture, the hand mouse. Tested with an OAK-D Pro W over USB 3: about 20 frames a second with both hands, distances from 0.4 to 3 m, and far-away mode on the camera. *Model*, *Track* and *Far-away hands* apply too (far-away hands on the camera uses its own body model, MoveNet).

- **One-time setup** (the first time you pick it, about 150 MB, a minute or so): Luxonis's depthai library version 2, which the tracking code is written for, needs Python 3.8–3.13, so Hand Tracker installs its own. It downloads [uv](https://github.com/astral-sh/uv), which installs a private Python 3.12 with depthai, OpenCV and NumPy, plus the camera models from depthai_hand_tracker. Everything goes in Hand Tracker's own data folder (`%APPDATA%\Hand Tracker\oak` on Windows); nothing else on your computer changes, and every download is checked against a known size or checksum.
- **Several OAK cameras at once** (a head, chest and wrist camera rig, say): choose *Several cameras at once…* in the camera list; each OAK camera plugged in is listed, named by its model once it's been used, and gets a tile and a role like any camera. **Hide pictures** (under the tiles) stops drawing their pictures on this screen, leaving the processor for finding hands (a Raspberry Pi especially): the hands are still tracked and recorded, and Remote recording's page still shows the cameras. A minimized window doesn't draw them either. Each camera's hands never wait for its picture: on a Raspberry Pi with nobody at its screen a picture can take a second to draw, so the hands go on at the camera's rate and the pictures come as they can (measured on a Pi 5 with four cameras, before this: 27–33 frames a second from the OAK-1 Lites with pictures off, 2–3 with them on). An OAK camera that's plugged in but doesn't answer (one can get stuck until it's unplugged) is named by its USB port, rather than just missing. Several OAK cameras can need more power than a computer's USB ports give (a Raspberry Pi especially): plug them into a powered USB hub.
- **A camera that can't keep a USB 3 connection** (its cable or its port) starts in USB 2 mode by itself; the note under the picture then says so. Pictures come a little slower over USB 2. Hand Tracker remembers it and starts it in USB 2 mode straight away next time (to try USB 3 again, with a better cable say, delete `usb2-cameras.json` from the `oak` folder below). In *Several cameras at once*, a camera that didn't start gets **Try again** under its picture; the others carry on.
- **"The OAK camera couldn't be started: it's busy"**: close **OAK Viewer** or any other program using the camera. If that doesn't help, unplug it and plug it back in, ideally into a USB 3 port with its own cable.
- **Linux** (64-bit PCs, and 64-bit ARM boards like the Raspberry Pi 4 and 5): installing the `.deb` lets Hand Tracker use OAK cameras over USB. It adds Luxonis's USB rule for them (`/lib/udev/rules.d/80-hand-tracker-oak.rules`, removed with the app), and a camera that's already plugged in can be used at once. The setup then works as on Windows, into `~/.config/Hand Tracker/oak`. Running from the source folder instead, allow it once: `echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="03e7", MODE="0666"' | sudo tee /etc/udev/rules.d/80-movidius.rules`, then `sudo udevadm control --reload-rules && sudo udevadm trigger`, and replug it. If Linux still doesn't let the app use the camera, it says so and what to do.
  - On a Raspberry Pi, an OAK-D can need more power than the Pi's USB ports give: if it won't start or keeps disconnecting, power it from its own supply or a powered USB hub.
  - GitHub checks this on every change to the OAK code (`.github/workflows/check-oak.yml`, without a camera): the setup on a 64-bit PC and on 64-bit ARM, depthai looking for cameras, and the helper's stream. Each Linux build also installs and removes the `.deb`, checking the camera rule.

## Viewing and converting recordings

The **Recording Viewer** opens:

| File | Where it comes from | Notes |
| --- | --- | --- |
| **JSON** | Hand Tracker's motion capture | All versions, including older single-hand files |
| **CSV** | Hand Tracker's CSV export, including after editing it in Excel or Google Sheets | Handles semicolon separators, decimal commas and reordered rows. Joint orientations and velocities are recalculated from the positions, and task phases come from the `phase` column, so your edits carry through |
| **C3D** | Any motion capture system: Vicon, Qualisys, OptiTrack Motive, and Hand Tracker itself | Read as labelled 3D markers, converted to millimetres, with gaps kept as gaps. Hand Tracker's own C3D (and TRC, GLB, NPZ) opens as the hands again |
| **Motive CSV** | OptiTrack Motive's CSV export | Markers, rigid-body centres, solved rigid-body markers and bones, as points (rotations aren't shown). Converted so the take looks the same as when it's opened as `.tak` or C3D: Motive's CSV is a mirror image of its C3D and internal coordinates |
| **TRC** | OpenSim, OptiTrack Motive, and Hand Tracker | Y-up TRC is turned Z-up with the standard OpenSim rotation |
| **BVH** | Blender, MotionBuilder, and Hand Tracker | Every joint and end site, from the skeleton and its rotations, as points (in centimetres, as BVH is usually written); a Hand Tracker BVH opens as its hand again |
| **NPZ** | NumPy, and Hand Tracker | Marker positions with their labels |
| **GLB** | glTF animations, and Hand Tracker | The animated nodes' positions, as points |
| **.tak** | OptiTrack Motive takes | Windows app only, and **OptiTrack Motive must be installed on that PC** (see below) |

For every recording you get:

- A summary.
- **Playback**: hand skeletons for hand recordings, and markers with front, side and top views for C3D and `.tak`.
- A **frame table**; click a row to jump to it.
- An **Export** panel that converts the recording:
  - **Hand recordings** can be exported to all 7 motion capture formats. So a CSV you edited can become BVH, GLB, C3D and so on.
  - **Marker recordings** (C3D, `.tak`) can be exported to C3D, TRC, CSV, GLB, NPZ and JSON.
  - **Any recording can become a video** in any of the 36 video formats: its playback (the skeletons, or the markers from the front) is drawn frame by frame, 1280 pixels wide, at the recording's frame rate (up to 60), so it's as long as the recording.
- **Several recordings at once**: choose or drop more than one, or use **Convert recordings…**, pick the formats and click **Convert all**. Hand recordings go to any format and marker recordings to the marker ones (BVH needs a skeleton, so a marker recording says it can't); a file isn't converted to its own format again. Each one leaves the list once it's done.

Any file can be chosen or dropped either way: recordings (`.json`, `.csv`, `.c3d`, `.trc`, `.bvh`, `.npz`, `.glb`, `.tak`) open in the viewer, and everything else opens as a video. **Convert videos…** queues several videos for converting.

The **Markers** list, the **frame table** and the export **Formats** list start collapsed to one line, which says what's inside (for example "42 markers" or the formats that are ticked). Click **Show** to open them and **Hide** to fold them away again. The video converter's format list works the same way.

In the frame table for hand recordings, joint positions are measured **from the wrist**, so the wrist joint is always 0, 0, 0. *Wrist world* is where the wrist is in the camera image; its z is always 0, because the tracker measures depth relative to the wrist.

### OptiTrack .tak takes

`.tak` is OptiTrack's proprietary, undocumented format, which only OptiTrack's own software can read. So Hand Tracker opens takes through the **Motive installed on your PC**. A small script (`electron/tak-convert.ps1`) uses Motive's NMotive API to read the take. None of OptiTrack's software is bundled with Hand Tracker. Your original take is never modified; Motive works on a temporary copy.

- **Viewing**: Motive exports the take's markers to C3D behind the scenes, and the viewer shows them.
- **Exporting**: C3D, TRC, CSV (Motive's format, including rigid bodies) and FBX come from **Motive's own exporters**. BVH is also available when the take contains a skeleton; Motive only writes BVH for skeletons. GLB, NPZ and JSON come from Hand Tracker.
- **Without Motive** (another PC, the Android app, or the website): in Motive, use *File → Export Tracking Data* to save the take as **C3D**, then open that C3D in the viewer.

## OptiTrack cameras and Motive

OptiTrack cameras belong to one program at a time: while Motive has them open, nothing else can read them (the Motive API reports the cameras as taken). The Windows app works alongside Motive in two ways.

**Track a camera's picture from Motive's window.** In the camera list, choose **Screen or window…**, pick Motive's window, and drag a box around one camera's view in Motive's 2D Camera viewport (or track the whole window). Hand Tracker then tracks hands in that picture live while Motive keeps recording. The picture isn't mirrored, and it works with any other window or screen too.
- Prime Color cameras give full-colour video, which tracks well.
- Infrared cameras only show a usable picture when Motive displays them in grayscale or MJPEG video mode, and hand detection on infrared pictures is less reliable.
- Motive's window must stay open, not minimised. It can be covered by other windows.

**Receive Motive's live data.** The **OptiTrack Motive** panel connects to Motive's NatNet stream: labelled markers, rigid bodies and skeletons, shown live from the front with the stream's rate. In Motive, open View → Streaming Pane and turn on **Broadcast Frame Data**. Enter the address of Motive's PC (127.0.0.1 if it's this one) and match its **Transmission Type** (multicast is Motive's default). NatNet 3.0 to 4.1 (Motive 2 and 3) are supported.
- While motion capture records, every Motive frame is recorded too.
- **Record Video** can include Motive's view below the camera's (and the 3D view), as it's drawn live. These layouts are offered while Motive is connected; a chosen one comes back when Motive reconnects. If Motive disconnects mid-recording, its part of the video says so.
- Motive's data is exported next to the hand files as `<name>-motive.c3d`, `.trc`, `.csv`, `.glb`, `.npz` or `.json`, in each chosen format that holds markers. It includes labelled markers, rigid-body pivots and skeleton bones.
- Positions are in millimetres, Z-up: the same axes as Motive's own C3D export, so a live recording lines up with the same take opened as `.tak`.
- Both recordings start together. Motive's keeps its own frame rate and numbering, and dropped network packets leave gaps.
- The **Android app** receives Motive's live data too: enter the address of Motive's PC (the phone must be on the same Wi-Fi). It's recorded and exported the same way.

## Tracking a video file

Click **Open Video…** next to the camera picker to track hands in a recorded video instead of the live camera. A transport bar appears with restart, play/pause, seek, speed, **Capture Whole Video** and **Use Camera**.

- **Every frame is tracked.** Playback pauses while each frame is analysed and then continues, so no frame is skipped, however slow the computer. On a slow machine the video just plays more slowly.
- **Timing comes from the video**, not from how fast it was processed. Motion capture timestamps match the footage exactly, and the frame rate is measured from the video (shown next to FPS).
- **Capture Whole Video** rewinds, records motion capture across the whole video, and stops at the end, ready to export.
- **Mirrored video**: Android phones save front-camera (selfie) videos mirrored, the way the preview looked. In a mirrored video every hand looks like the other one, so your right hand is labelled Left for the whole video (and moves the wrong way in the motion data). With **Mirrored video** on in the transport bar, the video is flipped back before tracking, so Left and Right, positions and exports are as a normal camera would have seen them. Motion captured from it notes that it was flipped.
  - **Phone videos are handled automatically.** The app reads the video's metadata (MP4 and MOV): a video from an Android phone opens with Mirrored video on, and a note says why, unless it's from the back camera. The file doesn't name the camera, but its rotation gives it away when the phone was held upright (the two cameras' sensors are mounted opposite ways round). Held sideways there's no telling, so it's taken to be the front camera; turn Mirrored video off for a back-camera video. iPhones save selfie videos the right way round, so they, like webcam and other videos, open with it off.
  - Turning it on or off is remembered for that video (by file name) and wins over the automatic choice.
- **Recording video from a file**: the annotated video is re-timed to the source frame rate on export, so it plays at the original speed.
- **Formats:**
  - Formats the device plays itself (MP4, MOV, M4V, MKV, WebM, and more depending on the device) open directly.
  - Anything else is converted automatically first, with progress shown over the camera view: AVI, MPEG-1/2 (`.mpg`, `.mpeg`, `.vob`), WMV/ASF, FLV, 3GP, Ogg Theora, MPEG-TS (`.ts`, `.m2ts`), MXF, DV, ProRes, Y4M, GIF and others ffmpeg can read. The Windows app uses its bundled ffmpeg; the website and Android app use ffmpeg.wasm on the device.
  - The file picker also offers camcorder files (`.mod`, `.tod`, `.m2t`), GoPro and Insta360 files (`.lrv`, `.360`, `.insv`), Phantom high-speed camera files (`.cine`), Windows Media Center and TiVo recordings (`.wtv`, `.dvr-ms`, `.ty`), Dahua CCTV recordings (`.dav`), RealVideo (`.rm`, `.rmvb`, `.ivr`), broadcast GXF and LXF, raw AV1 (`.obu`), and game video (Bink, Smacker, FLIC, RoQ, THP, PlayStation STR, Xbox XMV). A file is recognised by what's inside it, not its name, so a video with an unusual extension still opens (choose *All files* in the picker).

## Several videos at once

Choose more than one video in **Open Video…** (the cameras of a capture rig, say). A *Several videos* panel lists them, each with a **role**: where its camera was worn (*Head*, *Chest*, *Left wrist* or *Right wrist*), taken from its name when it says (`…_head.mp4`, `wrist_left.mp4`, `R-wrist.mov`) and otherwise given in order; pick another in the *Role* column (a video that had it swaps). It tracks each in turn, every frame at the video's own speed (as **Capture Whole Video** does), then lines them up from the hand movement in them.

- **When they line up**, a green message says how much later each video started and how well it matched.
  - **Save synced motion capture…** saves each video's motion capture on one shared clock: `t = 0` is the moment every video was running, and each file is trimmed to the stretch all of them cover. Files are named `<name>-<role>` (`<name>-head`, `<name>-wrist_left`…; `<name>-<video>` for a video with no role) in the formats you pick, each saying its role (`camera_role`), with `<name>-sync.json` next to them: each video's role, offset, where the shared stretch starts in it (`trim_start_s`), its length and how well each matched. In every file, `time_origin_s + t` is still the time in that video.
  - **Export synced videos in the Recording Viewer** puts the videos in the viewer's [export queue](#the-export-queue), each trimmed to the same stretch, so the converted videos (`<video>-synced`) start and end together.
- **When they don't**, a red message says *The motion capture data doesn't line up*, and why for each video: no hands were seen, the hands hardly move, the movement doesn't match, it only matches for part of the time, or it repeats so that several lineups fit.
  - **Add to motion capture queue**: each video's motion capture is saved on its own (`<video>-motion`). Videos already tracked aren't tracked again. **Add videos…** puts more in the queue (they're tracked when it runs), and **Capture and save all…** works through it; the Windows and Linux app asks for a folder once.
  - **Add to Recording Viewer queue**: each video is converted on its own, whole.
- **How it works:** 30 times a second, the app measures how fast the hands move in each video (the wrists and fingertips, in hand lengths per second, so a near and a far camera measure alike). It slides each video along the longest one to find where the movement matches best. Slow changes are ignored (every session starts with hands resting, then moving), because the detail of the movement is what tells two sessions apart. A lineup is trusted only when it matches well overall and in each half of the shared stretch, and no other lineup fits nearly as well. Offsets come out to within about a frame.
- **For a good sync**, each camera should see at least one hand moving for most of the time, and the videos should overlap for at least half of the shortest one (and 2 seconds). A few claps or a quick wave at the start helps.

## Video export

Press **Record Video**, choosing whether to include just the camera view or the camera view with the 3D view below it. While Motive's live data is connected (Windows and Linux app), Motive's view can go below them too: **Camera + Motive view** or **Camera + 3D + Motive view**. When you stop, a preview appears; pick one or more of the [36 formats](#video-formats) (and, in the Windows app, a folder).

## Converting videos

In the **Recording Viewer**, click **Open Video…** (or drop a video on it) to open a video in nearly any format: everything in the list under *Tracking a video file*, and anything else ffmpeg can read. The viewer plays it (converting a preview copy first if the device can't play it), shows its length, size, frame rate, codec and whether it has sound, and converts it to any of the formats below. Pick as many as you like, or **Select all**.

- Conversion always starts from the original file, and keeps the sound wherever the format has sound.
- **Windows app:** choose a folder; **Show in folder** opens each result.
- **Website:** each file downloads as soon as it's ready. Nothing is uploaded.
- **Android app:** files are saved to Documents/Hand Tracker, each with a **Share** button.
- ffmpeg.wasm runs on one processor core, so long or high-resolution videos take a while on the website and phone; the Windows app is several times faster.

### The export queue

Choose or drop several videos at once in the Recording Viewer and they go into its **Export queue**. So do videos sent from the tracker's [several-videos panel](#several-videos-at-once), including synced ones, which are trimmed to the stretch they share. The queue is shared by the tracker and the viewer (an open viewer shows new videos straight away) and is still there after a restart.

Pick formats and click **Convert all**. The videos are converted one after another, each on its own, into one folder (Windows and Linux app), as downloads (website) or into Documents/Hand Tracker (Android). A video leaves the queue once it has converted; if anything failed, it stays for another go. On the website and Android, the browser keeps a copy of each queued video until it leaves the queue; the desktop app only remembers where the file is.

### Video formats

| Format | Codec | Good for |
| --- | --- | --- |
| **Common** | | |
| MP4 | H.264 | Plays almost everywhere |
| MOV | H.264 | QuickTime and video editors |
| WebM | VP9 (VP8 on the website and phone) | Web pages and browsers |
| MKV | H.264 (recordings: the original VP9, unchanged) | Matroska players, archiving |
| AVI | MPEG-4 (Xvid) | Older players and software |
| GIF | Animated, 15 fps, up to 800 px wide | Chat and docs |
| **More formats** | | |
| M4V | H.264 | Apple devices and iTunes |
| WMV | Windows Media Video 8 | Windows Media Player, PowerPoint |
| MPG | MPEG-2 | DVD-era players |
| MPEG-1 | MPEG-1 | Plays on nearly anything |
| VOB | MPEG-2, AC-3 sound | DVD video files |
| TS | H.264 in MPEG transport stream | Broadcast and streaming |
| M2TS | H.264, AC-3 sound | Blu-ray and AVCHD camcorders |
| FLV | H.264 | Flash Video players |
| 3GP, 3G2 | H.264 (baseline) | Older phones |
| OGV | Theora, Vorbis sound | Open-source players |
| RM | RealVideo 2, up to 720 px wide, AC-3 sound | RealPlayer-era players |
| **Newer codecs** (Windows app only) | | |
| HEVC | H.265 in MP4 | About half the size of H.264 |
| AV1 | AV1 in WebM | Smallest files; slow to make |
| AV1 MP4 | AV1 in MP4 | Small files that play on phones and Windows; slow to make |
| **Editing** | | |
| ProRes | ProRes 422 in MOV | Final Cut, Premiere, Resolve |
| DNxHR | DNxHR HQ in MOV | Avid, Premiere, Resolve |
| CineForm | GoPro CineForm, 10-bit, in MOV | Premiere, Resolve (width rounded to a multiple of 16) |
| MXF | MPEG-2 4:2:2 | Broadcast |
| Motion JPEG | MJPEG in AVI | Frame-accurate editing |
| DV | DV, 720 × 480 (NTSC) or 576 (PAL) | MiniDV tools; letterboxed to fit |
| **Lossless and uncompressed** | | |
| FFV1 | Lossless, in MKV | Archiving; the smallest lossless files |
| UT Video | Lossless, in AVI | Editors and capture software; fast |
| HuffYUV | Lossless, in AVI | Older editors (VirtualDub and others) |
| QuickTime Animation | Lossless RLE, in MOV | Classic editing format |
| Uncompressed AVI | Raw RGB frames (Windows app only) | MATLAB, OpenCV and other research tools; about 80 MB a second at 720p |
| Y4M | Raw YUV frames, no sound (Windows app only) | Encoders and research tools; about 40 MB a second at 720p |
| **Animated images** | | |
| WebP | Animated WebP, 15 fps, up to 800 px wide | Web pages, chat |
| APNG | Animated PNG, 15 fps, up to 640 px wide | Lossless animations |
| AVIF | Animated AV1, 15 fps, up to 800 px wide (Windows app only) | Far smaller than GIF; modern browsers |

MPEG-1, MPG, VOB, MXF and DV only allow standard TV frame rates, so they use the nearest one (24, 25, 29.97, 30, 50, 59.94 or 60 fps). RealMedia can't hold a frame over 64 kB, so RM is kept to standard definition, as RealPlayer-era video was. The Windows app converts with the ffmpeg bundled with it (`ffmpeg-static`); the website and the Android app with ffmpeg.wasm (`@ffmpeg/ffmpeg`), whose VP9 encoder crashes (hence VP8 for WebM there). ffmpeg.wasm has no AV1 encoder and its HEVC encoder needs threads it doesn't have, so for HEVC, AV1 and AVIF it decodes the frames and the device's own encoder (WebCodecs) compresses them, then ffmpeg.wasm puts them, with the sound, in their container (`video-native.js`). Uncompressed AVI (OpenDML over 1 GB, as ffmpeg writes it) and Y4M are written a stretch at a time. So the website and phone offer all 36, except HEVC, AV1 or AVIF on a device without that encoder. Both are GPL builds of [FFmpeg](https://ffmpeg.org), whose source is available from the FFmpeg project.

## Motion JSON layout (format_version 2)

```text
{ format_version: 2, frame_rate, duration, recorded_at, image_size: [w, h], display_mirrored,
  coordinate_frame, notes,
  metadata: { contributor, location, task, length, length_s }   (takes from remote recording)
  hands: [ { handedness: "Left" | "Right", frame_rate,
             frames: [ { frame_index, t, joints: [ { name, position, orientation, velocity, acceleration } × 21 ] } ],
             trajectories: { end_effector: [[t, x, y, z]], palm_orientation: [[t, qx, qy, qz, qw]] },
             task_segments: [ { phase, start_frame, end_frame } ] } ] }
```

Files from earlier single-hand versions (with `frames` at the top level) still open in the Recording Viewer.

## Build the desktop apps

```bash
npm run dist
```

This writes `dist/HandTracker-<version>-portable.exe`, a single file that runs without installing. For a regular installer with Start-menu shortcuts, use `npm run dist:installer`.

```bash
npm run dist:deb
```

This writes `dist/hand-tracker_<version>_amd64.deb`, the Linux app, with an app-menu entry and icon. Build it on Linux (or in WSL on Windows): the app bundles the ffmpeg that `npm install` downloaded, which is for the computer it ran on.

## Web version

The hosted web version at **https://hand-tracker.pages.dev** is the same bundle the Android app uses (`www/`, built by `scripts/build-web.js`), served over HTTPS so browsers allow the camera.

The website's source is the GitHub repository **[alexandermulholland92/hand-tracker](https://github.com/alexandermulholland92/hand-tracker)**. Every push to `main` builds the site and publishes it (`.github/workflows/deploy-website.yml`). That needs one repository secret, `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with the **Cloudflare Pages: Edit** permission (Cloudflare dashboard → My Profile → API Tokens → Create Token), added under the repository's Settings → Secrets and variables → Actions. Without it, the workflow builds the site but doesn't publish it.

To publish from this PC instead:

```bash
npm run deploy:web
```

This builds `www/` and uploads it to Cloudflare Pages (project `hand-tracker`) with Cloudflare's `wrangler` tool, updating both https://hand-tracker.pages.dev and the older https://main.hand-tracker.pages.dev address. Each upload also gets its own permanent address (`https://<id>.hand-tracker.pages.dev`), so an earlier version stays reachable. Sign in once first. This asks only for the permission Pages needs, not wrangler's default full access:

```bash
npx wrangler@4 login --scopes account:read user:read pages:write offline_access
```

## Android app

`dist/HandTracker-1.1.0.apk` runs the same app on Android 7.0 or newer, fully offline.

**Install it:**

1. Copy the APK to your phone (USB, Google Drive, email…).
2. Open it from the phone's Files app.
3. If Android asks, allow your file manager to *install unknown apps*.

From a PC with USB debugging turned on, you can use `adb install dist/HandTracker-1.1.0.apk` instead. The first time you start tracking, allow camera access.

**What's different on a phone:**

- **Video** is recorded as **MP4** by the phone's own video encoder, and plays in the gallery and every app. The other formats are converted on the phone with ffmpeg.wasm, which downloads once, about 32 MB. HEVC, AV1 and AVIF use the phone's own encoders, where it has them (a format the phone can't make says so); uncompressed AVI and Y4M are made a stretch at a time and saved in parts, so they never have to fit in memory at once.
- **OptiTrack Motive's live data**, **controlling a PC over Wi-Fi** and **controlling the phone itself** work on the phone too; see [OptiTrack cameras and Motive](#optitrack-cameras-and-motive) and [Control your PC](#control-your-pc).
- **Motion capture** exports all 7 formats, exactly as on the desktop.
- Files are saved to **Documents/Hand Tracker** on the phone. Each saved file has a **Share** button to send it to Photos, Drive, email or another app.
- The screen stays on while the app is open, so tracking and recording aren't interrupted.
- The Recording Viewer opens in the same screen, with a *Back to tracker* link.

**Rebuild the APK** (needs Android Studio, which provides Java and the Android SDK):

```bash
npm run android:apk
```

This bundles the web app into `www/`, copies it into the Android project with Capacitor, builds it with Gradle, and writes `dist/HandTracker-<version>.apk`. The first build downloads Gradle and the Android build libraries. It also downloads a Java 21 JDK, because one plugin asks for that exact version. You can also open the `android/` folder in Android Studio.

The APK is signed with Android's standard **debug** key. That's fine for installing on your own devices. To publish on Google Play, build a release version signed with your own key in Android Studio (*Build → Generate Signed App Bundle / APK*).

## Automated check

```bash
npm run check
```

This launches the app with Chromium's fake camera, playing a generated test pattern with a running clock (`scripts/fake-camera.js`). It simulates two hands, records motion and video, and exports every format. It then verifies each file with an independent reader:

- **BVH** is replayed with forward kinematics and compared bone by bone with the recording.
- **GLB** is played in three.js.
- **C3D** is read directly from the file-format spec.
- **NPZ** is loaded with NumPy (so it needs Python with NumPy).
- **Videos** are decoded with ffmpeg and checked to be the right codec, with sound where the source had it (animated WebP by its structure, since ffmpeg 6.1 can't read it back).

Chromium's built-in fake camera (its generated picture) crashed its capture process now and then when opened, about one start in three on one PC, and every camera check after that failed; one that plays a file never did, so the checks use that (made once with the bundled ffmpeg). If the camera does crash, the run says so and starts again, up to three times in all; a page that stops answering for four minutes fails the run with what Chromium's processes did, instead of waiting forever.

It opens two simulated cameras of one moment together (the second started 1.5 s later) and checks that they sync to within a frame. The saved motion capture must be on one clock, and the converted videos must start on the same moment. A video of something else must get the error, then go through both queues.

It also opens the Recording Viewer with new, old and deliberately malicious files, and converts a WMV with sound to all 36 video formats in it. For OptiTrack, it connects to a stand-in Motive (NatNet 4.1, over multicast and unicast), records its stream with motion capture and checks the exported markers' names, rate, axes and scale, and records video with Motive's view below the camera's. It also tracks a part of the screen chosen in the Screen or window picker. Windows will briefly appear on screen while it runs.

There is also a check for the Android code:

```bash
npm run check:android
```

It runs the exact bundle that goes into the APK in a phone-sized window, with a simulated Android file system and share sheet. It records, saves the MP4 and all 7 motion formats through the Android save path, and verifies them with the same readers as above. It converts with ffmpeg.wasm as a phone does: the recording into other formats, an AVI opened for tracking, and a WMV with sound in the Recording Viewer into 16 formats, among them HEVC, AV1, AVIF, uncompressed AVI and Y4M. It receives a stand-in Motive's stream over multicast and unicast and records it, controls a stand-in PC over the network after pairing with its code, and starts phone control and drives its control window with simulated hands. It also checks the phone layout, the OCR, Share, and the viewer's Back link. The app's own Android plugins (Motive's network stream, the network link to a PC, phone control, saving and sharing) are stood in for by `scripts/fake-capacitor.js` with the same behaviour; they themselves can only be exercised on an actual phone.

And one for OAK camera support, without a camera (GitHub runs it on Linux, on a 64-bit PC and 64-bit ARM):

```bash
node scripts/check-oak.js
```

It runs the real one-time OAK setup into an empty folder (about 150 MB), then checks that it's ready, that depthai can look for cameras, and that the OAK helper streams frames from its simulated camera.

## Project layout

| File | Purpose |
| --- | --- |
| `hand-tracker.js` | Camera, MediaPipe, smoothing, features, orientation, stall recovery, square crop, pause, far-away focusing, external (OAK) frames |
| `far-hands.js` | Far-away hands: MediaPipe Pose and the square to search around the wrists |
| `pc-control.js` | Hand mouse, gesture actions and the Control your PC card |
| `gestures.js` | Names each hand's gesture from its landmarks (shared by the main window and phone control) |
| `phone-link-protocol.js`, `phone-link-ui.js`, `qr-code.js` | A phone controlling a PC over Wi-Fi: the signed messages, the pairing (with the QR code) on both sides |
| `phone-control.html`, `phone-control.js` | Android: the small window that tracks your hand while controlling the phone itself |
| `multi-camera.js`, `camera-tile.html`, `camera-tile.js` | Several cameras at once, each tracked in its own tile |
| `remote-record-ui.js`, `electron/remote-record.js`, `remote-client.html`, `remote-client.js` | Remote recording: the Record card's part, the small web server, and the remote recording page (served to phones, and shown in the apps) |
| `electron/wifi.js` | The computer's Wi-Fi through NetworkManager (Linux), for changing it from the remote recording page |
| `pi/hotspot-setup.sh` | A Raspberry Pi's own Wi-Fi hotspot, on from boot alongside its normal Wi-Fi |
| `remote.html`, `remote-launcher.js` | The website's Remote recording page: opens a computer's remote recording page by its name |
| `motion-video.js` | Draws a recording's playback into a video (WebCodecs and a small WebM writer) |
| `natnet-parse.js` | OptiTrack Motive's NatNet protocol (shared by the desktop and Android apps) |
| `keyboard.html`, `keyboard.js` | The floating keyboard |
| `oak-source.js` | A Luxonis OAK camera as the source: setup dialog, frames into HandTracker |
| `oak/` | OAK tracking code from depthai_hand_tracker, and `oak_bridge.py`, which streams its hands and pictures to the app |
| `robot-motion.js` | Two-hand motion capture recorder |
| `motion-export.js` | CSV / BVH / GLB / C3D / TRC / NPZ writers (hands and markers) |
| `motion-import.js` | Reads JSON, CSV, C3D, TRC, BVH, NPZ and GLB back in (with a C3D reader built from the format's published description), as hands where they hold Hand Tracker's hands |
| `export-ui.js` | Export panels shared by the main window and the viewer |
| `hand-3d.js` | Three.js view of both hands and grippers |
| `video-recorder.js` | Records the camera view (and the 3D and Motive views) with MediaRecorder |
| `video-formats.js` | The 36 video export formats and their ffmpeg settings, and the file types the pickers offer (shared by all three versions) |
| `video-convert.js` | Website and Android: opening and converting videos with ffmpeg.wasm |
| `video-native.js` | Website and Android: HEVC, AV1 and AVIF with the device's own encoders, and uncompressed AVI and Y4M made in parts |
| `multi-video.js` | Several videos at once: tracking them in turn, syncing, and the motion capture queue |
| `video-sync.js` | Lines videos up from the hand movement in them, and puts their motion capture on the shared clock |
| `video-queue.js` | The Recording Viewer's export queue (kept in the page's database, shared by the tracker and the viewer) |
| `video-origin.js` | Reads a video's metadata to tell a phone's front-camera video (saved mirrored) from its back-camera one |
| `readable-text.js` | Keeps text in the camera picture readable when mirrored |
| `app.js`, `index.html` | Main window |
| `viewer.js`, `viewer.html` | Recording Viewer |
| `mobile-bridge.js` | Android: saving to Documents/Hand Tracker and sharing (Capacitor plugins), Motive's live data, controlling a PC or the phone |
| `electron/` | Desktop app: secure local file serving, camera permission, save dialogs, ffmpeg export, `.tak` support through Motive (`tak.js`, `tak-convert.ps1`), Motive's live NatNet stream (`natnet.js`), mouse and keyboard input (`input.js`, `input-helper.ps1`), a phone controlling the PC (`phone-link.js`), and OAK cameras (`oak.js`) |
| `android/`, `capacitor.config.json` | Android app project (Capacitor): permissions, icon, keep-screen-on, and the app's own plugins (Motive's network stream, the network link to a PC, phone control and its accessibility service) |
| `scripts/` | `serve.js` (browser mode), `build-web.js` + `build-android.js` (APK build), `check.js`, `check-android.js`, `check-oak.js`, `run-checks.js` (runs them, again if the fake camera crashed), `motion-validators.js`, `video-validators.js`, `natnet-sim.js` (a stand-in Motive for the checks), `fake-camera.js` (the checks' test camera), `fake-capacitor.js`, `simulated-hands.js`, `fixtures/` (automated checks) |

## Limitations

- Depth (z) comes from MediaPipe's single-camera estimate, not a measurement; see the note on scale above.
- A hand held in front of your face is hard for MediaPipe to find, because there's little contrast between skin and skin: an open hand already being tracked usually stays tracked, but a fist or a pointing hand in front of the face often isn't found at all (tested live; lowering MediaPipe's confidence thresholds didn't help and made it mistake the face for a hand). Keep the hand beside your face, or against a contrasting background. When MediaPipe reports the same hand twice it's counted once, and a hand lost for a moment (up to 150 ms) stays on screen so the skeleton and labels don't flicker.
- Task phases (reach / grasp / manipulate / release) come from simple thresholds on finger curl and wrist speed, not a trained classifier.
- BVH joint rotations are reconstructed from joint positions. Twist along a finger bone can't be recovered from landmarks, so fingers bend but never twist.
- Readable-text detection scans about twice a second and waits for three matching scans, so text straightens about a second after it appears, and text that moves quickly can stay mirrored.
- *Black gloves* has been tested on photos of real hands recoloured as black gloves, not yet on real gloves; very shiny gloves with bright highlights may be found less well.
- Syncing finds one offset per video. It doesn't correct for cameras whose clocks run at slightly different speeds, which over a long recording can add up to a frame or two.
- On the website and the Android app, a video is converted in the device's memory, so very large files (roughly over 1 GB) may fail; use the Windows app for those.
- Several cameras at once: each camera has its own tracker, so each runs slower than a single camera would, and a phone or a Raspberry Pi may manage only two.
- Controlling the phone itself and a PC from the phone have been checked with stand-ins for the phone's own parts (its accessibility service, overlay and network); on a real phone, gestures that need precise placement (small buttons) are easier with a larger *Moves* setting.
- Tracking keeps running when the window is covered or minimized (minimized, at a slightly lower frame rate), so the hand mouse keeps working.
- If the graphics driver resets or its process crashes, MediaPipe loses its WebGL context. Hand Tracker notices and starts MediaPipe (and the far-away-hands body model) again, skipping a frame or two, instead of tracking stopping for good. A camera that stops sending frames is reopened the same way.
- Two, Three and Four are checked on simulated hands; unlike the other gestures, they haven't been tuned on photos or a live session yet.

## License

Hand Tracker is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE). It includes code from [depthai_hand_tracker](https://github.com/geaxgx/depthai_hand_tracker) by geaxgx (MIT licence) and uses Google's MediaPipe (Apache 2.0); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
