// kinect2-helper.cpp — a Kinect for Xbox One (Kinect v2) for Hand Tracker on Linux (electron/kinect.js
// runs it; kinect/build-linux.sh builds it). Through libfreenect2 (patched: kinect/libfreenect2.patch)
// it streams the Kinect's colour camera, its depth and its infrared, and through ALSA its four
// microphones, as HTK1 messages on stdout (the framing of oak/oak_bridge.py: "HTK1", a u32 header
// length, a JSON header, a u32 length and the header's parts one after another, little-endian).
//
//   kinect2-helper --check                  { status: "check", version, opengl }
//   kinect2-helper --list                   { status: "devices", devices: [{ id, name }] }
//   kinect2-helper --probe-gl               exits 0 if its OpenGL depth processing works here
//   kinect2-helper --selftest               the pictures and maps from made-up frames, no Kinect
//   kinect2-helper --device <serial> [--pipeline opengl|cpu] [--source color|infrared|auto]
//                  [--size 960x540|1920x1080|...] [--quality 80] [--no-mics] [--mirrored]
//
// Messages while it runs:
//   { status: "starting" | "running" | "error" | "stopped", ... }   ("running": the camera's
//     model, serial, firmware, depth pipeline, its cameras' own parameters, whether it has its
//     microphones)
//   { kind: "frame", seq, t, u, source, w, h, image: { fx, fy, cx, cy }, map: { w, h, fx, fy, cx,
//     cy }, dark, exposure, gain, fps, depthFps, colorFps, parts: { jpeg, depth } }
//     the picture to track hands on (the colour camera's, smaller, or the infrared one's), and the
//     depth for each part of it (u16 mm, 0 = none: the map, lined up with the picture). The
//     cameras' pictures come mirrored; they're turned back here, so they're as any camera's.
//   { kind: "raw", u, parts: { depth, ir } }        each depth frame, 512 x 424 u16 (mm; the
//     infrared camera's brightness), while it records ("record on")
//   { kind: "rawcolor", u, parts: { jpeg } }        each colour picture, 1920 x 1080 as the camera
//     made it (turned back losslessly), while it records with "rawcolor on"
//   { kind: "audio", u, rate, channels, frames, level, delays, angle, confidence, parts: { pcm, beam } }
//     about 10 a second: each microphone's level, and where the loudest sound comes from (the
//     microphones' delays, and its angle, roughly); with "record on" also the sound itself (pcm:
//     s32 interleaved, 4 channels, 16 kHz; beam: s16 mono, the four lined up on that sound)
//
// Commands on stdin, one a line: "source color|infrared|auto", "record on|off",
// "rawcolor on|off", "exposure auto <compensation -2..2>", "exposure manual <ms> <gain 1..4>",
// "whitebalance auto", "led <0-1000>", "depthrange <min m> <max m>", "filters on|off", "quit".

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener.hpp>
#include <libfreenect2/registration.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>
#include <libfreenect2/color_settings.h>
#include <libfreenect2/led_settings.h>
#include <libfreenect2/config.h>
#include <turbojpeg.h>
#include <alsa/asoundlib.h>
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
#include <GLFW/glfw3.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <complex>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <iostream>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <signal.h>
#include <unistd.h>

#define HELPER_VERSION "1"

using libfreenect2::Frame;

// ---------- output ----------
static std::mutex out_mu;
struct Part {
  std::string name;
  const void *data;
  size_t size;
};
static void send(const std::string &json_fields, const std::vector<Part> &parts = {}) {
  // The header's "parts": each one's [offset, length] in what follows it.
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

// libfreenect2's messages go to stderr, each with the time (the app keeps them in a log file:
// lost packets and USB troubles show there); its last error is kept, to say why.
static std::string clock_text() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t t = std::chrono::system_clock::to_time_t(now);
  const int ms = (int)(std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000);
  char buf[32];
  std::strftime(buf, sizeof buf, "%H:%M:%S", std::localtime(&t));
  char out[40];
  std::snprintf(out, sizeof out, "%s.%03d", buf, ms);
  return out;
}
class Logger : public libfreenect2::Logger {
 public:
  std::mutex mu;
  std::string last_error;
  Logger() { level_ = Info; }
  void log(Level level, const std::string &message) override {
    std::cerr << clock_text() << " [libfreenect2] " << message << std::endl;
    if (level == Error) {
      std::lock_guard<std::mutex> l(mu);
      last_error = message;
    }
  }
  std::string error() {
    std::lock_guard<std::mutex> l(mu);
    return last_error;
  }
};
static Logger *logger = nullptr;

// ---------- settings (the command line, then stdin) ----------
struct Settings {
  std::string device, pipeline = "auto", source = "color";
  int width = 960, height = 540, quality = 80;
  bool mics = true, mirrored_out = false; // mirrored_out: leave the pictures mirrored, as the Kinect makes them
  std::atomic<bool> record{false}, rawcolor{false}, quit{false};
  std::mutex mu;
  std::string want_source; // a "source" command waiting to be carried out (main loop)
  std::deque<std::string> device_commands; // exposure, led…, carried out by the main loop
};
static Settings S;

// ---------- pictures ----------
struct Jpeg {
  tjhandle dec = tjInitDecompress(), enc = tjInitCompress(), xf = tjInitTransform();
  std::vector<unsigned char> rgb, out;
  ~Jpeg() {
    tjDestroy(dec);
    tjDestroy(enc);
    tjDestroy(xf);
  }
  // Decodes jpeg to w x h (one of TurboJPEG's scalings of it), turned back from mirrored unless
  // mirrored is false. -> false if it couldn't.
  bool decode(const unsigned char *jpeg, size_t n, int w, int h, bool unmirror) {
    rgb.resize((size_t)w * h * 3);
    if (tjDecompress2(dec, jpeg, n, rgb.data(), w, 0, h, TJPF_RGB, TJFLAG_FASTDCT) != 0) return false;
    if (unmirror) {
      for (int y = 0; y < h; y++) {
        unsigned char *row = rgb.data() + (size_t)y * w * 3;
        for (int a = 0, b = w - 1; a < b; a++, b--) std::swap_ranges(row + a * 3, row + a * 3 + 3, row + b * 3);
      }
    }
    return true;
  }
  bool encode(const unsigned char *pixels, int w, int h, int format, int sampling, int q) {
    unsigned char *buf = nullptr;
    unsigned long size = 0;
    if (tjCompress2(enc, pixels, w, 0, h, format, &buf, &size, sampling, q, TJFLAG_FASTDCT) != 0) return false;
    out.assign(buf, buf + size);
    tjFree(buf);
    return true;
  }
  // The camera's own JPEG turned back (lossless; its width is a whole number of blocks).
  bool flip(const unsigned char *jpeg, size_t n) {
    unsigned char *buf = nullptr;
    unsigned long size = 0;
    tjtransform t;
    memset(&t, 0, sizeof t);
    t.op = TJXOP_HFLIP;
    t.options = TJXOPT_TRIM;
    if (tjTransform(xf, jpeg, n, 1, &buf, &size, &t, 0) != 0) return false;
    out.assign(buf, buf + size);
    tjFree(buf);
    return true;
  }
};

// The infrared camera's brightness (0-65535, mostly far below) as a picture: scaled by a slowly
// following bright level, with a square root, so hands show in a dark room.
struct IrScale {
  float bright = 3000;
  void picture(const float *ir, int w, int h, bool unmirror, std::vector<unsigned char> &out) {
    std::vector<float> sample;
    sample.reserve((w * h) / 16 + 1);
    for (int i = 0; i < w * h; i += 16) sample.push_back(ir[i]);
    if (!sample.empty()) {
      size_t k = sample.size() * 98 / 100;
      std::nth_element(sample.begin(), sample.begin() + k, sample.end());
      float p98 = std::max(200.0f, sample[k]);
      bright += (p98 - bright) * 0.1f;
    }
    out.resize((size_t)w * h);
    const float scale = 1.0f / bright;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        float v = std::sqrt(std::min(1.0f, std::max(0.0f, ir[y * w + x] * scale))) * 255.0f;
        out[(size_t)y * w + (unmirror ? w - 1 - x : x)] = (unsigned char)v;
      }
    }
  }
};

// ---------- the depth for each part of the picture ----------
// For the colour camera's picture: libfreenect2 lines each depth reading up with the colour camera
// (bigdepth, 1920 x 1082 with a row above and below), kept here at a quarter of the size. For the
// infrared picture: the depth itself (the same camera), at half its size.
static void depth_map_color(const Frame &bigdepth, int mw, int mh, bool unmirror, std::vector<uint16_t> &map) {
  map.assign((size_t)mw * mh, 0);
  const float *bd = (const float *)bigdepth.data;
  const int step_x = 1920 / mw, step_y = 1080 / mh;
  for (int y = 0; y < mh; y++) {
    for (int x = 0; x < mw; x++) {
      float best = std::numeric_limits<float>::infinity();
      const int x0 = x * step_x, y0 = y * step_y;
      // the middle first, else the nearest reading in its block
      const float mid = bd[(size_t)(y0 + step_y / 2 + 1) * 1920 + x0 + step_x / 2];
      if (std::isfinite(mid) && mid > 0) best = mid;
      else {
        for (int yy = y0; yy < y0 + step_y; yy++) {
          const float *row = bd + (size_t)(yy + 1) * 1920;
          for (int xx = x0; xx < x0 + step_x; xx++)
            if (row[xx] > 0 && row[xx] < best) best = row[xx];
        }
      }
      if (std::isfinite(best) && best > 0) map[(size_t)y * mw + (unmirror ? mw - 1 - x : x)] = (uint16_t)std::min(65535.0f, best);
    }
  }
}
static void depth_map_ir(const float *depth, int w, int h, int mw, int mh, bool unmirror, std::vector<uint16_t> &map) {
  map.assign((size_t)mw * mh, 0);
  const int sx = w / mw, sy = h / mh;
  for (int y = 0; y < mh; y++) {
    for (int x = 0; x < mw; x++) {
      float best = 0;
      for (int yy = y * sy; yy < (y + 1) * sy; yy++)
        for (int xx = x * sx; xx < (x + 1) * sx; xx++) {
          const float d = depth[yy * w + xx];
          if (d > 0 && (best == 0 || d < best)) best = d;
        }
      map[(size_t)y * mw + (unmirror ? mw - 1 - x : x)] = (uint16_t)std::min(65535.0f, best);
    }
  }
}
static void to_u16(const float *src, int w, int h, bool unmirror, std::vector<uint16_t> &out) {
  out.resize((size_t)w * h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      const float v = src[y * w + x];
      out[(size_t)y * w + (unmirror ? w - 1 - x : x)] = v > 0 ? (uint16_t)std::min(65535.0f, v + 0.5f) : 0;
    }
}

// ---------- the device's clock ----------
// Each frame's time in ms since 1970: the device's own tick (0.125 ms) plus the smallest gap seen
// between its ticks and when frames arrive (creeping up very slowly, for the clocks' drift).
struct Clock {
  double offset = std::numeric_limits<double>::infinity();
  double last = 0;
  double at(uint32_t ticks) {
    const double dev = ticks * 0.125, arrived = now_ms();
    if (std::isfinite(offset)) offset += std::max(0.0, (arrived - last)) * 1e-5;
    last = arrived;
    offset = std::min(offset, arrived - dev);
    return dev + offset;
  }
};

// ---------- microphones ----------
// The Kinect's four microphones are an ALSA card ("Xbox NUI Sensor"): 4 channels, 32-bit, 16 kHz.
// It has to be opened after the camera starts (starting it resets the device, which would leave an
// earlier handle dead).
static std::string find_mic_card() {
  int card = -1;
  while (snd_card_next(&card) == 0 && card >= 0) {
    char *name = nullptr, *longname = nullptr;
    snd_card_get_name(card, &name);
    snd_card_get_longname(card, &longname);
    const std::string n = name ? name : "", l = longname ? longname : "";
    free(name);
    free(longname);
    if (n.find("Xbox NUI") != std::string::npos || l.find("Xbox NUI") != std::string::npos || n == "Sensor")
      return "hw:" + std::to_string(card) + ",0";
  }
  return "";
}

// Radix-2 FFT, in place.
static void fft(std::vector<std::complex<float>> &a, bool inverse) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    const float ang = 2 * (float)M_PI / len * (inverse ? 1 : -1);
    const std::complex<float> wl(std::cos(ang), std::sin(ang));
    for (size_t i = 0; i < n; i += len) {
      std::complex<float> w(1);
      for (size_t j = 0; j < len / 2; j++) {
        const std::complex<float> u = a[i + j], v = a[i + j + len / 2] * w;
        a[i + j] = u + v;
        a[i + j + len / 2] = u - v;
        w *= wl;
      }
    }
  }
  if (inverse)
    for (auto &x : a) x /= (float)n;
}

// Where the loudest sound is: each microphone's delay behind the first one (GCC-PHAT, in samples,
// to a tenth), how sure (the peak's height over the rest), and its angle off straight ahead from
// the outer two's delay, roughly (OUTER_M apart: the microphones' exact places aren't published).
// Only a sound above the steady one is placed (electron/kinect.js's Beam, the same): the Kinect
// hears its own hum all the time, which would hold the angle still. Each microphone's steady
// sound is followed frequency by frequency, each frequency counts by how far above it it is, and
// the delays change only while the speech band is well above it (active: placed in the last 0.8 s).
struct Beam {
  static constexpr float OUTER_M = 0.2f, SOUND_MS = 343.0f, RATE = 16000;
  static constexpr int N = 1024, H = N / 2, MAX_LAG = 12;
  float delays[4] = {0, 0, 0, 0}, confidence = 0, angle = 0, snr = 0;
  bool active = false;
  int quiet = 99;
  std::vector<float> noise[4], window;
  void update(const std::vector<float> ch[4]) {
    const int k0 = (int)std::lround(200.0 / RATE * N), k1 = (int)std::lround(6000.0 / RATE * N); // the speech band
    if (window.empty())
      for (int i = 0; i < N; i++) window.push_back(0.5f - 0.5f * std::cos(2 * (float)M_PI * i / (N - 1)));
    const size_t n = std::min((size_t)N, ch[0].size()), at = ch[0].size() - n;
    std::vector<std::complex<float>> f[4];
    std::vector<float> power[4];
    for (int m = 0; m < 4; m++) {
      f[m].assign(N, 0);
      for (size_t i = 0; i < n; i++) f[m][i] = ch[m][at + i] * window[i];
      fft(f[m], false);
      power[m].resize(H + 1);
      for (int k = 0; k <= H; k++) power[m][k] = std::norm(f[m][k]);
    }
    const bool first = noise[0].empty();
    if (first)
      for (int m = 0; m < 4; m++) {
        noise[m] = power[m];
        for (auto &v : noise[m]) v += 1e-20f;
      }
    // How far above the steady sound: the speech band as a whole, and each frequency's share.
    double sp = 0, sn = 0;
    std::vector<float> share[4];
    for (int m = 0; m < 4; m++) {
      share[m].resize(H + 1);
      for (int k = 0; k <= H; k++) {
        if (k >= k0 && k <= k1) sp += power[m][k], sn += noise[m][k];
        share[m][k] = std::max(0.0f, 1 - 2 * noise[m][k] / std::max(power[m][k], 1e-30f));
      }
    }
    snr = first ? 0 : 10 * (float)std::log10(std::max(sp, 1e-30) / std::max(sn, 1e-30));
    int placed = 0;
    float conf_sum = 0;
    for (int m = 1; m < 4 && !first && snr > 6; m++) {
      std::vector<std::complex<float>> g(N, 0);
      float weight = 0;
      for (int k = k0; k <= k1; k++) {
        const float w = share[0][k] * share[m][k];
        if (w <= 0) continue;
        const std::complex<float> c = f[0][k] * std::conj(f[m][k]);
        const float mag = std::abs(c);
        if (mag < 1e-30f) continue;
        g[k] = c * (w / mag);
        g[N - k] = std::conj(g[k]);
        weight += w;
      }
      if (weight < 8) continue; // (too few frequencies above the steady sound to tell)
      fft(g, true);
      // the lag with the highest correlation: mic m's sound is that many samples behind mic 0's
      int best = 0;
      float top = -1e9f, sum = 0;
      for (int lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
        const float v = g[(lag + N) % N].real();
        sum += std::fabs(v);
        if (v > top) top = v, best = lag;
      }
      const float l = g[(best - 1 + N) % N].real(), r = g[(best + 1 + N) % N].real();
      const float den = l - 2 * top + r;
      const float frac = std::fabs(den) > 1e-12f ? 0.5f * (l - r) / den : 0;
      const float d = -(best + std::max(-0.5f, std::min(0.5f, frac)));
      const float c = sum > 0 ? top / (sum / (2 * MAX_LAG + 1)) : 0;
      if (c < 4) continue;
      delays[m] += (d - delays[m]) * 0.5f;
      placed++;
      conf_sum += c;
    }
    // The steady sound, after: its average while nothing stands out (the speech band within 3 dB
    // of it); while something does, down towards a quieter frequency, up only slowly (4 dB in 10 s).
    if (!first) {
      const bool calm = snr < 3;
      for (int m = 0; m < 4; m++)
        for (int k = 0; k <= H; k++) {
          const float v = power[m][k] + 1e-20f, s = noise[m][k];
          noise[m][k] = calm || v < s ? s + (v - s) * 0.1f : s * 1.01f;
        }
    }
    quiet = placed ? 0 : quiet + 1;
    active = quiet <= 8;
    confidence = placed ? std::min(1.0f, conf_sum / placed / 12) : confidence * 0.8f;
    const float s = std::max(-1.0f, std::min(1.0f, delays[3] / RATE * SOUND_MS / OUTER_M));
    angle = std::asin(s) * 180 / (float)M_PI;
  }
};

static void mic_thread(std::atomic<bool> *running, std::atomic<bool> *mics_ok) {
  const std::string dev = find_mic_card();
  if (dev.empty()) {
    status("note", "The Kinect's microphones weren't found (no \"Xbox NUI Sensor\" sound card).", "\"mics\":false");
    return;
  }
  snd_pcm_t *pcm = nullptr;
  int err = snd_pcm_open(&pcm, dev.c_str(), SND_PCM_STREAM_CAPTURE, 0);
  if (err >= 0) err = snd_pcm_set_params(pcm, SND_PCM_FORMAT_S32_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 4, 16000, 0, 500000);
  if (err >= 0) err = snd_pcm_start(pcm);
  if (err < 0) {
    status("note", std::string("The Kinect's microphones couldn't be opened: ") + snd_strerror(err) + (err == -EBUSY ? " (another program is using them)" : ""), "\"mics\":false");
    if (pcm) snd_pcm_close(pcm);
    return;
  }
  *mics_ok = true;
  status("note", "", "\"mics\":true,\"micDevice\":\"" + esc(dev) + "\"");
  const int frames = 1600; // 100 ms
  std::vector<int32_t> buf((size_t)frames * 4);
  std::vector<int16_t> beam(frames);
  std::vector<float> ch[4];
  Beam b;
  Clock clock;
  double gain = 8; // the Kinect's sound is quiet (about 20 dB below Windows'): the beam is turned up, gently
  while (*running && !S.quit) {
    snd_pcm_sframes_t got = snd_pcm_readi(pcm, buf.data(), frames);
    if (got < 0) {
      got = snd_pcm_recover(pcm, (int)got, 1);
      if (got < 0) break;
      snd_pcm_start(pcm);
      continue;
    }
    if (got == 0) continue;
    const double u = now_ms() - got * 1000.0 / 16000;
    float level[4];
    for (int m = 0; m < 4; m++) {
      ch[m].resize(got);
      double sq = 0;
      for (snd_pcm_sframes_t i = 0; i < got; i++) {
        const float v = buf[(size_t)i * 4 + m] / 2147483648.0f;
        ch[m][i] = v;
        sq += (double)v * v;
      }
      level[m] = (float)std::sqrt(sq / got);
    }
    b.update(ch);
    // The four lined up on the loudest sound and added together.
    double peak = 1e-6;
    std::vector<float> mono(got);
    for (snd_pcm_sframes_t i = 0; i < got; i++) {
      float v = 0;
      for (int m = 0; m < 4; m++) {
        const long j = (long)i + (long)std::lround(b.delays[m]);
        v += ch[m][std::max(0L, std::min((long)got - 1, j))];
      }
      mono[i] = v / 4;
      peak = std::max(peak, (double)std::fabs(mono[i]));
    }
    gain = std::min(gain, 0.9 / peak); // (never clipping)
    for (snd_pcm_sframes_t i = 0; i < got; i++) beam[i] = (int16_t)std::max(-32767.0, std::min(32767.0, mono[i] * gain * 32767));
    gain = std::min(64.0, gain * 1.01);
    std::ostringstream f;
    f << "\"kind\":\"audio\",\"u\":" << num(u, 1) << ",\"rate\":16000,\"channels\":4,\"frames\":" << got << ",\"level\":[" << num(level[0], 5) << ","
      << num(level[1], 5) << "," << num(level[2], 5) << "," << num(level[3], 5) << "],\"delays\":[" << num(b.delays[1], 2) << "," << num(b.delays[2], 2) << ","
      << num(b.delays[3], 2) << "],\"angle\":" << num(b.angle, 1) << ",\"confidence\":" << num(b.confidence, 2) << ",\"active\":" << (b.active ? "true" : "false")
      << ",\"snr\":" << num(b.snr, 1);
    if (S.record) send(f.str(), {{"pcm", buf.data(), (size_t)got * 16}, {"beam", beam.data(), (size_t)got * 2}});
    else send(f.str());
  }
  snd_pcm_close(pcm);
}

// ---------- the frames ----------
class Listener : public libfreenect2::FrameListener {
 public:
  std::mutex mu;
  std::condition_variable cv;
  Frame *color = nullptr, *ir = nullptr, *depth = nullptr;
  uint64_t colors = 0, depths = 0;
  bool onNewFrame(Frame::Type type, Frame *f) override {
    std::lock_guard<std::mutex> l(mu);
    Frame **slot = type == Frame::Color ? &color : type == Frame::Ir ? &ir : &depth;
    delete *slot;
    *slot = f;
    if (type == Frame::Color) colors++;
    if (type == Frame::Depth) depths++;
    cv.notify_one();
    return true;
  }
  ~Listener() {
    delete color;
    delete ir;
    delete depth;
  }
};

struct Rate {
  std::deque<double> at;
  void tick() {
    at.push_back(mono_ms());
    while (at.size() > 1 && at.back() - at.front() > 2000) at.pop_front();
  }
  double fps() const { return at.size() > 1 ? (at.size() - 1) * 1000.0 / (at.back() - at.front()) : 0; }
};

static void stdin_thread() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string cmd, a;
    in >> cmd >> a;
    if (cmd == "quit") break;
    if (cmd == "record") S.record = a == "on";
    else if (cmd == "rawcolor") S.rawcolor = a == "on";
    else if (cmd == "source" && (a == "color" || a == "infrared" || a == "auto")) {
      std::lock_guard<std::mutex> l(S.mu);
      S.want_source = a;
    } else {
      std::lock_guard<std::mutex> l(S.mu);
      S.device_commands.push_back(line);
    }
  }
  S.quit = true; // (stdin closed: the app's gone)
}

static void device_command(libfreenect2::Freenect2Device *dev, const std::string &line) {
  std::istringstream in(line);
  std::string cmd, a;
  in >> cmd >> a;
  try {
    if (cmd == "exposure" && a == "auto") {
      float comp = 0;
      in >> comp;
      dev->setColorAutoExposure(std::max(-2.0f, std::min(2.0f, comp)));
    } else if (cmd == "exposure" && a == "manual") {
      float ms = 20, g = 1;
      in >> ms >> g;
      dev->setColorManualExposure(std::max(0.1f, std::min(66.0f, ms)), std::max(1.0f, std::min(4.0f, g)));
    } else if (cmd == "whitebalance" && a == "auto") {
      dev->setColorSetting(libfreenect2::COLOR_SETTING_SET_WHITE_BALANCE_MODE, (uint32_t)1);
    } else if (cmd == "led") {
      const int v = std::max(0, std::min(1000, atoi(a.c_str())));
      libfreenect2::LedSettings led{0, 0, (uint16_t)v, (uint16_t)v, 0, 0};
      dev->setLedStatus(led);
    } else if (cmd == "depthrange" || cmd == "filters") {
      static libfreenect2::Freenect2Device::Config config;
      if (cmd == "depthrange") {
        float lo = 0.5f, hi = 4.5f;
        std::istringstream again(line);
        again >> cmd >> lo >> hi;
        config.MinDepth = std::max(0.1f, std::min(lo, 8.0f));
        config.MaxDepth = std::max(config.MinDepth + 0.1f, std::min(hi, 12.0f));
      } else {
        config.EnableBilateralFilter = config.EnableEdgeAwareFilter = a == "on";
      }
      dev->setConfiguration(config);
    } else {
      return;
    }
    status("note", "", "\"applied\":\"" + esc(line) + "\"");
  } catch (...) {
    status("note", "The Kinect didn't take that: " + line);
  }
}

static std::string color_params_json(const libfreenect2::Freenect2Device::ColorCameraParams &c, bool unmirror) {
  std::ostringstream o;
  o << "{\"w\":1920,\"h\":1080,\"fx\":" << num(c.fx) << ",\"fy\":" << num(c.fy) << ",\"cx\":" << num(unmirror ? 1919 - c.cx : c.cx) << ",\"cy\":" << num(c.cy) << "}";
  return o.str();
}
static std::string ir_params_json(const libfreenect2::Freenect2Device::IrCameraParams &p, bool unmirror) {
  std::ostringstream o;
  o << "{\"w\":512,\"h\":424,\"fx\":" << num(p.fx) << ",\"fy\":" << num(p.fy) << ",\"cx\":" << num(unmirror ? 511 - p.cx : p.cx) << ",\"cy\":" << num(p.cy)
    << ",\"k1\":" << num(p.k1, 6) << ",\"k2\":" << num(p.k2, 6) << ",\"k3\":" << num(p.k3, 6) << ",\"p1\":" << num(p.p1, 6) << ",\"p2\":" << num(p.p2, 6) << "}";
  return o.str();
}
// A camera's parameters scaled to a picture w x h of it (from fw x fh).
static std::string scaled_json(double fx, double fy, double cx, double cy, double fw, double fh, int w, int h) {
  const double sx = w / fw, sy = h / fh;
  std::ostringstream o;
  o << "\"fx\":" << num(fx * sx) << ",\"fy\":" << num(fy * sy) << ",\"cx\":" << num((cx + 0.5) * sx - 0.5) << ",\"cy\":" << num((cy + 0.5) * sy - 0.5);
  return o.str();
}

// One picture to send: the colour camera's (w x h) or the infrared one's, with its depth map.
struct Out {
  Jpeg jpeg;
  IrScale ir_scale;
  std::vector<unsigned char> grey;
  std::vector<uint16_t> map, raw_depth, raw_ir;
  Rate rate, depth_rate, color_rate;
  Clock clock;
  uint64_t seq = 0;
  double dark = 128; // the colour picture's average brightness, for "auto"
};

// Whether a picture's average brightness (from its RGB) says it's dark.
static double brightness(const std::vector<unsigned char> &rgb) {
  if (rgb.empty()) return 128;
  double sum = 0;
  size_t n = 0;
  for (size_t i = 0; i + 2 < rgb.size(); i += 3 * 37, n++) sum += 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  return n ? sum / n : 128;
}

static int run_device(libfreenect2::Freenect2 &ctx) {
  const bool unmirror = !S.mirrored_out;
  libfreenect2::PacketPipeline *pipeline = nullptr;
  std::string pipe_name = "cpu";
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
  if (S.pipeline == "opengl") {
    // (X11 when there's a display, as XWayland: GLFW's most worn path; else Wayland's own.)
    if (getenv("DISPLAY")) glfwInitHint(GLFW_PLATFORM, GLFW_PLATFORM_X11);
    pipeline = new libfreenect2::JpegOpenGLPacketPipeline();
    pipe_name = "opengl";
  }
#endif
  if (!pipeline) pipeline = new libfreenect2::JpegCpuPacketPipeline();

  status("starting", "Opening the Kinect…");
  libfreenect2::Freenect2Device *dev = ctx.openDevice(S.device, pipeline);
  if (!dev) {
    const std::string why = logger->error();
    status("error", "The Kinect couldn't be opened" + (why.empty() ? std::string(".") : ": " + why) + " Is it plugged into a USB 3 port, with its power on?");
    return 2;
  }
  Listener listener;
  dev->setColorFrameListener(&listener);
  dev->setIrAndDepthFrameListener(&listener);
  if (!dev->start()) {
    const std::string why = logger->error();
    status("error", "The Kinect didn't start" + (why.empty() ? std::string(".") : ": " + why));
    dev->close();
    delete dev;
    return 3;
  }
  // (Its cameras' own parameters are read as it starts: only then can depth be lined up with colour.)
  const auto cp = dev->getColorCameraParams();
  const auto ip = dev->getIrCameraParams();
  libfreenect2::Registration reg(ip, cp);
  Frame undistorted(512, 424, 4), registered(512, 424, 4), bigdepth(1920, 1082, 4);
  std::fill((float *)bigdepth.data, (float *)bigdepth.data + 1920 * 1082, std::numeric_limits<float>::infinity());
  Frame dummy_rgb(1920, 1080, 4);
  memset(dummy_rgb.data, 0, 1920 * 1080 * 4);
  dummy_rgb.format = Frame::BGRX;

  std::atomic<bool> running{true}, mics_ok{false};
  std::thread mics;
  if (S.mics) mics = std::thread(mic_thread, &running, &mics_ok);
  {
    std::ostringstream more;
    more << "\"camera\":\"Kinect for Xbox One\",\"id\":\"" << esc(dev->getSerialNumber()) << "\",\"firmware\":\"" << esc(dev->getFirmwareVersion()) << "\",\"pipeline\":\""
         << pipe_name << "\",\"color\":" << color_params_json(cp, unmirror) << ",\"ir\":" << ir_params_json(ip, unmirror) << ",\"depth\":true,\"infrared\":true,\"source\":\""
         << S.source << "\",\"size\":[" << S.width << "," << S.height << "],\"unmirrored\":" << (unmirror ? "true" : "false") << ",\"version\":\"" HELPER_VERSION "\"";
    status("running", "", more.str());
  }

  Out out;
  std::string source = S.source; // as asked: color, infrared or auto
  bool night = source == "infrared";
  double dark_since = 0, light_since = 0;
  uint64_t seen_colors = 0, seen_depths = 0;
  double last_color = mono_ms(), last_depth = last_color;
  std::vector<unsigned char> raw_jpeg;
  uint32_t raw_ts = 0;
  float exposure = 0, gain = 0;
  bool new_color = false;
  uint64_t color_count = 0;
  std::vector<float> ir_copy, depth_copy;
  uint32_t depth_ts = 0;
  while (!S.quit) {
    {
      std::lock_guard<std::mutex> l(S.mu);
      if (!S.want_source.empty()) {
        source = S.want_source;
        S.want_source.clear();
        night = source == "infrared";
        dark_since = light_since = 0;
      }
      while (!S.device_commands.empty()) {
        const std::string c = S.device_commands.front();
        S.device_commands.pop_front();
        device_command(dev, c);
      }
    }
    // The newest of each, when one has come.
    Frame *color = nullptr, *ir = nullptr, *depth = nullptr;
    {
      std::unique_lock<std::mutex> l(listener.mu);
      listener.cv.wait_for(l, std::chrono::milliseconds(200), [&] { return listener.colors != seen_colors || listener.depths != seen_depths; });
      if (listener.colors != seen_colors) {
        seen_colors = listener.colors;
        std::swap(color, listener.color);
      }
      if (listener.depths != seen_depths) {
        seen_depths = listener.depths;
        std::swap(ir, listener.ir);
        std::swap(depth, listener.depth);
      }
    }
    // The pictures the view needs (colour, or the infrared camera's at night) stopped: it ends, to
    // be started again (the app does that).
    const double got = mono_ms();
    if (color) last_color = got;
    if (depth) last_depth = got;
    if (got - (night ? last_depth : last_color) > 5000) {
      std::cerr << clock_text() << " no " << (night ? "infrared" : "colour") << " pictures for 5 s: " << seen_colors << " colour and " << seen_depths
                << " depth frames since it started, the last colour " << (int)(got - last_color) << " ms ago, the last depth " << (int)(got - last_depth) << " ms ago" << std::endl;
      status("error", "The Kinect stopped sending pictures.", "\"colors\":" + std::to_string(seen_colors) + ",\"depths\":" + std::to_string(seen_depths));
      delete color;
      delete ir;
      delete depth;
      break;
    }
    if (!color && !depth) continue;
    if (color) {
      out.color_rate.tick();
      color_count++;
      raw_jpeg.assign(color->data, color->data + color->bytes_per_pixel);
      raw_ts = color->timestamp;
      exposure = color->exposure;
      gain = color->gain;
      new_color = true;
      delete color;
      // The camera's own picture, kept with the take.
      if (S.record && S.rawcolor && (unmirror ? out.jpeg.flip(raw_jpeg.data(), raw_jpeg.size()) : (out.jpeg.out = raw_jpeg, true))) {
        send("\"kind\":\"rawcolor\",\"u\":" + num(out.clock.at(raw_ts), 1), {{"jpeg", out.jpeg.out.data(), out.jpeg.out.size()}});
      }
    }
    if (depth) {
      out.depth_rate.tick();
      depth_copy.assign((float *)depth->data, (float *)depth->data + 512 * 424);
      ir_copy.assign((float *)ir->data, (float *)ir->data + 512 * 424);
      depth_ts = depth->timestamp;
      // Lined up with the colour camera.
      reg.apply(&dummy_rgb, depth, &undistorted, &registered, true, &bigdepth);
      if (S.record) {
        to_u16(depth_copy.data(), 512, 424, unmirror, out.raw_depth);
        to_u16(ir_copy.data(), 512, 424, unmirror, out.raw_ir);
        send("\"kind\":\"raw\",\"u\":" + num(out.clock.at(depth_ts), 1) + ",\"w\":512,\"h\":424",
             {{"depth", out.raw_depth.data(), out.raw_depth.size() * 2}, {"ir", out.raw_ir.data(), out.raw_ir.size() * 2}});
      }
      delete ir;
      delete depth;
    }

    // Automatic: infrared once the colour picture has been dark for 3 s, colour again once it's
    // been light for 5 s (the colour camera is still looked at now and then, small).
    if (source == "auto" && new_color && !raw_jpeg.empty()) {
      if (night && color_count % 10 == 0 && out.jpeg.decode(raw_jpeg.data(), raw_jpeg.size(), 240, 135, false)) out.dark = brightness(out.jpeg.rgb);
      const double now = mono_ms();
      if (!night && out.dark < 35) {
        if (!dark_since) dark_since = now;
        if (now - dark_since > 3000) night = true, light_since = 0;
      } else dark_since = 0;
      if (night && out.dark > 70) {
        if (!light_since) light_since = now;
        if (now - light_since > 5000) night = false, dark_since = 0;
      } else light_since = 0;
    }

    // The picture to track, as each new one of its kind comes.
    std::ostringstream f;
    if (!night && new_color && !raw_jpeg.empty()) {
      new_color = false;
      bool ok;
      if (S.width == 1920 && S.height == 1080) {
        ok = unmirror ? out.jpeg.flip(raw_jpeg.data(), raw_jpeg.size()) : (out.jpeg.out = raw_jpeg, true);
        if (ok && source == "auto" && color_count % 10 == 0 && out.jpeg.decode(raw_jpeg.data(), raw_jpeg.size(), 240, 135, false)) out.dark = brightness(out.jpeg.rgb);
      } else {
        ok = out.jpeg.decode(raw_jpeg.data(), raw_jpeg.size(), S.width, S.height, unmirror);
        if (ok) {
          out.dark = brightness(out.jpeg.rgb);
          ok = out.jpeg.encode(out.jpeg.rgb.data(), S.width, S.height, TJPF_RGB, TJSAMP_420, S.quality);
        }
      }
      if (!ok) continue;
      const int mw = 480, mh = 270;
      depth_map_color(bigdepth, mw, mh, unmirror, out.map);
      const double ccx = unmirror ? 1919 - cp.cx : cp.cx;
      out.rate.tick();
      f << "\"kind\":\"frame\",\"seq\":" << ++out.seq << ",\"t\":" << num(mono_ms(), 1) << ",\"u\":" << num(out.clock.at(raw_ts), 1) << ",\"source\":\"color\",\"w\":" << S.width << ",\"h\":" << S.height
        << ",\"image\":{" << scaled_json(cp.fx, cp.fy, ccx, cp.cy, 1920, 1080, S.width, S.height) << "},\"map\":{\"w\":" << mw << ",\"h\":" << mh << "," << scaled_json(cp.fx, cp.fy, ccx, cp.cy, 1920, 1080, mw, mh)
        << "},\"dark\":" << num(out.dark, 1) << ",\"exposure\":" << num(exposure, 2) << ",\"gain\":" << num(gain, 2) << ",\"fps\":" << num(out.rate.fps(), 1)
        << ",\"depthFps\":" << num(out.depth_rate.fps(), 1) << ",\"colorFps\":" << num(out.color_rate.fps(), 1) << ",\"night\":false,\"auto\":" << (source == "auto" ? "true" : "false");
      send(f.str(), {{"jpeg", out.jpeg.out.data(), out.jpeg.out.size()}, {"depth", out.map.data(), out.map.size() * 2}});
    } else if (night && depth) {
      out.ir_scale.picture(ir_copy.data(), 512, 424, unmirror, out.grey);
      if (!out.jpeg.encode(out.grey.data(), 512, 424, TJPF_GRAY, TJSAMP_GRAY, S.quality)) continue;
      const int mw = 256, mh = 212;
      depth_map_ir(depth_copy.data(), 512, 424, mw, mh, unmirror, out.map);
      const double icx = unmirror ? 511 - ip.cx : ip.cx;
      out.rate.tick();
      f << "\"kind\":\"frame\",\"seq\":" << ++out.seq << ",\"t\":" << num(mono_ms(), 1) << ",\"u\":" << num(out.clock.at(depth_ts), 1) << ",\"source\":\"infrared\",\"w\":512,\"h\":424"
        << ",\"image\":{" << scaled_json(ip.fx, ip.fy, icx, ip.cy, 512, 424, 512, 424) << "},\"map\":{\"w\":" << mw << ",\"h\":" << mh << "," << scaled_json(ip.fx, ip.fy, icx, ip.cy, 512, 424, mw, mh)
        << "},\"dark\":" << num(out.dark, 1) << ",\"fps\":" << num(out.rate.fps(), 1) << ",\"depthFps\":" << num(out.depth_rate.fps(), 1) << ",\"colorFps\":" << num(out.color_rate.fps(), 1)
        << ",\"night\":true,\"auto\":" << (source == "auto" ? "true" : "false");
      send(f.str(), {{"jpeg", out.jpeg.out.data(), out.jpeg.out.size()}, {"depth", out.map.data(), out.map.size() * 2}});
    }
  }
  running = false;
  if (mics.joinable()) mics.join();
  dev->stop();
  dev->close();
  delete dev; // (the pipeline goes with the device)
  return 0;
}

// ---------- the build's own check: the pictures and maps from made-up frames ----------
static int selftest() {
  bool ok = true;
  std::ostringstream report;
  // A picture with a white square at its left: turned back, the square is at its right.
  std::vector<unsigned char> rgb(1920 * 1080 * 3, 30);
  for (int y = 500; y < 580; y++)
    for (int x = 100; x < 180; x++) memset(&rgb[((size_t)y * 1920 + x) * 3], 255, 3);
  Jpeg j;
  if (!j.encode(rgb.data(), 1920, 1080, TJPF_RGB, TJSAMP_420, 85)) return status("error", "selftest: encode"), 1;
  const std::vector<unsigned char> cam = j.out;
  ok &= j.decode(cam.data(), cam.size(), 960, 540, true);
  const auto px = [&](int x, int y) { return (int)j.rgb[((size_t)y * 960 + x) * 3]; };
  const bool turned = px(960 - 1 - 70, 270) > 200 && px(70, 270) < 80;
  report << "\"turned\":" << (turned ? "true" : "false");
  ok &= turned;
  ok &= j.flip(cam.data(), cam.size());
  ok &= j.decode(j.out.data(), j.out.size(), 960, 540, false);
  const bool flipped = px(960 - 1 - 70, 270) > 200 && px(70, 270) < 80;
  report << ",\"lossless\":" << (flipped ? "true" : "false");
  ok &= flipped;
  // Infrared: a room dim at the left, brighter to the right, with a bright hand at the left:
  // turned back, the hand is at the right, bright, the dim side beside it dim, the bright side bright.
  std::vector<float> ir(512 * 424);
  for (int y = 0; y < 424; y++)
    for (int x = 0; x < 512; x++) ir[y * 512 + x] = 100.0f + 900.0f * x / 511;
  for (int y = 200; y < 220; y++)
    for (int x = 10; x < 30; x++) ir[y * 512 + x] = 6000.0f;
  IrScale s;
  std::vector<unsigned char> grey;
  for (int k = 0; k < 40; k++) s.picture(ir.data(), 512, 424, true, grey);
  const bool ir_ok = grey[210 * 512 + 511 - 20] > 200 && grey[210 * 512 + 511 - 40] < 120 && grey[210 * 512 + 511 - 500] > 200;
  report << ",\"infrared\":" << (ir_ok ? "true" : "false");
  ok &= ir_ok;
  // Depth: a near box at the depth camera's left, lined up with the colour camera (factory-like
  // parameters), shows at the colour map's right (turned back), nearer than the wall.
  libfreenect2::Freenect2Device::ColorCameraParams cp{};
  cp.fx = 1081.37f, cp.fy = 1081.37f, cp.cx = 959.5f, cp.cy = 539.5f, cp.shift_d = 863, cp.shift_m = 52;
  cp.mx_x1y0 = 0.6f, cp.mx_x0y0 = 0.02f, cp.my_x0y1 = 0.6f, cp.my_x0y0 = 0.0f;
  libfreenect2::Freenect2Device::IrCameraParams ip{};
  ip.fx = 365.456f, ip.fy = 365.456f, ip.cx = 254.878f, ip.cy = 205.395f;
  libfreenect2::Registration reg(ip, cp);
  Frame d(512, 424, 4), und(512, 424, 4), regd(512, 424, 4), big(1920, 1082, 4), dummy(1920, 1080, 4);
  memset(dummy.data, 0, 1920 * 1080 * 4);
  float *dd = (float *)d.data;
  for (int i = 0; i < 512 * 424; i++) dd[i] = 3000.0f;
  for (int y = 180; y < 240; y++)
    for (int x = 120; x < 180; x++) dd[y * 512 + x] = 1000.0f;
  reg.apply(&dummy, &d, &und, &regd, true, &big);
  std::vector<uint16_t> map;
  depth_map_color(big, 480, 270, true, map);
  int near_left = 0, near_right = 0, wall = 0;
  for (int y = 0; y < 270; y++)
    for (int x = 0; x < 480; x++) {
      const int v = map[y * 480 + x];
      if (v > 900 && v < 1100) (x < 240 ? near_left : near_right)++;
      if (v > 2900 && v < 3100) wall++;
    }
  const bool depth_ok = near_right > 50 && near_left == 0 && wall > 10000;
  report << ",\"depth\":" << (depth_ok ? "true" : "false") << ",\"nearRight\":" << near_right << ",\"nearLeft\":" << near_left << ",\"wall\":" << wall;
  ok &= depth_ok;
  std::vector<uint16_t> irmap;
  depth_map_ir(dd, 512, 424, 256, 212, true, irmap);
  const bool irmap_ok = irmap[105 * 256 + 255 - 75] == 1000 && irmap[105 * 256 + 75] == 3000;
  report << ",\"irMap\":" << (irmap_ok ? "true" : "false");
  ok &= irmap_ok;
  // The microphones' delays: a steady hum heard by all four (the Kinect's own, louder at the first)
  // isn't placed; a sound above it reaching the last one 3 samples after the first is.
  std::vector<float> ch[4];
  srand(7);
  const auto rnd = [] { return rand() / (float)RAND_MAX - 0.5f; };
  long t = 0;
  const auto chunk = [&](bool loud) {
    std::vector<float> src(1600 + 8);
    for (auto &v : src) v = rnd();
    for (int m = 0; m < 4; m++) ch[m].resize(1600);
    for (int i = 0; i < 1600; i++, t++)
      for (int m = 0; m < 4; m++)
        ch[m][i] = (m ? 0.002f : 0.01f) * std::sin(2 * (float)M_PI * 163 * (t - 2 * m) / 16000) + 0.0003f * rnd() + (loud ? 0.05f * src[i + 8 - m] : 0);
  };
  Beam b;
  for (int k = 0; k < 40; k++) chunk(false), b.update(ch);
  const bool hum_ok = !b.active && std::fabs(b.delays[3]) < 0.01f;
  for (int k = 0; k < 6; k++) chunk(true), b.update(ch);
  const bool beam_ok = hum_ok && b.active && std::fabs(b.delays[3] - 3) < 0.3f && std::fabs(b.delays[1] - 1) < 0.3f;
  report << ",\"beam\":" << (beam_ok ? "true" : "false") << ",\"hum\":" << (hum_ok ? "true" : "false") << ",\"delays\":[" << num(b.delays[1], 2) << "," << num(b.delays[2], 2) << ","
         << num(b.delays[3], 2) << "],\"angle\":" << num(b.angle, 1);
  ok &= beam_ok;
  send("\"status\":\"selftest\",\"ok\":" + std::string(ok ? "true" : "false") + "," + report.str());
  return ok ? 0 : 1;
}

#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
// The OpenGL 1.x calls libfreenect2 makes itself (the rest it looks up), passed on to the OpenGL
// GLFW found as it ran: the helper doesn't need libGL to start (without OpenGL, the depth is
// worked out by the processor instead). Each looked up the first time, with its context current.
#define GL_PASS(ret, name, params, args) \
  extern "C" ret name params { \
    using F = ret(*) params; \
    static F f = (F)glfwGetProcAddress(#name); \
    return f args; \
  }
GL_PASS(void, glBindTexture, (GLenum target, GLuint texture), (target, texture))
GL_PASS(void, glClear, (GLbitfield mask), (mask))
GL_PASS(void, glDrawArrays, (GLenum mode, GLint first, GLsizei count), (mode, first, count))
GL_PASS(void, glGenTextures, (GLsizei n, GLuint *textures), (n, textures))
GL_PASS(GLenum, glGetError, (void), ())
GL_PASS(void, glGetIntegerv, (GLenum pname, GLint *params), (pname, params))
GL_PASS(const GLubyte *, glGetString, (GLenum name), (name))
GL_PASS(void, glPixelStorei, (GLenum pname, GLint param), (pname, param))
GL_PASS(void, glReadBuffer, (GLenum mode), (mode))
GL_PASS(void, glReadPixels, (GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, GLvoid *pixels), (x, y, width, height, format, type, pixels))
GL_PASS(void, glTexImage2D, (GLenum target, GLint level, GLint internalFormat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const GLvoid *pixels),
        (target, level, internalFormat, width, height, border, format, type, pixels))
GL_PASS(void, glTexParameteri, (GLenum target, GLenum pname, GLint param), (target, pname, param))
GL_PASS(void, glTexSubImage2D, (GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const GLvoid *pixels),
        (target, level, xoffset, yoffset, width, height, format, type, pixels))
GL_PASS(void, glViewport, (GLint x, GLint y, GLsizei width, GLsizei height), (x, y, width, height))
#endif

static void on_signal(int) { S.quit = true; }

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  std::string mode = "run";
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    const auto next = [&]() { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
    if (a == "--check" || a == "--list" || a == "--probe-gl" || a == "--selftest") mode = a.substr(2);
    else if (a == "--device") S.device = next();
    else if (a == "--pipeline") S.pipeline = next();
    else if (a == "--source") S.source = next();
    else if (a == "--quality") S.quality = std::max(30, std::min(95, atoi(next().c_str())));
    else if (a == "--no-mics") S.mics = false;
    else if (a == "--mirrored") S.mirrored_out = true;
    else if (a == "--size") {
      int w = 0, h = 0;
      if (sscanf(next().c_str(), "%dx%d", &w, &h) == 2) {
        // TurboJPEG's scalings of 1920 x 1080 (n/8): 1440x810, 1200x675, 960x540, 720x405, 480x270
        static const int ok[][2] = {{1920, 1080}, {1440, 810}, {1200, 675}, {960, 540}, {720, 405}, {480, 270}};
        for (auto &s : ok)
          if (s[0] == w && s[1] == h) S.width = w, S.height = h;
      }
    }
  }
  if (S.source != "color" && S.source != "infrared" && S.source != "auto") S.source = "color";
  logger = new Logger();
  libfreenect2::setGlobalLogger(logger);

  if (mode == "selftest") return selftest();
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
  const bool gl = true;
#else
  const bool gl = false;
#endif
  if (mode == "check") {
    send("\"status\":\"check\",\"version\":\"" HELPER_VERSION "\",\"libfreenect2\":\"" LIBFREENECT2_VERSION "\",\"opengl\":" + std::string(gl ? "true" : "false"));
    return 0;
  }
  if (mode == "probe-gl") {
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
    // (libfreenect2 ends the program itself if OpenGL can't be had: this run is the test.)
    if (getenv("DISPLAY")) glfwInitHint(GLFW_PLATFORM, GLFW_PLATFORM_X11);
    libfreenect2::PacketPipeline *p = new libfreenect2::JpegOpenGLPacketPipeline();
    delete p;
    send("\"status\":\"probe\",\"opengl\":true");
    return 0;
#else
    send("\"status\":\"probe\",\"opengl\":false");
    return 1;
#endif
  }

  libfreenect2::Freenect2 ctx;
  if (mode == "list") {
    std::ostringstream o;
    o << "\"status\":\"devices\",\"devices\":[";
    const int n = ctx.enumerateDevices();
    for (int i = 0; i < n; i++) o << (i ? "," : "") << "{\"id\":\"" << esc(ctx.getDeviceSerialNumber(i)) << "\",\"name\":\"Kinect for Xbox One\"}";
    o << "]";
    send(o.str());
    return 0;
  }
  if (ctx.enumerateDevices() == 0) {
    status("error", "No Kinect was found. Is it plugged into a USB 3 port, with its power on?");
    return 2;
  }
  if (S.device.empty()) S.device = ctx.getDefaultDeviceSerialNumber();
  std::thread(stdin_thread).detach();
  const int code = run_device(ctx);
  status("stopped", "", "\"code\":" + std::to_string(code));
  fflush(stdout);
  _exit(code); // (stdin's thread may still be reading)
}
