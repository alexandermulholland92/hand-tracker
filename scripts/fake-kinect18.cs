// fake-kinect18.cs — for the checks (scripts/check.js, kinect360-windows-helper): a stand-in for
// Microsoft's Kinect for Windows SDK 1.8 library (Microsoft.Kinect.dll), with just the parts
// kinect/Kinect360Helper.cs uses, so that helper builds and runs on a computer without the SDK or a
// Kinect for Xbox 360. Its one Kinect makes up 30 frames a second: a grey colour picture, an infrared
// one brighter to the right, a wall 2 m away with a box 850 mm away in the middle, one person standing
// 2 m away, its head tilted by its motor (and its tilt sensor saying so), and a 440 Hz tone. Built
// with Windows' own C# compiler: csc -target:library -out:Microsoft.Kinect.dll fake-kinect18.cs

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Microsoft.Kinect
{
    public enum KinectStatus { Undefined, Disconnected, Connected, Initializing, Error, NotPowered, NotReady, DeviceNotGenuine, DeviceNotSupported, InsufficientBandwidth }
    public enum ColorImageFormat { Undefined, RgbResolution640x480Fps30, RgbResolution1280x960Fps12, YuvResolution640x480Fps15, RawYuvResolution640x480Fps15, InfraredResolution640x480Fps30, RawBayerResolution640x480Fps30, RawBayerResolution1280x960Fps12 }
    public enum DepthImageFormat { Undefined, Resolution640x480Fps30, Resolution320x240Fps30, Resolution80x60Fps30 }
    public enum SkeletonTrackingState { NotTracked, PositionOnly, Tracked }
    public enum JointTrackingState { NotTracked, Inferred, Tracked }
    public enum JointType { HipCenter, Spine, ShoulderCenter, Head, ShoulderLeft, ElbowLeft, WristLeft, HandLeft, ShoulderRight, ElbowRight, WristRight, HandRight, HipLeft, KneeLeft, AnkleLeft, FootLeft, HipRight, KneeRight, AnkleRight, FootRight }
    public enum EchoCancellationMode { None, CancellationOnly, CancellationAndSuppression }
    public enum BeamAngleMode { Automatic, Adaptive, Manual }

    public struct Vector4 { public float X, Y, Z, W; }
    public struct SkeletonPoint { public float X, Y, Z; }
    public struct ColorImagePoint { public int X, Y; }
    public struct DepthImagePoint { public int X, Y, Depth; }
    public struct DepthImagePixel { public short Depth; public short PlayerIndex; }
    public struct Joint { public JointType JointType; public SkeletonPoint Position; public JointTrackingState TrackingState; }

    public class BoneRotation { public Vector4 Quaternion = new Vector4 { W = 1 }; }
    public class BoneOrientation { public BoneRotation AbsoluteRotation = new BoneRotation(); }
    public class JointCollection { internal Joint[] j = new Joint[20]; public Joint this[JointType t] { get { return j[(int)t]; } } }
    public class BoneOrientationCollection { readonly BoneOrientation b = new BoneOrientation(); public BoneOrientation this[JointType t] { get { return b; } } }

    public class Skeleton
    {
        public SkeletonTrackingState TrackingState;
        public int TrackingId;
        public JointCollection Joints = new JointCollection();
        public BoneOrientationCollection BoneOrientations = new BoneOrientationCollection();
    }

    // (the frames come every 33 ms of the stand-in's own clock)
    static class Clock
    {
        public static readonly DateTime Started = DateTime.UtcNow;
        public static long Ms { get { return (long)(DateTime.UtcNow - Started).TotalMilliseconds; } }
        public static long Frame { get { return Ms / 33; } }
    }

    public class ColorImageFrame : IDisposable
    {
        public int Width, Height;
        public long Timestamp;
        public ColorImageFormat Format;
        public void CopyPixelDataTo(byte[] data)
        {
            if (Format == ColorImageFormat.InfraredResolution640x480Fps30)
            {
                for (int y = 0; y < 480; y++)
                    for (int x = 0; x < 640; x++) { ushort v = (ushort)((100 + 800 * x / 639) << 6); data[(y * 640 + x) * 2] = (byte)v; data[(y * 640 + x) * 2 + 1] = (byte)(v >> 8); }
            }
            else for (int i = 0; i + 3 < data.Length && i < Width * Height * 4; i += 4) { data[i] = data[i + 1] = data[i + 2] = 90; data[i + 3] = 0; }
        }
        public void Dispose() { }
    }
    public class ColorImageStream
    {
        long last = -1;
        public ColorImageFormat Format = ColorImageFormat.Undefined;
        public void Enable(ColorImageFormat f) { Format = f; }
        public ColorImageFrame OpenNextFrame(int ms)
        {
            long n = Clock.Frame;
            if (Format == ColorImageFormat.Undefined || n == last || (Format == ColorImageFormat.RgbResolution1280x960Fps12 && n % 3 != 0)) return null;
            last = n;
            bool big = Format == ColorImageFormat.RgbResolution1280x960Fps12;
            return new ColorImageFrame { Width = big ? 1280 : 640, Height = big ? 960 : 480, Timestamp = Clock.Ms, Format = Format };
        }
    }
    public class DepthImageFrame : IDisposable
    {
        public long Timestamp;
        public void CopyDepthImagePixelDataTo(DepthImagePixel[] px)
        {
            for (int y = 0; y < 480; y++)
                for (int x = 0; x < 640; x++) px[y * 640 + x].Depth = (short)(Math.Abs(x / 640.0 - 0.5) < 0.15 && Math.Abs(y / 480.0 - 0.5) < 0.2 ? 850 : 2000);
        }
        public void Dispose() { }
    }
    public class DepthImageStream
    {
        long last = -1;
        bool on;
        public void Enable(DepthImageFormat f) { on = f == DepthImageFormat.Resolution640x480Fps30; }
        public DepthImageFrame OpenNextFrame(int ms)
        {
            long n = Clock.Frame;
            if (!on || n == last) return null;
            last = n;
            return new DepthImageFrame { Timestamp = Clock.Ms };
        }
    }
    public class SkeletonFrame : IDisposable
    {
        public void CopySkeletonDataTo(Skeleton[] s)
        {
            // One person standing 2 m away, in the middle, arms down.
            float[][] at = {
                new float[] { 0, 0, 2 }, new float[] { 0, 0.25f, 2 }, new float[] { 0, 0.5f, 2 }, new float[] { 0, 0.68f, 2 }, new float[] { -0.2f, 0.45f, 2 }, new float[] { -0.25f, 0.2f, 2 },
                new float[] { -0.27f, 0, 2 }, new float[] { -0.28f, -0.08f, 2 }, new float[] { 0.2f, 0.45f, 2 }, new float[] { 0.25f, 0.2f, 2 }, new float[] { 0.27f, 0, 2 }, new float[] { 0.28f, -0.08f, 2 },
                new float[] { -0.1f, -0.05f, 2 }, new float[] { -0.1f, -0.5f, 2 }, new float[] { -0.1f, -0.9f, 2 }, new float[] { -0.1f, -0.95f, 1.9f }, new float[] { 0.1f, -0.05f, 2 },
                new float[] { 0.1f, -0.5f, 2 }, new float[] { 0.1f, -0.9f, 2 }, new float[] { 0.1f, -0.95f, 1.9f } };
            for (int i = 0; i < s.Length; i++)
            {
                s[i] = new Skeleton { TrackingState = i == 0 ? SkeletonTrackingState.Tracked : SkeletonTrackingState.NotTracked, TrackingId = i == 0 ? 7 : 0 };
                if (i == 0) for (int k = 0; k < 20; k++) s[i].Joints.j[k] = new Joint { JointType = (JointType)k, Position = new SkeletonPoint { X = at[k][0], Y = at[k][1], Z = at[k][2] }, TrackingState = k == 15 || k == 19 ? JointTrackingState.Inferred : JointTrackingState.Tracked };
            }
        }
        public void Dispose() { }
    }
    public class SkeletonStream
    {
        long last = -1;
        bool on;
        public int FrameSkeletonArrayLength { get { return 6; } }
        public void Enable() { on = true; }
        public SkeletonFrame OpenNextFrame(int ms)
        {
            long n = Clock.Frame;
            if (!on || n == last) return null;
            last = n;
            return new SkeletonFrame();
        }
    }

    public class CoordinateMapper
    {
        // (the colour camera's picture, mirrored as the SDK's are: a point to the sensor's left, +X, is on its left)
        public ColorImagePoint MapSkeletonPointToColorPoint(SkeletonPoint p, ColorImageFormat f)
        {
            double s = f == ColorImageFormat.RgbResolution1280x960Fps12 ? 2 : 1;
            return new ColorImagePoint { X = (int)Math.Round((319.5 - 531.15 * p.X / p.Z) * s), Y = (int)Math.Round((239.5 - 531.15 * p.Y / p.Z) * s) };
        }
        public void MapColorFrameToDepthFrame(ColorImageFormat cf, DepthImageFormat df, DepthImagePixel[] depth, DepthImagePoint[] points)
        {
            int cw = cf == ColorImageFormat.RgbResolution1280x960Fps12 ? 1280 : 640, s = cw / 640;
            for (int y = 0; y < points.Length / cw; y++)
                for (int x = 0; x < cw; x++) { int dx = x / s, dy = y / s; points[y * cw + x] = new DepthImagePoint { X = dx, Y = dy, Depth = depth[dy * 640 + dx].Depth }; }
        }
    }

    // A 440 Hz tone, 16-bit, 16 kHz, as it'd come (32 ms at a time).
    class ToneStream : Stream
    {
        long k;
        public override int Read(byte[] buffer, int offset, int count)
        {
            Thread.Sleep(32);
            int n = Math.Min(count / 2, 512);
            for (int i = 0; i < n; i++, k++) { short v = (short)(Math.Sin(k / 16000.0 * 2 * Math.PI * 440) * 8000); buffer[offset + i * 2] = (byte)v; buffer[offset + i * 2 + 1] = (byte)(v >> 8); }
            return n * 2;
        }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return 0; } }
        public override long Position { get { return 0; } set { } }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { return 0; }
        public override void SetLength(long value) { }
        public override void Write(byte[] buffer, int offset, int count) { }
    }
    public class KinectAudioSource
    {
        public EchoCancellationMode EchoCancellationMode;
        public bool AutomaticGainControlEnabled;
        public BeamAngleMode BeamAngleMode;
        public double SoundSourceAngle { get { return 12.5; } }
        public double SoundSourceAngleConfidence { get { return 0.8; } }
        public Stream Start() { return new ToneStream(); }
        public void Stop() { }
    }

    public class KinectSensor
    {
        static readonly KinectSensorCollection all = new KinectSensorCollection();
        public static KinectSensorCollection KinectSensors { get { return all; } }
        int tilt;
        public KinectStatus Status { get { return KinectStatus.Connected; } }
        public string UniqueKinectId { get { return "USB\\VID_045E&PID_02AE\\FAKE360KINECT"; } }
        public string DeviceConnectionId { get { return "USB\\VID_045E&PID_02B0\\5&FAKE&0&1"; } }
        public readonly ColorImageStream ColorStream = new ColorImageStream();
        public readonly DepthImageStream DepthStream = new DepthImageStream();
        public readonly SkeletonStream SkeletonStream = new SkeletonStream();
        public readonly KinectAudioSource AudioSource = new KinectAudioSource();
        public readonly CoordinateMapper CoordinateMapper = new CoordinateMapper();
        public int MinElevationAngle { get { return -27; } }
        public int MaxElevationAngle { get { return 27; } }
        public int ElevationAngle { get { return tilt; } set { Thread.Sleep(300); tilt = Math.Max(-27, Math.Min(27, value)); } }
        public void Start() { }
        public void Stop() { }
        // (which way is down, in g: tilted up by its motor, down leans towards it)
        public Vector4 AccelerometerGetCurrentReading()
        {
            double a = tilt * Math.PI / 180;
            return new Vector4 { X = 0, Y = (float)-Math.Cos(a), Z = (float)Math.Sin(a), W = 0 };
        }
    }
    public class KinectSensorCollection : IEnumerable<KinectSensor>
    {
        readonly List<KinectSensor> list = new List<KinectSensor> { new KinectSensor() };
        public IEnumerator<KinectSensor> GetEnumerator() { return list.GetEnumerator(); }
        IEnumerator IEnumerable.GetEnumerator() { return list.GetEnumerator(); }
    }
}
