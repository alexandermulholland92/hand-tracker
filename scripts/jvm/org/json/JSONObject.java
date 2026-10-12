package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A stand-in for Android's org.json.JSONObject, for the checks only (scripts/check-android.js
 * runs BtRigProtocol.java on this computer's Java, which has no org.json): flat objects of
 * strings, numbers and booleans, which is all the Bluetooth link's heads are.
 */
public class JSONObject {
    private final Map<String, Object> map = new LinkedHashMap<>();

    public JSONObject() {
    }

    public JSONObject(String text) throws Exception {
        String s = text.trim();
        if (!s.startsWith("{") || !s.endsWith("}")) throw new Exception("Not a JSON object");
        int[] at = {1};
        skip(s, at);
        while (s.charAt(at[0]) != '}') {
            String key = string(s, at);
            skip(s, at);
            if (s.charAt(at[0]++) != ':') throw new Exception("Expected :");
            skip(s, at);
            Object value;
            char c = s.charAt(at[0]);
            if (c == '"') value = string(s, at);
            else {
                int end = at[0];
                while (",} \t\r\n".indexOf(s.charAt(end)) < 0) end++;
                String word = s.substring(at[0], end);
                at[0] = end;
                value = word.equals("true") ? Boolean.TRUE : word.equals("false") ? Boolean.FALSE : word.equals("null") ? null
                        : word.contains(".") ? (Object) Double.parseDouble(word) : (Object) Long.parseLong(word);
            }
            map.put(key, value);
            skip(s, at);
            if (s.charAt(at[0]) == ',') at[0]++;
            skip(s, at);
        }
    }

    private static void skip(String s, int[] at) {
        while (at[0] < s.length() && " \t\r\n".indexOf(s.charAt(at[0])) >= 0) at[0]++;
    }

    private static String string(String s, int[] at) throws Exception {
        if (s.charAt(at[0]++) != '"') throw new Exception("Expected a string");
        StringBuilder b = new StringBuilder();
        while (true) {
            char c = s.charAt(at[0]++);
            if (c == '"') return b.toString();
            if (c != '\\') {
                b.append(c);
                continue;
            }
            char e = s.charAt(at[0]++);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 'r': b.append('\r'); break;
                case 't': b.append('\t'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u': b.append((char) Integer.parseInt(s.substring(at[0], at[0] + 4), 16)); at[0] += 4; break;
                default: b.append(e);
            }
        }
    }

    public JSONObject put(String key, Object value) {
        map.put(key, value);
        return this;
    }

    public JSONObject put(String key, int value) {
        map.put(key, (long) value);
        return this;
    }

    public String optString(String key) {
        return optString(key, "");
    }

    public String optString(String key, String fallback) {
        Object v = map.get(key);
        return v == null ? fallback : String.valueOf(v);
    }

    public static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    @Override
    public String toString() {
        StringBuilder b = new StringBuilder("{");
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (b.length() > 1) b.append(',');
            b.append(quote(e.getKey())).append(':');
            Object v = e.getValue();
            b.append(v instanceof String ? quote((String) v) : String.valueOf(v));
        }
        return b.append('}').toString();
    }
}
