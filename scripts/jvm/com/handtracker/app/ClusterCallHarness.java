package com.handtracker.app;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ClusterCallHarness — the phone's Cluster Call service (ClusterCallServer.java) run on a computer for the checks
 * (scripts/check-cluster-call.js): it listens on the port given (this computer's own requests allowed too), and says each
 * thing that comes as a line of JSON on stdout ({"signal": ...} or {"announce": [...], "from": ...}); each line on
 * stdin is a request: {"send": address, "signal": {...}} -> {"reply": ...}, {"trusted": ip} -> {"trusted": bool}.
 *   java -cp <classes> com.handtracker.app.ClusterCallHarness <port> <name>
 */
public class ClusterCallHarness {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        String name = args.length > 1 ? args[1] : "Phone";
        ClusterCallServer server = new ClusterCallServer(name, port, true, new ClusterCallServer.Listener() {
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
            Object o = ClusterCallServer.parse(line);
            if (!(o instanceof Map)) continue;
            Map<?, ?> m = (Map<?, ?>) o;
            Map<String, Object> out = new LinkedHashMap<>();
            if (m.get("send") instanceof String && m.get("signal") instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> signal = (Map<String, Object>) m.get("signal");
                out.put("reply", ClusterCallServer.send((String) m.get("send"), signal, name));
            } else if (m.get("trusted") instanceof String) {
                out.put("trusted", ClusterCallServer.onTailnet((String) m.get("trusted")));
            } else if (m.get("hello") instanceof String) {
                out.put("hello", ClusterCallServer.hello((String) m.get("hello")));
            }
            say(out);
        }
        server.stop();
    }

    static synchronized void say(Map<String, Object> m) {
        System.out.println(ClusterCallServer.json(m));
        System.out.flush();
    }
}
