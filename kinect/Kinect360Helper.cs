// Kinect360Helper.cs — the Kinect for Xbox 360 (Kinect v1) for Hand Tracker on Windows (electron/kinect.js
// builds it the first time with Windows' own C# compiler, against Microsoft's Kinect for Windows Runtime
// 1.8, and runs it). It streams what KinectHelper.cs streams for the Kinect for Xbox One, the same way
// (HTK1 messages on stdout: "HTK1", a u32 header length, a JSON header, a u32 length and the header's
// parts): its colour camera's picture (640 x 480, or 1280 x 960 at 12 a second) or its infrared
// camera's (640 x 480: the two can't run at once), its depth lined up with it, the Kinect's own body
// tracking (part "body": JSON, as body-tracker.js's bodies: its 20 joints in the Kinect for Xbox One's
// 25, those it hasn't left out), its microphone array's beam (the four lined up by the Kinect), and its
// tilt motor and tilt sensor (each frame's "tilt", in degrees, and "accel", which way is down in m/s²).
// The SDK has no call for its light: "light" is said so.
//
//   Kinect360Helper --check | --list | --selftest
//   Kinect360Helper [--device <id>] [--source color|infrared|auto] [--size 640x480|1280x960] [--quality 80]
//                   [--no-mics] [--tilt <-27..27>]
//
// Commands on stdin, one a line: "source color|infrared|auto", "record on|off", "rawcolor on|off",
// "tilt <-27..27>", "depthrange <min m> <max m>", "quit".

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Kinect;

static class Kinect360Helper
{
    const string VERSION = "1";
    const int W = 640, H = 480; // (its depth and infrared, and its colour picture's usual size)
    // The SDK's own nominal focal lengths (NUI_CAMERA_COLOR_NOMINAL_FOCAL_LENGTH_IN_PIXELS, and the
    // depth one's at 320 x 240, doubled).
    const double COLOR_F = 531.15, DEPTH_F = 571.26;
    static readonly object outLock = new object();
    static Stream stdout;
    static volatile bool quit, record, rawcolor;
    static volatile string wantSource = null;
    static volatile int wantTilt = int.MinValue;
    static volatile float depthMin = 0.4f, depthMax = 8f;
    static string source = "color", device = null;
    static int width = 640, height = 480, quality = 80, startTilt = int.MinValue;
    static bool mics = true;
    static readonly CultureInfo C = CultureInfo.InvariantCulture;

    // ---------- output ----------
    static void Send(string fields, params KeyValuePair<string, byte[]>[] parts)
    {
        var h = new StringBuilder("{").Append(fields);
        if (parts.Length > 0)
        {
            h.Append(fields.Length > 0 ? "," : "").Append("\"parts\":{");
            long at = 0;
            for (int i = 0; i < parts.Length; i++)
            {
                h.Append(i > 0 ? "," : "").Append('"').Append(parts[i].Key).Append("\":[").Append(at).Append(',').Append(parts[i].Value.Length).Append(']');
                at += parts[i].Value.Length;
            }
            h.Append('}');
        }
        h.Append('}');
        byte[] header = Encoding.UTF8.GetBytes(h.ToString());
        int bn = 0;
        foreach (var p in parts) bn += p.Value.Length;
        lock (outLock)
        {
            stdout.Write(Encoding.ASCII.GetBytes("HTK1"), 0, 4);
            stdout.Write(BitConverter.GetBytes((uint)header.Length), 0, 4);
            stdout.Write(header, 0, header.Length);
            stdout.Write(BitConverter.GetBytes((uint)bn), 0, 4);
            foreach (var p in parts) stdout.Write(p.Value, 0, p.Value.Length);
            stdout.Flush();
        }
    }
    static KeyValuePair<string, byte[]> P(string name, byte[] data) { return new KeyValuePair<string, byte[]>(name, data); }
    static string Esc(string s)
    {
        var o = new StringBuilder();
        foreach (char c in s ?? "") { if (c == '"' || c == '\\') o.Append('\\').Append(c); else if (c < 0x20) o.Append(' '); else o.Append(c); }
        return o.ToString();
    }
    static string N(double v, int digits = 3)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
        return Math.Round(v, digits).ToString("0.###", C);
    }
    static void Status(string st, string message = "", string more = "")
    {
        string f = "\"status\":\"" + st + "\"";
        if (message.Length > 0) f += ",\"message\":\"" + Esc(message) + "\"";
        if (more.Length > 0) f += "," + more;
        Send(f);
    }
    static double NowMs() { return (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

    // Each frame's time in ms since 1970: the Kinect's own clock (ms since it started) plus the
    // smallest gap seen between it and when frames arrive (creeping up very slowly, for the drift).
    sealed class Clock
    {
        double offset = double.PositiveInfinity, last;
        public double At(long deviceMs)
        {
            double arrived = NowMs();
            if (!double.IsInfinity(offset)) offset += Math.Max(0, arrived - last) * 1e-5;
            last = arrived;
            offset = Math.Min(offset, arrived - deviceMs);
            return deviceMs + offset;
        }
    }

    // ---------- pictures ----------
    static byte[] Jpeg(byte[] pixels, int w, int h, PixelFormat format, int bytesPerPixel)
    {
        var bmp = BitmapSource.Create(w, h, 96, 96, format, null, pixels, w * bytesPerPixel);
        var enc = new JpegBitmapEncoder { QualityLevel = quality };
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using (var ms = new MemoryStream())
        {
            enc.Save(ms);
            return ms.ToArray();
        }
    }
    // The colour picture (BGRX, mirrored as the SDK gives it), turned back, opaque.
    static unsafe byte[] Unmirror32(byte[] bgra, int w, int h)
    {
        var out_ = new byte[w * h * 4];
        fixed (byte* src = bgra, dst = out_)
        {
            for (int y = 0; y < h; y++)
            {
                uint* srow = (uint*)(src + (long)y * w * 4), drow = (uint*)(dst + (long)y * w * 4);
                for (int x = 0; x < w; x++) drow[w - 1 - x] = srow[x] | 0xff000000u;
            }
        }
        return out_;
    }
    // The infrared camera's brightness (16 bits a pixel, its 10 in the top) as a picture, brightened
    // to its brightest few: turned back.
    static float irBright = 20000;
    static byte[] IrPicture(ushort[] ir, int w, int h, bool unmirror)
    {
        var sample = new List<float>(w * h / 16 + 1);
        for (int i = 0; i < w * h; i += 16) sample.Add(ir[i]);
        sample.Sort();
        float p98 = Math.Max(1500f, sample[sample.Count * 98 / 100]);
        irBright += (p98 - irBright) * 0.1f;
        var grey = new byte[w * h];
        float scale = 1f / irBright;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                grey[y * w + (unmirror ? w - 1 - x : x)] = (byte)(Math.Sqrt(Math.Min(1f, ir[y * w + x] * scale)) * 255);
        return grey;
    }
    static byte[] U16(ushort[] v)
    {
        var b = new byte[v.Length * 2];
        Buffer.BlockCopy(v, 0, b, 0, b.Length);
        return b;
    }
    static ushort[] Unmirrored(ushort[] v, int w, int h)
    {
        var o = new ushort[v.Length];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) o[y * w + (w - 1 - x)] = v[y * w + x];
        return o;
    }
    static bool InRange(int mm) { return mm > 0 && mm >= depthMin * 1000 && mm <= depthMax * 1000; }

    // ---------- where things are ----------
    // The depth for each part of the colour picture (mw x mh, mm, 0: none), from the Kinect's own
    // mapping of each colour pixel to the depth camera's.
    static byte[] ColorMap(DepthImagePoint[] pts, int cw, int ch, int mw, int mh, bool unmirror)
    {
        var map = new ushort[mw * mh];
        for (int y = 0; y < mh; y++)
            for (int x = 0; x < mw; x++)
            {
                int px = (int)((x + 0.5) * cw / mw), py = (int)((y + 0.5) * ch / mh);
                int z = pts[py * cw + px].Depth;
                if (InRange(z)) map[y * mw + (unmirror ? mw - 1 - x : x)] = (ushort)z;
            }
        return U16(map);
    }
    // The depth for each part of the infrared picture (its own camera's: lined up already), the
    // nearest in each block.
    static byte[] IrMap(ushort[] depth, int mw, int mh, bool unmirror)
    {
        var map = new ushort[mw * mh];
        int sx = W / mw, sy = H / mh;
        for (int y = 0; y < mh; y++)
            for (int x = 0; x < mw; x++)
            {
                ushort best = 0;
                for (int yy = y * sy; yy < (y + 1) * sy; yy++)
                    for (int xx = x * sx; xx < (x + 1) * sx; xx++)
                    {
                        ushort d = depth[yy * W + xx];
                        if (InRange(d) && (best == 0 || d < best)) best = d;
                    }
                map[y * mw + (unmirror ? mw - 1 - x : x)] = best;
            }
        return U16(map);
    }
    static string Camera(double f, int fw, int fh, int w, int h)
    {
        double sx = (double)w / fw, sy = (double)h / fh;
        return "\"fx\":" + N(f * sx) + ",\"fy\":" + N(f * sy) + ",\"cx\":" + N(((fw - 1) / 2.0 + 0.5) * sx - 0.5) + ",\"cy\":" + N(((fh - 1) / 2.0 + 0.5) * sy - 0.5);
    }

    // ---------- bodies ----------
    // The Kinect for Xbox One's 25 joints (body-tracker.js's JOINTS), each from one of this one's 20:
    // its neck is its ShoulderCenter (as is SpineShoulder); its hand tips and thumbs it hasn't.
    static readonly string[] NAMES = { "SpineBase", "SpineMid", "Neck", "Head", "ShoulderLeft", "ElbowLeft", "WristLeft", "HandLeft", "ShoulderRight", "ElbowRight", "WristRight", "HandRight",
        "HipLeft", "KneeLeft", "AnkleLeft", "FootLeft", "HipRight", "KneeRight", "AnkleRight", "FootRight", "SpineShoulder", "HandTipLeft", "ThumbLeft", "HandTipRight", "ThumbRight" };
    static readonly int[] FROM = {
        (int)JointType.HipCenter, (int)JointType.Spine, (int)JointType.ShoulderCenter, (int)JointType.Head, (int)JointType.ShoulderLeft, (int)JointType.ElbowLeft, (int)JointType.WristLeft,
        (int)JointType.HandLeft, (int)JointType.ShoulderRight, (int)JointType.ElbowRight, (int)JointType.WristRight, (int)JointType.HandRight, (int)JointType.HipLeft, (int)JointType.KneeLeft,
        (int)JointType.AnkleLeft, (int)JointType.FootLeft, (int)JointType.HipRight, (int)JointType.KneeRight, (int)JointType.AnkleRight, (int)JointType.FootRight, (int)JointType.ShoulderCenter,
        -1, -1, -1, -1 };
    static double signX = -1;
    static string BodiesJson(Skeleton[] bodies, CoordinateMapper mapper, ColorImageFormat format, int cw, int ch, bool unmirror)
    {
        var o = new StringBuilder("[");
        bool first = true;
        double sab = 0, saa = 0, sa = 0, sb = 0; int n = 0;
        for (int i = 0; i < bodies.Length; i++)
        {
            var b = bodies[i];
            if (b == null || b.TrackingState != SkeletonTrackingState.Tracked) continue;
            o.Append(first ? "" : ",").Append("{\"id\":").Append(i).Append(",\"trackingId\":\"").Append(b.TrackingId).Append("\",\"joints\":[");
            first = false;
            for (int k = 0; k < NAMES.Length; k++)
            {
                o.Append(k > 0 ? "," : "").Append("{\"name\":\"").Append(NAMES[k]).Append('"');
                if (FROM[k] < 0) { o.Append(",\"u\":null,\"v\":null,\"x\":null,\"y\":null,\"z\":null,\"state\":\"none\",\"q\":[1,0,0,0]}"); continue; }
                var type = (JointType)FROM[k];
                var j = b.Joints[type];
                var q = b.BoneOrientations[type].AbsoluteRotation.Quaternion;
                string state = j.TrackingState == JointTrackingState.Tracked ? "tracked" : j.TrackingState == JointTrackingState.Inferred ? "inferred" : "none";
                var c = mapper.MapSkeletonPointToColorPoint(j.Position, format);
                bool onPicture = c.X >= 0 && c.X < cw && c.Y >= 0 && c.Y < ch && j.Position.Z > 0;
                double ux = unmirror ? cw - 1 - c.X : c.X;
                if (onPicture && j.TrackingState == JointTrackingState.Tracked)
                {
                    double a = j.Position.X / j.Position.Z;
                    sa += a; sb += ux; saa += a * a; sab += a * ux; n++;
                }
                double u = onPicture ? (ux + 0.5) / cw : double.NaN, v = onPicture ? (c.Y + 0.5) / ch : double.NaN;
                o.Append(",\"u\":").Append(N(u, 4)).Append(",\"v\":").Append(N(v, 4))
                 .Append(",\"x\":").Append(N(signX * j.Position.X * 1000, 0)).Append(",\"y\":").Append(N(-j.Position.Y * 1000, 0)).Append(",\"z\":").Append(N(j.Position.Z * 1000, 0))
                 .Append(",\"state\":\"").Append(state).Append("\",\"q\":[").Append(N(q.W, 4)).Append(',').Append(N(q.X, 4)).Append(',').Append(N(q.Y, 4)).Append(',').Append(N(q.Z, 4)).Append("]}");
            }
            o.Append("],\"hands\":{\"left\":\"unknown\",\"right\":\"unknown\"},\"lean\":[0,0],\"centre\":[0.5,0.5]}");
        }
        // (which way its x runs on the turned-back picture: from the joints it placed)
        if (n >= 6)
        {
            double k = (n * sab - sa * sb) / Math.Max(1e-9, n * saa - sa * sa);
            if (!double.IsNaN(k) && Math.Abs(k) > 1) signX = Math.Sign(k);
        }
        return o.Append(']').ToString();
    }

    // ---------- commands ----------
    static void StdinThread()
    {
        string line;
        try
        {
            while ((line = Console.In.ReadLine()) != null)
            {
                var a = line.Trim().Split(' ');
                float lo, hi; int t;
                if (a[0] == "quit") break;
                if (a[0] == "record" && a.Length > 1) record = a[1] == "on";
                else if (a[0] == "rawcolor" && a.Length > 1) rawcolor = a[1] == "on";
                else if (a[0] == "source" && a.Length > 1 && (a[1] == "color" || a[1] == "infrared" || a[1] == "auto")) wantSource = a[1];
                else if (a[0] == "tilt" && a.Length > 1 && int.TryParse(a[1], NumberStyles.Integer, C, out t)) wantTilt = Math.Max(-27, Math.Min(27, t));
                else if (a[0] == "depthrange" && a.Length > 2 && float.TryParse(a[1], NumberStyles.Float, C, out lo) && float.TryParse(a[2], NumberStyles.Float, C, out hi) && hi > lo)
                { depthMin = Math.Max(0.4f, lo); depthMax = Math.Min(10f, hi); }
                else if (a[0] == "light") Status("note", "The Kinect's SDK can't set its light on Windows.");
                else Status("note", "The Kinect's SDK can't set that on Windows: " + line);
            }
        }
        catch (Exception) { }
        quit = true;
    }

    static string Id(string unique)
    {
        var o = new StringBuilder();
        foreach (char c in unique ?? "") if (char.IsLetterOrDigit(c)) o.Append(c);
        string s = o.ToString();
        return s.Length == 0 ? "KINECT360" : s.Length > 24 ? s.Substring(s.Length - 24) : s;
    }
    static List<KinectSensor> Connected()
    {
        var list = new List<KinectSensor>();
        foreach (var s in KinectSensor.KinectSensors) if (s.Status == KinectStatus.Connected) list.Add(s);
        return list;
    }

    // The tilt motor, moved on a thread of its own (it takes a second or so), no more than once a
    // second and 15 times in 20 seconds (the SDK's own limits, for the motor's sake).
    static volatile int tiltNow = 0;
    static void MotorThread(KinectSensor sensor)
    {
        var moves = new Queue<double>();
        double lastRead = 0;
        while (!quit)
        {
            int want = wantTilt;
            double now = NowMs();
            while (moves.Count > 0 && now - moves.Peek() > 20000) moves.Dequeue();
            if (want != int.MinValue && moves.Count < 15 && (moves.Count == 0 || now - moves.ToArray()[moves.Count - 1] > 1000))
            {
                wantTilt = int.MinValue;
                try
                {
                    sensor.ElevationAngle = Math.Max(sensor.MinElevationAngle, Math.Min(sensor.MaxElevationAngle, want));
                    moves.Enqueue(NowMs());
                    Status("note", "", "\"applied\":\"tilt " + want + "\",\"tilt\":" + want);
                }
                catch (Exception e) { Status("note", "Its tilt couldn't be set: " + e.Message); }
            }
            if (now - lastRead > 1000)
            {
                lastRead = now;
                try { tiltNow = sensor.ElevationAngle; } catch (Exception) { }
            }
            Thread.Sleep(50);
        }
    }

    // ---------- running ----------
    static int Run()
    {
        const bool unmirror = true;
        Status("starting", "Opening the Kinect…");
        KinectSensor sensor = null;
        for (int t = 0; t < 5000 && sensor == null; t += 200)
        {
            foreach (var s in Connected()) if (device == null || Id(s.UniqueKinectId) == device || Id(s.DeviceConnectionId) == device) { sensor = s; break; }
            if (sensor == null) Thread.Sleep(200);
        }
        if (sensor == null)
        {
            Status("error", "No Kinect for Xbox 360 was found. Is it plugged in, with its power adapter's power on, and Microsoft's Kinect for Windows Runtime 1.8 installed?");
            return 2;
        }
        var colorFormat = width >= 1280 ? ColorImageFormat.RgbResolution1280x960Fps12 : ColorImageFormat.RgbResolution640x480Fps30;
        int cw = width >= 1280 ? 1280 : 640, ch = width >= 1280 ? 960 : 480;
        bool night = source == "infrared";
        sensor.DepthStream.Enable(DepthImageFormat.Resolution640x480Fps30);
        sensor.ColorStream.Enable(night ? ColorImageFormat.InfraredResolution640x480Fps30 : colorFormat);
        sensor.SkeletonStream.Enable();
        try { sensor.Start(); }
        catch (Exception e) { Status("error", "The Kinect didn't start: " + e.Message); return 3; }
        if (startTilt != int.MinValue) wantTilt = startTilt;
        new Thread(() => MotorThread(sensor)) { IsBackground = true }.Start();
        KinectAudioSource audio = null;
        Stream audioStream = null;
        if (mics)
        {
            try
            {
                audio = sensor.AudioSource;
                audio.EchoCancellationMode = EchoCancellationMode.None;
                audio.AutomaticGainControlEnabled = false;
                audio.BeamAngleMode = BeamAngleMode.Adaptive;
                audioStream = audio.Start();
            }
            catch (Exception) { audio = null; audioStream = null; }
        }
        var mapper = sensor.CoordinateMapper;
        Status("running", "", "\"camera\":\"Kinect for Xbox 360\",\"model\":\"360\",\"id\":\"" + Esc(Id(sensor.UniqueKinectId)) + "\",\"firmware\":\"\",\"pipeline\":\"Kinect SDK 1.8\",\"color\":{\"w\":" + cw + ",\"h\":" + ch + ","
            + Camera(COLOR_F * cw / 640, cw, ch, cw, ch) + "},\"ir\":{\"w\":640,\"h\":480," + Camera(DEPTH_F, W, H, W, H) + "},\"depth\":true,\"infrared\":true,\"bodies\":true,\"mics\":" + (audioStream != null ? "true" : "false")
            + ",\"motor\":true,\"tilt\":" + tiltNow + ",\"light\":null,\"source\":\"" + source + "\",\"size\":[" + (night ? W : cw) + "," + (night ? H : ch) + "],\"unmirrored\":true,\"version\":\"" + VERSION + "\"");

        // The microphones' beam, read on a thread of its own: 16-bit, 16 kHz, one channel.
        var beam = new List<short>();
        var beamLock = new object();
        double audioLevel = 0, beamU = 0;
        if (audioStream != null)
            new Thread(() =>
            {
                var buf = new byte[3200];
                try
                {
                    while (!quit)
                    {
                        int got = audioStream.Read(buf, 0, buf.Length);
                        if (got <= 0) { Thread.Sleep(10); continue; }
                        double sq = 0;
                        lock (beamLock)
                        {
                            if (beamU == 0) beamU = NowMs() - got / 32.0;
                            for (int i = 0; i + 1 < got; i += 2)
                            {
                                short s = BitConverter.ToInt16(buf, i);
                                sq += (double)s * s;
                                if (record) beam.Add(s);
                            }
                            audioLevel = Math.Sqrt(sq / Math.Max(1, got / 2)) / 32768;
                        }
                    }
                }
                catch (Exception) { }
            }) { IsBackground = true }.Start();

        var bgra = new byte[cw * ch * 4];
        var irRaw = new byte[W * H * 2];
        var ir = new ushort[W * H];
        var depthPx = new DepthImagePixel[W * H];
        var depth = new ushort[W * H];
        var depthPts = new DepthImagePoint[cw * ch];
        var skeletons = new Skeleton[sensor.SkeletonStream.FrameSkeletonArrayLength];
        var clock = new Clock();
        bool haveDepth = false;
        string bodiesJson = "[]";
        double dark = 128, darkSince = 0, lightSince = 0, lastFrame = NowMs(), lastAudio = 0, lastAccel = 0;
        double[] accel = { 0, -9.81, 0 };
        long seq = 0, depthTime = 0;
        var rate = new Queue<double>();
        while (!quit)
        {
            if (wantSource != null) { source = wantSource; wantSource = null; if (source != "auto") night = source == "infrared"; darkSince = lightSince = 0; }
            // (its colour stream is the colour camera's or the infrared one's: switched when night changes)
            bool streamNight = sensor.ColorStream.Format == ColorImageFormat.InfraredResolution640x480Fps30;
            if (streamNight != night) { try { sensor.ColorStream.Enable(night ? ColorImageFormat.InfraredResolution640x480Fps30 : colorFormat); } catch (Exception) { } }
            bool got = false;
            using (var f = sensor.DepthStream.OpenNextFrame(0))
                if (f != null)
                {
                    f.CopyDepthImagePixelDataTo(depthPx);
                    for (int i = 0; i < depthPx.Length; i++) depth[i] = (ushort)Math.Max((short)0, depthPx[i].Depth);
                    depthTime = f.Timestamp;
                    haveDepth = got = true;
                }
            using (var f = sensor.SkeletonStream.OpenNextFrame(0))
                if (f != null) { f.CopySkeletonDataTo(skeletons); bodiesJson = BodiesJson(skeletons, mapper, colorFormat, cw, ch, unmirror); }
            if (NowMs() - lastAccel > 500)
            {
                lastAccel = NowMs();
                try { var a = sensor.AccelerometerGetCurrentReading(); accel = new double[] { a.X * 9.81, a.Y * 9.81, a.Z * 9.81 }; } catch (Exception) { }
            }
            // The microphones: where the sound comes from (the SDK's own), and the sound itself while recording.
            if (audio != null && NowMs() - lastAudio > 100)
            {
                lastAudio = NowMs();
                byte[] b = null; double u, level;
                lock (beamLock)
                {
                    u = beamU > 0 ? beamU : NowMs();
                    level = audioLevel;
                    if (record && beam.Count > 0) { b = new byte[beam.Count * 2]; Buffer.BlockCopy(beam.ToArray(), 0, b, 0, b.Length); }
                    beam.Clear();
                    beamU = 0;
                }
                string fields = "\"kind\":\"audio\",\"u\":" + N(u, 1) + ",\"rate\":16000,\"channels\":1,\"frames\":" + (b != null ? b.Length / 2 : 0) + ",\"level\":[" + N(level, 5)
                    + "],\"angle\":" + N(audio.SoundSourceAngle, 1) + ",\"confidence\":" + N(audio.SoundSourceAngleConfidence, 2) + ",\"beamAngle\":true";
                if (b != null) Send(fields, P("beam", b)); else Send(fields);
            }
            bool newPicture = false;
            long pictureTime = 0;
            using (var f = sensor.ColorStream.OpenNextFrame(0))
                if (f != null)
                {
                    if (f.Format == ColorImageFormat.InfraredResolution640x480Fps30) { f.CopyPixelDataTo(irRaw); Buffer.BlockCopy(irRaw, 0, ir, 0, irRaw.Length); newPicture = night; }
                    else if (f.Width == cw && f.Height == ch) { f.CopyPixelDataTo(bgra); newPicture = !night; }
                    pictureTime = f.Timestamp;
                    got = got || newPicture;
                }
            // (how dark it is: a sample of the colour picture, or the infrared one's brightness)
            if (newPicture && !night)
            {
                double sum = 0; int n = 0;
                for (int i = 0; i < bgra.Length; i += 4 * 997) { sum += 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]; n++; }
                dark = n > 0 ? sum / n : 128;
            }
            if (source == "auto" && newPicture)
            {
                double now = NowMs();
                // (by night its colour camera isn't running: back to colour after a minute, to look again)
                if (!night && dark < 35) { if (darkSince == 0) darkSince = now; if (now - darkSince > 3000) { night = true; lightSince = now; } } else darkSince = 0;
                if (night && now - lightSince > 60000) { night = false; darkSince = 0; }
            }
            if (haveDepth && depthTime != 0 && record && got)
            {
                // (each depth frame's, with the infrared while it's the picture)
                if (night) Send("\"kind\":\"raw\",\"u\":" + N(clock.At(depthTime), 1) + ",\"w\":640,\"h\":480", P("depth", U16(Unmirrored(depth, W, H))), P("ir", U16(Unmirrored(ir, W, H))));
                else Send("\"kind\":\"raw\",\"u\":" + N(clock.At(depthTime), 1) + ",\"w\":640,\"h\":480", P("depth", U16(Unmirrored(depth, W, H))));
                depthTime = 0;
            }
            if (!got)
            {
                if (NowMs() - lastFrame > 5000) { Status("error", "The Kinect stopped sending pictures."); break; }
                Thread.Sleep(3);
                continue;
            }
            lastFrame = NowMs();
            if (!newPicture || !haveDepth) continue;
            string motion = ",\"tilt\":" + tiltNow + ",\"accel\":[" + N(accel[0], 2) + "," + N(accel[1], 2) + "," + N(accel[2], 2) + "],\"light\":null";
            Tick(rate);
            if (!night)
            {
                var turned = Unmirror32(bgra, cw, ch);
                if (record && rawcolor) Send("\"kind\":\"rawcolor\",\"u\":" + N(clock.At(pictureTime), 1), P("jpeg", Jpeg(turned, cw, ch, PixelFormats.Bgra32, 4)));
                mapper.MapColorFrameToDepthFrame(colorFormat, DepthImageFormat.Resolution640x480Fps30, depthPx, depthPts);
                const int mw = 320, mh = 240;
                byte[] map = ColorMap(depthPts, cw, ch, mw, mh, unmirror);
                byte[] jpeg = Jpeg(turned, cw, ch, PixelFormats.Bgra32, 4);
                string fields = "\"kind\":\"frame\",\"seq\":" + (++seq) + ",\"t\":" + N(NowMs(), 1) + ",\"u\":" + N(clock.At(pictureTime), 1) + ",\"source\":\"color\",\"w\":" + cw + ",\"h\":" + ch
                    + ",\"image\":{" + Camera(COLOR_F * cw / 640, cw, ch, cw, ch) + "},\"map\":{\"w\":" + mw + ",\"h\":" + mh + "," + Camera(COLOR_F * cw / 640, cw, ch, mw, mh)
                    + "},\"dark\":" + N(dark, 1) + ",\"fps\":" + N(Fps(rate), 1) + ",\"night\":false,\"auto\":" + (source == "auto" ? "true" : "false") + motion;
                Send(fields, P("jpeg", jpeg), P("depth", map), P("body", Encoding.UTF8.GetBytes(bodiesJson)));
            }
            else
            {
                const int mw = 320, mh = 240;
                byte[] jpeg = Jpeg(IrPicture(ir, W, H, unmirror), W, H, PixelFormats.Gray8, 1);
                byte[] map = IrMap(depth, mw, mh, unmirror);
                string fields = "\"kind\":\"frame\",\"seq\":" + (++seq) + ",\"t\":" + N(NowMs(), 1) + ",\"u\":" + N(clock.At(pictureTime), 1) + ",\"source\":\"infrared\",\"w\":640,\"h\":480"
                    + ",\"image\":{" + Camera(DEPTH_F, W, H, W, H) + "},\"map\":{\"w\":" + mw + ",\"h\":" + mh + "," + Camera(DEPTH_F, W, H, mw, mh) + "},\"dark\":" + N(dark, 1)
                    + ",\"fps\":" + N(Fps(rate), 1) + ",\"night\":true,\"auto\":" + (source == "auto" ? "true" : "false") + motion;
                // (the bodies' places are on the colour picture: none drawn on the infrared one)
                Send(fields, P("jpeg", jpeg), P("depth", map));
            }
        }
        quit = true;
        try { if (audio != null) audio.Stop(); } catch (Exception) { }
        try { sensor.Stop(); } catch (Exception) { }
        return 0;
    }
    static void Tick(Queue<double> q)
    {
        q.Enqueue(NowMs());
        while (q.Count > 1 && NowMs() - q.Peek() > 2000) q.Dequeue();
    }
    static double Fps(Queue<double> q)
    {
        if (q.Count < 2) return 0;
        var a = q.ToArray();
        return (a.Length - 1) * 1000.0 / Math.Max(1, a[a.Length - 1] - a[0]);
    }

    // ---------- the build's own check (no Kinect) ----------
    static int SelfTest()
    {
        // A picture with a white square at its left: turned back, the square is at its right.
        var bgra = new byte[640 * 480 * 4];
        for (int i = 0; i < bgra.Length; i += 4) { bgra[i] = bgra[i + 1] = bgra[i + 2] = 30; }
        for (int y = 220; y < 260; y++) for (int x = 40; x < 80; x++) { int i = (y * 640 + x) * 4; bgra[i] = bgra[i + 1] = bgra[i + 2] = 255; }
        var turned = Unmirror32(bgra, 640, 480);
        bool turnedOk = turned[(240 * 640 + (639 - 60)) * 4] > 200 && turned[(240 * 640 + 60) * 4] < 80 && turned[3] == 255;
        byte[] jpeg = Jpeg(turned, 640, 480, PixelFormats.Bgra32, 4);
        bool encoded = jpeg.Length > 1000 && jpeg[0] == 0xff && jpeg[1] == 0xd8;
        var ir = new ushort[W * H];
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) ir[y * W + x] = (ushort)((100 + 900 * x / 639) << 6);
        for (int y = 230; y < 250; y++) for (int x = 10; x < 30; x++) ir[y * W + x] = 60000;
        byte[] grey = null;
        for (int k = 0; k < 40; k++) grey = IrPicture(ir, W, H, true);
        bool irOk = grey[240 * W + 639 - 20] > 200 && grey[240 * W + 639 - 40] < 160 && grey[240 * W + 639 - 600] > 150;
        var depth = new ushort[W * H];
        for (int i = 0; i < depth.Length; i++) depth[i] = 3000;
        for (int y = 200; y < 280; y++) for (int x = 140; x < 220; x++) depth[y * W + x] = 1000;
        var m = IrMap(depth, 320, 240, true);
        bool mapOk = BitConverter.ToUInt16(m, (120 * 320 + 319 - 90) * 2) == 1000 && BitConverter.ToUInt16(m, (120 * 320 + 90) * 2) == 3000;
        depthMax = 2.5f;
        var m2 = IrMap(depth, 320, 240, true);
        bool rangeOk = BitConverter.ToUInt16(m2, (120 * 320 + 90) * 2) == 0 && BitConverter.ToUInt16(m2, (120 * 320 + 319 - 90) * 2) == 1000;
        depthMax = 8f;
        bool ok = turnedOk && encoded && irOk && mapOk && rangeOk && NAMES.Length == 25 && FROM.Length == 25;
        Send("\"status\":\"selftest\",\"ok\":" + (ok ? "true" : "false") + ",\"turned\":" + (turnedOk ? "true" : "false") + ",\"jpeg\":" + (encoded ? "true" : "false")
            + ",\"infrared\":" + (irOk ? "true" : "false") + ",\"irMap\":" + (mapOk ? "true" : "false") + ",\"range\":" + (rangeOk ? "true" : "false"));
        return ok ? 0 : 1;
    }

    [STAThread]
    static int Main(string[] args)
    {
        stdout = Console.OpenStandardOutput();
        string mode = "run";
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            Func<string> next = () => i + 1 < args.Length ? args[++i] : "";
            int v;
            if (a == "--check" || a == "--list" || a == "--selftest") mode = a.Substring(2);
            else if (a == "--device") device = next();
            else if (a == "--source") { string s = next(); if (s == "color" || s == "infrared" || s == "auto") source = s; }
            else if (a == "--quality") { if (int.TryParse(next(), out v)) quality = Math.Max(30, Math.Min(95, v)); }
            else if (a == "--no-mics") mics = false;
            else if (a == "--tilt") { if (int.TryParse(next(), NumberStyles.Integer, C, out v)) startTilt = Math.Max(-27, Math.Min(27, v)); }
            else if (a == "--light") next(); // (the SDK can't set it)
            else if (a == "--size") { string s = next(); width = s == "1280x960" ? 1280 : 640; height = width == 1280 ? 960 : 480; }
        }
        try
        {
            if (mode == "selftest") return SelfTest();
            if (mode == "check") { Send("\"status\":\"check\",\"version\":\"" + VERSION + "\",\"sdk\":\"Kinect for Windows 1.8\""); return 0; }
            if (mode == "list")
            {
                var o = new StringBuilder("[");
                foreach (var s in Connected()) o.Append(o.Length > 1 ? "," : "").Append("{\"id\":\"").Append(Esc(Id(s.UniqueKinectId))).Append("\",\"name\":\"Kinect for Xbox 360\"}");
                Send("\"status\":\"devices\",\"devices\":" + o.Append(']'));
                return 0;
            }
            new Thread(StdinThread) { IsBackground = true }.Start();
            int code = Run();
            Status("stopped", "", "\"code\":" + code);
            return code;
        }
        catch (Exception e)
        {
            Status("error", "The Kinect's helper stopped: " + e.Message);
            return 5;
        }
    }
}
