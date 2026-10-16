/** Small procedural textures (drawn once on a canvas, shared by every Lumo on the page). */
import * as THREE from 'three';

type Draw = (g: CanvasRenderingContext2D, s: number) => void;

function canvasTexture(size: number, draw: Draw, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export interface LumoTextures {
  glow: THREE.Texture;
  soft: THREE.Texture;
  sparkle: THREE.Texture;
  heart: THREE.Texture;
  zee: THREE.Texture;
  question: THREE.Texture;
  blush: THREE.Texture;
  shadow: THREE.Texture;
  keyboard: THREE.Texture;
  all: THREE.Texture[];
}

export function makeTextures(): LumoTextures {
  const glow = canvasTexture(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    r.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  // A soft round puff for exhaust (premultiplied-looking falloff).
  const soft = canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  const sparkle = canvasTexture(128, (g, s) => {
    const c = s / 2;
    const glowR = g.createRadialGradient(c, c, 0, c, c, c * 0.5);
    glowR.addColorStop(0, 'rgba(255,255,255,0.9)');
    glowR.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glowR;
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#fff';
    g.beginPath();
    // A four-point twinkle with concave sides.
    const R = c * 0.95,
      r = c * 0.12;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 - Math.PI / 2;
      const b = a + Math.PI / 4;
      g.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
      g.lineTo(c + Math.cos(b) * r, c + Math.sin(b) * r);
    }
    g.closePath();
    g.fill();
  });
  const heart = canvasTexture(128, (g, s) => {
    g.translate(s / 2, s / 2 + 6);
    g.scale(s / 140, s / 140);
    const path = new Path2D('M0 40 C -60 -5 -45 -60 0 -30 C 45 -60 60 -5 0 40 Z');
    g.shadowColor = 'rgba(255, 120, 170, 0.6)';
    g.shadowBlur = 12;
    const grad = g.createLinearGradient(0, -50, 0, 40);
    grad.addColorStop(0, '#ffb3cf');
    grad.addColorStop(1, '#ff6fa3');
    g.fillStyle = grad;
    g.fill(path);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath();
    g.ellipse(-22, -22, 9, 6, -0.6, 0, Math.PI * 2);
    g.fill();
  });
  const letter = (ch: string, fill: string) =>
    canvasTexture(128, (g, s) => {
      g.font = `800 ${s * 0.78}px ui-rounded, "SF Pro Rounded", "Nunito", "Montserrat Variable", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = s * 0.1;
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.strokeText(ch, s / 2, s / 2 + s * 0.04);
      g.fillStyle = fill;
      g.fillText(ch, s / 2, s / 2 + s * 0.04);
    });
  const zee = letter('z', '#8f7dff');
  const question = letter('?', '#ff9a5c');
  const blush = canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,140,170,0.85)');
    r.addColorStop(0.55, 'rgba(255,150,180,0.45)');
    r.addColorStop(1, 'rgba(255,160,190,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  const shadow = canvasTexture(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(70,50,120,0.42)');
    r.addColorStop(0.5, 'rgba(70,50,120,0.18)');
    r.addColorStop(1, 'rgba(70,50,120,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  const keyboard = canvasTexture(256, (g, s) => {
    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      g.beginPath();
      g.roundRect(x, y, w, h, r);
    };
    rr(6, 46, s - 12, s - 92, 26);
    const bg = g.createLinearGradient(0, 46, 0, s - 46);
    bg.addColorStop(0, 'rgba(150,220,255,0.55)');
    bg.addColorStop(1, 'rgba(180,160,255,0.55)');
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.stroke();
    const cols = 9,
      rows = 4,
      pad = 22,
      gap = 6;
    const kw = (s - pad * 2 - gap * (cols - 1)) / cols;
    const kh = (s - 92 - pad * 2 - gap * (rows - 1)) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === rows - 1 && (c < 2 || c > 6)) continue;
        const wide = r === rows - 1 && c === 2;
        rr(pad + c * (kw + gap), 46 + pad + r * (kh + gap), wide ? kw * 5 + gap * 4 : kw, kh, 6);
        g.fillStyle = 'rgba(255,255,255,0.75)';
        g.fill();
        if (wide) break;
      }
    }
  });
  return {
    glow,
    soft,
    sparkle,
    heart,
    zee,
    question,
    blush,
    shadow,
    keyboard,
    all: [glow, soft, sparkle, heart, zee, question, blush, shadow, keyboard],
  };
}
