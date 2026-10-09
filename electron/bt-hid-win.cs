// bt-hid-win.cs — this Windows computer as a Bluetooth mouse and keyboard (HID over GATT) for
// another device, an iPhone or iPad most of all (hid-core.js has the reports). Built the first
// time it's needed by the C# compiler every Windows has (.NET Framework 4), against Windows'
// own WinRT metadata: nothing to install. electron/bt-hid.js runs it.
//
//   bt-hid-win.exe <report map, hex> <report id:size,...>
//   stdin:  "r <id> <hex>"   a report (sent to every device subscribed to it)
//           "quit"
//   stdout: "ready"                      published and advertising
//           "adv <status>"               the advertising's state changed
//           "clients <n> <device name>"  devices taking the mouse's reports
//           "error <message>"            (then it ends)
//
// Written for the C# 5 compiler that comes with Windows (no newer syntax).

using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation;
using Windows.Storage.Streams;

class BtHid {
  static readonly object OutLock = new object();
  static void Say(string s) {
    lock (OutLock) {
      Console.Out.WriteLine(s);
      Console.Out.Flush();
    }
  }

  static R Wait<R>(IAsyncOperation<R> op) {
    while (op.Status == AsyncStatus.Started) Thread.Sleep(2);
    if (op.Status != AsyncStatus.Completed) throw new Exception("Windows didn't finish (" + (op.ErrorCode != null ? op.ErrorCode.Message : op.Status.ToString()) + ")");
    return op.GetResults();
  }

  static Guid U(int shortId) {
    return new Guid(string.Format("0000{0:x4}-0000-1000-8000-00805f9b34fb", shortId));
  }

  static IBuffer Buf(byte[] b) {
    var w = new DataWriter();
    w.WriteBytes(b);
    return w.DetachBuffer();
  }

  static byte[] Hex(string s) {
    var b = new byte[s.Length / 2];
    for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
    return b;
  }

  static GattServiceProvider NewService(int id) {
    var r = Wait(GattServiceProvider.CreateAsync(U(id)));
    if (r.Error != BluetoothError.Success) throw new Exception("Windows wouldn't publish Bluetooth service " + id.ToString("x4") + " (" + r.Error + ")");
    return r.ServiceProvider;
  }

  static GattLocalCharacteristic NewChar(GattServiceProvider sp, int id, GattCharacteristicProperties props, byte[] value, bool secure) {
    var p = new GattLocalCharacteristicParameters();
    p.CharacteristicProperties = props;
    p.ReadProtectionLevel = secure ? GattProtectionLevel.EncryptionRequired : GattProtectionLevel.Plain;
    p.WriteProtectionLevel = secure ? GattProtectionLevel.EncryptionRequired : GattProtectionLevel.Plain;
    if (value != null && (props & GattCharacteristicProperties.Notify) == 0) p.StaticValue = Buf(value);
    var r = Wait(sp.Service.CreateCharacteristicAsync(U(id), p));
    if (r.Error != BluetoothError.Success) throw new Exception("Windows wouldn't make characteristic " + id.ToString("x4") + " (" + r.Error + ")");
    return r.Characteristic;
  }

  // Writes the device may make (protocol mode, control point): taken, answered if it asks.
  static void TakeWrites(GattLocalCharacteristic c) {
    c.WriteRequested += new TypedEventHandler<GattLocalCharacteristic, GattWriteRequestedEventArgs>((s, e) => {
      var deferral = e.GetDeferral();
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          var req = Wait(e.GetRequestAsync());
          if (req != null && req.Option == GattWriteOption.WriteWithResponse) req.Respond();
        } catch (Exception) {
        } finally {
          deferral.Complete();
        }
      });
    });
  }

  // A characteristic whose value is read when asked (a report's current value, the battery).
  static void Answer(GattLocalCharacteristic c, Func<byte[]> value) {
    c.ReadRequested += new TypedEventHandler<GattLocalCharacteristic, GattReadRequestedEventArgs>((s, e) => {
      var deferral = e.GetDeferral();
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          var req = Wait(e.GetRequestAsync());
          if (req != null) req.RespondWithValue(Buf(value()));
        } catch (Exception) {
        } finally {
          deferral.Complete();
        }
      });
    });
  }

  static readonly Dictionary<int, GattLocalCharacteristic> reports = new Dictionary<int, GattLocalCharacteristic>();
  static readonly Dictionary<int, byte[]> last = new Dictionary<int, byte[]>();
  static readonly Queue<KeyValuePair<int, byte[]>> queue = new Queue<KeyValuePair<int, byte[]>>();
  static int mouseId = 2;
  static bool quitting = false;

  static void Main(string[] args) {
    try {
      Run(args);
    } catch (Exception err) {
      Say("error " + err.Message.Replace("\r", " ").Replace("\n", " "));
      Environment.Exit(1);
    }
  }

  static void Run(string[] args) {
    if (args.Length < 2) throw new Exception("usage: bt-hid-win <report map hex> <id:size,...>");
    var map = Hex(args[0]);
    var adapter = Wait(BluetoothAdapter.GetDefaultAsync());
    if (adapter == null) throw new Exception("This computer has no Bluetooth (or it's turned off).");
    if (!adapter.IsLowEnergySupported || !adapter.IsPeripheralRoleSupported) throw new Exception("This computer's Bluetooth can't act as a device (no Bluetooth LE peripheral role).");

    var props = GattCharacteristicProperties.Read | GattCharacteristicProperties.Notify;
    var hid = NewService(0x1812);
    NewChar(hid, 0x2A4A, GattCharacteristicProperties.Read, new byte[] { 0x11, 0x01, 0x00, 0x02 }, true); // HID 1.11, normally connectable
    NewChar(hid, 0x2A4B, GattCharacteristicProperties.Read, map, true);
    TakeWrites(NewChar(hid, 0x2A4C, GattCharacteristicProperties.WriteWithoutResponse, null, true));
    var mode = NewChar(hid, 0x2A4E, GattCharacteristicProperties.Read | GattCharacteristicProperties.WriteWithoutResponse, new byte[] { 0x01 }, true);
    TakeWrites(mode);
    foreach (var part in args[1].Split(',')) {
      var idSize = part.Split(':');
      int id = int.Parse(idSize[0]), size = int.Parse(idSize[1]);
      var c = NewChar(hid, 0x2A4D, props, new byte[size], true);
      last[id] = new byte[size];
      int rid = id;
      Answer(c, () => last[rid]);
      var dp = new GattLocalDescriptorParameters();
      dp.StaticValue = Buf(new byte[] { (byte)id, 0x01 }); // its report id, an input report
      dp.ReadProtectionLevel = GattProtectionLevel.EncryptionRequired;
      var dr = Wait(c.CreateDescriptorAsync(U(0x2908), dp));
      if (dr.Error != BluetoothError.Success) throw new Exception("Windows wouldn't make a report reference (" + dr.Error + ")");
      reports[id] = c;
    }
    mouseId = reports.ContainsKey(2) ? 2 : new List<int>(reports.Keys)[0];
    reports[mouseId].SubscribedClientsChanged += new TypedEventHandler<GattLocalCharacteristic, object>((s, e) => ThreadPool.QueueUserWorkItem(_ => SayClients()));

    // (Only the HID service: Windows keeps Device Information to itself, and a second service
    // advertising alongside, such as a battery, makes it stop advertising both. A Bluetooth
    // mouse needs neither.)

    var adv = new GattServiceProviderAdvertisingParameters();
    adv.IsDiscoverable = true;
    adv.IsConnectable = true;
    // Windows stops the advertising now and then (another app's, the radio busy): started
    // again a moment later, for as long as this runs.
    hid.AdvertisementStatusChanged += new TypedEventHandler<GattServiceProvider, GattServiceProviderAdvertisementStatusChangedEventArgs>((s, e) => {
      Say("adv " + e.Status + (e.Error != BluetoothError.Success ? " " + e.Error : ""));
      if (e.Status == GattServiceProviderAdvertisementStatus.Aborted && !quitting) {
        ThreadPool.QueueUserWorkItem(_ => {
          Thread.Sleep(1500);
          try {
            if (!quitting && hid.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Aborted) hid.StartAdvertising(adv);
          } catch (Exception) {
          }
        });
      }
    });
    hid.StartAdvertising(adv);
    for (int i = 0; i < 500 && hid.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started; i++) Thread.Sleep(20);
    if (hid.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started) throw new Exception("Windows wouldn't start the Bluetooth advertising (is Bluetooth on?).");
    Say("ready");
    SayClients();

    var sender = new Thread(SendLoop);
    sender.IsBackground = true;
    sender.Start();

    string line;
    while ((line = Console.In.ReadLine()) != null) {
      line = line.Trim();
      if (line == "quit") break;
      if (!line.StartsWith("r ")) continue;
      var parts = line.Split(' ');
      int id;
      if (parts.Length != 3 || !int.TryParse(parts[1], out id) || !reports.ContainsKey(id)) continue;
      byte[] bytes;
      try {
        bytes = Hex(parts[2]);
      } catch (Exception) {
        continue;
      }
      lock (queue) {
        queue.Enqueue(new KeyValuePair<int, byte[]>(id, bytes));
        Monitor.Pulse(queue);
      }
    }
    lock (queue) {
      quitting = true;
      Monitor.Pulse(queue);
    }
    try {
      hid.StopAdvertising();
    } catch (Exception) {
    }
  }

  // Reports in order, one notification at a time. Mouse moves waiting behind each other (the
  // same buttons, no wheel) go as one, so a slow link never falls behind the hand.
  static void SendLoop() {
    while (true) {
      KeyValuePair<int, byte[]> next;
      lock (queue) {
        while (queue.Count == 0 && !quitting) Monitor.Wait(queue);
        if (quitting) return;
        next = queue.Dequeue();
        if (next.Key == mouseId && next.Value.Length == 4 && next.Value[3] == 0) {
          int dx = (sbyte)next.Value[1], dy = (sbyte)next.Value[2];
          while (queue.Count > 0) {
            var p = queue.Peek();
            if (p.Key != mouseId || p.Value.Length != 4 || p.Value[0] != next.Value[0] || p.Value[3] != 0) break;
            int nx = dx + (sbyte)p.Value[1], ny = dy + (sbyte)p.Value[2];
            if (nx < -127 || nx > 127 || ny < -127 || ny > 127) break;
            dx = nx;
            dy = ny;
            queue.Dequeue();
          }
          next = new KeyValuePair<int, byte[]>(next.Key, new byte[] { next.Value[0], (byte)(sbyte)dx, (byte)(sbyte)dy, 0 });
        }
      }
      last[next.Key] = next.Value;
      try {
        Wait(reports[next.Key].NotifyValueAsync(Buf(next.Value)));
      } catch (Exception) {
        // (no device listening right now)
      }
    }
  }

  static void SayClients() {
    try {
      var clients = reports[mouseId].SubscribedClients;
      string name = "";
      if (clients.Count > 0) {
        try {
          var dev = Wait(BluetoothLEDevice.FromIdAsync(clients[0].Session.DeviceId.Id));
          if (dev != null) name = dev.Name;
        } catch (Exception) {
        }
      }
      Say("clients " + clients.Count + (name.Length > 0 ? " " + name : ""));
    } catch (Exception) {
    }
  }
}
