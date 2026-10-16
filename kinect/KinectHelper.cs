// KinectHelper.cs — the Kinect for Xbox One for Hand Tracker on Windows (electron/kinect.js builds
// it the first time with Windows' own C# compiler, against Microsoft's Kinect for Windows Runtime
// 2.0, and runs it). It streams what kinect2-helper.cpp streams on Linux, the same way (HTK1
// messages on stdout: "HTK1", a u32 header length, a JSON header, a u32 length and the header's
// parts), and the Kinect's own body tracking with each frame (part "body": JSON, as
// body-tracker.js's bodies) and its microphone array's beam (the four lined up by the Kinect).
//
//   KinectHelper --check | --list | --selftest
//   KinectHelper [--device <id>] [--source color|infrared|auto] [--size 960x540|...] [--quality 80] [--no-mics]
//
// Commands on stdin, one a line: "source color|infrared|auto", "record on|off", "rawcolor on|off",
// "quit" (the colour camera's exposure, its light and depth's range can't be set through the
// SDK: those are said so).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Kinect;

static class KinectHelper
{
    const string VERSION = "1";
    static readonly object outLock = new object();
    static Stream stdout;
    static volatile bool quit, record, rawcolor;
    static volatile string wantSource = null;
    static string source = "color";
    static int width = 960, height = 540, quality = 80;
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

    // Each frame's time in ms since 1970: the Kinect's own clock plus the smallest gap seen between
    // it and when frames arrive (creeping up very slowly, for the clocks' drift).
    sealed class Clock
    {
        double offset = double.PositiveInfinity, last;
        public double At(TimeSpan relative)
        {
            double dev = relative.TotalMilliseconds, arrived = NowMs();
            if (!double.IsInfinity(offset)) offset += Math.Max(0, arrived - last) * 1e-5;
            last = arrived;
            offset = Math.Min(offset, arrived - dev);
            return dev + offset;
        }
    }

    // ---------- pictures ----------
    // BGRA w x h (stride w*4) -> JPEG, through WPF's encoder.
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
    // The colour picture (BGRA 1920 x 1080, mirrored as the Kinect makes it) at w x h, turned back.
    static unsafe byte[] Shrink(byte[] bgra, int w, int h, bool unmirror)
    {
        var out_ = new byte[w * h * 4];
        fixed (byte* src = bgra, dst = out_)
        {
            for (int y = 0; y < h; y++)
            {
                int sy = (int)((y + 0.5) * 1080 / h);
                uint* srow = (uint*)(src + (long)sy * 1920 * 4);
                uint* drow = (uint*)(dst + (long)y * w * 4);
                for (int x = 0; x < w; x++)
                {
                    int sx = (int)((x + 0.5) * 1920 / w);
                    drow[unmirror ? w - 1 - x : x] = srow[sx] | 0xff000000u;
                }
            }
        }
        return out_;
    }
    // The infrared camera's brightness as a picture (as kinect2-helper.cpp's IrScale).
    static float irBright = 3000;
    static byte[] IrPicture(ushort[] ir, int w, int h, bool unmirror)
    {
        var sample = new List<float>(w * h / 16 + 1);
        for (int i = 0; i < w * h; i += 16) sample.Add(ir[i]);
        sample.Sort();
        float p98 = Math.Max(200f, sample[sample.Count * 98 / 100]);
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

    // ---------- where things are ----------
    // The colour camera's parameters, found from the Kinect's own mapping of colour pixels to
    // points (the SDK has no call for them): u = fx * x / z + cx, fitted on the points it maps.
    static double fx = 1081.37, fy = 1081.37, cx = 959.5, cy = 539.5, signX = -1, signY = -1;
    static bool fitted = false;
    static void Fit(CameraSpacePoint[] pts, bool unmirror)
    {
        double sa = 0, sb = 0, saa = 0, sab = 0, sc = 0, sd = 0, scc = 0, scd = 0;
        int n = 0;
        for (int y = 20; y < 1080; y += 40)
            for (int x = 20; x < 1920; x += 40)
            {
                var p = pts[y * 1920 + x];
                if (!(p.Z > 0.3f) || float.IsInfinity(p.X)) continue;
                double a = p.X / p.Z, b = unmirror ? 1919 - x : x, c = p.Y / p.Z, d = y;
                sa += a; sb += b; saa += a * a; sab += a * b; sc += c; sd += d; scc += c * c; scd += c * d; n++;
            }
        if (n < 200) return;
        double kx = (n * sab - sa * sb) / (n * saa - sa * sa), ky = (n * scd - sc * sd) / (n * scc - sc * sc);
        if (double.IsNaN(kx) || double.IsNaN(ky)) return;
        cx = (sb - kx * sa) / n;
        cy = (sd - ky * sc) / n;
        signX = Math.Sign(kx);
        signY = Math.Sign(ky);
        fx = Math.Abs(kx);
        fy = Math.Abs(ky);
        fitted = true;
    }
    // The depth for each part of the colour picture (mw x mh, mm, 0: none), from the Kinect's own
    // mapping of each colour pixel to a point.
    static byte[] ColorMap(CameraSpacePoint[] pts, int mw, int mh, bool unmirror)
    {
        var map = new ushort[mw * mh];
        for (int y = 0; y < mh; y++)
            for (int x = 0; x < mw; x++)
            {
                int px = (int)((x + 0.5) * 1920 / mw), py = (int)((y + 0.5) * 1080 / mh);
                float z = pts[py * 1920 + px].Z;
                if (z > 0 && !float.IsInfinity(z)) map[y * mw + (unmirror ? mw - 1 - x : x)] = (ushort)Math.Min(65535, z * 1000);
            }
        return U16(map);
    }
    static byte[] IrMap(ushort[] depth, int mw, int mh, bool unmirror)
    {
        var map = new ushort[mw * mh];
        int sx = 512 / mw, sy = 424 / mh;
        for (int y = 0; y < mh; y++)
            for (int x = 0; x < mw; x++)
            {
                ushort best = 0;
                for (int yy = y * sy; yy < (y + 1) * sy; yy++)
                    for (int xx = x * sx; xx < (x + 1) * sx; xx++)
                    {
                        ushort d = depth[yy * 512 + xx];
                        if (d > 0 && (best == 0 || d < best)) best = d;
                    }
                map[y * mw + (unmirror ? mw - 1 - x : x)] = best;
            }
        return U16(map);
    }
    static string Scaled(double f_x, double f_y, double c_x, double c_y, double fw, double fh, int w, int h)
    {
        double sx = w / fw, sy = h / fh;
        return "\"fx\":" + N(f_x * sx) + ",\"fy\":" + N(f_y * sy) + ",\"cx\":" + N((c_x + 0.5) * sx - 0.5) + ",\"cy\":" + N((c_y + 0.5) * sy - 0.5);
    }

    // ---------- bodies ----------
    // The SDK's joints, in its own order (as body-tracker.js's JOINTS).
    static readonly JointType[] JOINTS = {
        JointType.SpineBase, JointType.SpineMid, JointType.Neck, JointType.Head, JointType.ShoulderLeft, JointType.ElbowLeft, JointType.WristLeft, JointType.HandLeft,
        JointType.ShoulderRight, JointType.ElbowRight, JointType.WristRight, JointType.HandRight, JointType.HipLeft, JointType.KneeLeft, JointType.AnkleLeft, JointType.FootLeft,
        JointType.HipRight, JointType.KneeRight, JointType.AnkleRight, JointType.FootRight, JointType.SpineShoulder, JointType.HandTipLeft, JointType.ThumbLeft,
        JointType.HandTipRight, JointType.ThumbRight };
    static string HandName(HandState s)
    {
        switch (s) { case HandState.Open: return "open"; case HandState.Closed: return "closed"; case HandState.Lasso: return "lasso"; case HandState.NotTracked: return "notTracked"; default: return "unknown"; }
    }
    static string BodiesJson(Body[] bodies, CoordinateMapper mapper, bool unmirror)
    {
        var o = new StringBuilder("[");
        bool first = true;
        for (int i = 0; i < bodies.Length; i++)
        {
            var b = bodies[i];
            if (b == null || !b.IsTracked) continue;
            o.Append(first ? "" : ",").Append("{\"id\":").Append(i).Append(",\"trackingId\":\"").Append(b.TrackingId).Append("\",\"joints\":[");
            first = false;
            for (int k = 0; k < JOINTS.Length; k++)
            {
                var j = b.Joints[JOINTS[k]];
                var q = b.JointOrientations[JOINTS[k]].Orientation;
                string state = j.TrackingState == TrackingState.Tracked ? "tracked" : j.TrackingState == TrackingState.Inferred ? "inferred" : "none";
                var c = mapper.MapCameraPointToColorSpace(j.Position);
                bool onPicture = !float.IsInfinity(c.X) && !float.IsInfinity(c.Y);
                double u = onPicture ? ((unmirror ? 1919 - c.X : c.X) + 0.5) / 1920 : double.NaN, v = onPicture ? (c.Y + 0.5) / 1080 : double.NaN;
                o.Append(k > 0 ? "," : "").Append("{\"name\":\"").Append(JOINTS[k]).Append("\",\"u\":").Append(N(u, 4)).Append(",\"v\":").Append(N(v, 4))
                 .Append(",\"x\":").Append(N(signX * j.Position.X * 1000, 0)).Append(",\"y\":").Append(N(signY * j.Position.Y * 1000, 0)).Append(",\"z\":").Append(N(j.Position.Z * 1000, 0))
                 .Append(",\"state\":\"").Append(state).Append("\",\"q\":[").Append(N(q.W, 4)).Append(',').Append(N(q.X, 4)).Append(',').Append(N(q.Y, 4)).Append(',').Append(N(q.Z, 4)).Append("]}");
            }
            o.Append("],\"hands\":{\"left\":\"").Append(HandName(b.HandLeftState)).Append("\",\"right\":\"").Append(HandName(b.HandRightState))
             .Append("\"},\"lean\":[").Append(N(b.Lean.X, 2)).Append(',').Append(N(b.Lean.Y, 2)).Append("],\"centre\":[0.5,0.5]}");
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
                if (a[0] == "quit") break;
                if (a[0] == "record" && a.Length > 1) record = a[1] == "on";
                else if (a[0] == "rawcolor" && a.Length > 1) rawcolor = a[1] == "on";
                else if (a[0] == "source" && a.Length > 1 && (a[1] == "color" || a[1] == "infrared" || a[1] == "auto")) wantSource = a[1];
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
        return s.Length == 0 ? "KINECT" : s.Length > 24 ? s.Substring(s.Length - 24) : s;
    }

    static KinectSensor Open(int waitMs)
    {
        var sensor = KinectSensor.GetDefault();
        if (sensor == null) return null;
        sensor.Open();
        for (int t = 0; t < waitMs && !sensor.IsAvailable; t += 100) Thread.Sleep(100);
        return sensor;
    }

    // ---------- running ----------
    static int Run()
    {
        bool unmirror = true;
        Status("starting", "Opening the Kinect…");
        var sensor = Open(5000);
        if (sensor == null || !sensor.IsAvailable)
        {
            Status("error", "No Kinect was found. Is it plugged into a USB 3 port, with its power on, and Microsoft's Kinect for Windows Runtime 2.0 installed?");
            if (sensor != null) sensor.Close();
            return 2;
        }
        var mapper = sensor.CoordinateMapper;
        var colorReader = sensor.ColorFrameSource.OpenReader();
        var depthReader = sensor.DepthFrameSource.OpenReader();
        var irReader = sensor.InfraredFrameSource.OpenReader();
        var bodyReader = sensor.BodyFrameSource.OpenReader();
        AudioBeamFrameReader audioReader = null;
        if (mics) try { audioReader = sensor.AudioSource.OpenReader(); } catch (Exception) { audioReader = null; }
        var ii = mapper.GetDepthCameraIntrinsics();
        double icx = unmirror ? 511 - ii.PrincipalPointX : ii.PrincipalPointX;
        Status("running", "", "\"camera\":\"Kinect for Xbox One\",\"id\":\"" + Esc(Id(sensor.UniqueKinectId)) + "\",\"firmware\":\"\",\"pipeline\":\"Kinect SDK\",\"color\":{\"w\":1920,\"h\":1080,"
            + Scaled(fx, fy, unmirror ? 1919 - cx : cx, cy, 1920, 1080, 1920, 1080) + "},\"ir\":{\"w\":512,\"h\":424,\"fx\":" + N(ii.FocalLengthX) + ",\"fy\":" + N(ii.FocalLengthY)
            + ",\"cx\":" + N(icx) + ",\"cy\":" + N(ii.PrincipalPointY) + ",\"k1\":" + N(ii.RadialDistortionSecondOrder, 6) + ",\"k2\":" + N(ii.RadialDistortionFourthOrder, 6)
            + ",\"k3\":" + N(ii.RadialDistortionSixthOrder, 6) + "},\"depth\":true,\"infrared\":true,\"bodies\":true,\"mics\":" + (audioReader != null ? "true" : "false")
            + ",\"source\":\"" + source + "\",\"size\":[" + width + "," + height + "],\"unmirrored\":true,\"version\":\"" + VERSION + "\"");

        var bgra = new byte[1920 * 1080 * 4];
        var depth = new ushort[512 * 424];
        var ir = new ushort[512 * 424];
        var bodies = new Body[sensor.BodyFrameSource.BodyCount];
        var colorPts = new CameraSpacePoint[1920 * 1080];
        var clock = new Clock();
        bool haveDepth = false, haveIr = false, night = source == "infrared";
        string bodiesJson = "[]";
        double dark = 128, darkSince = 0, lightSince = 0, lastFrame = NowMs();
        long seq = 0, colors = 0;
        var rate = new Queue<double>();
        var audioLevel = 0.0; double angle = 0, confidence = 0;
        var beam = new List<short>();
        double beamU = 0, lastAudio = 0;
        float exposure = 0, gain = 0;
        while (!quit)
        {
            if (wantSource != null) { source = wantSource; wantSource = null; night = source == "infrared"; darkSince = lightSince = 0; }
            bool got = false;
            // Depth and infrared (30 a second in any light), each frame's.
            TimeSpan depthTime = TimeSpan.Zero;
            using (var f = depthReader.AcquireLatestFrame())
                if (f != null) { f.CopyFrameDataToArray(depth); depthTime = f.RelativeTime; haveDepth = got = true; }
            bool newIr = false;
            using (var f = irReader.AcquireLatestFrame())
                if (f != null) { f.CopyFrameDataToArray(ir); haveIr = got = newIr = true; }
            if (depthTime != TimeSpan.Zero && record)
            {
                double u = clock.At(depthTime);
                Send("\"kind\":\"raw\",\"u\":" + N(u, 1) + ",\"w\":512,\"h\":424", P("depth", U16(unmirror ? Unmirrored(depth, 512, 424) : depth)), P("ir", U16(unmirror ? Unmirrored(ir, 512, 424) : ir)));
            }
            using (var f = bodyReader.AcquireLatestFrame())
                if (f != null) { f.GetAndRefreshBodyData(bodies); bodiesJson = BodiesJson(bodies, mapper, unmirror); }
            // The microphones' beam: where the sound comes from, and the sound itself while recording.
            if (audioReader != null)
            {
                var frames = audioReader.AcquireLatestBeamFrames();
                if (frames != null)
                    foreach (var bf in frames)
                    {
                        using (bf)
                            foreach (var sub in bf.SubFrames)
                                using (sub)
                                {
                                    var data = new byte[sub.FrameLengthInBytes];
                                    sub.CopyFrameDataToArray(data);
                                    double sq = 0;
                                    for (int i = 0; i + 3 < data.Length; i += 4)
                                    {
                                        float s = BitConverter.ToSingle(data, i);
                                        sq += s * s;
                                        if (record) beam.Add((short)Math.Max(-32767, Math.Min(32767, s * 32767 * 4)));
                                    }
                                    audioLevel = Math.Sqrt(sq / Math.Max(1, data.Length / 4));
                                    angle = sub.BeamAngle * 180 / Math.PI;
                                    confidence = sub.BeamAngleConfidence;
                                    if (beamU == 0) beamU = NowMs();
                                }
                    }
                if (NowMs() - lastAudio > 100)
                {
                    lastAudio = NowMs();
                    string fields = "\"kind\":\"audio\",\"u\":" + N(beamU > 0 ? beamU : NowMs(), 1) + ",\"rate\":16000,\"channels\":1,\"frames\":" + beam.Count + ",\"level\":[" + N(audioLevel, 5)
                        + "],\"angle\":" + N(angle, 1) + ",\"confidence\":" + N(confidence, 2) + ",\"beamAngle\":true";
                    if (record && beam.Count > 0)
                    {
                        var b = new byte[beam.Count * 2];
                        Buffer.BlockCopy(beam.ToArray(), 0, b, 0, b.Length);
                        Send(fields, P("beam", b));
                    }
                    else Send(fields);
                    beam.Clear();
                    beamU = 0;
                }
            }
            // The colour picture (30 a second, 15 in the dark), and the depth lined up with it.
            bool newColor = false;
            TimeSpan colorTime = TimeSpan.Zero;
            using (var f = colorReader.AcquireLatestFrame())
                if (f != null)
                {
                    f.CopyConvertedFrameDataToArray(bgra, ColorImageFormat.Bgra);
                    colorTime = f.RelativeTime;
                    try { exposure = (float)f.ColorCameraSettings.ExposureTime.TotalMilliseconds; gain = f.ColorCameraSettings.Gain; } catch (Exception) { }
                    newColor = got = true;
                    colors++;
                }
            if (newColor && record && rawcolor)
            {
                var full = Shrink(bgra, 1920, 1080, unmirror);
                Send("\"kind\":\"rawcolor\",\"u\":" + N(clock.At(colorTime), 1), P("jpeg", Jpeg(full, 1920, 1080, PixelFormats.Bgra32, 4)));
            }
            if (newColor && (source == "auto" || !night) && (colors % 5 == 0 || !night))
            {
                // (how dark it is: a sample of the picture)
                double sum = 0; int n = 0;
                for (int i = 0; i < bgra.Length; i += 4 * 997) { sum += 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]; n++; }
                dark = n > 0 ? sum / n : 128;
            }
            if (source == "auto" && newColor)
            {
                double now = NowMs();
                if (!night && dark < 35) { if (darkSince == 0) darkSince = now; if (now - darkSince > 3000) { night = true; lightSince = 0; } } else darkSince = 0;
                if (night && dark > 70) { if (lightSince == 0) lightSince = now; if (now - lightSince > 5000) { night = false; darkSince = 0; } } else lightSince = 0;
            }
            if (!got)
            {
                if (NowMs() - lastFrame > 5000) { Status("error", "The Kinect stopped sending pictures."); break; }
                Thread.Sleep(3);
                continue;
            }
            lastFrame = NowMs();
            byte[] body = Encoding.UTF8.GetBytes(bodiesJson);
            if (!night && newColor && haveDepth)
            {
                mapper.MapColorFrameToCameraSpace(depth, colorPts);
                if (!fitted || seq % 300 == 0) Fit(colorPts, unmirror);
                const int mw = 480, mh = 270;
                byte[] map = ColorMap(colorPts, mw, mh, unmirror);
                byte[] jpeg = Jpeg(Shrink(bgra, width, height, unmirror), width, height, PixelFormats.Bgra32, 4);
                double ccx = cx; // (fitted in the turned-back picture already)
                Tick(rate);
                string fields = "\"kind\":\"frame\",\"seq\":" + (++seq) + ",\"t\":" + N(NowMs(), 1) + ",\"u\":" + N(clock.At(colorTime), 1) + ",\"source\":\"color\",\"w\":" + width + ",\"h\":" + height
                    + ",\"image\":{" + Scaled(fx, fy, ccx, cy, 1920, 1080, width, height) + "},\"map\":{\"w\":" + mw + ",\"h\":" + mh + "," + Scaled(fx, fy, ccx, cy, 1920, 1080, mw, mh)
                    + "},\"dark\":" + N(dark, 1) + ",\"exposure\":" + N(exposure, 2) + ",\"gain\":" + N(gain, 2) + ",\"fps\":" + N(Fps(rate), 1) + ",\"night\":false,\"auto\":" + (source == "auto" ? "true" : "false");
                Send(fields, P("jpeg", jpeg), P("depth", map), P("body", body));
            }
            else if (night && newIr && haveDepth)
            {
                const int mw = 256, mh = 212;
                byte[] grey = IrPicture(ir, 512, 424, unmirror);
                byte[] jpeg = Jpeg(grey, 512, 424, PixelFormats.Gray8, 1);
                byte[] map = IrMap(depth, mw, mh, unmirror);
                Tick(rate);
                string fields = "\"kind\":\"frame\",\"seq\":" + (++seq) + ",\"t\":" + N(NowMs(), 1) + ",\"u\":" + N(clock.At(depthTime == TimeSpan.Zero ? colorTime : depthTime), 1) + ",\"source\":\"infrared\",\"w\":512,\"h\":424"
                    + ",\"image\":{" + Scaled(ii.FocalLengthX, ii.FocalLengthY, icx, ii.PrincipalPointY, 512, 424, 512, 424) + "},\"map\":{\"w\":" + mw + ",\"h\":" + mh + ","
                    + Scaled(ii.FocalLengthX, ii.FocalLengthY, icx, ii.PrincipalPointY, 512, 424, mw, mh) + "},\"dark\":" + N(dark, 1) + ",\"fps\":" + N(Fps(rate), 1) + ",\"night\":true,\"auto\":" + (source == "auto" ? "true" : "false");
                // (the bodies' places are on the colour picture: none drawn on the infrared one)
                Send(fields, P("jpeg", jpeg), P("depth", map));
            }
        }
        if (audioReader != null) audioReader.Dispose();
        colorReader.Dispose();
        depthReader.Dispose();
        irReader.Dispose();
        bodyReader.Dispose();
        sensor.Close();
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
        var bgra = new byte[1920 * 1080 * 4];
        for (int i = 0; i < bgra.Length; i += 4) { bgra[i] = bgra[i + 1] = bgra[i + 2] = 30; bgra[i + 3] = 255; }
        for (int y = 500; y < 580; y++) for (int x = 100; x < 180; x++) { int i = (y * 1920 + x) * 4; bgra[i] = bgra[i + 1] = bgra[i + 2] = 255; }
        var small = Shrink(bgra, 960, 540, true);
        bool turned = small[(270 * 960 + (959 - 70)) * 4] > 200 && small[(270 * 960 + 70) * 4] < 80;
        byte[] jpeg = Jpeg(small, 960, 540, PixelFormats.Bgra32, 4);
        bool encoded = jpeg.Length > 1000 && jpeg[0] == 0xff && jpeg[1] == 0xd8;
        var ir = new ushort[512 * 424];
        for (int y = 0; y < 424; y++) for (int x = 0; x < 512; x++) ir[y * 512 + x] = (ushort)(100 + 900 * x / 511);
        for (int y = 200; y < 220; y++) for (int x = 10; x < 30; x++) ir[y * 512 + x] = 6000;
        byte[] grey = null;
        for (int k = 0; k < 40; k++) grey = IrPicture(ir, 512, 424, true);
        bool irOk = grey[210 * 512 + 511 - 20] > 200 && grey[210 * 512 + 511 - 40] < 120 && grey[210 * 512 + 511 - 500] > 200;
        var depth = new ushort[512 * 424];
        for (int i = 0; i < depth.Length; i++) depth[i] = 3000;
        for (int y = 180; y < 240; y++) for (int x = 120; x < 180; x++) depth[y * 512 + x] = 1000;
        var m = IrMap(depth, 256, 212, true);
        bool mapOk = BitConverter.ToUInt16(m, (105 * 256 + 255 - 75) * 2) == 1000 && BitConverter.ToUInt16(m, (105 * 256 + 75) * 2) == 3000;
        bool ok = turned && encoded && irOk && mapOk;
        Send("\"status\":\"selftest\",\"ok\":" + (ok ? "true" : "false") + ",\"turned\":" + (turned ? "true" : "false") + ",\"jpeg\":" + (encoded ? "true" : "false")
            + ",\"infrared\":" + (irOk ? "true" : "false") + ",\"irMap\":" + (mapOk ? "true" : "false"));
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
            if (a == "--check" || a == "--list" || a == "--selftest") mode = a.Substring(2);
            else if (a == "--device") next();
            else if (a == "--source") { string s = next(); if (s == "color" || s == "infrared" || s == "auto") source = s; }
            else if (a == "--quality") { int q; if (int.TryParse(next(), out q)) quality = Math.Max(30, Math.Min(95, q)); }
            else if (a == "--no-mics") mics = false;
            else if (a == "--size")
            {
                var p = next().Split('x');
                int w, h;
                if (p.Length == 2 && int.TryParse(p[0], out w) && int.TryParse(p[1], out h) && w >= 320 && w <= 1920 && h >= 180 && h <= 1080) { width = w; height = h; }
            }
        }
        try
        {
            if (mode == "selftest") return SelfTest();
            if (mode == "check") { Send("\"status\":\"check\",\"version\":\"" + VERSION + "\",\"sdk\":\"Kinect for Windows 2.0\""); return 0; }
            if (mode == "list")
            {
                var sensor = Open(3000);
                string list = sensor != null && sensor.IsAvailable ? "[{\"id\":\"" + Esc(Id(sensor.UniqueKinectId)) + "\",\"name\":\"Kinect for Xbox One\"}]" : "[]";
                if (sensor != null) sensor.Close();
                Send("\"status\":\"devices\",\"devices\":" + list);
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
