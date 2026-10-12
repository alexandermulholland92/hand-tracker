// bluetooth-helper-mac.m — Hand Tracker's Bluetooth link on a Mac: the GATT service remote
// recording is reached by over Bluetooth Low Energy (electron/bluetooth-link.js says what goes
// over it; this only carries its frames), advertised by name with its service (CoreBluetooth's
// CBPeripheralManager). Built with the app (scripts/build-mac-helper.js); macOS asks the first
// time whether Hand Tracker may use Bluetooth. electron/bluetooth.js runs it; a JSON line each
// way, as bluetooth-helper-linux.py:
//
//   in:  {"t":"start","name":N,"service":U,"info":U,"rx":U,"tx":U}   publish the service, advertise as N
//        {"t":"info","data":B64}      INFO's value
//        {"t":"tx","data":B64}        a notification on TX (to every device subscribed)
//   out: {"t":"ready","address":"","network":false}
//        {"t":"rx","dev":D,"mtu":M,"data":B64}   a device wrote a frame
//        {"t":"gone","dev":D}         a device stopped listening (disconnected)
//        {"t":"error","message":S}
//
// It ends when its input closes.

#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>

static void say(NSDictionary *msg) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
  if (!json) return;
  @synchronized([NSFileHandle class]) {
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  }
}

@interface Link : NSObject <CBPeripheralManagerDelegate>
@property(strong) CBPeripheralManager *manager;
@property(strong) CBMutableCharacteristic *tx;
@property(strong) NSData *info;
@property(strong) NSDictionary *start;
@property(strong) NSMutableArray<NSData *> *waiting; // notifications not sent yet (the queue was full)
@property(strong) NSMutableSet<CBCentral *> *listening;
@end

@implementation Link
- (instancetype)init {
  if ((self = [super init])) {
    _info = [NSData data];
    _waiting = [NSMutableArray array];
    _listening = [NSMutableSet set];
  }
  return self;
}

- (void)handle:(NSDictionary *)msg {
  NSString *t = msg[@"t"];
  if ([t isEqualToString:@"start"] && !self.manager) {
    self.start = msg;
    self.manager = [[CBPeripheralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()];
  } else if ([t isEqualToString:@"info"]) {
    self.info = [[NSData alloc] initWithBase64EncodedString:msg[@"data"] ?: @"" options:0] ?: [NSData data];
  } else if ([t isEqualToString:@"tx"] && self.tx) {
    NSData *d = [[NSData alloc] initWithBase64EncodedString:msg[@"data"] ?: @"" options:0];
    if (!d) return;
    [self.waiting addObject:d];
    [self flush];
  }
}

- (void)flush {
  while (self.waiting.count) {
    if (![self.manager updateValue:self.waiting[0] forCharacteristic:self.tx onSubscribedCentrals:nil]) return; // (sent when ready again)
    [self.waiting removeObjectAtIndex:0];
  }
}

- (void)peripheralManagerIsReadyToUpdateSubscribers:(CBPeripheralManager *)p {
  [self flush];
}

- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)p {
  if (p.state == CBManagerStatePoweredOn) {
    if (self.tx) return;
    NSDictionary *s = self.start;
    CBMutableService *service = [[CBMutableService alloc] initWithType:[CBUUID UUIDWithString:s[@"service"]] primary:YES];
    CBMutableCharacteristic *info = [[CBMutableCharacteristic alloc] initWithType:[CBUUID UUIDWithString:s[@"info"]] properties:CBCharacteristicPropertyRead value:nil permissions:CBAttributePermissionsReadable];
    CBMutableCharacteristic *rx = [[CBMutableCharacteristic alloc] initWithType:[CBUUID UUIDWithString:s[@"rx"]]
                                                                     properties:CBCharacteristicPropertyWrite | CBCharacteristicPropertyWriteWithoutResponse
                                                                          value:nil
                                                                    permissions:CBAttributePermissionsWriteable];
    self.tx = [[CBMutableCharacteristic alloc] initWithType:[CBUUID UUIDWithString:s[@"tx"]] properties:CBCharacteristicPropertyNotify value:nil permissions:CBAttributePermissionsReadable];
    service.characteristics = @[ info, rx, self.tx ];
    [p addService:service];
  } else if (p.state == CBManagerStateUnauthorized) {
    say(@{@"t" : @"error", @"message" : @"Hand Tracker isn't allowed to use Bluetooth: allow it in System Settings → Privacy & Security → Bluetooth."});
  } else if (p.state == CBManagerStatePoweredOff) {
    say(@{@"t" : @"error", @"message" : @"Bluetooth is off: turn it on."});
  } else if (p.state == CBManagerStateUnsupported) {
    say(@{@"t" : @"error", @"message" : @"This Mac's Bluetooth can't be reached over Bluetooth Low Energy."});
  }
}

- (void)peripheralManager:(CBPeripheralManager *)p didAddService:(CBService *)service error:(NSError *)error {
  if (error) {
    say(@{@"t" : @"error", @"message" : [NSString stringWithFormat:@"Bluetooth service: %@", error.localizedDescription]});
    return;
  }
  NSString *name = [self.start[@"name"] isKindOfClass:[NSString class]] ? self.start[@"name"] : @"";
  NSMutableDictionary *adv = [@{CBAdvertisementDataServiceUUIDsKey : @[ service.UUID ]} mutableCopy];
  if (name.length) adv[CBAdvertisementDataLocalNameKey] = name;
  [p startAdvertising:adv];
}

- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)p error:(NSError *)error {
  if (error) say(@{@"t" : @"error", @"message" : [NSString stringWithFormat:@"Bluetooth advertising: %@", error.localizedDescription]});
  else say(@{@"t" : @"ready", @"address" : @"", @"network" : @NO});
}

- (void)peripheralManager:(CBPeripheralManager *)p didReceiveReadRequest:(CBATTRequest *)request {
  if (request.offset > self.info.length) {
    [p respondToRequest:request withResult:CBATTErrorInvalidOffset];
    return;
  }
  request.value = [self.info subdataWithRange:NSMakeRange(request.offset, self.info.length - request.offset)];
  [p respondToRequest:request withResult:CBATTErrorSuccess];
}

- (void)peripheralManager:(CBPeripheralManager *)p didReceiveWriteRequests:(NSArray<CBATTRequest *> *)requests {
  for (CBATTRequest *r in requests) {
    say(@{@"t" : @"rx", @"dev" : r.central.identifier.UUIDString, @"mtu" : @(r.central.maximumUpdateValueLength + 3),
          @"data" : [r.value ?: [NSData data] base64EncodedStringWithOptions:0]});
  }
  if (requests.count) [p respondToRequest:requests[0] withResult:CBATTErrorSuccess];
}

- (void)peripheralManager:(CBPeripheralManager *)p central:(CBCentral *)central didSubscribeToCharacteristic:(CBCharacteristic *)c {
  [self.listening addObject:central];
}

- (void)peripheralManager:(CBPeripheralManager *)p central:(CBCentral *)central didUnsubscribeFromCharacteristic:(CBCharacteristic *)c {
  [self.listening removeObject:central];
  say(@{@"t" : @"gone", @"dev" : central.identifier.UUIDString});
}
@end

int main(void) {
  @autoreleasepool {
    Link *link = [[Link alloc] init];
    // Lines in, on a thread of their own; handled on the main queue, as CoreBluetooth's are.
    [NSThread detachNewThreadWithBlock:^{
      char buf[65536];
      while (fgets(buf, sizeof buf, stdin)) {
        NSData *d = [NSData dataWithBytes:buf length:strlen(buf)];
        NSDictionary *msg = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
        if (![msg isKindOfClass:[NSDictionary class]]) continue;
        dispatch_async(dispatch_get_main_queue(), ^{
          [link handle:msg];
        });
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        [link.manager stopAdvertising];
        exit(0);
      });
    }];
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
