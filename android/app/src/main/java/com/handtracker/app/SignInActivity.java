package com.handtracker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * A dashboard's own sign-in page, in a window of its own (RemotePlugin.signIn). The user
 * signs in there themselves; this window closes once that's done:
 *   mode "supabase": the page has kept a signed-in session (sb-…-auth-token), which is
 *     handed back to the app (as the desktop app's signInWithSite does), and the page's own
 *     copy is cleared;
 *   mode "cookie": checkUrl answers as signed in with the WebView's cookies, which the app's
 *     requests then use (as the desktop app's fleet sign-in does).
 */
public class SignInActivity extends Activity {
    static final String EXTRA_URL = "url";
    static final String EXTRA_MODE = "mode";
    static final String EXTRA_CHECK_URL = "checkUrl";
    static final String EXTRA_SESSION = "session";
    private static final String READ_SESSION = "(() => { try {"
            + " const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x)); if (!k) return null;"
            + " const v = JSON.parse(localStorage.getItem(k));"
            + " return v && v.access_token && v.refresh_token ? JSON.stringify({ access_token: v.access_token, refresh_token: v.refresh_token, expires_at: v.expires_at, user: { email: v.user && v.user.email } }) : null;"
            + " } catch (e) { return null; } })()";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private String site;
    private boolean finished;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra(EXTRA_URL);
        Uri u = Uri.parse(url);
        site = u.getScheme() + "://" + u.getAuthority();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(14, 15, 18));
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (8 * getResources().getDisplayMetrics().density);
        bar.setPadding(pad * 2, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText("Sign in to your dashboard");
        title.setTextColor(Color.rgb(230, 230, 235));
        title.setTextSize(16);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setOnClickListener(v -> done(RESULT_CANCELED, null));
        bar.addView(cancel);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Sign-in providers (Google…) and the dashboard itself open here; other schemes don't.
                String s = request.getUrl().getScheme();
                return !"https".equals(s) && !"http".equals(s);
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        web.loadUrl(url);
        handler.postDelayed(this::poll, 1500);
    }

    private void poll() {
        if (finished) return;
        String mode = getIntent().getStringExtra(EXTRA_MODE);
        if ("supabase".equals(mode)) {
            web.evaluateJavascript(READ_SESSION, (value) -> {
                if (finished) return;
                String json = value == null || value.equals("null") ? null : unquote(value);
                if (json != null) {
                    // The app keeps its own copy; sign this window's out of the WebView.
                    WebStorage.getInstance().deleteOrigin(site);
                    done(RESULT_OK, json);
                } else handler.postDelayed(this::poll, 1000);
            });
        } else {
            final String check = getIntent().getStringExtra(EXTRA_CHECK_URL);
            new Thread(() -> {
                boolean ok = signedIn(check);
                handler.post(() -> {
                    if (finished) return;
                    if (ok) done(RESULT_OK, null);
                    else handler.postDelayed(this::poll, 1500);
                });
            }).start();
        }
    }

    // checkUrl answers with JSON (not a sign-in page or a redirect to one), using the WebView's cookies.
    private static boolean signedIn(String check) {
        if (check == null || check.isEmpty()) return false;
        HttpURLConnection c = null;
        try {
            CookieManager jar = CookieManager.getInstance();
            jar.flush();
            c = (HttpURLConnection) new URL(check).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            String cookie = jar.getCookie(check);
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            if (c.getResponseCode() != 200) return false;
            String type = c.getContentType();
            if (type == null || !type.contains("json")) return false;
            byte[] b = new byte[64];
            int n = c.getInputStream().read(b);
            String head = n > 0 ? new String(b, 0, n, StandardCharsets.UTF_8).trim() : "";
            return head.startsWith("{");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // evaluateJavascript hands back a JSON string literal.
    private static String unquote(String literal) {
        try {
            return new org.json.JSONArray("[" + literal + "]").getString(0);
        } catch (Exception e) {
            return null;
        }
    }

    private void done(int result, String session) {
        if (finished) return;
        finished = true;
        Intent data = new Intent();
        if (session != null) data.putExtra(EXTRA_SESSION, session);
        setResult(result, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else done(RESULT_CANCELED, null);
    }

    @Override
    protected void onDestroy() {
        finished = true;
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
