// kinect360-helper.cpp — a Kinect for Xbox 360 (Kinect v1) for Hand Tracker on Linux and the Mac
// (electron/kinect.js runs it; kinect/build-kinect360.sh builds it). Through libfreenect it streams the
// Kinect's colour camera (640 x 480, or 1280 x 1024 at 10 a second) or its infrared camera (640 x 480:
// the two can't run at once), its depth lined up with that picture, its four microphones (the sound
// itself: electron/kinect.js places it, KinectMics.chunk), and its tilt motor, light and tilt sensor,
// as HTK1 messages on stdout (the framing of oak/oak_bridge.py: "HTK1", a u32 header length, a JSON
// header, a u32 length and the header's parts one after another, little-endian). Its microphones (and,
// on a Kinect model 1473, its motor, light and tilt sensor, which it reaches through them) need its
// audio firmware (Microsoft's audios.bin, the person's copy: --firmware), sent each time it starts.
//
//   kinect360-helper --check                 { status: "check", version }
//   kinect360-helper --list                  { status: "devices", devices: [{ id, name }] }
//   kinect360-helper --selftest              the pictures and maps from made-up frames, no Kinect
//   kinect360-helper [--device <serial>] [--source color|infrared|auto] [--size 640x480|1280x960]
//                    [--quality 80] [--no-mics] [--firmware <audios.bin>] [--tilt <-27..27>]
//                    [--light off|green|red|yellow|blink-green|blink-red-yellow] [--mirrored]
//
// Messages while it runs:
//   { status: "starting" | "running" | "error" | "stopped" | "note", ... }
//   { kind: "frame", seq, t, u, source, w, h, image: { fx, fy, cx, cy }, map: { w, h, fx, fy, cx, cy },
//     dark, fps, night, auto, tilt, accel: [x, y, z] (m/s², which way is down), moving, light,
//     parts: { jpeg, depth } }   the picture to track hands on, and the depth for each part of it
//     (u16 mm, 0 = none: the map, lined up with the picture)
//   { kind: "raw", u, w: 640, h: 480, parts: { depth, ir } }   each depth frame (mm, lined up with the
//     picture), and the infrared camera's brightness while it's the picture, while it records
//   { kind: "rawcolor", u, parts: { jpeg } }   each colour picture as the camera made it, while it
//     records with "rawcolor on"
//   { kind: "mics", u, parts: { pcm } }   100 ms of its four microphones: s32 interleaved, 16 kHz
//
// Commands on stdin, one a line: "source color|infrared|auto", "record on|off", "rawcolor on|off",
// "tilt <-27..27>", "light <off|green|...>", "depthrange <min m> <max m>", "quit".

#include <libfreenect.h>
#ifdef KINECT360_WITH_AUDIO
#include <libfreenect_audio.h>
#endif
#include <turbojpeg.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <signal.h>

#define HELPER_VERSION "1"

// ---------- output ----------
static std::mutex out_mu;
struct Part {
  std::string name;
  const void *data;
  size_t size;
};
static void send(const std::string &json_fields, const std::vector<Part> &parts = {}) {
  std::ostringstream h;
  h << "{" << json_fields;
  if (!parts.empty()) {
    h << (json_fields.empty() ? "" : ",") << "\"parts\":{";
    size_t at = 0;
    for (size_t i = 0; i < parts.size(); i++) {
      h << (i ? "," : "") << "\"" << parts[i].name << "\":[" << at << "," << parts[i].size << "]";
      at += parts[i].size;
    }
    h << "}";
  }
  h << "}";
  const std::string header = h.str();
  uint32_t hn = header.size(), bn = 0;
  for (const Part &p : parts) bn += p.size;
  std::lock_guard<std::mutex> lock(out_mu);
  fwrite("HTK1", 1, 4, stdout);
  fwrite(&hn, 4, 1, stdout);
  fwrite(header.data(), 1, hn, stdout);
  fwrite(&bn, 4, 1, stdout);
  for (const Part &p : parts) fwrite(p.data, 1, p.size, stdout);
  fflush(stdout);
}
static std::string esc(const std::string &s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\', o += c;
    else if ((unsigned char)c < 0x20) o += ' ';
    else o += c;
  }
  return o;
}
static std::string num(double v, int digits = 3) {
  if (!std::isfinite(v)) return "null";
  std::ostringstream o;
  o.setf(std::ios::fixed);
  o.precision(digits);
  o << v;
  std::string s = o.str();
  if (s.find('.') != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  return s == "-0" ? "0" : s;
}
static void status(const std::string &st, const std::string &message = "", const std::string &more = "") {
  std::string f = "\"status\":\"" + st + "\"";
  if (!message.empty()) f += ",\"message\":\"" + esc(message) + "\"";
  if (!more.empty()) f += "," + more;
  send(f);
}
static double now_ms() {
  return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}
static double mono_ms() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// libfreenect's messages go to stderr (the app keeps them in a log file).
static void log_cb(freenect_context *, freenect_loglevel, const char *msg) { std::cerr << "[libfreenect] " << msg; }

// ---------- settings (the command line, then stdin) ----------
static const int W = 640, H = 480;
// The colour and depth cameras' nominal focal lengths at 640 x 480 (libfreenect's registration's,
// as Microsoft's SDK has them).
static const double COLOR_F = 531.15, DEPTH_F = 571.26;
struct Settings {
  std::string device, source = "color", firmware, light;
  int width = 640, height = 480, quality = 80, tilt = 1000;
  bool mics = true, mirrored_out = false;
  std::atomic<bool> record{false}, rawcolor{false}, quit{false};
  std::atomic<float> depth_min{0.4f}, depth_max{8.f};
  std::mutex mu;
  std::string want_source;
  std::deque<std::string> device_commands; // tilt, light: carried out by the main loop
};
static Settings S;

// ---------- pictures ----------
static std::vector<unsigned char> to_jpeg(const unsigned char *pixels, int w, int h, int format) {
  tjhandle enc = tjInitCompress();
  unsigned char *buf = nullptr;
  unsigned long n = 0;
  std::vector<unsigned char> out;
  if (tjCompress2(enc, pixels, w, 0, h, format, &buf, &n, format == TJPF_GRAY ? TJSAMP_GRAY : TJSAMP_420, S.quality, TJFLAG_FASTDCT) == 0) out.assign(buf, buf + n);
  if (buf) tjFree(buf);
  tjDestroy(enc);
  return out;
}
// The colour picture (RGB), turned back (the Kinect's own pictures are mirrored) unless mirrored_out.
static void unmirror_rgb(const unsigned char *src, unsigned char *dst, int w, int h, bool unmirror) {
  for (int y = 0; y < h; y++) {
    const unsigned char *s = src + (size_t)y * w * 3;
    unsigned char *d = dst + (size_t)y * w * 3;
    if (!unmirror) {
      memcpy(d, s, (size_t)w * 3);
      continue;
    }
    for (int x = 0; x < w; x++) memcpy(d + (w - 1 - x) * 3, s + x * 3, 3);
  }
}
// The infrared camera's brightness (10 bits) as a picture, brightened to its brightest few.
static float ir_bright = 400;
static void ir_picture(const uint16_t *ir, int w, int h, bool unmirror, unsigned char *grey) {
  std::vector<uint16_t> sample;
  sample.reserve(w * h / 16 + 1);
  for (int i = 0; i < w * h; i += 16) sample.push_back(ir[i]);
  std::nth_element(sample.begin(), sample.begin() + sample.size() * 98 / 100, sample.end());
  const float p98 = std::max(60.f, (float)sample[sample.size() * 98 / 100]);
  ir_bright += (p98 - ir_bright) * 0.1f;
  const float scale = 1.f / ir_bright;
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) grey[y * w + (unmirror ? w - 1 - x : x)] = (unsigned char)(std::sqrt(std::min(1.f, ir[y * w + x] * scale)) * 255);
}
static bool in_range(int mm) { return mm > 0 && mm >= S.depth_min * 1000 && mm <= S.depth_max * 1000; }
// The depth for each part of the picture (mw x mh of a 640 x 480 depth already lined up with it),
// the nearest in each block, turned back as the picture is.
static void depth_map(const uint16_t *depth, int mw, int mh, bool unmirror, uint16_t *map) {
  const int sx = W / mw, sy = H / mh;
  for (int y = 0; y < mh; y++)
    for (int x = 0; x < mw; x++) {
      uint16_t best = 0;
      for (int yy = y * sy; yy < (y + 1) * sy; yy++)
        for (int xx = x * sx; xx < (x + 1) * sx; xx++) {
          const uint16_t d = depth[yy * W + xx];
          if (in_range(d) && (!best || d < best)) best = d;
        }
      map[y * mw + (unmirror ? mw - 1 - x : x)] = best;
    }
}
static void unmirror16(const uint16_t *src, uint16_t *dst, int w, int h, bool unmirror) {
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) dst[y * w + (unmirror ? w - 1 - x : x)] = src[y * w + x];
}
static std::string camera(double f, int fw, int fh, int w, int h) {
  const double sx = (double)w / fw, sy = (double)h / fh;
  return "\"fx\":" + num(f * sx) + ",\"fy\":" + num(f * sy) + ",\"cx\":" + num(((fw - 1) / 2.0 + 0.5) * sx - 0.5) + ",\"cy\":" + num(((fh - 1) / 2.0 + 0.5) * sy - 0.5);
}

// ---------- the Kinect's streams (libfreenect's callbacks, on the main loop's thread) ----------
struct Frames {
  std::vector<unsigned char> rgb;  // the colour picture, as it came
  std::vector<uint16_t> ir;        // the infrared one's (640 x 480 of its 640 x 488)
  std::vector<uint16_t> depth;     // mm, 640 x 480, lined up with the picture
  int rgb_w = W, rgb_h = H;
  bool new_picture = false, new_depth = false, night = false;
  uint32_t picture_ts = 0, depth_ts = 0;
  double picture_at = 0, depth_at = 0;
  std::vector<int32_t> mics;       // interleaved, as they come, sent 100 ms at a time
  double mics_at = 0;
} F;
static void video_cb(freenect_device *dev, void *data, uint32_t ts) {
  const freenect_frame_mode m = freenect_get_current_video_mode(dev);
  if (m.video_format == FREENECT_VIDEO_IR_10BIT) {
    F.ir.assign((const uint16_t *)data, (const uint16_t *)data + W * H);
    F.night = true;
  } else {
    F.rgb.assign((const unsigned char *)data, (const unsigned char *)data + (size_t)m.width * m.height * 3);
    F.rgb_w = m.width;
    F.rgb_h = m.height;
    F.night = false;
  }
  F.new_picture = true;
  F.picture_ts = ts;
  F.picture_at = now_ms();
}
static void depth_cb(freenect_device *, void *data, uint32_t ts) {
  F.depth.assign((const uint16_t *)data, (const uint16_t *)data + W * H);
  F.new_depth = true;
  F.depth_ts = ts;
  F.depth_at = now_ms();
}
#ifdef KINECT360_WITH_AUDIO
static void audio_cb(freenect_device *, int num_samples, int32_t *mic1, int32_t *mic2, int32_t *mic3, int32_t *mic4, int16_t *, void *) {
  if (F.mics.empty()) F.mics_at = now_ms() - num_samples / 16.0;
  for (int i = 0; i < num_samples; i++) {
    F.mics.push_back(mic1[i]);
    F.mics.push_back(mic2[i]);
    F.mics.push_back(mic3[i]);
    F.mics.push_back(mic4[i]);
  }
}
#endif

static freenect_led_options led_of(const std::string &s) {
  if (s == "off") return LED_OFF;
  if (s == "red") return LED_RED;
  if (s == "yellow") return LED_YELLOW;
  if (s == "blink-green") return LED_BLINK_GREEN;
  if (s == "blink-red-yellow") return LED_BLINK_RED_YELLOW;
  return LED_GREEN;
}

// (Each frame's time: when it arrived here, ms since 1970, less the time a 30-a-second frame takes
// to come over USB. libfreenect's own timestamps' rate isn't said, so they aren't used.)
static const double TRANSFER_MS = 30;

// ---------- commands ----------
static void stdin_thread() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string cmd, a, b;
    in >> cmd >> a >> b;
    if (cmd == "quit") break;
    if (cmd == "record") S.record = a == "on";
    else if (cmd == "rawcolor") S.rawcolor = a == "on";
    else if (cmd == "source" && (a == "color" || a == "infrared" || a == "auto")) {
      std::lock_guard<std::mutex> l(S.mu);
      S.want_source = a;
    } else if (cmd == "depthrange") {
      const float lo = std::atof(a.c_str()), hi = std::atof(b.c_str());
      if (hi > lo) S.depth_min = std::max(0.4f, lo), S.depth_max = std::min(10.f, hi);
    } else if (cmd == "tilt" || cmd == "light") {
      std::lock_guard<std::mutex> l(S.mu);
      S.device_commands.push_back(line);
    } else status("note", "The Kinect for Xbox 360 can't set that: " + line);
  }
  S.quit = true;
}

static std::string serial_ok(const char *s) {
  std::string o;
  for (const char *p = s; p && *p && o.size() < 60; p++)
    if (isalnum((unsigned char)*p)) o += *p;
  return o;
}

static int list_devices() {
  freenect_context *ctx = nullptr;
  std::string out = "[";
  if (freenect_init(&ctx, nullptr) >= 0) {
    freenect_set_log_level(ctx, FREENECT_LOG_ERROR);
    freenect_device_attributes *attrs = nullptr;
    const int n = freenect_list_device_attributes(ctx, &attrs);
    int i = 0;
    for (freenect_device_attributes *a = attrs; a && i < n; a = a->next, i++) {
      std::string id = serial_ok(a->camera_serial);
      if (id.empty()) id = "KINECT" + std::to_string(i);
      out += (i ? "," : "") + std::string("{\"id\":\"") + id + "\",\"name\":\"Kinect for Xbox 360\"}";
    }
    if (attrs) freenect_free_device_attributes(attrs);
    freenect_shutdown(ctx);
  }
  send("\"status\":\"devices\",\"devices\":" + out + "]");
  return 0;
}

// ---------- running ----------
static int run() {
  const bool unmirror = !S.mirrored_out;
  status("starting", "Opening the Kinect…");
  freenect_context *ctx = nullptr;
  if (freenect_init(&ctx, nullptr) < 0) {
    status("error", "libfreenect couldn't start (USB).");
    return 2;
  }
  freenect_set_log_level(ctx, FREENECT_LOG_WARNING);
  freenect_set_log_callback(ctx, log_cb);
  // Its audio firmware, the person's copy, sent as it opens: its microphones (and a model 1473's motor) then work.
  std::vector<unsigned char> fw;
  if (!S.firmware.empty()) {
    std::ifstream f(S.firmware, std::ios::binary);
    fw.assign(std::istreambuf_iterator<char>(f), {});
  }
  bool audio = false;
#ifdef KINECT360_WITH_AUDIO
  audio = S.mics && !fw.empty();
  if (audio) freenect_set_fw_address_nui(ctx, fw.data(), (unsigned int)fw.size());
#endif
  freenect_select_subdevices(ctx, (freenect_device_flags)(FREENECT_DEVICE_MOTOR | FREENECT_DEVICE_CAMERA | (audio ? FREENECT_DEVICE_AUDIO : 0)));
  freenect_device *dev = nullptr;
  int opened = -1;
  for (int tries = 0; tries < 3 && opened < 0; tries++) {
    if (!S.device.empty() && S.device.rfind("KINECT", 0) != 0) opened = freenect_open_device_by_camera_serial(ctx, &dev, S.device.c_str());
    else opened = freenect_open_device(ctx, &dev, S.device.size() > 6 ? std::atoi(S.device.c_str() + 6) : 0);
    if (opened < 0) std::this_thread::sleep_for(std::chrono::milliseconds(700));
  }
  if (opened < 0 && audio) {
    // (its microphones wouldn't open: without them)
    audio = false;
    freenect_select_subdevices(ctx, (freenect_device_flags)(FREENECT_DEVICE_MOTOR | FREENECT_DEVICE_CAMERA));
    if (!S.device.empty() && S.device.rfind("KINECT", 0) != 0) opened = freenect_open_device_by_camera_serial(ctx, &dev, S.device.c_str());
    else opened = freenect_open_device(ctx, &dev, 0);
  }
  if (opened < 0) {
    status("error", "No Kinect for Xbox 360 was found. Is it plugged in, with its power adapter's power on?");
    freenect_shutdown(ctx);
    return 2;
  }
  const bool hi_res = S.width >= 1280;
  bool night = S.source == "infrared";
  auto set_modes = [&](bool n) {
    freenect_stop_video(dev);
    freenect_stop_depth(dev);
    freenect_set_video_mode(dev, n ? freenect_find_video_mode(FREENECT_RESOLUTION_MEDIUM, FREENECT_VIDEO_IR_10BIT)
                                   : freenect_find_video_mode(hi_res ? FREENECT_RESOLUTION_HIGH : FREENECT_RESOLUTION_MEDIUM, FREENECT_VIDEO_RGB));
    // (by day its depth lined up with the colour camera; by night the infrared camera's own, which it is)
    freenect_set_depth_mode(dev, freenect_find_depth_mode(FREENECT_RESOLUTION_MEDIUM, n ? FREENECT_DEPTH_MM : FREENECT_DEPTH_REGISTERED));
    freenect_set_video_callback(dev, video_cb);
    freenect_set_depth_callback(dev, depth_cb);
    // (its pictures as the camera sees them: the mirroring is undone here, as for the Kinect for Xbox One)
    freenect_set_flag(dev, FREENECT_MIRROR_VIDEO, FREENECT_OFF);
    freenect_set_flag(dev, FREENECT_MIRROR_DEPTH, FREENECT_OFF);
    const bool ok = freenect_start_depth(dev) >= 0 && freenect_start_video(dev) >= 0;
    F.new_picture = F.new_depth = false;
    return ok;
  };
  if (!set_modes(night)) {
    status("error", "The Kinect's cameras didn't start.");
    freenect_close_device(dev);
    freenect_shutdown(ctx);
    return 3;
  }
#ifdef KINECT360_WITH_AUDIO
  if (audio) {
    freenect_set_audio_in_callback(dev, audio_cb);
    if (freenect_start_audio(dev) < 0) audio = false;
  }
#endif
  if (S.tilt >= -27 && S.tilt <= 27) freenect_set_tilt_degs(dev, S.tilt);
  if (!S.light.empty()) freenect_set_led(dev, led_of(S.light));
  const int cw = hi_res ? 1280 : W, ch = hi_res ? 1024 : H;
  status("running", "", "\"camera\":\"Kinect for Xbox 360\",\"model\":\"360\",\"id\":\"" + esc(S.device) + "\",\"firmware\":" + (fw.empty() ? "false" : "true") +
                            ",\"pipeline\":\"libfreenect\",\"color\":{\"w\":" + std::to_string(cw) + ",\"h\":" + std::to_string(ch) + "," + camera(COLOR_F * cw / W, cw, ch, cw, ch) +
                            "},\"ir\":{\"w\":640,\"h\":480," + camera(DEPTH_F, W, H, W, H) + "},\"depth\":true,\"infrared\":true,\"bodies\":false,\"mics\":" + (audio ? "true" : "false") +
                            ",\"motor\":true,\"tilt\":" + std::to_string(S.tilt >= -27 && S.tilt <= 27 ? S.tilt : 0) + ",\"light\":\"" + esc(S.light.empty() ? "green" : S.light) +
                            "\",\"source\":\"" + S.source + "\",\"size\":[" + std::to_string(night ? W : cw) + "," + std::to_string(night ? H : ch) + "],\"unmirrored\":" +
                            (unmirror ? "true" : "false") + ",\"version\":\"" HELPER_VERSION "\"");
  if (S.mics && !audio)
    status("note", fw.empty() ? "Its microphones need its audio firmware (Microsoft's audios.bin): choose it under the Kinect's ⚙." : "Its microphones didn't start.", "\"mics\":false");

  std::vector<unsigned char> turned, grey(W * H);
  std::vector<uint16_t> map(320 * 240), depth_out(W * H), ir_out(W * H);
  std::deque<double> rate;
  double dark = 128, dark_since = 0, night_since = 0, last_frame = mono_ms(), last_tilt = 0, accel[3] = {0, -9.81, 0}, tilt_now = 0;
  bool moving = false;
  std::string light = S.light.empty() ? "green" : S.light;
  long seq = 0;
  while (!S.quit) {
    timeval tv = {0, 20000};
    if (freenect_process_events_timeout(ctx, &tv) < 0) {
      status("error", "The Kinect stopped answering (USB).");
      break;
    }
    // Commands for the device itself, and the source's change.
    {
      std::deque<std::string> cmds;
      std::string want;
      {
        std::lock_guard<std::mutex> l(S.mu);
        cmds.swap(S.device_commands);
        want.swap(S.want_source);
      }
      for (const std::string &c : cmds) {
        std::istringstream in(c);
        std::string cmd, a;
        in >> cmd >> a;
        if (cmd == "tilt") {
          const int t = std::max(-27, std::min(27, std::atoi(a.c_str())));
          freenect_set_tilt_degs(dev, t);
          status("note", "", "\"applied\":\"tilt " + std::to_string(t) + "\",\"tilt\":" + std::to_string(t));
        } else {
          freenect_set_led(dev, led_of(a));
          light = a;
          status("note", "", "\"applied\":\"light " + esc(a) + "\",\"light\":\"" + esc(a) + "\"");
        }
      }
      if (!want.empty()) {
        S.source = want;
        if (want != "auto" && (want == "infrared") != night) {
          night = want == "infrared";
          set_modes(night);
        }
        dark_since = 0;
        night_since = mono_ms();
      }
    }
    // The tilt sensor, twice a second.
    if (mono_ms() - last_tilt > 500) {
      last_tilt = mono_ms();
      if (freenect_update_tilt_state(dev) >= 0) {
        freenect_raw_tilt_state *st = freenect_get_tilt_state(dev);
        freenect_get_mks_accel(st, &accel[0], &accel[1], &accel[2]);
        moving = freenect_get_tilt_status(st) == TILT_STATUS_MOVING;
        // (while it moves the Kinect gives no angle: its -128, read as -64°, sent as null)
        tilt_now = moving || st->tilt_angle == -128 ? NAN : freenect_get_tilt_degs(st);
      }
    }
    // The microphones, 100 ms at a time.
    if (F.mics.size() >= 1600 * 4) {
      send("\"kind\":\"mics\",\"u\":" + num(F.mics_at, 1) + ",\"rate\":16000,\"channels\":4", {{"pcm", F.mics.data(), 1600 * 4 * 4}});
      F.mics.erase(F.mics.begin(), F.mics.begin() + 1600 * 4);
      F.mics_at += 100;
    }
    if (F.new_depth && S.record) {
      unmirror16(F.depth.data(), depth_out.data(), W, H, unmirror);
      const double u = F.depth_at - TRANSFER_MS;
      if (night && F.ir.size() == (size_t)W * H) {
        unmirror16(F.ir.data(), ir_out.data(), W, H, unmirror);
        send("\"kind\":\"raw\",\"u\":" + num(u, 1) + ",\"w\":640,\"h\":480", {{"depth", depth_out.data(), depth_out.size() * 2}, {"ir", ir_out.data(), ir_out.size() * 2}});
      } else send("\"kind\":\"raw\",\"u\":" + num(u, 1) + ",\"w\":640,\"h\":480", {{"depth", depth_out.data(), depth_out.size() * 2}});
    }
    F.new_depth = false;
    if (!F.new_picture) {
      if (mono_ms() - last_frame > 5000) {
        status("error", "The Kinect stopped sending pictures.");
        break;
      }
      continue;
    }
    F.new_picture = false;
    last_frame = mono_ms();
    if (F.night != night || F.depth.size() != (size_t)W * H) continue; // (the other camera's last, while it switches)
    // (how dark it is: a sample of the colour picture)
    if (!night) {
      double sum = 0;
      int n = 0;
      for (size_t i = 0; i + 2 < F.rgb.size(); i += 3 * 997) sum += 0.299 * F.rgb[i] + 0.587 * F.rgb[i + 1] + 0.114 * F.rgb[i + 2], n++;
      dark = n ? sum / n : 128;
    }
    if (S.source == "auto") {
      const double now = mono_ms();
      // (by night its colour camera isn't running: back to colour after a minute, to look again)
      if (!night && dark < 35) {
        if (!dark_since) dark_since = now;
        if (now - dark_since > 3000) night = true, night_since = now, set_modes(true);
      } else dark_since = 0;
      if (night && now - night_since > 60000) night = false, dark_since = 0, set_modes(false);
      if (F.night != night) continue;
    }
    rate.push_back(mono_ms());
    while (rate.size() > 1 && rate.back() - rate.front() > 2000) rate.pop_front();
    const double fps = rate.size() > 1 ? (rate.size() - 1) * 1000.0 / std::max(1.0, rate.back() - rate.front()) : 0;
    const double u = F.picture_at - TRANSFER_MS;
    const std::string motion = ",\"tilt\":" + num(tilt_now, 1) + ",\"accel\":[" + num(accel[0], 2) + "," + num(accel[1], 2) + "," + num(accel[2], 2) + "],\"moving\":" +
                               (moving ? "true" : "false") + ",\"light\":\"" + esc(light) + "\"";
    depth_map(F.depth.data(), 320, 240, unmirror, map.data());
    if (!night) {
      // (its depth is lined up with the colour camera's 640 x 480: its 1280 x 1024 picture is sent as
      // its top 1280 x 960, twice that)
      const int fh = F.rgb_w >= 1280 ? 960 : F.rgb_h;
      turned.resize((size_t)F.rgb_w * fh * 3);
      unmirror_rgb(F.rgb.data(), turned.data(), F.rgb_w, fh, unmirror);
      const std::vector<unsigned char> jpeg = to_jpeg(turned.data(), F.rgb_w, fh, TJPF_RGB);
      if (S.record && S.rawcolor) send("\"kind\":\"rawcolor\",\"u\":" + num(u, 1), {{"jpeg", jpeg.data(), jpeg.size()}});
      send("\"kind\":\"frame\",\"seq\":" + std::to_string(++seq) + ",\"t\":" + num(now_ms(), 1) + ",\"u\":" + num(u, 1) + ",\"source\":\"color\",\"w\":" + std::to_string(F.rgb_w) +
               ",\"h\":" + std::to_string(fh) + ",\"image\":{" + camera(COLOR_F * F.rgb_w / W, F.rgb_w, fh, F.rgb_w, fh) + "},\"map\":{\"w\":320,\"h\":240," + camera(COLOR_F, W, H, 320, 240) +
               "},\"dark\":" + num(dark, 1) + ",\"fps\":" + num(fps, 1) + ",\"night\":false,\"auto\":" + (S.source == "auto" ? "true" : "false") + motion,
           {{"jpeg", jpeg.data(), jpeg.size()}, {"depth", map.data(), map.size() * 2}});
    } else if (F.ir.size() == (size_t)W * H) {
      ir_picture(F.ir.data(), W, H, unmirror, grey.data());
      const std::vector<unsigned char> jpeg = to_jpeg(grey.data(), W, H, TJPF_GRAY);
      send("\"kind\":\"frame\",\"seq\":" + std::to_string(++seq) + ",\"t\":" + num(now_ms(), 1) + ",\"u\":" + num(u, 1) + ",\"source\":\"infrared\",\"w\":640,\"h\":480,\"image\":{" +
               camera(DEPTH_F, W, H, W, H) + "},\"map\":{\"w\":320,\"h\":240," + camera(DEPTH_F, W, H, 320, 240) + "},\"dark\":" + num(dark, 1) + ",\"fps\":" + num(fps, 1) +
               ",\"night\":true,\"auto\":" + (S.source == "auto" ? "true" : "false") + motion,
           {{"jpeg", jpeg.data(), jpeg.size()}, {"depth", map.data(), map.size() * 2}});
    }
  }
  S.quit = true;
#ifdef KINECT360_WITH_AUDIO
  if (audio) freenect_stop_audio(dev);
#endif
  freenect_stop_video(dev);
  freenect_stop_depth(dev);
  freenect_close_device(dev);
  freenect_shutdown(ctx);
  return 0;
}

// ---------- the build's own check (no Kinect) ----------
static int selftest() {
  // A picture with a white square at its left: turned back, the square is at its right.
  std::vector<unsigned char> rgb(W * H * 3, 30), out(W * H * 3);
  for (int y = 220; y < 260; y++)
    for (int x = 40; x < 80; x++) memset(&rgb[(y * W + x) * 3], 255, 3);
  unmirror_rgb(rgb.data(), out.data(), W, H, true);
  const bool turned = out[(240 * W + 639 - 60) * 3] > 200 && out[(240 * W + 60) * 3] < 80;
  const std::vector<unsigned char> jpeg = to_jpeg(out.data(), W, H, TJPF_RGB);
  const bool encoded = jpeg.size() > 1000 && jpeg[0] == 0xff && jpeg[1] == 0xd8;
  std::vector<uint16_t> ir(W * H);
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++) ir[y * W + x] = 30 + 300 * x / 639;
  for (int y = 230; y < 250; y++)
    for (int x = 10; x < 30; x++) ir[y * W + x] = 1000;
  std::vector<unsigned char> grey(W * H);
  for (int k = 0; k < 40; k++) ir_picture(ir.data(), W, H, true, grey.data());
  const bool ir_ok = grey[240 * W + 639 - 20] > 200 && grey[240 * W + 639 - 40] < 160 && grey[240 * W + 639 - 600] > 150;
  std::vector<uint16_t> depth(W * H, 3000), map(320 * 240);
  for (int y = 200; y < 280; y++)
    for (int x = 140; x < 220; x++) depth[y * W + x] = 1000;
  depth_map(depth.data(), 320, 240, true, map.data());
  const bool map_ok = map[120 * 320 + 319 - 90] == 1000 && map[120 * 320 + 90] == 3000;
  S.depth_max = 2.5f;
  depth_map(depth.data(), 320, 240, true, map.data());
  const bool range_ok = map[120 * 320 + 90] == 0 && map[120 * 320 + 319 - 90] == 1000;
  S.depth_max = 8.f;
  const bool ok = turned && encoded && ir_ok && map_ok && range_ok && led_of("blink-red-yellow") == LED_BLINK_RED_YELLOW;
  send(std::string("\"status\":\"selftest\",\"ok\":") + (ok ? "true" : "false") + ",\"turned\":" + (turned ? "true" : "false") + ",\"jpeg\":" + (encoded ? "true" : "false") +
       ",\"infrared\":" + (ir_ok ? "true" : "false") + ",\"irMap\":" + (map_ok ? "true" : "false") + ",\"range\":" + (range_ok ? "true" : "false"));
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  std::string mode = "run";
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto next = [&]() { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
    if (a == "--check" || a == "--list" || a == "--selftest") mode = a.substr(2);
    else if (a == "--device") S.device = serial_ok(next().c_str());
    else if (a == "--source") {
      const std::string s = next();
      if (s == "color" || s == "infrared" || s == "auto") S.source = s;
    } else if (a == "--size") {
      const std::string s = next();
      S.width = s == "1280x960" ? 1280 : 640;
      S.height = S.width == 1280 ? 960 : 480;
    } else if (a == "--quality") S.quality = std::max(30, std::min(95, std::atoi(next().c_str())));
    else if (a == "--no-mics") S.mics = false;
    else if (a == "--firmware") S.firmware = next();
    else if (a == "--tilt") S.tilt = std::max(-27, std::min(27, std::atoi(next().c_str())));
    else if (a == "--light") S.light = next();
    else if (a == "--mirrored") S.mirrored_out = true;
  }
  if (mode == "selftest") return selftest();
  if (mode == "check") {
    send("\"status\":\"check\",\"version\":\"" HELPER_VERSION "\",\"library\":\"libfreenect\"");
    return 0;
  }
  if (mode == "list") return list_devices();
  std::thread(stdin_thread).detach();
  const int code = run();
  status("stopped", "", "\"code\":" + std::to_string(code));
  return code;
}
