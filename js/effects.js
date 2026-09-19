import * as THREE from 'three';

// 发光贴图（用于冲击波/枪口闪光 Sprite）
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,220,150,0.7)');
  grd.addColorStop(1, 'rgba(255,180,60,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];   // 粒子组
    this.sprites = [];  // 冲击波 / 枪口闪光
    this.shakeAmp = 0;
    this.glowTex = makeGlowTexture();
    this.flashLight = new THREE.PointLight(0xffa040, 0, 90, 2);
    scene.add(this.flashLight);
  }

  shake(a) { this.shakeAmp = Math.min(1.4, this.shakeAmp + a); }

  _spawnParticles(pos, opts) {
    const {
      count = 40, color = 0xffaa33, size = 2.2, speed = 26,
      life = 1.2, gravity = 9, drag = 1.2, additive = true
    } = opts;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.35 + Math.random() * 0.85);
      vel[i * 3]     = Math.sin(ph) * Math.cos(th) * sp;
      vel[i * 3 + 1] = Math.cos(ph) * sp;
      vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size, transparent: true, opacity: 1, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    const points = new THREE.Points(geo, mat);
    points.position.copy(pos);
    this.scene.add(points);
    this.bursts.push({ points, vel, life: 0, max: life, gravity, drag });
  }

  _spawnSprite(pos, opts) {
    const { color = 0xffd9a0, from = 2, to = 26, life = 0.45, opacity = 0.95 } = opts;
    const mat = new THREE.SpriteMaterial({
      map: this.glowTex, color, transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    const spr = new THREE.Sprite(mat);
    spr.position.copy(pos);
    spr.scale.set(from, from, 1);
    this.scene.add(spr);
    this.sprites.push({ spr, life: 0, max: life, from, to, opacity });
  }

  // 枪口火光
  muzzle(pos) {
    this._spawnSprite(pos, { color: 0xffe6a8, from: 1.2, to: 2.6, life: 0.055 });
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = 4;
  }

  // 命中火花
  sparks(pos, color = 0xffe08a) {
    this._spawnParticles(pos, { count: 18, color, size: 1.4, speed: 20, life: 0.4, gravity: 14, drag: 1.5 });
  }

  // 爆炸：火球 + 浓烟 + 冲击波 + 闪光
  explosion(pos, scale = 1) {
    this._spawnParticles(pos, { count: 130, color: 0xffa53d, size: 2.6 * scale, speed: 42 * scale, life: 1.5, gravity: 11, drag: 1.4 });
    this._spawnParticles(pos, { count: 70,  color: 0xffe27a, size: 1.8 * scale, speed: 60 * scale, life: 0.8, gravity: 4,  drag: 1.2 });
    this._spawnParticles(pos, { count: 60,  color: 0x4a4a4a, size: 4.2 * scale, speed: 16 * scale, life: 2.6, gravity: -2, drag: 1.0, additive: false });
    this._spawnSprite(pos, { color: 0xffd9a0, from: 3 * scale, to: 46 * scale, life: 0.5 });
    this._spawnSprite(pos, { color: 0xffffff, from: 2 * scale, to: 20 * scale, life: 0.22 });
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = 12;
    this.shake(0.55);
  }

  update(dt) {
    // 粒子
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life += dt;
      const p = b.points.geometry.attributes.position.array;
      const dragK = Math.max(0, 1 - b.drag * dt);
      for (let j = 0; j < p.length; j += 3) {
        b.vel[j] *= dragK;
        b.vel[j + 1] = b.vel[j + 1] * dragK - b.gravity * dt;
        b.vel[j + 2] *= dragK;
        p[j] += b.vel[j] * dt;
        p[j + 1] += b.vel[j + 1] * dt;
        p[j + 2] += b.vel[j + 2] * dt;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
      b.points.material.opacity = Math.max(0, 1 - b.life / b.max);
      if (b.life >= b.max) {
        this.scene.remove(b.points);
        b.points.geometry.dispose();
        b.points.material.dispose();
        this.bursts.splice(i, 1);
      }
    }
    // Sprite 冲击波
    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const s = this.sprites[i];
      s.life += dt;
      const k = Math.min(1, s.life / s.max);
      const sc = s.from + (s.to - s.from) * k;
      s.spr.scale.set(sc, sc, 1);
      s.spr.material.opacity = s.opacity * (1 - k);
      if (s.life >= s.max) {
        this.scene.remove(s.spr);
        s.spr.material.dispose();
        this.sprites.splice(i, 1);
      }
    }
    // 闪光衰减
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 40);
    // 震屏衰减
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 2.2);
  }
}
