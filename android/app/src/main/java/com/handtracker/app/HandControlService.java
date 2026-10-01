package com.handtracker.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Path;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * The accessibility service that carries out the hand mouse and gesture actions on the
 * phone itself (PhoneControlService.java, phone-control.js): taps, long presses, swipes and
 * scrolls at the pointer, Back / Home / Recents and the other system buttons, volume and
 * media keys, and typing into the text box in use. The user turns it on in Android's
 * Accessibility settings; it does nothing while phone control isn't running, and it reads
 * nothing on screen except the text box being typed into.
 */
public class HandControlService extends AccessibilityService {
    static volatile HandControlService instance;

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing: it only acts when asked.
    }

    @Override
    public void onInterrupt() {
    }

    // Turned on in Android's Accessibility settings?
    static boolean isEnabled(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        ComponentName me = new ComponentName(context, HandControlService.class);
        for (String s : enabled.split(":")) {
            ComponentName c = ComponentName.unflattenFromString(s);
            if (me.equals(c)) return true;
        }
        return false;
    }

    // ---------- touches ----------
    boolean stroke(float x1, float y1, float x2, float y2, long durationMs) {
        Path path = new Path();
        path.moveTo(Math.max(0, x1), Math.max(0, y1));
        if (x1 != x2 || y1 != y2) path.lineTo(Math.max(0, x2), Math.max(0, y2));
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(1, durationMs)))
                .build();
        return dispatchGesture(g, null, null);
    }

    boolean tap(float x, float y) {
        return stroke(x, y, x, y, 40);
    }

    boolean longPress(float x, float y) {
        return stroke(x, y, x, y, 700);
    }

    boolean doubleTap(float x, float y) {
        Path p = new Path();
        p.moveTo(Math.max(0, x), Math.max(0, y));
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 40))
                .addStroke(new GestureDescription.StrokeDescription(p, 140, 40))
                .build();
        return dispatchGesture(g, null, null);
    }

    // ---------- keys ----------
    // "" when done, else why not.
    String key(String combo) {
        String k = combo.trim().toLowerCase();
        switch (k) {
            case "back": case "esc": case "escape": case "browserback":
                return global(GLOBAL_ACTION_BACK);
            case "home": case "win": case "windows": case "super": case "meta": case "cmd":
                return global(GLOBAL_ACTION_HOME);
            case "recents": case "alt+tab": case "overview":
                return global(GLOBAL_ACTION_RECENTS);
            case "notifications":
                return global(GLOBAL_ACTION_NOTIFICATIONS);
            case "quicksettings":
                return global(GLOBAL_ACTION_QUICK_SETTINGS);
            case "printscreen": case "screenshot":
                return Build.VERSION.SDK_INT >= 28 ? global(GLOBAL_ACTION_TAKE_SCREENSHOT) : "Screenshots need Android 9 or newer";
            case "lock": case "win+l":
                return Build.VERSION.SDK_INT >= 28 ? global(GLOBAL_ACTION_LOCK_SCREEN) : "Locking the screen needs Android 9 or newer";
            case "volumeup": return volume(AudioManager.ADJUST_RAISE);
            case "volumedown": return volume(AudioManager.ADJUST_LOWER);
            case "mute": return volume(AudioManager.ADJUST_TOGGLE_MUTE);
            case "playpause": case "space": return media(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE);
            case "nexttrack": return media(KeyEvent.KEYCODE_MEDIA_NEXT);
            case "prevtrack": return media(KeyEvent.KEYCODE_MEDIA_PREVIOUS);
            case "stop": return media(KeyEvent.KEYCODE_MEDIA_STOP);
            case "enter": case "return": return enter();
            case "backspace": return backspace();
            default:
                return "That key isn't on a phone. Phones have back, home, recents, notifications, screenshot, lock, volume and media keys, enter and backspace.";
        }
    }

    private String global(int action) {
        return performGlobalAction(action) ? "" : "Android didn't do that";
    }

    private String volume(int direction) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return "No sound control";
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI);
        return "";
    }

    private String media(int keyCode) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return "No media control";
        long now = SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0));
        return "";
    }

    // ---------- typing ----------
    private AccessibilityNodeInfo textBox() {
        AccessibilityNodeInfo focus = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        return focus != null && focus.isEditable() ? focus : null;
    }

    private static CharSequence current(AccessibilityNodeInfo box) {
        if (Build.VERSION.SDK_INT >= 26 && box.isShowingHintText()) return "";
        CharSequence t = box.getText();
        return t == null ? "" : t;
    }

    private static String setText(AccessibilityNodeInfo box, CharSequence text) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) ? "" : "That text box didn't take the text";
    }

    String type(String text) {
        AccessibilityNodeInfo box = textBox();
        if (box == null) return "Tap a text box first (with the hand mouse or your finger)";
        return setText(box, current(box).toString() + text);
    }

    private String backspace() {
        AccessibilityNodeInfo box = textBox();
        if (box == null) return "Tap a text box first";
        String t = current(box).toString();
        return t.isEmpty() ? "" : setText(box, t.substring(0, t.offsetByCodePoints(t.length(), -1)));
    }

    private String enter() {
        AccessibilityNodeInfo box = textBox();
        if (box == null) return "Tap a text box first";
        if (Build.VERSION.SDK_INT >= 30 && box.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) return "";
        return "Enter needs Android 11 or newer";
    }
}
