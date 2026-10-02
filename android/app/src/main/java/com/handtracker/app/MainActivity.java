package com.handtracker.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own native plugins (Capacitor's come from their packages).
        registerPlugin(NatNetPlugin.class);
        registerPlugin(RemotePlugin.class);
        registerPlugin(UdpPlugin.class);
        registerPlugin(PhoneControlPlugin.class);
        registerPlugin(RigServerPlugin.class);
        super.onCreate(savedInstanceState);
        // Tracking and recording shouldn't be cut off by the screen timing out.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
