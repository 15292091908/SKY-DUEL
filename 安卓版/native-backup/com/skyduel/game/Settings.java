package com.skyduel.game;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 设置项（SharedPreferences 本地持久化）。
 * 对应网页版的设置需求：灵敏度、辅助瞄准、控件尺寸、音效。
 */
public class Settings {
    public static float sensMul = 1f;        // 视角/拖拽灵敏度倍率 0.4~2.5
    public static int assist = 1;            // 辅助瞄准：0 关 / 1 轻微 / 2 标准
    public static float joyScale = 1f;       // 摇杆大小 0.7~1.6
    public static float btnScale = 1f;       // 按钮大小 0.7~1.6
    public static boolean sfxOn = true;
    public static boolean leftHanded = false;// 左手模式：摇杆与开火按钮互换位置

    private static final String PREF = "skyduel_settings";

    public static void load(Context c) {
        try {
            SharedPreferences sp = c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            sensMul = sp.getFloat("sensMul", 1f);
            assist = sp.getInt("assist", 1);
            joyScale = sp.getFloat("joyScale", 1f);
            btnScale = sp.getFloat("btnScale", 1f);
            sfxOn = sp.getBoolean("sfxOn", true);
            leftHanded = sp.getBoolean("leftHanded", false);
        } catch (Throwable ignored) {}
    }

    public static void save(Context c) {
        try {
            SharedPreferences.Editor ed = c.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit();
            ed.putFloat("sensMul", sensMul);
            ed.putInt("assist", assist);
            ed.putFloat("joyScale", joyScale);
            ed.putFloat("btnScale", btnScale);
            ed.putBoolean("sfxOn", sfxOn);
            ed.putBoolean("leftHanded", leftHanded);
            ed.apply();
        } catch (Throwable ignored) {}
    }
}
