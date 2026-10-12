// bluetooth-helper-win.cs — Hand Tracker's Bluetooth link on Windows: the GATT service remote
// recording is reached by over Bluetooth Low Energy (electron/bluetooth-link.js says what goes
// over it; this only carries its frames), advertised with its service so a phone or the website
// finds it (Windows gives it the computer's own Bluetooth name). Built the first time it's
// needed by the C# compiler every Windows has (.NET Framework 4), against Windows' own WinRT
// metadata, as bt-hid-win.cs is: nothing to install. electron/bluetooth.js runs it; a JSON line
// each way, as bluetooth-helper-linux.py:
//
//   in:  {"t":"start","name":N,"service":U,"info":U,"rx":U,"tx":U}   publish the service, advertise
//        {"t":"info","data":B64}      INFO's value
//        {"t":"tx","data":B64}        a notification on TX (to every device subscribed)
//   out: {"t":"ready","address":A,"network":false}
//        {"t":"rx","dev":D,"mtu":M,"data":B64}   a device wrote a frame
//        {"t":"gone","dev":D}         a device stopped listening (disconnected)
//        {"t":"error","message":S}
//
// It ends (its service with it) when its input closes. Written for the C# 5 compiler that comes
// with Windows (no newer syntax).

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation;
using Windows.Storage.Streams;

class BluetoothLinkHelper {
  static readonly object OutLock = new object();
  static void Say(string json) {
    lock (OutLock) {
      Console.Out.WriteLine(json);
      Console.Out.Flush();
    }
  }
  static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.Append(string.Format("\\u{0:x4}", (int)c));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static void Error(string message) {
    Say("{\"t\":\"error\",\"message\":" + Q(message) + "}");
  }

  // A JSON line's string field (the lines in are Hand Tracker's own: UUIDs, base64, a name).
  static string Field(string json, string key) {
    var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
    return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
  }

  static R Wait<R>(IAsyncOperation<R> op) {
    while (op.Status == AsyncStatus.Started) Thread.Sleep(2);
    if (op.Status != AsyncStatus.Completed) throw new Exception("Windows didn't finish (" + (op.ErrorCode != null ? op.ErrorCode.Message : op.Status.ToString()) + ")");
    return op.GetResults();
  }

  static IBuffer Buf(byte[] b) {
    var w = new DataWriter();
    w.WriteBytes(b);
    return w.DetachBuffer();
  }
  static byte[] Bytes(IBuffer buf) {
    var r = DataReader.FromBuffer(buf);
    var b = new byte[buf.Length];
    r.ReadBytes(b);
    return b;
  }

  static GattLocalCharacteristic NewChar(GattServiceProvider sp, Guid id, GattCharacteristicProperties props) {
    var p = new GattLocalCharacteristicParameters();
    p.CharacteristicProperties = props;
    p.ReadProtectionLevel = GattProtectionLevel.Plain;
    p.WriteProtectionLevel = GattProtectionLevel.Plain;
    var r = Wait(sp.Service.CreateCharacteristicAsync(id, p));
    if (r.Error != BluetoothError.Success) throw new Exception("Windows wouldn't make a Bluetooth characteristic (" + r.Error + ")");
    return r.Characteristic;
  }

  static GattServiceProvider provider;
  static GattLocalCharacteristic tx;
  static byte[] info = new byte[0];
  static readonly HashSet<string> listening = new HashSet<string>();
  static bool quitting = false;

  static void Main() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var t = Field(line, "t");
      try {
        if (t == "start" && provider == null) Start(line);
        else if (t == "info") info = Convert.FromBase64String(Field(line, "data") ?? "");
        else if (t == "tx" && tx != null) {
          var bytes = Convert.FromBase64String(Field(line, "data") ?? "");
          ThreadPool.QueueUserWorkItem(_ => {
            try {
              Wait(tx.NotifyValueAsync(Buf(bytes)));
            } catch (Exception) {
              // (a device gone meanwhile)
            }
          });
        }
      } catch (Exception err) {
        Error(err.Message.Replace("\r", " ").Replace("\n", " "));
        if (t == "start") Environment.Exit(2);
      }
    }
    quitting = true;
    try {
      if (provider != null) provider.StopAdvertising();
    } catch (Exception) {
    }
  }

  static void Start(string msg) {
    var adapter = Wait(BluetoothAdapter.GetDefaultAsync());
    if (adapter == null) throw new Exception("This computer has no Bluetooth (or it's turned off).");
    if (!adapter.IsLowEnergySupported || !adapter.IsPeripheralRoleSupported) throw new Exception("This computer's Bluetooth can't be reached over Bluetooth Low Energy (no peripheral role).");

    var r = Wait(GattServiceProvider.CreateAsync(new Guid(Field(msg, "service"))));
    if (r.Error != BluetoothError.Success) throw new Exception("Windows wouldn't publish the Bluetooth service (" + r.Error + ")");
    provider = r.ServiceProvider;

    // INFO: read, its value as it is now (a new password changes it).
    var infoC = NewChar(provider, new Guid(Field(msg, "info")), GattCharacteristicProperties.Read);
    infoC.ReadRequested += new TypedEventHandler<GattLocalCharacteristic, GattReadRequestedEventArgs>((s, e) => {
      var deferral = e.GetDeferral();
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          var req = Wait(e.GetRequestAsync());
          if (req != null) {
            var value = info;
            int off = (int)Math.Min(req.Offset, (uint)value.Length);
            var part = new byte[value.Length - off];
            Array.Copy(value, off, part, 0, part.Length);
            req.RespondWithValue(Buf(part));
          }
        } catch (Exception) {
        } finally {
          deferral.Complete();
        }
      });
    });

    // RX: each frame a device writes.
    var rx = NewChar(provider, new Guid(Field(msg, "rx")), GattCharacteristicProperties.Write | GattCharacteristicProperties.WriteWithoutResponse);
    rx.WriteRequested += new TypedEventHandler<GattLocalCharacteristic, GattWriteRequestedEventArgs>((s, e) => {
      var deferral = e.GetDeferral();
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          var req = Wait(e.GetRequestAsync());
          if (req == null) return;
          var bytes = Bytes(req.Value);
          if (req.Option == GattWriteOption.WriteWithResponse) req.Respond();
          Say("{\"t\":\"rx\",\"dev\":" + Q(e.Session.DeviceId.Id) + ",\"mtu\":" + e.Session.MaxPduSize + ",\"data\":" + Q(Convert.ToBase64String(bytes)) + "}");
        } catch (Exception) {
        } finally {
          deferral.Complete();
        }
      });
    });

    // TX: notifications; a device that stops listening is gone.
    tx = NewChar(provider, new Guid(Field(msg, "tx")), GattCharacteristicProperties.Notify);
    tx.SubscribedClientsChanged += new TypedEventHandler<GattLocalCharacteristic, object>((s, e) => {
      var now = new HashSet<string>();
      foreach (var c in tx.SubscribedClients) now.Add(c.Session.DeviceId.Id);
      lock (listening) {
        foreach (var dev in listening) if (!now.Contains(dev)) Say("{\"t\":\"gone\",\"dev\":" + Q(dev) + "}");
        listening.Clear();
        listening.UnionWith(now);
      }
    });

    var adv = new GattServiceProviderAdvertisingParameters();
    adv.IsDiscoverable = true;
    adv.IsConnectable = true;
    // Windows stops the advertising now and then (another app's, the radio busy): started again
    // a moment later, for as long as this runs.
    provider.AdvertisementStatusChanged += new TypedEventHandler<GattServiceProvider, GattServiceProviderAdvertisementStatusChangedEventArgs>((s, e) => {
      if (e.Status == GattServiceProviderAdvertisementStatus.Aborted && !quitting) {
        ThreadPool.QueueUserWorkItem(_ => {
          Thread.Sleep(1500);
          try {
            if (!quitting && provider.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Aborted) provider.StartAdvertising(adv);
          } catch (Exception) {
          }
        });
      }
    });
    provider.StartAdvertising(adv);
    for (int i = 0; i < 500 && provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started; i++) Thread.Sleep(20);
    if (provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started) throw new Exception("Windows wouldn't start the Bluetooth advertising (is Bluetooth on?).");
    var a = adapter.BluetoothAddress;
    var address = string.Join(":", new[] { 40, 32, 24, 16, 8, 0 }.Select(sh => ((a >> sh) & 0xff).ToString("X2")));
    Say("{\"t\":\"ready\",\"address\":" + Q(address) + ",\"network\":false}");
  }
}
