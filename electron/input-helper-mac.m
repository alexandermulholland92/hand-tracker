// input-helper-mac.m — moves the mouse pointer, clicks, scrolls and presses keys for Hand
// Tracker's hand mouse, floating keyboard and gesture actions (macOS). scripts/dist.js builds
// it (clang, on a Mac) into electron/input-helper-mac; electron/input.js starts it and sends
// one command per line on stdin, as to input-helper.ps1 on Windows:
//   move X Y              pointer to X,Y (points, all screens; the main screen's top-left is 0,0)
//   pos                   answers "pos X Y"
//   down|up|click|double left|right|middle
//   wheel N               N notches, positive = up
//   keydown|keyup|tap K   a Mac virtual key code (decimal)
//   media K               a media key: 0 volume up, 1 volume down, 7 mute, 16 play/pause,
//                         17 next track, 18 previous track
//   text BASE64           types the text (UTF-8, base64), any language
//   ping                  answers "pong"
// macOS only lets it act once Hand Tracker is allowed under System Settings → Privacy &
// Security → Accessibility (electron/input.js asks first). It only sends input the way a real
// mouse and keyboard do; it doesn't read anything, and it stops when Hand Tracker closes its stdin.

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool held[3];        // left, right, middle buttons held down
static CGEventFlags mods;   // modifier keys held down (keydown without a keyup yet)

static CGPoint here(void) {
  CGEventRef e = CGEventCreate(NULL);
  if (!e) return CGPointZero;
  CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  return p;
}

static int buttonOf(const char *name) {
  if (strcmp(name, "right") == 0) return 1;
  if (strcmp(name, "middle") == 0) return 2;
  return 0;
}

static void post(CGEventRef e) {
  if (!e) return;
  CGEventSetFlags(e, mods);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

static void mouse(int b, bool down, int clicks) {
  static const CGEventType DOWN[] = {kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown};
  static const CGEventType UP[] = {kCGEventLeftMouseUp, kCGEventRightMouseUp, kCGEventOtherMouseUp};
  CGEventRef e = CGEventCreateMouseEvent(NULL, down ? DOWN[b] : UP[b], here(), (CGMouseButton)b);
  if (e) CGEventSetIntegerValueField(e, kCGMouseEventClickState, clicks);
  held[b] = down;
  post(e);
}

static void move(double x, double y) {
  // With a button held, a move is a drag (or apps don't see it as one).
  CGEventType type = kCGEventMouseMoved;
  CGMouseButton b = kCGMouseButtonLeft;
  if (held[0]) {
    type = kCGEventLeftMouseDragged;
  } else if (held[1]) {
    type = kCGEventRightMouseDragged;
    b = kCGMouseButtonRight;
  } else if (held[2]) {
    type = kCGEventOtherMouseDragged;
    b = kCGMouseButtonCenter;
  }
  post(CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), b));
}

static CGEventFlags flagOf(int key) {
  switch (key) {
    case 55: case 54: return kCGEventFlagMaskCommand;
    case 56: case 60: return kCGEventFlagMaskShift;
    case 58: case 61: return kCGEventFlagMaskAlternate;
    case 59: case 62: return kCGEventFlagMaskControl;
  }
  return 0;
}

static void key(int code, bool down) {
  CGEventFlags f = flagOf(code);
  if (f) mods = down ? (mods | f) : (mods & ~f);
  post(CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, down));
}

static void media(int code) {
  for (int down = 1; down >= 0; down--) {
    NSEvent *e = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint modifierFlags:(down ? 0xa00 : 0xb00) timestamp:0 windowNumber:0 context:nil subtype:8 data1:((code << 16) | ((down ? 0xa : 0xb) << 8)) data2:-1];
    CGEventPost(kCGHIDEventTap, [e CGEvent]);
  }
}

static void typeText(const char *base64) {
  NSData *data = [[NSData alloc] initWithBase64EncodedString:[NSString stringWithUTF8String:base64] options:0];
  if (!data) return;
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  NSUInteger n = text.length, i = 0;
  CGEventFlags saved = mods;
  mods = 0; // typed characters are just characters
  while (i < n) {
    unichar c = [text characterAtIndex:i];
    if (c == '\r') { i++; continue; }
    if (c == '\n') {
      post(CGEventCreateKeyboardEvent(NULL, 36, true));
      post(CGEventCreateKeyboardEvent(NULL, 36, false));
      i++;
      continue;
    }
    // A character at a time (two halves of an emoji together), as a key with that character.
    UniChar chars[2] = {c, 0};
    UniCharCount len = 1;
    if (CFStringIsSurrogateHighCharacter(c) && i + 1 < n) chars[len++] = [text characterAtIndex:i + 1];
    for (int down = 1; down >= 0; down--) {
      CGEventRef e = CGEventCreateKeyboardEvent(NULL, 0, down);
      if (e) CGEventKeyboardSetUnicodeString(e, len, chars);
      post(e);
    }
    i += len;
  }
  mods = saved;
}

static void say(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void click(int b, int times) {
  for (int i = 1; i <= times; i++) {
    mouse(b, true, i);
    mouse(b, false, i);
  }
}

static void run(char *line) {
  char *argv[4] = {0};
  int argc = 0;
  for (char *t = strtok(line, " \t\r\n"); t && argc < 4; t = strtok(NULL, " \t\r\n")) argv[argc++] = t;
  if (!argc) return;
  const char *cmd = argv[0], *a = argc > 1 ? argv[1] : "", *b = argc > 2 ? argv[2] : "0";
  if (strcmp(cmd, "ping") == 0) say("pong");
  else if (strcmp(cmd, "pos") == 0) {
    CGPoint p = here();
    char out[64];
    snprintf(out, sizeof out, "pos %d %d", (int)lround(p.x), (int)lround(p.y));
    say(out);
  } else if (strcmp(cmd, "move") == 0) move(atof(a), atof(b));
  else if (strcmp(cmd, "down") == 0) mouse(buttonOf(a), true, 1);
  else if (strcmp(cmd, "up") == 0) mouse(buttonOf(a), false, 1);
  else if (strcmp(cmd, "click") == 0) click(buttonOf(a), 1);
  else if (strcmp(cmd, "double") == 0) click(buttonOf(a), 2);
  else if (strcmp(cmd, "wheel") == 0) post(CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, atoi(a)));
  else if (strcmp(cmd, "keydown") == 0) key(atoi(a), true);
  else if (strcmp(cmd, "keyup") == 0) key(atoi(a), false);
  else if (strcmp(cmd, "tap") == 0) {
    key(atoi(a), true);
    key(atoi(a), false);
  }
  else if (strcmp(cmd, "media") == 0) media(atoi(a));
  else if (strcmp(cmd, "text") == 0) typeText(a);
  else {
    char out[96];
    snprintf(out, sizeof out, "error unknown command %.60s", cmd);
    say(out);
  }
}

int main(void) {
  @autoreleasepool {
    say("ready");
    char *line = NULL;
    size_t size = 0;
    while (getline(&line, &size, stdin) >= 0) {
      @autoreleasepool {
        run(line);
      }
    }
    free(line);
  }
  return 0;
}
