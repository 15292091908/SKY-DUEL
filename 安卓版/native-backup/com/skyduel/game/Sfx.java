package com.skyduel.game;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * 音效：用 AudioTrack 实时合成（对应网页版 js/audio.js 的 Web Audio 合成方案，零音频资源）。
 * 一个流式混音线程把所有正在播放的"声音"叠加后写入音频设备。
 */
public class Sfx {

    private static final int RATE = 22050;

    private AudioTrack track;
    private Thread worker;
    private volatile boolean running = false;

    private short[] gun, boom, beep;
    private final List<Voice> voices = new ArrayList<>();

    private static final class Voice {
        short[] buf; int pos; float gain;
        Voice(short[] b, float g) { buf = b; gain = g; }
    }

    public Sfx() {
        gun = synthGun();
        boom = synthBoom();
        beep = synthBeep();
    }

    public synchronized void start() {
        if (running) return;
        try {
            int minBuf = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufSize = Math.max(minBuf, RATE / 10 * 2);
            track = new AudioTrack(AudioManager.STREAM_MUSIC, RATE, AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize, AudioTrack.MODE_STREAM);
            if (track.getState() != AudioTrack.STATE_INITIALIZED) { track = null; return; }
            track.play();
            running = true;
            worker = new Thread(this::loop, "skyd-voice");
            worker.setDaemon(true);
            worker.start();
        } catch (Throwable t) {
            Log.w("SkyDuel", "音频不可用: " + t.getMessage());
            track = null;
        }
    }

    public synchronized void stop() {
        running = false;
        try { if (track != null) { track.pause(); track.flush(); track.release(); } } catch (Throwable ignored) {}
        track = null;
    }

    public void gun() { play(gun, 0.30f); }
    public void explosion() { play(boom, 0.55f); }
    public void beep() { play(beep, 0.22f); }

    private void play(short[] b, float gain) {
        if (!running || b == null || !Settings.sfxOn) return;
        synchronized (voices) {
            if (voices.size() > 24) voices.remove(0);
            voices.add(new Voice(b, gain));
        }
    }

    private void loop() {
        final int CHUNK = 512;
        short[] mix = new short[CHUNK];
        while (running) {
            synchronized (voices) {
                for (int i = 0; i < CHUNK; i++) mix[i] = 0;
                for (int v = voices.size() - 1; v >= 0; v--) {
                    Voice vo = voices.get(v);
                    for (int i = 0; i < CHUNK; i++) {
                        if (vo.pos >= vo.buf.length) break;
                        int s = (int) (mix[i] + vo.buf[vo.pos++] * vo.gain);
                        mix[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, s));
                    }
                    if (vo.pos >= vo.buf.length) voices.remove(v);
                }
            }
            try { if (track != null) track.write(mix, 0, CHUNK); } catch (Throwable t) { break; }
        }
    }

    // ================= 波形合成 =================
    private static short[] synthGun() {
        int n = RATE * 70 / 1000;
        short[] out = new short[n];
        Random r = new Random(7);
        float lp = 0;
        for (int i = 0; i < n; i++) {
            float t = i / (float) n;
            float env = (float) Math.pow(1 - t, 3.2);
            float noise = (float) (r.nextGaussian() * 0.8);
            lp += (noise - lp) * 0.55f;                       // 简易低通，去掉刺耳高频
            float body = (float) Math.sin(2 * Math.PI * 150 * i / RATE) * 0.5f * env;
            out[i] = (short) ((lp * 0.6f + body) * env * 12000);
        }
        return out;
    }

    private static short[] synthBoom() {
        int n = RATE * 700 / 1000;
        short[] out = new short[n];
        Random r = new Random(11);
        float lp = 0;
        for (int i = 0; i < n; i++) {
            float t = i / (float) n;
            float env = (float) Math.pow(1 - t, 2.1);
            float noise = (float) r.nextGaussian();
            lp += (noise - lp) * 0.10f;
            float rumble = (float) Math.sin(2 * Math.PI * 58 * i / RATE);
            out[i] = (short) ((lp * 0.8f + rumble * 0.7f) * env * 9000);
        }
        return out;
    }

    private static short[] synthBeep() {
        int n = RATE * 110 / 1000;
        short[] out = new short[n];
        for (int i = 0; i < n; i++) {
            float t = i / (float) n;
            float env = (float) Math.sin(Math.PI * Math.min(1f, t * 1.4f));
            float sq = (i / 26) % 2 == 0 ? 1f : -1f;
            out[i] = (short) (sq * env * 5000);
        }
        return out;
    }
}
