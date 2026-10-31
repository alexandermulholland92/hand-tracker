package com.handtracker.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    // A page of the app's own to open (a notification's: SentryWatchService.java): a computer's
    // remote recording page, there a Sentry alert's video, or the list of computers.
    static final String EXTRA_PAGE = "com.handtracker.app.PAGE";
    private static final Pattern PAGE = Pattern.compile(
            "^(remote\\.html|remote-client\\.html\\?rig=[A-Za-z0-9._*%-]{1,300}(#alert=\\d{1,15}-[a-z0-9]{1,8}(&take=[A-Za-z0-9._*%-]{1,600})?)?)$");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own native plugins (Capacitor's come from their packages). Hand Mouse has
        // only the hand mouse's: the PC link's key in the Keystore and its messages, this phone's
        // control, the Bluetooth mouse. Remote Recording has no hand mouse, Recording Converter
        // neither the hand mouse nor remote recording.
        boolean converter = getResources().getBoolean(R.bool.recording_converter);
        registerPlugin(RemotePlugin.class);
        if (!getResources().getBoolean(R.bool.remote_recording) && !converter) {
            registerPlugin(UdpPlugin.class);
            registerPlugin(PhoneControlPlugin.class);
            registerPlugin(BtHidPlugin.class);
        }
        if (!getResources().getBoolean(R.bool.hand_mouse) && !converter) {
            registerPlugin(NatNetPlugin.class);
            registerPlugin(RigServerPlugin.class);
            registerPlugin(SentryWatchPlugin.class);
            registerPlugin(BtLinkPlugin.class);
        }
        super.onCreate(savedInstanceState);
        // Tracking and recording shouldn't be cut off by the screen timing out.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // A video asked for (a take's ▶, an alert's notification) plays once it has come.
        if (getBridge() != null) getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        if (savedInstanceState == null) openPage(getIntent());
        // Back: the page before this one in the app (the list of computers, a computer's page,
        // its settings), as in a browser; only from the first page does it leave the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() == null ? null : getBridge().getWebView();
                if (web != null && web.canGoBack()) {
                    web.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openPage(intent);
    }

    // The page a notification asks for, in place of what's showing (not again from Recents).
    private void openPage(Intent intent) {
        String page = intent == null ? null : intent.getStringExtra(EXTRA_PAGE);
        if (page == null || !PAGE.matcher(page).matches() || getBridge() == null) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        intent.removeExtra(EXTRA_PAGE);
        String url = getBridge().getLocalUrl() + "/" + page;
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
}
