package com.skyduel.game;

import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 联机层：WebRTC + JSON 协议，与网页版 js/net.js + js/main.js 完全同构。
 *
 * 通道：'s'（无序不可靠，20Hz 状态 upd/sync） + 'e'（有序可靠，事件）。
 * 所有报文附带 sender（真实 peerId）与 seq（单调递增，网页端据此去重）。
 * 四元数数组顺序 [x, y, z, w]（与网页版 q:[q.x,q.y,q.z,q.w] 一致）。
 *
 * 报文清单（对齐 main.js）：
 *   状态通道：upd{p,q|ty,tp,by,sp} / sync{lst,s0,s1,rn,over} / voice(忽略)
 *   事件通道：hello / team / roster / map / go / fire / blt / hitRep / dmgReject /
 *             envDmg / died / crash / rEnd / round / matchEnd / rematch / kstat /
 *             peerGone / ping / pong / pickStart / pick / pickList / pickReject / ready / pickCancel
 */
public class Net {

    public interface Listener {
        // ---- 传输 ----
        void onStatus(String text);
        void onClosed(String reason);
        void onConnected(boolean asHost);
        void onOfferCode(String code);
        void onAnswerCode(String code);
        // ---- 大厅流程 ----
        void onHello(String id);                                    // 房主收到加入方真实 ID
        void onTeam(int team, int slot, int hostTeam, int hostSlot, String hostId, String gamemode);
        void onStart(String map);                                   // 'map'/'go'：开局（带地图）
        void onPeerGone(String id);
        // ---- 选阵营（aavs 房主流程）----
        void onPickStart();
        void onPickList(int team, int slot);
        void onPickReject();
        // ---- 状态（仅写 volatile 缓冲，游戏线程消费）----
        void onUpd(boolean isAA, float x, float y, float z, float qx, float qy, float qz, float qw,
                   float ty, float tp, float by, float sp);
        void onSyncJson(String json);
        // ---- 事件 ----
        void onFire(String sender, float ox, float oy, float oz, float dx, float dy, float dz,
                    int fid, float speed, float dmg, boolean splash);
        void onBlt(String from, float ox, float oy, float oz, float dx, float dy, float dz,
                   float speed, float dmg, boolean splash);
        void onHitRep(String sender, int fid, String targetId, float px, float py, float pz, float dmg);
        void onDmgReject(int fid);
        void onEnvDmg(String sender, float dmg);
        void onDied(String id);
        void onCrash(String sender, String target, float dmg, boolean fatal);
        void onREnd(int rn, int s0, int s1, int w);
        void onRound(int rn);
        void onMatchEnd(int s0, int s1, boolean hostWin);
        void onRematch();
        void onKstat(int k, int d);                                 // 房主权威击杀台账（3s 定向）
    }

    private static boolean webrtcReady = false;

    public static void init(Context ctx) {
        if (webrtcReady) return;
        try {
            PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(ctx)
                            .setEnableInternalTracer(false)
                            .createInitializationOptions());
            webrtcReady = true;
        } catch (Throwable t) { Log.e("SkyDuel", "WebRTC init fail", t); }
    }

    private abstract static class SdpObs implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription s) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) {}
        @Override public void onSetFailure(String error) {}
    }

    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private DataChannel dcS, dcE;
    private volatile boolean sOpen = false, eOpen = false, running = false;
    private volatile boolean codeEmitted = false;
    private Listener listener;
    private boolean asHost = false;
    private String myId = "";
    private int seq = 0;

    public void setMyId(String id) { myId = id; }

    // ================= 信令 =================
    public void host(Listener l) { asHost = true; listener = l; startPeer(l); }

    public void join(Listener l) { asHost = false; listener = l; startPeer(l); }

    public void pasteOffer(String code) {
        if (pc == null) { listener.onStatus("连接尚未就绪"); return; }
        try {
            pc.setRemoteDescription(new SdpObs() {
                @Override public void onSetSuccess() {
                    listener.onStatus("已接受邀请码，生成应答码…");
                    pc.createAnswer(new SdpObs() {
                        @Override public void onCreateSuccess(SessionDescription ans) {
                            pc.setLocalDescription(new SdpObs() {
                                @Override public void onSetSuccess() { /* 等 ICE 收集完成 */ }
                            }, ans);
                        }
                    }, new MediaConstraints());
                }
                @Override public void onSetFailure(String e) { listener.onStatus("邀请码无法应用：" + e); }
            }, decodeDesc(code));
        } catch (Throwable t) { listener.onStatus("邀请码解析失败"); }
    }

    public void pasteAnswer(String code) {
        if (pc == null) return;
        try {
            pc.setRemoteDescription(new SdpObs() {
                @Override public void onSetSuccess() { listener.onStatus("应答已接受，等待通道打开…"); }
                @Override public void onSetFailure(String e) { listener.onStatus("应答码无法应用：" + e); }
            }, decodeDesc(code));
        } catch (Throwable t) { listener.onStatus("应答码解析失败"); }
    }

    // ================= PeerConnection =================
    private void startPeer(Listener l) {
        if (!webrtcReady) { l.onStatus("WebRTC 初始化失败"); return; }
        running = true; codeEmitted = false;
        try {
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
            List<PeerConnection.IceServer> ice = new ArrayList<>();   // 与网页版一致：空 ICE，纯直连
            PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(ice);
            cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            pc = factory.createPeerConnection(cfg, new PeerConnection.Observer() {
                @Override public void onIceGatheringChange(PeerConnection.IceGatheringState st) {
                    if (st == PeerConnection.IceGatheringState.COMPLETE && pc != null
                            && pc.getLocalDescription() != null && running && !codeEmitted) {
                        codeEmitted = true;
                        String code = encodeDesc(pc.getLocalDescription());
                        if (asHost) listener.onOfferCode(code); else listener.onAnswerCode(code);
                    }
                }
                @Override public void onIceConnectionChange(PeerConnection.IceConnectionState st) {
                    if (st == PeerConnection.IceConnectionState.CONNECTED) listener.onStatus("P2P 已连通");
                    else if (st == PeerConnection.IceConnectionState.FAILED
                            || st == PeerConnection.IceConnectionState.DISCONNECTED
                            || st == PeerConnection.IceConnectionState.CLOSED) {
                        if (running) { running = false; listener.onClosed("WebRTC 连接断开"); }
                    }
                }
                @Override public void onDataChannel(DataChannel dc) { bindChannel(dc, l); }
                @Override public void onIceCandidate(IceCandidate c) {}
                @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
                @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
                @Override public void onAddStream(org.webrtc.MediaStream s) {}
                @Override public void onRemoveStream(org.webrtc.MediaStream s) {}
                @Override public void onRenegotiationNeeded() {}
                @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) {}
                @Override public void onStandardizedIceConnectionChange(PeerConnection.IceConnectionState s) {}
                @Override public void onIceConnectionReceivingChange(boolean b) {}
                @Override public void onSelectedCandidatePairChanged(org.webrtc.CandidatePairChangeEvent e) {}
                @Override public void onAddTrack(org.webrtc.RtpReceiver r, org.webrtc.MediaStream[] ms) {}
                @Override public void onRemoveTrack(org.webrtc.RtpReceiver r) {}
                @Override public void onTrack(org.webrtc.RtpTransceiver t) {}
            });
            if (pc == null) { l.onStatus("PC 创建失败"); running = false; return; }
            if (asHost) {
                // 房主先建双通道（与网页版 createOffer 前建通道一致）
                DataChannel.Init dS = new DataChannel.Init(); dS.ordered = false; dS.maxRetransmits = 0;
                dcS = pc.createDataChannel("s", dS); bindChannel(dcS, l);
                DataChannel.Init dE = new DataChannel.Init(); dE.ordered = true;
                dcE = pc.createDataChannel("e", dE); bindChannel(dcE, l);
                pc.createOffer(new SdpObs() {
                    @Override public void onCreateSuccess(SessionDescription offer) {
                        pc.setLocalDescription(new SdpObs() { @Override public void onSetSuccess() {} }, offer);
                    }
                }, new MediaConstraints());
            } else {
                l.onStatus("等待粘贴房主邀请码…");
            }
        } catch (Throwable t) { running = false; l.onStatus("WebRTC 异常：" + t.getMessage()); }
    }

    private void bindChannel(DataChannel dc, Listener l) {
        dc.registerObserver(new DataChannel.Observer() {
            @Override public void onBufferedAmountChange(long n) {}
            @Override public void onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) {
                    if ("s".equals(dc.label())) sOpen = true; else eOpen = true;
                    if (sOpen && eOpen && running) listener.onConnected(asHost);
                } else if (dc.state() == DataChannel.State.CLOSED && running && "e".equals(dc.label())) {
                    running = false; l.onClosed("数据通道已关闭");
                }
            }
            @Override public void onMessage(DataChannel.Buffer buf) {
                try {
                    byte[] arr = new byte[buf.data.remaining()];
                    buf.data.get(arr);
                    dispatch(new String(arr, StandardCharsets.UTF_8), l, "s".equals(dc.label()));
                } catch (Throwable ignored) {}
            }
        });
        if ("s".equals(dc.label())) { dcS = dc; sOpen = dc.state() == DataChannel.State.OPEN; }
        else { dcE = dc; eOpen = dc.state() == DataChannel.State.OPEN; }
    }

    // ================= SDP 编解码（Base64(JSON{type,sdp})，与网页版一致） =================
    private static String encodeDesc(SessionDescription d) {
        try {
            JSONObject j = new JSONObject();
            j.put("type", d.type.canonicalForm());
            j.put("sdp", d.description);
            return Base64.encodeToString(j.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        } catch (Throwable t) { return ""; }
    }

    private static SessionDescription decodeDesc(String code) {
        try {
            byte[] raw = Base64.decode(code.trim(), Base64.NO_WRAP);
            JSONObject j = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            return new SessionDescription(
                    SessionDescription.Type.fromCanonicalForm(j.optString("type", "offer")),
                    j.optString("sdp", ""));
        } catch (Throwable t) { return new SessionDescription(SessionDescription.Type.OFFER, ""); }
    }

    // ================= 发送 =================
    private void send(boolean stateCh, String json) {
        DataChannel dc = stateCh ? dcS : dcE;
        boolean open = stateCh ? sOpen : eOpen;
        if (dc == null || !open) return;
        try {
            byte[] arr = json.getBytes(StandardCharsets.UTF_8);
            ByteBuffer bb = ByteBuffer.allocateDirect(arr.length);
            bb.put(arr); bb.flip();
            dc.send(new DataChannel.Buffer(bb, false));
        } catch (Throwable t) {
            if (running) { running = false; if (listener != null) listener.onClosed("发送失败"); }
        }
    }

    /** 事件报文：fields 为 "t":"xxx","k":v... 形式的键值（不含外层大括号），自动附带 sender+seq */
    private void sendE(String fields) {
        send(false, "{\"sender\":\"" + myId + "\",\"seq\":" + (++seq) + "," + fields + "}");
    }

    private void sendS(String fields) {
        send(true, "{\"sender\":\"" + myId + "\",\"seq\":" + (++seq) + "," + fields + "}");
    }

    // ---- 大厅 ----
    public void sendHello() { sendE("\"t\":\"hello\",\"id\":\"" + myId + "\""); }
    public void sendTeam(int team, int slot, int hostTeam, int hostSlot, String gamemode) {
        sendE("\"t\":\"team\",\"team\":" + team + ",\"slot\":" + slot
                + ",\"hostTeam\":" + hostTeam + ",\"hostSlot\":" + hostSlot
                + ",\"myId\":\"" + myId + "\",\"gamemode\":\"" + gamemode + "\"");
    }
    public void sendRoster(String myIdOfHost, int hostTeam, String guestId, int guestTeam) {
        sendE("\"t\":\"roster\",\"roster\":[{\"peerId\":\"" + myIdOfHost + "\",\"team\":" + hostTeam
                + ",\"slot\":0},{\"peerId\":\"" + guestId + "\",\"team\":" + guestTeam + ",\"slot\":0}]");
    }
    public void sendMap(String map) { sendE("\"t\":\"map\",\"map\":\"" + map + "\""); }
    public void sendGo(String map) { sendE("\"t\":\"go\",\"map\":\"" + map + "\""); }
    public void sendPeerGone(String id) { sendE("\"t\":\"peerGone\",\"id\":\"" + id + "\""); }
    public void sendRematch() { sendE("\"t\":\"rematch\""); }
    public void sendReady() { sendE("\"t\":\"ready\""); }
    public void sendPick(int side) { sendE("\"t\":\"pick\",\"side\":" + side); }

    // ---- 状态（20Hz）----
    /** upd：飞机位置/朝向。q 为 [qx,qy,qz,qw]（网页版顺序） */
    public void sendUpdPlane(float[] p, float[] qxyzw, float sp) {
        sendS("\"t\":\"upd\",\"p\":[" + r(p[0]) + "," + r(p[1]) + "," + r(p[2])
                + "],\"q\":[" + r(qxyzw[0]) + "," + r(qxyzw[1]) + "," + r(qxyzw[2]) + "," + r(qxyzw[3])
                + "],\"sp\":" + (int) sp);
    }

    /** upd：防空车位置/炮塔/车体 */
    public void sendUpdAA(float[] p, float ty, float tp, float by, float sp) {
        sendS("\"t\":\"upd\",\"p\":[" + r(p[0]) + "," + r(p[1]) + "," + r(p[2])
                + "],\"ty\":" + r(ty) + ",\"tp\":" + r(tp) + ",\"by\":" + r(by) + ",\"sp\":" + (int) sp);
    }

    /** sync：房主权威快照。lstJson 为网页版格式 JSONArray 字符串 */
    public void sendSync(String lstJson, int s0, int s1, int rn, boolean over) {
        sendS("\"t\":\"sync\",\"lst\":" + lstJson
                + ",\"s0\":" + s0 + ",\"s1\":" + s1 + ",\"rn\":" + rn + ",\"over\":" + over);
    }

    // ---- 对战事件 ----
    public void sendFire(float ox, float oy, float oz, float dx, float dy, float dz, int fid, float speed, float dmg, boolean splash) {
        sendE("\"t\":\"fire\",\"o\":[" + r(ox) + "," + r(oy) + "," + r(oz)
                + "],\"d\":[" + r(dx) + "," + r(dy) + "," + r(dz)
                + "],\"fid\":" + fid + ",\"s\":" + (int) speed + ",\"dm\":" + (int) dmg + ",\"sl\":" + (splash ? 1 : 0) + "}");
    }

    public void sendBlt(float ox, float oy, float oz, float dx, float dy, float dz, String from, float speed, float dmg, boolean splash) {
        sendE("\"t\":\"blt\",\"o\":[" + r(ox) + "," + r(oy) + "," + r(oz)
                + "],\"d\":[" + r(dx) + "," + r(dy) + "," + r(dz)
                + "],\"from\":\"" + from + "\",\"s\":" + (int) speed + ",\"dm\":" + (int) dmg + ",\"sl\":" + (splash ? 1 : 0) + "}");
    }

    public void sendHitRep(int fid, String targetId, float px, float py, float pz, float dmg) {
        sendE("\"t\":\"hitRep\",\"fid\":" + fid + ",\"id\":\"" + targetId
                + "\",\"p\":[" + r(px) + "," + r(py) + "," + r(pz) + "],\"dmg\":" + (int) dmg + "}");
    }

    public void sendDmgReject(int fid) { sendE("\"t\":\"dmgReject\",\"fid\":" + fid); }
    public void sendEnvDmg(float dmg) { sendE("\"t\":\"envDmg\",\"dmg\":" + (int) dmg); }
    public void sendDied() { sendE("\"t\":\"died\",\"id\":\"" + myId + "\""); }
    public void sendCrash(String target, float dmg, boolean fatal) {
        if (fatal) sendE("\"t\":\"crash\",\"target\":\"" + target + "\",\"fatal\":true");
        else sendE("\"t\":\"crash\",\"target\":\"" + target + "\",\"dmg\":" + (int) dmg);
    }
    public void sendREnd(int rn, int s0, int s1, int w) {
        sendE("\"t\":\"rEnd\",\"rn\":" + rn + ",\"s0\":" + s0 + ",\"s1\":" + s1 + ",\"w\":" + w);
    }
    public void sendRound(int rn) { sendE("\"t\":\"round\",\"rn\":" + rn); }
    public void sendMatchEnd(boolean hostWin, int s0, int s1) {
        sendE("\"t\":\"matchEnd\",\"win\":" + hostWin + ",\"s0\":" + s0 + ",\"s1\":" + s1);
    }

    /** 房主 → 加入方：权威击杀台账（对方自己的 {击杀 k, 阵亡 d}，3s 一次） */
    public void sendKstat(int k, int d) { sendE("\"t\":\"kstat\",\"k\":" + k + ",\"d\":" + d); }

    private static String r(float v) { return String.format(java.util.Locale.US, "%.2f", v); }

    // ================= 接收解析（JSON → Listener 回调；只读不阻塞） =================
    private void dispatch(String line, Listener l, boolean stateCh) {
        try {
            JSONObject d = new JSONObject(line);
            String t = d.optString("t", "");
            if (stateCh) {
                if ("upd".equals(t)) {
                    JSONArray p = d.optJSONArray("p");
                    if (p == null || p.length() < 3) return;
                    JSONArray q = d.optJSONArray("q");
                    boolean isAA = q == null;
                    l.onUpd(isAA,
                            (float) p.optDouble(0), (float) p.optDouble(1), (float) p.optDouble(2),
                            q != null ? (float) q.optDouble(0) : 0f,
                            q != null ? (float) q.optDouble(1) : 0f,
                            q != null ? (float) q.optDouble(2) : 0f,
                            q != null ? (float) q.optDouble(3) : 1f,
                            (float) d.optDouble("ty", 0), (float) d.optDouble("tp", 0),
                            (float) d.optDouble("by", 0), (float) d.optDouble("sp", 0));
                } else if ("sync".equals(t)) {
                    l.onSyncJson(line);
                }
                // voice：安卓端暂不支持语音，忽略
                return;
            }
            // ---- 事件通道 ----
            if ("ping".equals(t)) {   // 网页端探测 → 原样回 pong（对端用自己的时钟算 RTT）
                long ts = (long) d.optDouble("ts", 0);
                if (ts > 0) sendE("\"t\":\"pong\",\"ts\":" + ts);
                return;
            }
            if ("pong".equals(t)) return;   // 安卓端暂不显示 RTT
            if (d.has("seq")) { /* 网页端已去重，这里无需处理 */ }
            if ("fire".equals(t)) {
                JSONArray o = d.optJSONArray("o"), dd = d.optJSONArray("d");
                if (o == null || dd == null || o.length() < 3 || dd.length() < 3) return;
                l.onFire(d.optString("sender", ""),
                        (float) o.optDouble(0), (float) o.optDouble(1), (float) o.optDouble(2),
                        (float) dd.optDouble(0), (float) dd.optDouble(1), (float) dd.optDouble(2),
                        d.optInt("fid", 0), (float) d.optDouble("s", 560), (float) d.optDouble("dm", 7),
                        d.optInt("sl", 0) == 1);
            } else if ("blt".equals(t)) {
                JSONArray o = d.optJSONArray("o"), dd = d.optJSONArray("d");
                if (o == null || dd == null || o.length() < 3 || dd.length() < 3) return;
                l.onBlt(d.optString("from", ""),
                        (float) o.optDouble(0), (float) o.optDouble(1), (float) o.optDouble(2),
                        (float) dd.optDouble(0), (float) dd.optDouble(1), (float) dd.optDouble(2),
                        (float) d.optDouble("s", 560), (float) d.optDouble("dm", 7),
                        d.optInt("sl", 0) == 1);
            } else if ("hitRep".equals(t)) {
                JSONArray p = d.optJSONArray("p");
                l.onHitRep(d.optString("sender", ""), d.optInt("fid", 0), d.optString("id", ""),
                        p != null && p.length() > 2 ? (float) p.optDouble(0) : 0f,
                        p != null && p.length() > 2 ? (float) p.optDouble(1) : 0f,
                        p != null && p.length() > 2 ? (float) p.optDouble(2) : 0f,
                        (float) d.optDouble("dmg", 0));
            } else if ("dmgReject".equals(t)) {
                l.onDmgReject(d.optInt("fid", 0));
            } else if ("envDmg".equals(t)) {
                l.onEnvDmg(d.optString("sender", ""), (float) d.optDouble("dmg", 0));
            } else if ("died".equals(t)) {
                l.onDied(d.optString("id", ""));
            } else if ("crash".equals(t)) {
                l.onCrash(d.optString("sender", ""), d.optString("target", ""),
                        (float) d.optDouble("dmg", 0), d.optBoolean("fatal", false));
            } else if ("rEnd".equals(t)) {
                l.onREnd(d.optInt("rn", 0), d.optInt("s0", 0), d.optInt("s1", 0), d.optInt("w", -1));
            } else if ("round".equals(t)) {
                l.onRound(d.optInt("rn", -1));
            } else if ("matchEnd".equals(t)) {
                l.onMatchEnd(d.optInt("s0", 0), d.optInt("s1", 0), d.optBoolean("win", false));
            } else if ("rematch".equals(t)) {
                l.onRematch();
            } else if ("kstat".equals(t)) {
                l.onKstat(d.optInt("k", 0), d.optInt("d", 0));
            } else if ("hello".equals(t)) {
                l.onHello(d.optString("id", ""));
            } else if ("team".equals(t)) {
                l.onTeam(d.optInt("team", 0), d.optInt("slot", 0), d.optInt("hostTeam", 0),
                        d.optInt("hostSlot", 0), d.optString("myId", ""), d.optString("gamemode", "dogfight"));
            } else if ("map".equals(t) || "go".equals(t)) {
                l.onStart(d.optString("map", "island"));
            } else if ("peerGone".equals(t)) {
                l.onPeerGone(d.optString("id", ""));
            } else if ("pickStart".equals(t)) {
                l.onPickStart();
            } else if ("pickList".equals(t)) {
                l.onPickList(d.optInt("team", 0), d.optInt("slot", 0));
            } else if ("pickReject".equals(t)) {
                l.onPickReject();
            }
            // roster / pickCount / pickCancel：安卓端 1v1 不需要，忽略
        } catch (Throwable ignored) {}
    }

    public boolean isRunning() { return running; }

    // ================= 剪贴板 / 释放 =================
    public void copyText(String text) {
        try {
            Context ctx = MainActivity.appContext;
            if (ctx == null) return;
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("skyduel", text));
        } catch (Throwable ignored) {}
    }

    public void close() {
        running = false; codeEmitted = false;
        try { if (dcS != null) dcS.close(); } catch (Throwable ignored) {}
        try { if (dcE != null) dcE.close(); } catch (Throwable ignored) {}
        try { if (pc != null) pc.close(); } catch (Throwable ignored) {}
        try { if (factory != null) factory.dispose(); } catch (Throwable ignored) {}
        dcS = dcE = null; pc = null; factory = null; sOpen = eOpen = false;
    }
}
