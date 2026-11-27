package com.handtracker.app;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * VideoCallHarness — the phone's Video Call service (VideoCallServer.java) run on a computer for the checks
 * (scripts/check-call.js): it listens on the port given (this computer's own requests allowed too), and says each
 * thing that comes as a line of JSON on stdout ({"signal": ...} or {"announce": [...], "from": ...}); each line on
 * stdin is a request: {"send": address, "signal": {...}} -> {"reply": ...}, {"trusted": ip} -> {"trusted": bool}.
 *   java -cp <classes> com.handtracker.app.VideoCallHarness <port> <name>
 */
public class VideoCallHarness {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        String name = args.length > 1 ? args[1] : "Phone";
        VideoCallServer server = new VideoCallServer(name, port, true, new VideoCallServer.Listener() {
            @Override
            public Map<String, Object> onSignal(Map<String, Object> signal) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("signal", signal);
                say(m);
                return null;
            }

            @Override
            public void onAnnounce(List<Map<String, Object>> devices, String from) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("announce", devices);
                m.put("from", from);
                say(m);
            }
        });
        server.start();
        Map<String, Object> ready = new LinkedHashMap<>();
        ready.put("ready", port);
        say(ready);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            Object o = VideoCallServer.parse(line);
            if (!(o instanceof Map)) continue;
            Map<?, ?> m = (Map<?, ?>) o;
            Map<String, Object> out = new LinkedHashMap<>();
            if (m.get("send") instanceof String && m.get("signal") instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> signal = (Map<String, Object>) m.get("signal");
                out.put("reply", VideoCallServer.send((String) m.get("send"), signal, name));
            } else if (m.get("trusted") instanceof String) {
                out.put("trusted", VideoCallServer.onTailnet((String) m.get("trusted")));
            } else if (m.get("hello") instanceof String) {
                out.put("hello", VideoCallServer.hello((String) m.get("hello")));
            }
            say(out);
        }
        server.stop();
    }

    static synchronized void say(Map<String, Object> m) {
        System.out.println(VideoCallServer.json(m));
        System.out.flush();
    }
}
