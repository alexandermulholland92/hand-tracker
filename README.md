# Hand Tracker

Real-time tracking of **both hands** from a webcam (MediaPipe Hands, 21 landmarks per hand), with a live 3D view, gesture and finger-curl readouts, **motion capture export in 7 formats**, **video recording**, and a **video converter** that opens nearly any video format and exports **36 formats**. Runs as a Windows or Linux desktop app, an Android app, or in a browser.

## Run it

**On the web:** open **https://hand-tracker.pages.dev** in Chrome, Edge or Safari, on a computer or a phone. Nothing to install, and tracking runs entirely on your device; no video leaves it.

**Windows app:** double-click `dist/HandTracker-1.1.0-portable.exe`. Nothing to install; it works offline.

**Linux app** (Ubuntu, Debian, Mint and others that install `.deb` packages): run `sudo apt install ./dist/hand-tracker_1.1.0_amd64.deb`, then open **Hand Tracker** from the app menu or run `hand-tracker`. It works offline and does everything the Windows app does except open OptiTrack `.tak` takes, which needs Motive, and Motive only runs on Windows (export a take from Motive as C3D and open that instead). Motive's live data does work. To remove it: `sudo apt remove hand-tracker`.

**Download the latest build:** every change to `main` rebuilds the Windows, Linux and Android apps on GitHub and puts them on the [Latest build](https://github.com/alexandermulholland92/hand-tracker/releases/tag/latest-build) release (`.github/workflows/build-apps.yml`). Each APK built there installs over the last one, but it's signed with a different key from one built on your PC, so Android only installs it over a PC-built copy after that copy is uninstalled (and the other way round). The same happens after a week with no builds, when GitHub drops the saved key.

**Android app:** install `dist/HandTracker-1.1.0.apk` on your phone (see [Android app](#android-app) below).

**From source** (Node.js 18+):

```bash
npm install
```

```bash
npm start
```

**In a browser, from source:** run `npm run web` and open http://localhost:8080. Browsers only allow the camera on `localhost` or `https`, so opening `index.html` directly from disk won't work.

Video import and export work in all three: the Windows app converts with its bundled ffmpeg; the website and the Android app use ffmpeg.wasm, which runs on the device (nothing is uploaded) and downloads once, about 32 MB, the first time it's needed. The Windows app is faster, and is the only one that makes HEVC and AV1. Only the Windows app can open OptiTrack `.tak` takes.

## Features

- **Two hands at once**: each hand gets its own card (Left in blue, Right in orange), an on-screen label with its gesture, a 3D skeleton and a simulated robot gripper. A *Both Hands* panel shows the distance between the wrists. Choose *Track: 1 hand* for a little extra speed.
- **Steady tracking**: every landmark is smoothed with a One Euro filter, which holds a still hand steady but follows fast movement closely, so the skeleton doesn't shake and gesture labels don't flicker. Each hand keeps its Left/Right label unless MediaPipe disagrees for several frames in a row.
- **Camera controls**: choose the camera, resolution (640×480 to 1920×1080) and model (Lite for speed, Full for accuracy). Settings are remembered.
- **Track a video file** instead of the camera: *Open Video…* accepts MP4, MOV, MKV, WebM, AVI, MPEG, WMV, FLV, 3GP, Ogg, MPEG-TS, MXF, DV, ProRes, GIF and more; see [Tracking a video file](#tracking-a-video-file). Android phone selfie videos, which are saved mirrored, are flipped back automatically; for any other video where Left and Right come out swapped, turn on *Mirrored video*.
- **Convert any video**: the Recording Viewer's *Open Video…* opens nearly any video and converts it to any of 36 formats; see [Converting videos](#converting-videos).
- **Mirror view with readable text**: front (selfie) cameras and webcams are shown mirrored so movements feel natural; rear cameras and video files are shown as they are. The Mirror button switches it, and the app remembers your choice for each camera. Times in the picture, like a clock or a timestamp, are always shown the right way round: the app finds them with on-device OCR (tesseract.js, bundled) and flips them back. Other text (signs, screens, printing) reads backwards unless you turn on the optional **Readable text** button (off by default; your choice is remembered), which flips all text back. The app's own labels are always drawn the right way round. To avoid flipping things that only look like text (cloth, shadows, stripes), an area is only shown the right way round once it has been read as text in three scans running, so real text straightens about a second after it appears. Anything read on or right next to a hand is ignored too (OCR takes an OK sign's ring for an "O"), so no flipped patch is left behind when the hand moves away.
- **Gestures**: pinch, OK sign (thumb and index in a ring, the other fingers out), thumbs up, fist, open palm, peace (at any angle, upright, leaning or on its side), rock on, call me, shaka, point, thumbs down, *live long and prosper* (the Vulcan salute: fingers in two pairs with a V between the middle and ring fingers) and *the bird* (only the middle finger raised, pointing up or sideways but not down, with the hand facing the camera rather than side-on; sideways counts so it still works on a phone held on its side), plus palm yaw/pitch/roll and per-finger curl. Call Me and Shaka are the same hand shape: rocking the wrist back and forth makes it Shaka, holding it still is Call Me. A label must hold for a few frames before it changes, so it doesn't flicker. Gestures are judged mostly by how far each fingertip reaches from the wrist (in palm lengths), which holds up on real hands better than finger-bend angles do; the rules are checked against 202 hands measured from real photos (`scripts/fixtures/gesture-hands.json`) and were tuned on a live webcam session.
- **Recording Viewer** (header link or *File → Open Recording Viewer*): opens hand recordings (JSON, CSV), **C3D** files and **OptiTrack `.tak`** takes. You can play them back, browse the frames, and convert them to other formats; see [Viewing and converting recordings](#viewing-and-converting-recordings).
- **Recovers from camera dropouts**: if the camera stops sending frames, the app shows a notice and reconnects automatically.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `R` | Start / stop video recording |
| `M` | Start / stop motion capture |
| `O` | Toggle the skeleton overlay |

## Motion capture export

Press **Start Motion Capture**, do the movement, press **Stop**, then pick formats in the *Export Motion Capture* panel. Both hands are recorded on one shared clock.

| Format | Opens in | Contents |
| --- | --- | --- |
| **JSON** | Anything; the Recording Viewer | Everything: 21 joints per frame with position, orientation, velocity and acceleration, plus trajectories and task phases |
| **CSV** | Excel, Google Sheets, pandas, MATLAB | One row per hand per frame. Columns: `hand, frame, t, phase`, the wrist's camera-frame position (`wrist_world_x/y/z`), the palm quaternion, x/y/z for all 21 joints relative to the wrist (`wrist_x` … `pinky_tip_z`), and `image_width, image_height`. Can be imported back (see below) |
| **BVH** | Blender, Maya, MotionBuilder, Cinema 4D; Unity/Unreal via Blender | Animated skeleton, one file per hand (`…-left.bvh`, `…-right.bvh`) |
| **GLB** (glTF 2.0) | Blender, three.js, Unity, Unreal, Windows 3D Viewer | Animated 3D hands (joints and bones) that play straight away |
| **C3D** | Vicon Nexus, Qualisys, Visual3D, Mokka, ezc3d | 42 3D markers (21 per hand); frames where a hand wasn't visible are marked invalid |
| **TRC** | OpenSim | The same 42 markers as a text table |
| **NPZ** | Python / NumPy (`np.load`) | Per hand: `left_t`, `left_joints` (T×21×3), `left_wrist`, `left_palm_quat`, `left_phase`; plus `joint_names`, `parents` |

Units and axes:

- **JSON, CSV and NPZ** keep MediaPipe's raw units: x and y as fractions of the image width/height, and z as relative depth. The joint positions are relative to the wrist.
- **BVH, GLB, C3D and TRC** are converted to real-world-style units: BVH in cm, GLB in m, C3D and TRC in mm. They use right-handed axes: Y-up for BVH, GLB and TRC; Z-up for C3D.
- A single webcam can't measure distance, so the size is **estimated** by assuming an average adult hand (wrist to middle fingertip ≈ 19 cm). Treat absolute distances as approximate; relative motion and angles are what's reliable.
- The 3D formats show the hands as the camera saw them (not mirrored), so a left hand stays a left hand.

## Viewing and converting recordings

The **Recording Viewer** opens:

| File | Where it comes from | Notes |
| --- | --- | --- |
| **JSON** | Hand Tracker's motion capture | All versions, including older single-hand files |
| **CSV** | Hand Tracker's CSV export, including after editing it in Excel or Google Sheets | Handles semicolon separators, decimal commas and reordered rows. Joint orientations and velocities are recalculated from the positions, and task phases come from the `phase` column, so your edits carry through |
| **C3D** | Any motion capture system: Vicon, Qualisys, OptiTrack Motive, and Hand Tracker itself | Read as labelled 3D markers, converted to millimetres, with gaps kept as gaps |
| **Motive CSV** | OptiTrack Motive's CSV export | Markers, rigid-body centres, solved rigid-body markers and bones, as points (rotations aren't shown). Converted so the take looks the same as when it's opened as `.tak` or C3D: Motive's CSV is a mirror image of its C3D and internal coordinates |
| **TRC** | OpenSim, OptiTrack Motive, and Hand Tracker | Y-up TRC is turned Z-up with the standard OpenSim rotation |
| **.tak** | OptiTrack Motive takes | Windows app only, and **OptiTrack Motive must be installed on that PC** (see below) |

For every recording you get:

- A summary.
- **Playback**: hand skeletons for hand recordings, and markers with front, side and top views for C3D and `.tak`.
- A **frame table**; click a row to jump to it.
- An **Export** panel that converts the recording:
  - **Hand recordings** can be exported to all 7 motion capture formats. So a CSV you edited can become BVH, GLB, C3D and so on.
  - **Marker recordings** (C3D, `.tak`) can be exported to C3D, TRC, CSV, GLB, NPZ and JSON.

Any file can be chosen or dropped either way: recordings (`.json`, `.csv`, `.c3d`, `.trc`, `.tak`) open in the viewer, and everything else opens as a video.

The **Markers** list, the **frame table** and the export **Formats** list start collapsed to one line, which says what's inside (for example "42 markers" or the formats that are ticked). Click **Show** to open them and **Hide** to fold them away again. The video converter's format list works the same way.

In the frame table for hand recordings, joint positions are measured **from the wrist**, so the wrist joint is always 0, 0, 0. *Wrist world* is where the wrist is in the camera image; its z is always 0, because the tracker measures depth relative to the wrist.

### OptiTrack .tak takes

`.tak` is OptiTrack's proprietary, undocumented format, which only OptiTrack's own software can read. So Hand Tracker opens takes through the **Motive installed on your PC**. A small script (`electron/tak-convert.ps1`) uses Motive's NMotive API to read the take. None of OptiTrack's software is bundled with Hand Tracker. Your original take is never modified; Motive works on a temporary copy.

- **Viewing**: Motive exports the take's markers to C3D behind the scenes, and the viewer shows them.
- **Exporting**: C3D, TRC, CSV (Motive's format, including rigid bodies) and FBX come from **Motive's own exporters**. BVH is also available when the take contains a skeleton; Motive only writes BVH for skeletons. GLB, NPZ and JSON come from Hand Tracker.
- **Without Motive** (another PC, the Android app, or the website): in Motive, use *File → Export Tracking Data* to save the take as **C3D**, then open that C3D in the viewer.

## OptiTrack cameras and Motive (Windows app)

OptiTrack cameras belong to one program at a time: while Motive has them open, nothing else can read them (the Motive API reports the cameras as taken). The Windows app works alongside Motive in two ways.

**Track a camera's picture from Motive's window.** In the camera list, choose **Screen or window…**, pick Motive's window, and drag a box around one camera's view in Motive's 2D Camera viewport (or track the whole window). Hand Tracker then tracks hands in that picture live while Motive keeps recording. The picture isn't mirrored, and it works with any other window or screen too.
- Prime Color cameras give full-colour video, which tracks well.
- Infrared cameras only show a usable picture when Motive displays them in grayscale or MJPEG video mode, and hand detection on infrared pictures is less reliable.
- Motive's window must stay open, not minimised. It can be covered by other windows.

**Receive Motive's live data.** The **OptiTrack Motive** panel connects to Motive's NatNet stream: labelled markers, rigid bodies and skeletons, shown live from the front with the stream's rate. In Motive, open View → Streaming Pane and turn on **Broadcast Frame Data**. Enter the address of Motive's PC (127.0.0.1 if it's this one) and match its **Transmission Type** (multicast is Motive's default). NatNet 3.0 to 4.1 (Motive 2 and 3) are supported.
- While motion capture records, every Motive frame is recorded too.
- Motive's data is exported next to the hand files as `<name>-motive.c3d`, `.trc`, `.csv`, `.glb`, `.npz` or `.json`, in each chosen format that holds markers. It includes labelled markers, rigid-body pivots and skeleton bones.
- Positions are in millimetres, Z-up: the same axes as Motive's own C3D export, so a live recording lines up with the same take opened as `.tak`.
- Both recordings start together. Motive's keeps its own frame rate and numbering, and dropped network packets leave gaps.

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

## Video export

Press **Record Video**, choosing whether to include just the camera view or the camera view with the 3D view below it. When you stop, a preview appears; pick one or more of the [36 formats](#video-formats) (and, in the Windows app, a folder).

## Converting videos

In the **Recording Viewer**, click **Open Video…** (or drop a video on it) to open a video in nearly any format: everything in the list under *Tracking a video file*, and anything else ffmpeg can read. The viewer plays it (converting a preview copy first if the device can't play it), shows its length, size, frame rate, codec and whether it has sound, and converts it to any of the formats below. Pick as many as you like, or **Select all**.

- Conversion always starts from the original file, and keeps the sound wherever the format has sound.
- **Windows app:** choose a folder; **Show in folder** opens each result.
- **Website:** each file downloads as soon as it's ready. Nothing is uploaded.
- **Android app:** files are saved to Documents/Hand Tracker, each with a **Share** button.
- ffmpeg.wasm runs on one processor core, so long or high-resolution videos take a while on the website and phone; the Windows app is several times faster.

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

MPEG-1, MPG, VOB, MXF and DV only allow standard TV frame rates, so they use the nearest one (24, 25, 29.97, 30, 50, 59.94 or 60 fps). RealMedia can't hold a frame over 64 kB, so RM is kept to standard definition, as RealPlayer-era video was. The Windows app converts with the ffmpeg bundled with it (`ffmpeg-static`); the website and the Android app with ffmpeg.wasm (`@ffmpeg/ffmpeg`), whose VP9 encoder crashes and whose HEVC encoder needs threads it doesn't have, hence VP8 for WebM there and no HEVC or AV1 (it has no AV1 encoder, so no AVIF either). Uncompressed AVI and Y4M are too big to make in a browser's memory, so they're Windows-only too; the website and phone offer the other 30. Both are GPL builds of [FFmpeg](https://ffmpeg.org), whose source is available from the FFmpeg project.

## Motion JSON layout (format_version 2)

```text
{ format_version: 2, frame_rate, duration, recorded_at, image_size: [w, h], display_mirrored,
  coordinate_frame, notes,
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

- **Video** is recorded as **MP4** by the phone's own video encoder, and plays in the gallery and every app. The other formats (all except HEVC and AV1) are converted on the phone with ffmpeg.wasm, which downloads once, about 32 MB.
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

This launches the app with Chromium's built-in fake camera. It simulates two hands, records motion and video, and exports every format. It then verifies each file with an independent reader:

- **BVH** is replayed with forward kinematics and compared bone by bone with the recording.
- **GLB** is played in three.js.
- **C3D** is read directly from the file-format spec.
- **NPZ** is loaded with NumPy (so it needs Python with NumPy).
- **Videos** are decoded with ffmpeg and checked to be the right codec, with sound where the source had it (animated WebP by its structure, since ffmpeg 6.1 can't read it back).

It also opens the Recording Viewer with new, old and deliberately malicious files, and converts a WMV with sound to all 36 video formats in it. For OptiTrack, it connects to a stand-in Motive (NatNet 4.1, over multicast and unicast), records its stream with motion capture and checks the exported markers' names, rate, axes and scale. It also tracks a part of the screen chosen in the Screen or window picker. Windows will briefly appear on screen while it runs.

There is also a check for the Android code:

```bash
npm run check:android
```

It runs the exact bundle that goes into the APK in a phone-sized window, with a simulated Android file system and share sheet. It records, saves the MP4 and all 7 motion formats through the Android save path, and verifies them with the same readers as above. It converts with ffmpeg.wasm as a phone does: the recording into other formats, an AVI opened for tracking, and a WMV with sound in the Recording Viewer. It also checks the phone layout, the OCR, Share, and the viewer's Back link. The real Android file-saving and sharing plugins can only be exercised on an actual phone.

If a camera check fails with "fake test camera crashed", rerun it. Chromium's built-in test camera occasionally drops out on some PCs; this doesn't affect real webcams.

## Project layout

| File | Purpose |
| --- | --- |
| `hand-tracker.js` | Camera, MediaPipe, smoothing, features, orientation, stall recovery |
| `robot-motion.js` | Two-hand motion capture recorder |
| `motion-export.js` | CSV / BVH / GLB / C3D / TRC / NPZ writers (hands and markers) |
| `motion-import.js` | Reads JSON, CSV and C3D back in (with a C3D reader built from the format's published description) |
| `export-ui.js` | Export panels shared by the main window and the viewer |
| `hand-3d.js` | Three.js view of both hands and grippers |
| `video-recorder.js` | Records the camera view (and the 3D view) with MediaRecorder |
| `video-formats.js` | The 36 video export formats and their ffmpeg settings, and the file types the pickers offer (shared by all three versions) |
| `video-convert.js` | Website and Android: opening and converting videos with ffmpeg.wasm |
| `video-origin.js` | Reads a video's metadata to tell a phone's front-camera video (saved mirrored) from its back-camera one |
| `readable-text.js` | Keeps text in the camera picture readable when mirrored |
| `app.js`, `index.html` | Main window |
| `viewer.js`, `viewer.html` | Recording Viewer |
| `mobile-bridge.js` | Android: saving to Documents/Hand Tracker and sharing (Capacitor plugins) |
| `electron/` | Desktop app: secure local file serving, camera permission, save dialogs, ffmpeg export, `.tak` support through Motive (`tak.js`, `tak-convert.ps1`), and Motive's live NatNet stream (`natnet.js`) |
| `android/`, `capacitor.config.json` | Android app project (Capacitor): permissions, icon, keep-screen-on |
| `scripts/` | `serve.js` (browser mode), `build-web.js` + `build-android.js` (APK build), `check.js`, `check-android.js`, `motion-validators.js`, `video-validators.js`, `natnet-sim.js` (a stand-in Motive for the checks), `fake-capacitor.js`, `simulated-hands.js`, `fixtures/` (automated checks) |

## Limitations

- Depth (z) comes from MediaPipe's single-camera estimate, not a measurement; see the note on scale above.
- Task phases (reach / grasp / manipulate / release) come from simple thresholds on finger curl and wrist speed, not a trained classifier.
- BVH joint rotations are reconstructed from joint positions. Twist along a finger bone can't be recovered from landmarks, so fingers bend but never twist.
- Readable-text detection scans about twice a second and waits for three matching scans, so text straightens about a second after it appears, and text that moves quickly can stay mirrored.
- On the website and the Android app, a video is converted in the device's memory, so very large files (roughly over 1 GB) may fail; use the Windows app for those.
- Tracking and recording keep running when the window is covered by other windows, but pause while it is minimized (Windows stops drawing minimized windows).

## License

Hand Tracker is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE).
