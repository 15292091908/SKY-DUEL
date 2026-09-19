package com.skyduel.game;

/**
 * AI 敌机（对应 js/ai.js 的精简版）：追踪 + 提前量 + 贴地保护 + 对准后开火。
 * 难度参数与网页版保持同一量级：转向/俯仰速率复用 Plane 的常量。
 */
public class Bot {
    public boolean firing = false;
    private float think = 0;

    public void update(Plane self, Plane foe, float dt) {
        if (!self.alive || !foe.alive) { firing = false; return; }
        think += dt;

        // 目标点：对方位置 + 提前量（按自身弹速与对方速度估算）
        float[] to = M4.sub(foe.pos, self.pos);
        float dist = M4.len(to);
        float lead = dist / Plane.BULLET_SPEED;
        float[] ff = foe.forward();
        float[] aim = new float[]{
                foe.pos[0] + ff[0] * foe.speed * lead * 0.8f,
                foe.pos[1] + ff[1] * foe.speed * lead * 0.8f,
                foe.pos[2] + ff[2] * foe.speed * lead * 0.8f
        };
        float[] dir = M4.norm(M4.sub(aim, self.pos));

        // 机头朝 -Z：yaw = atan2(-dir.x, -dir.z)，pitch = asin(dir.y)
        float wantYaw = (float) Math.atan2(-dir[0], -dir[2]);
        float wantPitch = (float) Math.asin(M4.clamp(dir[1], -1f, 1f));

        float dy = angDiff(wantYaw, self.yaw);
        float stepY = M4.clamp(dy, -Plane.TURN_RATE * dt, Plane.TURN_RATE * dt);
        self.yaw += stepY;
        self.yawVel = stepY / Math.max(dt, 1e-4f);

        float dp = wantPitch - self.pitch;
        self.pitch = M4.clamp(self.pitch + M4.clamp(dp, -Plane.PITCH_RATE * dt, Plane.PITCH_RATE * dt),
                -Plane.MAX_PITCH, Plane.MAX_PITCH);

        // 贴地 / 限高保护（避免 AI 撞海或飞出空域）
        if (self.pos[1] < 95) self.pitch = Math.max(self.pitch, 0.10f);
        if (self.pos[1] > 690) self.pitch = Math.min(self.pitch, -0.04f);
        // 出界时拉回中心
        float r = (float) Math.hypot(self.pos[0], self.pos[2]);
        if (r > 1560f) {
            float wantHome = (float) Math.atan2(self.pos[0], self.pos[2]);   // 机头朝 -Z：指向原点
            float dh = angDiff(wantHome, self.yaw);
            self.yaw += M4.clamp(dh, -Plane.TURN_RATE * dt * 0.8f, Plane.TURN_RATE * dt * 0.8f);
        }

        // 速度：远则加速追击，近则收油门避免冲过头
        self.targetSpeed = dist > 700 ? 155f : (dist < 200 ? 105f : 135f);

        // 开火：夹角足够小且距离合适
        float[] sf = self.forward();
        float cosA = M4.dot(sf, dir);
        firing = dist < 1000f && cosA > 0.9955f;
    }

    private static float angDiff(float want, float cur) {
        float d = want - cur;
        while (d > Math.PI) d -= (float) (Math.PI * 2);
        while (d < -Math.PI) d += (float) (Math.PI * 2);
        return d;
    }
}
