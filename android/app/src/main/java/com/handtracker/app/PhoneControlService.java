package com.handtracker.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Controlling the phone itself with your hand, while any app is in front: a foreground
 * service (it keeps the camera while Hand Tracker is in the background, with a notification
 * saying so) that shows
 *  - a small window in a corner with the camera picture, where phone-control.js tracks your
 *    hand and runs the hand mouse and gesture actions (its × stops it), and
 *  - the pointer, drawn over every app (touches pass straight through it).
 * What the hand mouse does (taps, swipes, keys, typing) is carried out by the accessibility
 * service, HandControlService.java. Started and stopped by PhoneControlPlugin.java.
 */
public class PhoneControlService extends Service {
    static final String EXTRA_SETTINGS = "settings";
    static final String ACTION_STOP = "com.handtracker.app.STOP_PHONE_CONTROL";
    private static final String CHANNEL = "phone-control";
    private static final int NOTIFICATION_ID = 7;

    static volatile PhoneControlService running;
    static volatile Runnable onStopped;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private PointerView pointer;
    private FrameLayout tracker;
    private WebView web;
    private volatile float px = -1, py = -1; // the pointer, in screen pixels
    private float dragX, dragY;
    private long dragSince;
    private boolean dragging;
    private boolean swiping; // the drag is a swipe that follows the hand (HandControlService.swipeStart)

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startInForeground();
        if (running == null) {
            running = this;
            showWindows(intent == null ? "{}" : String.valueOf(intent.getStringExtra(EXTRA_SETTINGS)));
        }
        return START_NOT_STICKY;
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Controlling this phone", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent stop = PendingIntent.getService(this, 0, new Intent(this, PhoneControlService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setContentTitle("Hand Tracker is controlling this phone")
                .setContentText("Your hand moves the pointer. Tap Stop, or the × on its window, to end.")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        else startForeground(NOTIFICATION_ID, n);
    }

    private int overlayType() {
        return Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void showWindows(String settings) {
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        float dp = getResources().getDisplayMetrics().density;

        // The pointer, over everything; touches go through.
        pointer = new PointerView(this, dp);
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        wm.addView(pointer, lp);

        // The tracking window: the camera picture and a × to stop.
        tracker = new FrameLayout(this);
        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        // The app's own files (the same bundle as the app), at a secure address so the camera can be used.
        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = assets.shouldInterceptRequest(request.getUrl());
                // (MediaPipe's WebAssembly only compiles as it streams in with its proper type.)
                if (r != null && request.getUrl().getPath() != null && request.getUrl().getPath().endsWith(".wasm")) r.setMimeType("application/wasm");
                return r;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // it never goes anywhere else
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only the camera, only for this page (the app already has camera permission).
                for (String r : request.getResources()) {
                    if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        request.deny();
                        return;
                    }
                }
                request.grant(request.getResources());
            }
        });
        web.addJavascriptInterface(new Bridge(), "HandControl");
        tracker.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        TextView close = new TextView(this);
        close.setText("×");
        close.setTextColor(Color.WHITE);
        close.setTextSize(18);
        close.setGravity(Gravity.CENTER);
        close.setBackgroundColor(Color.argb(160, 14, 15, 18));
        close.setOnClickListener(v -> stopSelf());
        tracker.addView(close, new FrameLayout.LayoutParams((int) (28 * dp), (int) (28 * dp), Gravity.TOP | Gravity.END));
        WindowManager.LayoutParams tp = new WindowManager.LayoutParams(
                (int) (128 * dp), (int) (96 * dp), overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        tp.gravity = Gravity.TOP | Gravity.START;
        tp.x = (int) (8 * dp);
        tp.y = (int) (48 * dp);
        wm.addView(tracker, tp);
        web.loadUrl("https://appassets.androidplatform.net/assets/public/phone-control.html?settings=" + Uri.encode(settings));
    }

    @Override
    public void onDestroy() {
        running = null;
        main.removeCallbacksAndMessages(null);
        try {
            if (web != null) {
                web.removeJavascriptInterface("HandControl");
                web.destroy();
            }
            if (tracker != null) wm.removeView(tracker);
            if (pointer != null) wm.removeView(pointer);
        } catch (Exception ignored) {
            // already gone
        }
        Runnable cb = onStopped;
        if (cb != null) cb.run();
        super.onDestroy();
    }

    private DisplayMetrics screen() {
        DisplayMetrics m = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(m);
        return m;
    }

    private static HandControlService touch() {
        return HandControlService.instance;
    }

    private static final String NO_SERVICE = "Turn on Hand Tracker in Android's Accessibility settings to tap and type on this phone";

    // What phone-control.js calls (on WebView's own thread); "" when done, else why not.
    private class Bridge {
        @JavascriptInterface
        public void pointer(double nx, double ny) {
            DisplayMetrics m = screen();
            px = (float) (Math.max(0, Math.min(1, nx)) * (m.widthPixels - 1));
            py = (float) (Math.max(0, Math.min(1, ny)) * (m.heightPixels - 1));
            main.post(() -> {
                if (pointer != null) pointer.moveTo(px, py, dragging);
            });
            HandControlService s = touch();
            if (swiping && s != null) s.swipeTo(px, py);
        }

        @JavascriptInterface
        public String button(String which, String action) {
            HandControlService s = touch();
            if (s == null) return NO_SERVICE;
            if (px < 0) return "Show your hand to the camera first";
            boolean right = "right".equals(which);
            switch (action) {
                case "click":
                    return (right ? s.longPress(px, py) : s.tap(px, py)) ? "" : "Android didn't take the tap";
                case "double":
                    return s.doubleTap(px, py) ? "" : "Android didn't take the tap";
                case "down":
                    // A drag: a swipe that follows the hand (Android 8 and later); before that, the
                    // swipe is made when the button comes up, from here to there.
                    dragging = true;
                    dragX = px;
                    dragY = py;
                    dragSince = System.currentTimeMillis();
                    swiping = !right && s.swipeStart(px, py);
                    return "";
                case "up":
                    if (!dragging) return "";
                    dragging = false;
                    if (swiping) {
                        swiping = false;
                        s.swipeEnd(px, py);
                        return "";
                    }
                    long ms = Math.max(120, Math.min(3000, System.currentTimeMillis() - dragSince));
                    return s.stroke(dragX, dragY, px, py, ms) ? "" : "Android didn't take the swipe";
                default:
                    return "";
            }
        }

        @JavascriptInterface
        public String wheel(double notches) {
            HandControlService s = touch();
            if (s == null) return NO_SERVICE;
            if (px < 0) return "Show your hand to the camera first";
            // Scrolling up moves the content down: a swipe downwards, a fifth of the screen a notch.
            DisplayMetrics m = screen();
            float d = (float) Math.max(-3, Math.min(3, notches)) * m.heightPixels / 5f;
            float y1 = Math.max(1, Math.min(m.heightPixels - 2, py - d / 2)), y2 = Math.max(1, Math.min(m.heightPixels - 2, py + d / 2));
            return s.stroke(px, y1, px, y2, 250) ? "" : "Android didn't take the swipe";
        }

        @JavascriptInterface
        public String key(String combo, String action) {
            if ("up".equals(action)) return "";
            HandControlService s = touch();
            return s == null ? NO_SERVICE : s.key(combo);
        }

        @JavascriptInterface
        public String text(String text) {
            HandControlService s = touch();
            return s == null ? NO_SERVICE : s.type(text);
        }

        // A gesture action's web request (from here: no browser cross-site limits).
        @JavascriptInterface
        public String web(String json) {
            JSONObject out = new JSONObject();
            HttpURLConnection c = null;
            try {
                JSONObject req = new JSONObject(json);
                URL url = new URL(req.getString("url"));
                if (!"http".equals(url.getProtocol()) && !"https".equals(url.getProtocol())) throw new Exception("Only http:// and https:// addresses can be called.");
                String method = req.optString("method", "GET").toUpperCase();
                c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestMethod(method);
                if (!"GET".equals(method) && req.has("body") && !req.isNull("body")) {
                    byte[] body = req.get("body").toString().getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body);
                    }
                }
                out.put("status", c.getResponseCode());
                InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
                if (in != null) in.close();
            } catch (Exception e) {
                try {
                    out.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                } catch (Exception ignored) {
                    // can't happen
                }
            } finally {
                if (c != null) c.disconnect();
            }
            return out.toString();
        }

        @JavascriptInterface
        public void status(String json) {
            // (The hand mouse's status line; nothing to show it on.)
        }

        @JavascriptInterface
        public void stop() {
            main.post(PhoneControlService.this::stopSelf);
        }
    }

    // The pointer: a ring (filled while dragging), drawn over every app.
    private static class PointerView extends View {
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG), fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float r;
        private float x = -1, y = -1;
        private boolean down;

        PointerView(Context c, float dp) {
            super(c);
            r = 14 * dp;
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeWidth(3 * dp);
            ring.setColor(Color.rgb(255, 146, 43));
            ring.setShadowLayer(3 * dp, 0, 0, Color.BLACK);
            fill.setColor(Color.argb(140, 255, 146, 43));
            setLayerType(View.LAYER_TYPE_SOFTWARE, null); // (shadows)
        }

        void moveTo(float nx, float ny, boolean dragging) {
            x = nx;
            y = ny;
            down = dragging;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (x < 0) return;
            // Drawn where the touch lands: this view covers the whole screen from its top-left.
            int[] at = new int[2];
            getLocationOnScreen(at);
            float cx = x - at[0], cy = y - at[1];
            if (down) canvas.drawCircle(cx, cy, r, fill);
            canvas.drawCircle(cx, cy, r, ring);
            canvas.drawCircle(cx, cy, 2.5f * ring.getStrokeWidth() / 3, ring);
        }
    }
}
