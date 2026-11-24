/* EPD Sender — 纯静态前端，无外部依赖
 * 图片取景 -> 调色板量化 -> 4bpp 索引包 -> Web Bluetooth 发送
 */
(function () {
  'use strict';

  /* 网页版本：每次改动都改这里，界面和日志都会显示，用来确认浏览器没有用缓存 */
  const WEB_VER = 'v86w';

  /* ============================ 调色板 ============================ */
  /* 64 色表来自固件 epd/Display.h 的实测数据（8x8，索引 = (色相<<3)|明度） */
  const PAL64 = [
    [19, 32, 62], [22, 31, 55], [24, 34, 59], [27, 35, 61], [28, 34, 59], [34, 37, 60], [51, 44, 51], [91, 56, 45],
    [39, 100, 203], [101, 170, 246], [181, 218, 254], [239, 247, 254], [239, 246, 253], [239, 246, 252], [245, 248, 249], [255, 255, 255],
    [5, 34, 121], [8, 48, 157], [12, 58, 171], [21, 67, 174], [48, 86, 176], [79, 102, 179], [124, 125, 172], [181, 162, 180],
    [0, 60, 175], [2, 93, 195], [11, 110, 211], [21, 125, 220], [41, 151, 234], [73, 172, 232], [135, 200, 200], [178, 220, 203],
    [132, 4, 10], [168, 0, 12], [176, 2, 17], [180, 2, 18], [193, 8, 22], [200, 15, 28], [208, 16, 24], [223, 29, 27],
    [30, 18, 47], [49, 21, 53], [57, 25, 60], [69, 27, 62], [92, 35, 64], [122, 44, 67], [153, 66, 79], [189, 92, 95],
    [4, 68, 75], [19, 99, 68], [32, 117, 73], [43, 128, 72], [62, 143, 70], [77, 153, 68], [105, 170, 50], [135, 187, 44],
    [58, 47, 62], [180, 158, 13], [231, 206, 12], [255, 235, 14], [253, 234, 13], [251, 233, 14], [248, 229, 13], [246, 229, 14],
  ];

  /* ---------------------------- 屏白校正（WB） ----------------------------
     实拍对比（白纸作参照，同框拍摄可抵消相机白平衡）：屏上 0x0F 相对纸白
     R -2.6%、B -5.2%，亮度只有纸白的 0.72 倍 —— 屏的"白"本身略偏黄绿，而预览
     是纯白发光屏。这里把实测偏色按「屏白强度」补进色表描述（屏上 64 个物理色
     一个都不动，只改网页怎么描述它们）。全强度会推向暖绿白、容易过冲，默认 50。 */
  const PAL64_RAW = PAL64.map((c) => c.slice());
  const PANEL_WB = { r: 0.9741, b: 0.9477 };   /* 相对 G = 1 的实测偏色 */
  const PAPER_GAIN = { r: 0.707, g: 0.723, b: 0.681 };  /* 实测 屏白/纸白：133,136,128 / 188,187,185 */
  function applyPanelWB(strength) {
    const s = clamp((strength == null ? 50 : Number(strength)) / 100, 0, 1.5);
    const gr = 1 + s * (PANEL_WB.r - 1);
    const gb = 1 + s * (PANEL_WB.b - 1);
    for (let i = 0; i < PAL64.length; i++) {
      const src = PAL64_RAW[i];
      PAL64[i][0] = clamp(Math.round(src[0] * gr), 0, 255);
      PAL64[i][1] = src[1];
      PAL64[i][2] = clamp(Math.round(src[2] * gb), 0, 255);
    }
  }

  const PAL6 = [[0, 0, 0], [255, 255, 255], [215, 0, 0], [255, 220, 0], [40, 104, 184], [64, 156, 0]];
  const CODE6 = [0x00, 0x0f, 0x21, 0x3c, 0x08, 0x34];
  const PALBW = [[0, 0, 0], [255, 255, 255]];
  const CODEBW = [0x00, 0x0f];

  const MODES = {
    c64: { label: '64 色', pal: PAL64, code: PAL64.map((_, i) => i), fwMode: 0, nib: null },
    c6: { label: '6 色', pal: PAL6, code: CODE6, fwMode: 1,
      nib: [0x0, 0x1, 0x3, 0x2, 0x5, 0x6] },   /* 黑 白 红 黄 蓝 绿 → 面板六色号 */
    bw: { label: '黑白', pal: PALBW, code: CODEBW, fwMode: 2, nib: [0x0, 0x1] }
  };

  /* ============================ 小工具 ============================ */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round1 = (v) => Math.round(v * 10) / 10;

  /* ============================ DOM ============================ */
  const stage = $('stage');
  const view = $('view');
  const crop = $('crop');
  const empty = $('empty');
  const stageHint = $('stageHint');
  const preview = $('preview');
  const logEl = $('log');
  const fileInput = $('file');

  /* ============================ 状态 ============================ */
  const S = {
    img: null,
    name: '',
    orient: 'landscape',
    zoom: 1,
    tx: 0,
    ty: 0,
    rot: 0,
    mode: 'c64',
    dither: true,
    neutral: true,
    neutralStr: 100,
    wbStr: 50,
    paperSim: false,
    cool: 0,
    hsv: false,
    skyBlue: false,
    dehaze: 0,
    ditherStr: 0,
    sat: 0,
    expo: 0,
    ambi: 0,
    high: 0,
    shad: 0,
    temp: 0,
    tint: 0,
    bright: 0,
    contrast: 0,
    pixZoom: 1,
    indices: null,
    packed: null,
    device: null,
    server: null,
    ch: null,
    connected: false
  };

  applyPanelWB(S.wbStr);   /* 默认屏白强度 50% */

  /* ============================ 日志 ============================ */
  function log(msg, cls) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = '[' + t + '] ' + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.childElementCount > 300) logEl.removeChild(logEl.firstChild);
  }

  function setFoot(s) {
    $('footState').textContent = s;
  }

  /* ============================ 目标尺寸 / 取景框 ============================ */
  function targetSize() {
    /* 面板缓冲区永远是 720x480（每行 360 字节，4bpp）。竖屏不能再改缓冲尺寸，
       否则固件仍按 360 字节/行读取，会撕裂成多张重叠画面。 */
    return { w: 720, h: 480 };
  }

  function cropRect() {
    const { w: tw, h: th } = targetSize();
    const aspect = tw / th;
    const sw = Math.max(1, view.clientWidth);
    const sh = Math.max(1, view.clientHeight);
    let cw = Math.min(sw * 0.86, sh * 0.86 * aspect);
    let ch = cw / aspect;
    if (ch > sh * 0.9) {
      ch = sh * 0.9;
      cw = ch * aspect;
    }
    return { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch };
  }

  function baseScale(cr) {
    if (!S.img) return 1;
    return Math.max(cr.w / S.img.naturalWidth, cr.h / S.img.naturalHeight);
  }

  /* ============================ 画布渲染 ============================ */
  function renderStage() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sw = Math.max(1, view.clientWidth);
    const sh = Math.max(1, view.clientHeight);
    const W = Math.round(sw * dpr);
    const H = Math.round(sh * dpr);
    if (view.width !== W || view.height !== H) {
      view.width = W;
      view.height = H;
    }
    const ctx = view.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sw, sh);

    paintedCrop = cropRect();
    crop.style.left = paintedCrop.x + 'px';
    crop.style.top = paintedCrop.y + 'px';
    crop.style.width = paintedCrop.w + 'px';
    crop.style.height = paintedCrop.h + 'px';

    if (!S.img) return;

    const bs = baseScale(paintedCrop);
    ctx.save();
    ctx.translate(sw / 2 + S.tx, sh / 2 + S.ty);
    ctx.rotate((S.rot * Math.PI) / 180);
    ctx.scale(bs * S.zoom, bs * S.zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.img, -S.img.naturalWidth / 2, -S.img.naturalHeight / 2);
    ctx.restore();
  }

  let paintedCrop = { x: 0, y: 0, w: 1, h: 1 };

  /* ============================ 颜色量化 ============================ */
  const LUT_CACHE = new Map();

  /* 色系：0 中性 / 1 红 / 2 绿 / 3 蓝 / 4 黄橙。
     目的：蓝色目标不许落到绿系条目上（淡青蓝被当成薄荷绿就是这个原因）。 */
  function famOf(r, g, b) {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn < 28) return 0;
    /* 纯黄 (255,253,0)：R 与 G 并列最大，按“最大通道是 G”会被判成绿色系，
       6bit LUT 的桶心 (254,254,2) 正好踩中这个并列，黄色就被送到 0x37 黄绿。 */
    if (mx === r && mx === g) return 4;
    if (mx === g) return 2;
    if (mx === b) return 3;
    if (g > b * 1.15 && g > 90) return 4;
    return 1;
  }

  /* RGB -> HSV：h 0..360，s/v 0..1 */
  function rgb2hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return [h, mx === 0 ? 0 : d / mx, mx / 255];
  }

  function buildLut(pal, pool) {
    const n = pal.length;
    const ks = pool || null;
    const cool = (S.cool || 0) * 0.25;   /* 去黄补偿：0..100 -> 0..25 的 R-/B+ 偏移 */
    const chroma = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      chroma[i] = Math.max(pal[i][0], pal[i][1], pal[i][2]) - Math.min(pal[i][0], pal[i][1], pal[i][2]);
    }
    const pr = new Int16Array(n);
    const pg = new Int16Array(n);
    const pb = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      pr[i] = pal[i][0];
      pg[i] = pal[i][1];
      pb[i] = pal[i][2];
    }
    const fam = new Uint8Array(n);
    for (let i = 0; i < n; i++) fam[i] = famOf(pr[i], pg[i], pb[i]);
    const hsvMode = !!S.hsv;
    const pH = new Float32Array(n), pS = new Float32Array(n), pV = new Float32Array(n);
    if (hsvMode) {
      for (let i = 0; i < n; i++) {
        const t = rgb2hsv(pr[i], pg[i], pb[i]);
        pH[i] = t[0]; pS[i] = t[1]; pV[i] = t[2];
      }
    }
    const lut = new Uint8Array(64 * 64 * 64);
    for (let r = 0; r < 64; r++) {
      const R = (r << 2) | 2;
      for (let g = 0; g < 64; g++) {
        const G = (g << 2) | 2;
        const base = (r << 12) | (g << 6);
        for (let b = 0; b < 64; b++) {
          const B = (b << 2) | 2;
          let best = 0;
          let bd = Infinity;
          /* 只在低彩度目标上补偿：白/奶油白/灰才是屏上泛黄的主犯，饱和色有自己的格子 */
          const tch = Math.max(R, G, B) - Math.min(R, G, B);
          const csh = tch < 40 ? cool : 0;
          const Rc = R - csh, Bc = B + csh;
          const tf = famOf(Rc, G, Bc);
          let hT = 0, sT = 0, vT = 0;
          if (hsvMode) { const t = rgb2hsv(Rc, G, Bc); hT = t[0]; sT = t[1]; vT = t[2]; }
          /* 青色目标：G≈B 且明显偏蓝。它常被最近邻换成绿偏的薄荷条目（B2DCCB），
             加罚分把这类条目推远，改落到真正的青（87C8C8）。
             只对"够饱和"的青生效：淡青天空要是也被推去 87C8C8，整片天会变暗发绿。 */
          const tmx = Math.max(Rc, G, Bc), tmn = Math.min(Rc, G, Bc);
          const tCyan = tf === 2 && Bc >= G - 8 && Bc > Rc + 20 && tmx - tmn >= 45;
          for (let ki = 0; ki < (ks ? ks.length : n); ki++) {
            const k = ks ? ks[ki] : ki;
            if (tf !== 0 && fam[k] !== 0 && fam[k] !== tf) continue;
            let d;
            if (hsvMode) {
              let dh = Math.abs(hT - pH[k]);
              if (dh > 180) dh = 360 - dh;
              const hw = Math.min(sT, pS[k]);
              const ds = (sT - pS[k]) * 255;
              const dv = (vT - pV[k]) * 255;
              d = 2.1 * dh * dh * 10.24 * hw + 1.4 * ds * ds + 3.0 * dv * dv;
              /* 青/淡青目标不许落到「薄荷」条目（G 明显大于 B）：那块屏上 0x1F 看着就是绿，
                 和白色一混，整片天立刻发绿。0x1E 的 G≈B，是真青，允许。 */
              if (sT > 0.06 && Bc >= G - 8 && Bc > Rc + 20 && pg[k] - pb[k] > 10) d += 4.0e6;
              if (S.skyBlue && sT < 0.55 && Bc > Rc + 18 && Bc >= G - 30 && fam[k] === 2) d += 4.0e6;
            } else {
              const dr = Rc - pr[k];
              const dg = G - pg[k];
              const db = Bc - pb[k];
              d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            }
            /* 青蓝目标只允许偏蓝的条目：屏上那几格薄荷青看着是绿的，
               不这样拦住，淡蓝天空会被判成薄荷绿。 */
            if (tf === 3 && Bc - G >= 0 && pb[k] - pg[k] < 15) d += 3000;
            if (tCyan && pg[k] - pb[k] > 10) d += 12000;
            /* 够饱和的青也不许落到近白/中性条目（屏白校正后 0x0D 会抢走 ACE6E3） */
            if (tCyan && chroma[k] <= 12) d += 6000;
            if (S.skyBlue && tch < 140 && Bc > Rc + 18 && Bc >= G - 30 && fam[k] === 2) d += 4.0e6;
            if (d < bd) {
              bd = d;
              best = k;
            }
          }
          if (bd === Infinity) {           /* 同色系里一个都没选中时退回全表 */
            for (let ki = 0; ki < (ks ? ks.length : n); ki++) {
              const k = ks ? ks[ki] : ki;
              let d;
              if (hsvMode) {
                let dh = Math.abs(hT - pH[k]);
                if (dh > 180) dh = 360 - dh;
                const hw = Math.min(sT, pS[k]);
                const ds = (sT - pS[k]) * 255;
                const dv = (vT - pV[k]) * 255;
                d = 2.1 * dh * dh * 10.24 * hw + 1.4 * ds * ds + 3.0 * dv * dv;
                if (sT > 0.06 && Bc >= G - 8 && Bc > Rc + 20 && pg[k] - pb[k] > 10) d += 4.0e6;
                if (S.skyBlue && sT < 0.55 && Bc > Rc + 18 && Bc >= G - 30 && fam[k] === 2) d += 4.0e6;
              } else {
                const dr = Rc - pr[k];
                const dg = G - pg[k];
                const db = Bc - pb[k];
                d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
              }
                if (tCyan && pg[k] - pb[k] > 10) d += 12000;
              /* 够饱和的青也不许落到近白/中性条目（屏白校正后 0x0D 会抢走 ACE6E3） */
              if (tCyan && chroma[k] <= 12) d += 6000;
              if (S.skyBlue && tch < 140 && Bc > Rc + 18 && Bc >= G - 30 && fam[k] === 2) d += 4.0e6;
              if (d < bd) {
                bd = d;
                best = k;
              }
            }
          }
          lut[base | b] = best;
        }
      }
    }
    return lut;
  }

  /* 把 64 色按色相分成 8 组（每 8 个是同一色相的明度阶梯）。
     抖动只允许在组内混合，避免"暗红 -> 黄/棕"这种跨色相串色。 */
  const HUE_ROWS = new WeakMap();
  function hueRows(pal) {
    if (pal.length !== 64) return null;
    let rows = HUE_ROWS.get(pal);
    if (rows) return rows;
    rows = [];
    for (let h = 0; h < 8; h++) {
      const g = [];
      for (let k = 0; k < 8; k++) g.push(h * 8 + k);
      rows.push(g);
    }
    HUE_ROWS.set(pal, rows);
    return rows;
  }

  /* 在给定色相组内挑与目标色最近的档位 */
  function pickInRow(pal, row, r, g, b) {
    const tch = Math.max(r, g, b) - Math.min(r, g, b);
    const cs = tch < 40 ? (S.cool || 0) * 0.25 : 0;
    const r2 = clamp(r - cs, 0, 255), b2 = clamp(b + cs, 0, 255);
    const tmx = Math.max(r2, g, b2), tmn = Math.min(r2, g, b2);
    const tCyan = tmx - tmn >= 28 && tmx === g && b2 >= g - 8 && b2 > r2 + 20 && tmx - tmn >= 45;
    let best = row[0], bd = Infinity;
    for (let n = 0; n < row.length; n++) {
      const ci = row[n];
      const c = pal[ci];
      const dr = r2 - c[0], dg = g - c[1], db = b2 - c[2];
      let d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (tCyan && c[1] - c[2] > 10) d += 1e6;   /* 青色目标在同色相组里也不要薄荷 */
      /* 抖动路径同样拦薄荷：淡青天空在 0x18-0x1F 这一行里会被 0x1F 抢走，整片天发绿 */
      if (b2 >= g - 8 && b2 > r2 + 20 && c[1] - c[2] > 10) d += 1e6;
      if (d < bd) { bd = d; best = ci; }
    }
    return best;
  }

  /* 按实测色相把 64 个条目分成色族：0 中性 / 1 红 / 2 橙黄 / 3 绿 / 4 青 / 5 蓝 / 6 紫。
     抖动只允许在同一色族内混合，避免「中性灰抖成橄榄黄」。 */
  const FAM_CACHE = new WeakMap();
  function palFam(pal) {
    let f = FAM_CACHE.get(pal);
    if (f) return f;
    f = new Uint8Array(pal.length);
    for (let i = 0; i < pal.length; i++) {
      const c = pal[i];
      const mx = Math.max(c[0], c[1], c[2]);
      const mn = Math.min(c[0], c[1], c[2]);
      if (mx - mn <= 18) { f[i] = 0; continue; }
      const h = rgb2hsv(c[0], c[1], c[2])[0];
      if (h < 20 || h >= 330) f[i] = 1;
      else if (h < 70) f[i] = 2;
      else if (h < 160) f[i] = 3;
      else if (h < 200) f[i] = 4;
      else if (h < 260) f[i] = 5;
      else f[i] = 6;
    }
    FAM_CACHE.set(pal, f);
    return f;
  }

  const FAMIDX_CACHE = new WeakMap();
  function famIndex(pal) {
    let m = FAMIDX_CACHE.get(pal);
    if (m) return m;
    const f = palFam(pal);
    m = [[], [], [], [], [], [], []];
    for (let i = 0; i < f.length; i++) m[f[i]].push(i);
    FAMIDX_CACHE.set(pal, m);
    return m;
  }

  /* 在同一色族里挑与目标最近的档位（抖动路径用） */
  function pickInFam(pal, famIdx, fid, r, g, b) {
    const list = (famIdx[fid] && famIdx[fid].length) ? famIdx[fid] : famIdx[0];
    const tch = Math.max(r, g, b) - Math.min(r, g, b);
    const cs = tch < 40 ? (S.cool || 0) * 0.25 : 0;
    const r2 = clamp(r - cs, 0, 255), b2 = clamp(b + cs, 0, 255);
    let best = list[0], bd = Infinity;
    for (let n = 0; n < list.length; n++) {
      const ci = list[n];
      const c = pal[ci];
      const dr = r2 - c[0], dg = g - c[1], db = b2 - c[2];
      let d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      /* 青色目标不吃薄荷条目（0x1F 那块屏上偏绿） */
      if (b2 >= g - 8 && b2 > r2 + 20 && c[1] - c[2] > 10) d += 1e6;
      if (d < bd) { bd = d; best = ci; }
    }
    return best;
  }

  function getLut(pal) {
    const key = pal.length + '|' + (S.cool || 0) + '|' + (S.hsv ? 1 : 0) + '|' + (S.skyBlue ? 1 : 0);
    let l = LUT_CACHE.get(key);
    if (!l) {
      l = buildLut(pal, null);
      LUT_CACHE.set(key, l);
    }
    return l;
  }


  /* 这块屏的 64 色里没有任何中性中灰：最接近 RGB(64,64,64) 的是 0x38(89,60,38) 棕。
     不保护的话，灰度区域会被吸到棕/蓝/紫格子上，一开抖动就整体发黄。
     所以对低彩度像素只允许在黑(00)与白(0F)之间抖动，由误差扩散自己合成灰阶。 */
  /* 26 太宽：0x17(209,178,192) 这种真的淡粉彩度只有 24，会被硬拉进中性池，
     而中性池里只有近黑与近白（0x0D 244,250,255），淡粉就被换成了淡蓝白。
     18 能覆盖真实灰阶（暖灰 15 仍在池内），又放过了淡粉/淡紫。 */
  const EXACT_CACHE = new Map();
  /* 恒等映射：色表里每一项的 RGB 必须原样映射回它自己的下标。
     这样「用当前色表生成的 64 色图 A」传进来，预览与 A 逐像素完全一致；
     照片里恰好等于色表值的像素也自然落到对应格。 */
  function getExact(pal) {
    let m = EXACT_CACHE.get(pal);
    if (m) return m;
    m = new Map();
    for (let i = 0; i < pal.length; i++) {
      const c = pal[i];
      const k = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!m.has(k)) m.set(k, i);
    }
    /* 同一格子在「屏白校正」不同强度下取整后会差 1 级：0x29 实测 #311535，
       强度 50 时压成 #301534。图 A / 色卡按强度 50 生成，页面滑块却可能停在
       0 或别处，于是 1 级差让精确匹配落空、被最近邻抢走，看起来像"颜色被改了"。
       这里把 0/50/100 三档的结果都登记进同一个下标，两种写法都能精确落格。 */
    if (pal === PAL64) {
      for (const st of [0, 50, 100]) {
        const s = st / 100;
        const gr = 1 + s * (PANEL_WB.r - 1);
        const gb = 1 + s * (PANEL_WB.b - 1);
        for (let i = 0; i < PAL64_RAW.length; i++) {
          const c = PAL64_RAW[i];
          const k = (clamp(Math.round(c[0] * gr), 0, 255) << 16)
            | (c[1] << 8)
            | clamp(Math.round(c[2] * gb), 0, 255);
          if (!m.has(k)) m.set(k, i);
        }
      }
    }
    EXACT_CACHE.set(pal, m);
    return m;
  }

  const NEUTRAL_CHROMA = 18;
  const NEUTRAL_CACHE = new Map();

  function getNeutralLut(pal) {
    let l = NEUTRAL_CACHE.get(pal);
    if (l) return l;
    const idx = [];
    for (let i = 0; i < pal.length; i++) {
      const c = pal[i];
      const chroma = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      if (chroma <= 12) idx.push(i);
    }
    if (idx.length < 2) {
      let lo = 0, hi = 0;
      for (let i = 1; i < pal.length; i++) {
        const a = pal[i][0] + pal[i][1] + pal[i][2];
        const b1 = pal[lo][0] + pal[lo][1] + pal[lo][2];
        const b2 = pal[hi][0] + pal[hi][1] + pal[hi][2];
        if (a < b1) lo = i;
        if (a > b2) hi = i;
      }
      idx.length = 0;
      idx.push(lo, hi);
    }
    l = buildLut(pal, idx, 0);
    NEUTRAL_CACHE.set(pal, l);
    return l;
  }

  /* 可分离盒式模糊求局部亮度：光感（鲜明度）要用它算局部对比。
     src 是 RGBA 视图；半径 6 像素在 720x480 上足够稳，且只跑一次。 */
  function blurLuma(src, w, h, r) {
    const L = new Float32Array(w * h);
    for (let i = 0, o = 0; i < w * h; i++, o += 4) {
      L[i] = 0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2];
    }
    const tmp = new Float32Array(w * h);
    const wid = 2 * r + 1;
    const cl = (v, m) => (v < 0 ? 0 : v >= m ? m - 1 : v);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += L[row + cl(x, w)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / wid;
        sum += L[row + cl(x + r + 1, w)] - L[row + cl(x - r, w)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[cl(y, h) * w + x];
      for (let y = 0; y < h; y++) {
        L[y * w + x] = sum / wid;
        sum += tmp[cl(y + r + 1, h) * w + x] - tmp[cl(y - r, h) * w + x];
      }
    }
    return L;
  }

  /* ============================ 转换主流程 ============================ */
    /* v85w：色号分布日志（1.5 s 去抖） */
  let gCodeT = 0;
  function logCodes(txt) {
    const now = Date.now();
    if (now - gCodeT < 1500) return;
    gCodeT = now;
    log(txt);
  }

function convert() {
    if (!S.img) return;
    const t0 = performance.now();
    const { w, h } = targetSize();
    const cr = paintedCrop;
    const sw = Math.max(1, view.clientWidth);
    const sh = Math.max(1, view.clientHeight);
    const k = w / cr.w;

    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(k, 0, 0, k, -cr.x * k, -cr.y * k);
    ctx.translate(sw / 2 + S.tx, sh / 2 + S.ty);
    ctx.rotate((S.rot * Math.PI) / 180);
    const bs = baseScale(cr);
    ctx.scale(bs * S.zoom, bs * S.zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.img, -S.img.naturalWidth / 2, -S.img.naturalHeight / 2);

    const src = ctx.getImageData(0, 0, w, h).data;
    S.lastSrc = src;   /* 供取色明细读取原色 */
    const N = w * h;
    const mode = MODES[S.mode];
    const pal = mode.pal;
    const lut = getLut(pal);
    const lutN = S.neutral ? getNeutralLut(pal) : null;
    const xm = getExact(pal);
    const nThr = S.neutral ? NEUTRAL_CHROMA * ((S.neutralStr == null ? 100 : S.neutralStr) / 100) : 0;
    const famIdx = famIndex(pal);
    const fams = palFam(pal);
    const idx = new Uint8Array(N);

    const bright = S.bright * 2.55;
    const cf = 1 + (S.contrast / 60) * 0.8;
    /* 手机相册风格的六项调节，全部作用在"匹配前的像素"上，默认 0 时不做任何事。
       顺序：色温/色调 -> 曝光 -> 高光/阴影 -> 光感 -> 亮度/对比度 -> 去朦胧 -> 饱和 */
    const tempK = (S.temp || 0) / 100;
    const tintK = (S.tint || 0) / 100;
    const wbR = 1 + 0.18 * tempK;          /* 色温正=偏暖：R↑ B↓ */
    const wbB = 1 - 0.18 * tempK;
    const wbM = 1 + 0.04 * tintK;          /* 色调正=偏品红：G↓，R/B 微抬 */
    const wbG = 1 - 0.10 * tintK;
    const expoG = Math.pow(2, (S.expo || 0) / 100);   /* ±1 挡曝光 */
    const hlK = (S.high || 0) / 100;       /* 正=提亮高光 */
    const shK = (S.shad || 0) / 100;       /* 正=提亮阴影 */
    const amb = (S.ambi || 0) / 100;       /* 光感/鲜明度 */
    const satK = (1 + (S.sat || 0) / 100) * (1 + 0.18 * amb);
    const dh = Math.min(0.6, (S.dehaze || 0) / 100 * 0.45);
    const ped = 255 * dh;
    const inv = 1 / (1 - dh);
    const blur = amb !== 0 ? blurLuma(src, w, h, 6) : null;

    const buf = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      let rr = src[o], gg = src[o + 1], bb = src[o + 2];
      /* ① 色温 / 色调（白平衡轴） */
      if (tempK !== 0 || tintK !== 0) {
        rr = rr * wbR * wbM;
        gg = gg * wbG;
        bb = bb * wbB * wbM;
      }
      /* ② 曝光 */
      if (expoG !== 1) { rr *= expoG; gg *= expoG; bb *= expoG; }
      /* ③ 高光 / 阴影：按亮度掩膜整体平移 */
      if (hlK !== 0 || shK !== 0) {
        const y0 = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        const m = y0 / 255;
        let dlt = 0;
        if (hlK !== 0) dlt += hlK * 72 * m * m;
        if (shK !== 0) { const n2 = 1 - m; dlt += shK * 72 * n2 * n2; }
        rr += dlt; gg += dlt; bb += dlt;
      }
      /* ④ 光感：提亮暗部 + 局部对比（原亮度与 6px 模糊亮度之差） */
      if (blur) {
        const y0 = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        const m = 1 - y0 / 255;
        const add = amb * (0.75 * (y0 - blur[i]) + 26 * m * m);
        rr += add; gg += add; bb += add;
      }
      /* ⑤ 亮度 / 对比度（原有） */
      rr = (rr - 128) * cf + 128 + bright;
      gg = (gg - 128) * cf + 128 + bright;
      bb = (bb - 128) * cf + 128 + bright;
      /* 去朦胧：屏上泛白相当于整幅图被白雾抬了黑位。
         这里按 A=255 的反雾公式做逐像素反演：J = (I - 255*dh) / (1 - dh)，
         白点保持不变、黑位被压回去，对比与彩度同时上来。 */
      if (dh > 0) {
        rr = (rr - ped) * inv;
        gg = (gg - ped) * inv;
        bb = (bb - ped) * inv;
      }
      if (satK !== 1) {
        const yy = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        rr = yy + (rr - yy) * satK;
        gg = yy + (gg - yy) * satK;
        bb = yy + (bb - yy) * satK;
      }
      buf[i * 3] = rr;
      buf[i * 3 + 1] = gg;
      buf[i * 3 + 2] = bb;
    }

    /* 抖动量 = 0 时走纯查表，保证开关抖动不改变结果（组内选档只在真抖动时才起作用）。 */
    if (S.dither && (S.ditherStr || 0) > 0) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const p = i * 3;
          const r = clamp(buf[p] | 0, 0, 255);
          const g = clamp(buf[p + 1] | 0, 0, 255);
          const b = clamp(buf[p + 2] | 0, 0, 255);
          const useN = lutN && (Math.max(r, g, b) - Math.min(r, g, b)) < nThr;
          let pi = xm.get((r << 16) | (g << 8) | b);
          if (pi === undefined) {
            pi = (useN ? lutN : lut)[((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)];
            if (!useN) pi = pickInFam(pal, famIdx, fams[pi], r, g, b);
          }
          idx[i] = pi;
          const c = pal[pi];
          const dk = S.ditherStr / 100;
          if (dk <= 0) continue;
          const er = (r - c[0]) * dk;
          const eg = (g - c[1]) * dk;
          const eb = (b - c[2]) * dk;
          if (x + 1 < w) {
            const q = p + 3;
            buf[q] += (er * 7) / 16;
            buf[q + 1] += (eg * 7) / 16;
            buf[q + 2] += (eb * 7) / 16;
          }
          if (y + 1 < h) {
            const row = p + w * 3;
            if (x > 0) {
              buf[row - 3] += (er * 3) / 16;
              buf[row - 2] += (eg * 3) / 16;
              buf[row - 1] += (eb * 3) / 16;
            }
            buf[row] += (er * 5) / 16;
            buf[row + 1] += (eg * 5) / 16;
            buf[row + 2] += (eb * 5) / 16;
            if (x + 1 < w) {
              buf[row + 3] += er / 16;
              buf[row + 4] += eg / 16;
              buf[row + 5] += eb / 16;
            }
          }
        }
      }
    } else {
      for (let i = 0; i < N; i++) {
        const p = i * 3;
        const r = clamp(buf[p] | 0, 0, 255);
        const g = clamp(buf[p + 1] | 0, 0, 255);
        const b = clamp(buf[p + 2] | 0, 0, 255);
        const useN = lutN && (Math.max(r, g, b) - Math.min(r, g, b)) < nThr;
        const pe = xm.get((r << 16) | (g << 8) | b);
        idx[i] = (pe !== undefined) ? pe
          : (useN ? lutN : lut)[((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)];
      }
    }

    S.indices = idx;
    /* v85w：把真正发给屏的色号分布打出来（只统计、不发数据）
       用途：判断屏上偏色是网页选错色号，还是固件/面板那段的问题。
       1.5 秒去抖，拖滑块时不会刷屏。 */
    {
      const hist = new Uint32Array(pal.length);
      const nTot = idx.length;
      for (let i2 = 0; i2 < nTot; i2++) hist[idx[i2]]++;
      const top = [];
      for (let k = 0; k < hist.length; k++) if (hist[k]) top.push([k, hist[k]]);
      top.sort((x, y) => y[1] - x[1]);
      S.codeHist = top.slice(0, 6).map(([k, n]) =>
        '0x' + (k < 16 ? '0' : '') + k.toString(16).toUpperCase() + ' ' +
        (100 * n / nTot).toFixed(1) + '%').join(' · ');
      logCodes('色号分布 top6 · ' + S.codeHist);
    }


    // 4bpp 打包（高 nibble = 左像素）
    const packed = new Uint8Array(N >> 1);
    const codes = mode.code;
    for (let i = 0; i < packed.length; i++) {
      packed[i] = (codes[idx[i * 2]] << 4) | codes[idx[i * 2 + 1]];
    }
    S.packed = packed;

    drawPreview();
    updateStats();
    if (S.connected) $('sendImgBtn').disabled = false;

    const dt = Math.round(performance.now() - t0);
    setFoot('已转换 · ' + dt + ' ms');
  }

  function drawPreview() {
    if (!S.indices) return;
    const { w, h } = targetSize();
    if (preview.width !== w || preview.height !== h) {
      preview.width = w;
      preview.height = h;
    }
    const ctx = preview.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const pal = MODES[S.mode].pal;
    const pgr = S.paperSim ? PAPER_GAIN.r : 1;  /* 纸面模拟：只影响预览，不改发给屏的数据 */
    const pgg = S.paperSim ? PAPER_GAIN.g : 1;
    const pgb = S.paperSim ? PAPER_GAIN.b : 1;
    for (let i = 0; i < w * h; i++) {
      const c = pal[S.indices[i]];
      const o = i * 4;
      d[o] = c[0] * pgr;
      d[o + 1] = c[1] * pgg;
      d[o + 2] = c[2] * pgb;
      d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function updateStats() {
    const { w, h } = targetSize();
    $('statSize').textContent = w + ' × ' + h;
    $('previewBadge').textContent = w + '×' + h;
    $('statBytes').textContent = S.packed ? S.packed.length.toLocaleString() + ' B' : '—';
    $('statPal').textContent = MODES[S.mode].label;
    $('dlBtn').disabled = !S.packed;
  }

  /* ========================== 测色卡（校色用） ========================== */
  /* 面板按 (色相<<3 | 明度) 解释每个像素，6bit 一个色号。
     这里绕开调色板查表和抖动，直接往每个像素写"色号"，
     生成 8×8 的色卡：行 = 色相 0..7（上→下），列 = 明度 0..7（左→右）。
     格子之间留 1 像素黑线，方便在实拍照片里量出每格的边界。
     用途：拍一张实拍照，就能知道面板对每个色号的真实颜色，
     从而核对网页 PAL64 到底差在哪一格。 */
  function buildCalibCard() {
    const { w, h } = targetSize();
    const cw = Math.floor(w / 8);
    const chh = Math.floor(h / 8);
    const idx = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const hue = Math.min(7, Math.floor(y / chh));
      for (let x = 0; x < w; x++) {
        const lev = Math.min(7, Math.floor(x / cw));
        idx[y * w + x] = (x % cw === 0 || y % chh === 0) ? 0x00 : ((hue << 3) | lev);
      }
    }
    S.mode = 'c64';
    const seg = $('segMode');
    if (seg) {
      Array.from(seg.children).forEach((b) => b.classList.toggle('on', b.dataset.val === 'c64'));
    }
    S.indices = idx;
    const codes = MODES.c64.code;
    const packed = new Uint8Array((w * h) >> 1);
    for (let i = 0; i < packed.length; i++) {
      packed[i] = (codes[idx[i * 2]] << 4) | codes[idx[i * 2 + 1]];
    }
    S.packed = packed;
    drawPreview();
    updateStats();
    if (S.connected) $('sendImgBtn').disabled = false;
    log('已生成 8×8 测色卡：行 = 色相 0..7（上→下），列 = 明度 0..7（左→右）；点「发送图像」上屏', 'ok');
    setFoot('测色卡已就绪');
  }

  /* ============================ 交互：拖动 / 缩放 ============================ */
  const pts = new Map();
  let dragStart = null;
  let lastPinch = null;

  function pinchInfo() {
    const a = Array.from(pts.values());
    const dx = a[0].x - a[1].x;
    const dy = a[0].y - a[1].y;
    return {
      dist: Math.hypot(dx, dy),
      midX: (a[0].x + a[1].x) / 2,
      midY: (a[0].y + a[1].y) / 2
    };
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!S.img) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty };
      lastPinch = null;
      stage.classList.add('dragging');
    } else if (pts.size === 2) {
      dragStart = null;
      lastPinch = pinchInfo();
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size === 1 && dragStart) {
      S.tx = dragStart.tx + (e.clientX - dragStart.x);
      S.ty = dragStart.ty + (e.clientY - dragStart.y);
      renderStage();
      scheduleConvert();
    } else if (pts.size === 2) {
      const now = pinchInfo();
      if (lastPinch && lastPinch.dist > 4) {
        const f = now.dist / lastPinch.dist;
        S.zoom = clamp(S.zoom * f, 0.2, 6);
        S.tx += now.midX - lastPinch.midX;
        S.ty += now.midY - lastPinch.midY;
        syncZoomUI();
        renderStage();
        scheduleConvert();
      }
      lastPinch = now;
    }
  });

  function endPointer(e) {
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      dragStart = null;
      lastPinch = null;
      stage.classList.remove('dragging');
    } else if (pts.size === 1) {
      const rest = Array.from(pts.values())[0];
      dragStart = { x: rest.x, y: rest.y, tx: S.tx, ty: S.ty };
      lastPinch = null;
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener(
    'wheel',
    (e) => {
      if (!S.img) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015);
      S.zoom = clamp(S.zoom * f, 0.2, 6);
      syncZoomUI();
      renderStage();
      scheduleConvert();
    },
    { passive: false }
  );

  let convTimer = null;
  function scheduleConvert() {
    if (!S.img) return;
    clearTimeout(convTimer);
    convTimer = setTimeout(convert, 90);
  }

  function syncZoomUI() {
    $('zoom').value = String(S.zoom);
    $('zoomVal').textContent = Math.round(S.zoom * 100) + '%';
  }

  /* ============================ 图片载入 ============================ */
  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      log('这不是图片文件：' + file.name, 'err');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      S.img = img;
      S.name = file.name;
      S.tx = 0;
      S.ty = 0;
      S.zoom = 1;
      S.rot = 0;
      $('rotate').value = '0';
      $('rotateVal').textContent = '0°';
      $('fileName').textContent = file.name + ' · ' + img.naturalWidth + '×' + img.naturalHeight;
      $('clearBtn').disabled = false;
      empty.hidden = true;
      crop.hidden = false;
      stageHint.hidden = false;
      syncZoomUI();
      renderStage();
      convert();
      log('已载入 ' + file.name + '（' + img.naturalWidth + '×' + img.naturalHeight + '）', 'ok');
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      log('图片解码失败：' + file.name, 'err');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['pickBtn', 'pickBtn2'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('click', () => fileInput.click());
  });

  $('clearBtn').addEventListener('click', () => {
    S.img = null;
    S.indices = null;
    S.packed = null;
    S.name = '';
    $('fileName').textContent = '未选择';
    $('clearBtn').disabled = true;
    empty.hidden = false;
    crop.hidden = true;
    stageHint.hidden = true;
    preview.getContext('2d').clearRect(0, 0, preview.width, preview.height);
    updateStats();
    renderStage();
  });

  /* 拖放 */
  ['dragenter', 'dragover'].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      stage.style.borderColor = 'var(--accent)';
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      stage.style.borderColor = '';
    })
  );
  stage.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* ============================ 参数控件 ============================ */
  function bindSeg(id, key, onAfter) {
    const root = $(id);
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      Array.from(root.children).forEach((b) => b.classList.toggle('on', b === btn));
      const v = btn.dataset.val;
      S[key] = key === 'pixZoom' ? Number(v) : v;
      if (onAfter) onAfter(v);
    });
  }

  bindSeg('segOrient', 'orient', (v) => {
    /* 竖屏 = 把画面旋转 90° 后装进 720x480 的横向缓冲。
       这样固件读到的仍是 360 字节/行，屏幕竖着看就是正立的竖图。 */
    const r = v === 'portrait' ? 90 : 0;
    S.rot = r;
    const rs = $('rotate');
    if (rs) rs.value = String(r);
    const rv = $('rotateVal');
    if (rv) rv.textContent = r + '°';
    renderStage();
    convert();
    log('取景方向：' + targetSize().w + '×' + targetSize().h +
        (r ? '（画面已旋转 90°，请把屏幕竖起来看）' : ''));
  });

  bindSeg('segMode', 'mode', (v) => {
    log('颜色模式：' + MODES[v].label);
    if (S.img) {
      setFoot('正在生成调色板…');
      setTimeout(() => {
        convert();
      }, 0);
    }
  });

  bindSeg('segPixZoom', 'pixZoom', (v) => {
    preview.style.width = Number(v) * 100 + '%';
  });

  $('dither').addEventListener('change', (e) => {
    S.dither = e.target.checked;
    if (S.img) convert();
  });

  function bindRange(id, key, fmt, after) {
    const el = $(id);
    el.addEventListener('input', () => {
      S[key] = Number(el.value);
      if (fmt) fmt(S[key]);
      if (after) after();
    });
  }

  bindRange('rotate', 'rot', (v) => {
    $('rotateVal').textContent = v + '°';
  }, () => {
    renderStage();
    scheduleConvert();
  });

  bindRange('bright', 'bright', (v) => {
    $('brightVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('contrast', 'contrast', (v) => {
    $('contrastVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('dstr', 'ditherStr', (v) => {
    $('dstrVal').textContent = v + '%';
  }, () => scheduleConvert());

  bindRange('sat', 'sat', (v) => {
    $('satVal').textContent = v + '%';
  }, () => scheduleConvert());

  bindRange('expo', 'expo', (v) => {
    $('expoVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('ambi', 'ambi', (v) => {
    $('ambiVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('high', 'high', (v) => {
    $('highVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('shad', 'shad', (v) => {
    $('shadVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('temp', 'temp', (v) => {
    $('tempVal').textContent = String(v);
  }, () => scheduleConvert());

  bindRange('tint', 'tint', (v) => {
    $('tintVal').textContent = String(v);
  }, () => scheduleConvert());

  $('neutral').addEventListener('change', (e) => {
    S.neutral = e.target.checked;
    scheduleConvert();
  });

  bindRange('dehaze', 'dehaze', (v) => {
    $('dehazeVal').textContent = v + '%';
  }, () => scheduleConvert());

  bindRange('nstr', 'neutralStr', (v) => {
    $('nstrVal').textContent = v + '%';
  }, () => scheduleConvert());


  bindRange('wbstr', 'wbStr', (v) => {
    $('wbstrVal').textContent = v + '%';
  }, () => {
    applyPanelWB(S.wbStr);
    LUT_CACHE.clear(); EXACT_CACHE.clear(); NEUTRAL_CACHE.clear();
    if (S.img) convert();
  });

  $('paperSim').addEventListener('change', (e) => {
    S.paperSim = e.target.checked;
    drawPreview();
  });

  $('skyBlue').addEventListener('change', (e) => {
    S.skyBlue = e.target.checked;
    LUT_CACHE.clear(); NEUTRAL_CACHE.clear();
    if (S.img) convert();
  });

  $('hsvMode').addEventListener('change', (e) => {
    S.hsv = e.target.checked;
    LUT_CACHE.clear(); NEUTRAL_CACHE.clear();
    if (S.img) convert();
  });

  bindRange('cool', 'cool', (v) => {
    $('coolVal').textContent = v + '%';
  }, () => {
    LUT_CACHE.clear(); NEUTRAL_CACHE.clear();
    if (S.img) convert();
  });

  $('zoom').addEventListener('input', () => {
    S.zoom = Number($('zoom').value);
    $('zoomVal').textContent = Math.round(S.zoom * 100) + '%';
    renderStage();
    scheduleConvert();
  });

  $('zoomIn').addEventListener('click', () => {
    S.zoom = clamp(S.zoom * 1.15, 0.2, 6);
    syncZoomUI();
    renderStage();
    scheduleConvert();
  });

  $('zoomOut').addEventListener('click', () => {
    S.zoom = clamp(S.zoom / 1.15, 0.2, 6);
    syncZoomUI();
    renderStage();
    scheduleConvert();
  });

  $('fitBtn').addEventListener('click', () => {
    S.zoom = 1;
    S.tx = 0;
    S.ty = 0;
    syncZoomUI();
    renderStage();
    scheduleConvert();
  });

  $('resetBtn').addEventListener('click', () => {
    S.rot = 0;
    S.bright = 0;
    S.contrast = 0;
    S.zoom = 1;
    S.tx = 0;
    S.ty = 0;
    $('rotate').value = '0';
    $('rotateVal').textContent = '0°';
    $('bright').value = '0';
    $('brightVal').textContent = '0';
    $('contrast').value = '0';
    $('contrastVal').textContent = '0';
    syncZoomUI();
    renderStage();
    scheduleConvert();
    log('已复位视图与参数');
  });

  function rotateBy(d) {
    let v = S.rot + d;
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    S.rot = v;
    $('rotate').value = String(v);
    $('rotateVal').textContent = v + '°';
    renderStage();
    scheduleConvert();
  }
  $('rotL').addEventListener('click', () => rotateBy(-90));
  $('rotR').addEventListener('click', () => rotateBy(90));

  $('dlBtn').addEventListener('click', () => {
    if (!S.packed) return;
    const { w, h } = targetSize();
    const blob = new Blob([S.packed], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'epd_' + w + 'x' + h + '_' + S.mode + '_4bpp.bin';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    log('已导出 ' + a.download + '（' + S.packed.length + ' 字节）', 'ok');
  });

  /* ============================ 蓝牙 ============================ */
  const SERVICE_UUID = 0xffe0;
  const CHAR_WRITE = 0xffe1;
  const CHAR_WRITE_2 = 0xffe3;
  const CHAR_NOTIFY = 0xffe4;
  const NAME_PREFIX = 'EPD-CH584';

  const NTF_STATE = 0xb0;
  const NTF_MTU = 0xb1;
  const NTF_PROGRESS = 0xb2;
  const ST = { IDLE: 0, ARMED: 1, REFRESHING: 2, DONE: 3, ERROR: 4, RETRY: 5, OTA_READY: 6, OTA_DONE: 7 };

  let gMtu = 23;
  const NTF_VER = 0xb3;      /* 固件版本通知（v27 起） */
  const NTF_UIN = 0xb5;      /* NFC 名片：0xB5 + 结果码 + 号码 */
  const NTF_PROBE = 0xb7;     /* 面板自检：0xB7 + 5 字节 */
  const NTF_PWR = 0xb6;      /* 电池：0xB6 + mV(2LE) + 百分比 + 标志(1) */
  let gBattTimer = 0;        /* 连上后每 60 s 问一次电量 */
  let gOtaPhase = 0;         /* 1 = 正在提交并等待重启 */
  let gOtaDevice = null;     /* OTA 期间保留 device 以便自动重连 */
  let gDiscWaiters = [];     /* 断链事件 -> promise */
  let gOtaPct = 0;        /* 协商前按最小 ATT_MTU 算 */
  let gState = ST.IDLE;
  let gStateSeq = 0;    /* 每收到一次状态通知 +1，用来避免"状态还是上一次的"误判 */
let gFwOld = false;   /* 连上后 3 秒一条通知都没有 → 板子里是旧固件（无传图协议） */
  let gWaiter = null;
  let gLastNotiMs = Date.now();  /* 最近一次收到任何通知的时刻，做"设备还活着"的看门狗 */
  let gPhase = 0;                /* 设备回报的面板阶段号（刷屏心跳携带） */
  let gPhaseLogged = -1;         /* 已经写进日志的阶段号，避免每秒刷屏 */
  let gHbLog = 0;                /* 上次写"仍在某阶段"日志的时刻 */
  let gHbT0 = 0;                 /* 进入当前阶段的时刻 */
  let gNotiCount = 0;            /* 收到通知的总条数（任何类型），用来判断'设备到底有没有在说话' */
  let gDevUp = -1;               /* 设备最近一次上报的运行秒数 */
  let gDevUpPrev = -1;
  let gParamKey = '';            /* MTU/参数去重 */
  let gJustOta = false;          /* 刚做完 OTA，重启属正常 */           /* 上一次连接的运行秒数，用来判断设备是否复位过 */

  /* 面板阶段号 → 中文（与固件 panel.h 的 P_xxx 一一对应） */
  const PHASE_NAME = ['空闲', '面板上电', '载入波形1', '写色相平面', '升压 PON',
    '刷新相1', '载入波形2', '刷新相2', '载入波形3', '写明度平面', '刷新相3', '掉电 POF'];

  function phaseName(p) {
    return PHASE_NAME[p] || ('阶段' + p);
  }

  function stateName(s) {
    switch (s) {
      case ST.ARMED: return '可以发数据';
      case ST.REFRESHING: return '刷新中';
      case ST.DONE: return '完成';
      case ST.ERROR: return '出错';
      case ST.RETRY: return '校验失败需重发';
      case ST.OTA_READY: return '可以发固件';
      case ST.OTA_DONE: return '固件已收齐';
      default: return '空闲';
    }
  }

  /* 电池显示：电压 mV + 百分比（固件实测 PA7 分压，满 4200 / 空 3550） */
  function updateBatt(mv, pct) {
    const box = $('battBadge');
    if (!box) return;
    box.hidden = false;
    const v = (mv / 1000).toFixed(2);
    $('battText').textContent = v + ' V · ' + pct + '%';
    const fill = $('battFill');
    if (fill) {
      fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      fill.className = pct <= 5 ? 'crit' : (pct <= 20 ? 'low' : 'ok');
    }
    box.title = '电池 ' + mv + ' mV（' + pct + '%）· 低于 3600 mV 会进入断电保护';
    box.className = 'batt' + (mv < 3600 ? ' danger' : (pct <= 20 ? ' low' : ''));
  }

  function askBatt() {
    if (!S.connected || !S.ch) return;
    try {
      const p = S.ch.writeValue(new Uint8Array([0x62]));  /* 'b' */
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 老固件不认识，忽略 */ }
  }

  function askVer() {
    if (!S.connected || !S.ch) return;
    try {
      const p = S.ch.writeValue(new Uint8Array([0x56]));  /* 'V' 查询固件版本 */
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 老固件不认识，忽略 */ }
  }

  function startBattPoll() {
    if (gBattTimer) return;
    askVer();
    askBatt();
    gBattTimer = setInterval(askBatt, 60000);
  }

  function stopBattPoll() {
    if (gBattTimer) { clearInterval(gBattTimer); gBattTimer = 0; }
    const box = $('battBadge');
    if (box) { box.hidden = true; }
  }

  /* 状态落地：真正的 0xB0 通知和刷新心跳里捎带的状态都走这里。
     相同状态不重复计，否则补发的 ARMED 会让 waitAny 提前返回。 */
  function applyState(st) {
    if (st === gState) return;
    gState = st;
    gStateSeq++;
    log('设备状态 → ' + stateName(gState), gState === ST.ERROR ? 'err' : 'ok');
    if (gWaiter && gStateSeq > gWaiter.mark && gWaiter.list.indexOf(gState) >= 0) {
      const w = gWaiter;
      gWaiter = null;
      clearInterval(w.timer);
      w.resolve(gState);
    }
  }

  function onNotify(ev) {
    const dv = ev.target.value;
    const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    if (!b.length) return;
    gLastNotiMs = Date.now();
    gNotiCount++;
    /* 只要收到任何通知，就推翻“旧固件”的判断（之前只是还没来得及上报） */
    if (gFwOld) {
      gFwOld = false;
      $('bleHint').textContent = '';
      log('设备开始正常上报，固件是新版，之前那次提示忽略。', 'ok');
    }
    if (b[0] === NTF_MTU) {
      gMtu = b[1] | (b[2] << 8);
      if (b.length >= 9) {
        const intv = (b[3] | (b[4] << 8)) * 1.25;
        const tmo = (b[5] | (b[6] << 8)) / 100;
        const up = b[7] | (b[8] << 8);
        const key = gMtu + '/' + intv.toFixed(1) + '/' + tmo.toFixed(1);
        if (key !== gParamKey) {
          gParamKey = key;
          log('协商 MTU = ' + gMtu + '，单次写入上限 ' + Math.max(1, Math.min(509, gMtu - 3)) + ' 字节', 'ok');
          log('连接参数：间隔 ' + intv.toFixed(1) + ' ms · 监督超时 ' + tmo.toFixed(1) + ' s',
            intv > 60 ? 'warn' : 'ok');
        }
        if (intv > 60) {
          log('间隔还是偏大（每包要等 ' + intv.toFixed(0) + ' ms），172800 字节会传很久；' +
            '页面已请求 15 ms，若一直不生效是手机没批准。', 'warn');
        }
        if (gDevUpPrev >= 0 && up + 3 < gDevUpPrev) {
          if (gJustOta) {
            log('设备已重启（OTA 后的正常重启），新运行 ' + up + ' 秒。', 'ok');
            gJustOta = false;
          } else {
            log('⚠ 设备重启过：上次连到这里时已运行 ' + gDevUpPrev + ' 秒，这次只有 ' + up +
              ' 秒 —— 说明上次刷屏时板子掉电/复位了。', 'err');
          }
        }
        gDevUp = up;
        setFoot('设备在线 ' + up + ' 秒');
      }
      if (gMtu <= 23) {
        log('警告：MTU 只有 23，传一张图会非常慢。换一台手机或重连一次通常能协商到 247。', 'warn');
      }
      return;
    }
    if (b[0] === NTF_VER) {
      let v = '';
      for (let i = 1; i < b.length; i++) v += String.fromCharCode(b[i]);
      log('设备固件版本：' + v, 'ok');
      setFoot('固件 ' + v);
      return;
    }
    if (b[0] === 0xb8) {
      log('设备已收到自检命令，正在测量（约 15 秒）…');
      return;
    }
    if (b[0] === NTF_PROBE) {
      const hx = Array.from(b).map((v) => v.toString(16).padStart(2, '0')).join(' ');
      log('面板自检 raw (' + b.length + '): ' + hx);
      if (b.length >= 6) {
        log('  解读：复位前 BUSY=' + b[1] + ' · 复位后=' + b[2] + ' · soft-start 反应=' + b[3]
          + ' · PON 反应=' + b[4] + ' · 结束 BUSY=' + b[5]);
      }
      return;
    }
    if (b[0] === NTF_UIN) {
      const STXT = { 0: '已写入', 1: '口令错误', 2: '号码不合法', 3: '写 Flash 失败', 4: '设备忙，请稍后重试', 0x20: '当前号码' };
      let u = '';
      for (let i = 2; i < b.length; i++) u += String.fromCharCode(b[i]);
      const ok = (b[1] === 0 || b[1] === 0x20);
      const msg = (STXT[b[1]] || ('状态 ' + b[1])) + (u ? '：' + u : '');
      nfcStatus('设备回报 · ' + msg, !ok);
      log('NFC 名片 · ' + msg, ok ? 'ok' : 'err');
      if (u) { const inp = $('nfcUin'); if (inp) inp.value = u; }
      return;
    }

    if (b[0] === NTF_PWR) {
      if (b.length >= 4) {
        const mv = b[1] | (b[2] << 8);
        updateBatt(mv, b[3]);
      }
      return;
    }

    if (b[0] === NTF_STATE) {
      applyState(b[1]);
      return;
    }
    if (b[0] === NTF_PROGRESS) {
      if (b[1] === 0xff) {
        if (b.length >= 4) applyState(b[3]);   /* v49：心跳里带状态 */
        /* 刷屏心跳：面板还在动，告诉用户现在进行到哪一相 */
        const p = b[2];
        const t = Date.now();
        gPhase = p;
        setFoot('屏幕刷新中：' + phaseName(p));
        if (p !== gPhaseLogged) {
          gPhaseLogged = p;
          gHbT0 = t;
          gHbLog = t;
          log('面板 · ' + phaseName(p), 'ok');
        } else if (p !== 0 && t - gHbLog > 15000) {
          gHbLog = t;
          log('面板仍在' + phaseName(p) + '（已 ' + Math.round((t - gHbT0) / 1000) + ' 秒）', 'warn');
        }
      } else if (b[1] === 0xee) {
        /* 固件升级的上传进度 */
        if (typeof setOtaProgress === 'function') setOtaProgress(b[2] / 100);
        setFoot('固件已收 ' + b[2] + '%');
      } else {
        setFoot('设备已收 ' + b[2] + '%');
      }
    }
  }

  /* 等到「mark 之后到达的、且属于 list 的」第一个状态通知。
     maxMs = 总超时；idleMs = 多久没收到任何通知才判定设备失联。
     刷屏时要等两三分钟，期间只有 1 s 一次的心跳，所以不能只看总时长。 */
  /* v60：面板就绪判定（不依赖状态"变化"）。
     上一张图结束时状态就是 ARMED，这张图结束时又是 ARMED，applyState 会去重，
     页面就永远等不到变化。改成看相位：固件在发出 ARMED 之前一定会把
     phase 置成 P_HIGH(3)，所以"相位离开 3 又回到 3"= 这一张图的面板真的就绪。 */
  function waitArmedFresh() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const TOTAL = 240000;
      const IDLE = 60000;
      let leftHigh = false;
      let done = false;
      const timer = setInterval(() => {
        if (done) return;
        const now = Date.now();
        if (gPhase !== 3) leftHigh = true;
        if (gState === ST.ERROR) { done = true; clearInterval(timer); resolve(ST.ERROR); return; }
        if (leftHigh && gPhase === 3 && gState === ST.ARMED) {
          done = true; clearInterval(timer); resolve(ST.ARMED); return;
        }
        if (now - t0 > TOTAL) {
          done = true; clearInterval(timer);
          reject(new Error('等面板就绪超时（' + Math.round(TOTAL / 1000) + ' 秒，当前相位：' +
            phaseName(gPhase) + '）'));
          return;
        }
        if (now - gLastNotiMs > IDLE) {
          done = true; clearInterval(timer);
          reject(new Error('设备 ' + Math.round(IDLE / 1000) + ' 秒没有任何上报'));
        }
      }, 200);
    });
  }

  function waitAny(mark, list, ms, idleMs) {
    return new Promise((resolve, reject) => {
      if (gStateSeq > mark && list.indexOf(gState) >= 0) { resolve(gState); return; }
      if (gWaiter) {
        clearInterval(gWaiter.timer);
        gWaiter.reject(new Error('被新的等待打断'));
        gWaiter = null;
      }
      const t0 = Date.now();
      const idle = idleMs || 30000;
      const timer = setInterval(() => {
        const now = Date.now();
        if (gStateSeq > mark && list.indexOf(gState) >= 0) {
          gWaiter = null;
          clearInterval(timer);
          resolve(gState);
          return;
        }
        if (now - t0 > ms) {
          gWaiter = null;
          clearInterval(timer);
          reject(new Error('等设备超时（总 ' + Math.round(ms / 1000) + ' 秒，当前：' +
            stateName(gState) + '）'));
          return;
        }
        if (now - gLastNotiMs > idle) {
          gWaiter = null;
          clearInterval(timer);
          reject(new Error('设备 ' + Math.round(idle / 1000) + ' 秒没有任何上报（当前：' +
            stateName(gState) + '），检查供电或距离'));
        }
      }, 200);
      gWaiter = { mark, list, resolve, reject, timer };
    });
  }

  function setStatus(state, text) {
    $('status').dataset.state = state;
    $('statusText').textContent = text;
  }

  function bleSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /* 粗略识别浏览器，只用来给提示，不做逻辑判断 */
  function uaKind() {
    const ua = navigator.userAgent;
    if (/MicroMessenger/i.test(ua)) return 'wechat';
    if (/Quark|UCBrowser/i.test(ua)) return 'uc';
    if (/MiuiBrowser|XiaoMi|Miui/i.test(ua)) return 'xiaomi';
    if (/HuaweiBrowser|HBPC/i.test(ua)) return 'huawei';
    if (/VivoBrowser/i.test(ua)) return 'vivo';
    if (/HeyTapBrowser|OppoBrowser/i.test(ua)) return 'oppo';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'ios';
    if (/Edg[A-Z]?\//i.test(ua)) return 'edge';
    if (/SamsungBrowser/i.test(ua)) return 'samsung';
    if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
    if (/Chrome\//i.test(ua)) return 'chrome';
    return 'other';
  }

  const UA_NAME = {
    wechat: '微信内置浏览器', uc: '夸克/UC', xiaomi: '小米浏览器', huawei: '华为浏览器',
    vivo: 'vivo 浏览器', oppo: 'OPPO 浏览器', ios: 'iOS Safari', edge: 'Edge',
    samsung: '三星浏览器', firefox: 'Firefox', chrome: 'Chrome', other: '当前浏览器'
  };

  function renderBleDiag() {
    const kind = uaKind();
    const secure = window.isSecureContext !== false;
    const hasApi = bleSupported();
    const parts = [
      '浏览器：' + (UA_NAME[kind] || '未知'),
      '安全上下文：' + (secure ? '是' : '否'),
      'Web Bluetooth：' + (hasApi ? '有' : '无')
    ];
    $('bleDiag').textContent = parts.join(' · ');
    if (!hasApi) $('copyLinkBtn').hidden = false;
  }

  function checkBleSupport() {
    renderBleDiag();
    if (bleSupported()) return true;

    $('connectBtn').disabled = true;
    const kind = uaKind();
    let tip;
    if (kind === 'ios') {
      tip = 'iOS 的 Safari / Chrome 都不支持 Web Bluetooth。请装 Bluefy 浏览器打开本页，或改用安卓 Chrome。';
    } else if (kind === 'wechat') {
      tip = '微信内置浏览器不支持 Web Bluetooth。请点右上角“…”→ 在浏览器打开，或复制链接到 Chrome / Edge。';
    } else if (kind === 'xiaomi' || kind === 'huawei' || kind === 'vivo' || kind === 'oppo' || kind === 'uc') {
      tip = '这个厂商浏览器没有开放 Web Bluetooth（这是浏览器的限制，不是页面问题）。请复制链接到 Chrome / Edge 打开。';
    } else if (location.protocol === 'file:') {
      tip = '当前是本地文件（file://），浏览器不给蓝牙权限。请用 https:// 或 http://localhost 打开。';
    } else if (!window.isSecureContext) {
      tip = '当前不是安全上下文（需要 https://），浏览器不给蓝牙权限。';
    } else {
      tip = '这个浏览器不支持 Web Bluetooth。请用 Chrome / Edge（桌面或安卓）。';
    }
    $('bleHint').textContent = tip;
    $('bleHint').style.color = 'var(--warn)';
    log(tip, 'warn');
    return false;
  }

  $('copyLinkBtn').addEventListener('click', async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      $('copyLinkBtn').textContent = '已复制：' + url;
    } catch (e) {
      $('copyLinkBtn').textContent = url;
      log('复制失败，手动长按复制：' + url, 'warn');
    }
  });

  const BLE_ERR = {
    NotAllowedError: '浏览器拒绝了蓝牙权限（可能被系统策略或浏览器设置禁止）',
    SecurityError: '不是安全上下文，浏览器不给蓝牙权限',
    NotSupportedError: '这个浏览器禁用了 Web Bluetooth',
    NotFoundError: '没有选到设备（可能取消了，或设备不在可见范围）',
    NetworkError: 'GATT 连接失败（设备可能已被手机系统或别的 App 占用）',
    InvalidStateError: '蓝牙适配器不可用，请确认手机蓝牙已打开',
    AbortError: '操作被取消'
  };

  /* 给不可取消的 Promise 套一个超时，至少能知道它卡在哪一步 */
  function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(label + ' 超过 ' + Math.round(ms / 1000) + ' 秒没有任何响应'));
      }, ms);
      Promise.resolve(p).then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
      );
    });
  }

  async function connectDevice() {
    log('[1/5] 点击收到，开始连接流程');
    if (!checkBleSupport()) { log('[1/5] 浏览器不支持，已停止'); return; }
    if (S.connected) { log('[1/5] 已处于连接状态，忽略'); return; }

    const useAll = $('allDevices').checked;
    const options = useAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE_UUID] };

    setStatus('scanning', '正在扫描…');
    setFoot('扫描中');
    $('connectBtn').disabled = true;

    try {
      log('[2/5] 调用 requestDevice（' + (useAll ? '全部设备' : '名字以 ' + NAME_PREFIX + ' 开头') + '）…');
      const t0 = performance.now();
      const device = await withTimeout(navigator.bluetooth.requestDevice(options), 20000, 'requestDevice');
      log('[3/5] 选中设备：' + (device.name || '(无名字)') + ' · ' + device.id +
        '（选择器用了 ' + Math.round(performance.now() - t0) + ' ms）');

      gOtaDevice = device;
      device.addEventListener('gattserverdisconnected', () => {
        const ota = (gOtaPhase === 1);

        S.connected = false;
        S.ch = null;
        S.server = null;
        $('disconnectBtn').disabled = true;
        $('sendBtn').disabled = true;
        $('otaBtn').disabled = true; $('otaSrvBtn').disabled = true;
        if (ota) {                    /* OTA 写完 Flash 后设备必然复位，这是正常步骤 */
          setStatus('scanning', '设备重启中');
          setFoot('设备重启中（OTA 正常步骤）');
          log('设备已断开——OTA 写 Flash 后自动重启，属于正常流程，正在等它回来…', 'ok');
        } else {
          /* 保留 device 引用：浏览器允许在用户已授权的设备上直接 gatt.connect() 重连 */
          autoReconnect(device);
          setStatus('idle', '已断开');
          $('deviceName').textContent = '未连接';
          $('connectBtn').disabled = false;
          setFoot('已断开');
          if (S.sending) {
            S.sending = false;
            log('传输中途断开了 —— 最常见原因是手机锁屏 / 切后台被系统限流，导致对端不再应答（设备直到 32 秒监督超时才发现）。请保持屏幕常亮，重新点「连接设备」后再发一次。', 'err');
          } else {
            log('设备已断开', 'warn');
          }
        }
        if (gDiscWaiters.length) {
          const ws = gDiscWaiters;
          gDiscWaiters = [];
          for (const f of ws) { try { f(); } catch (e) { /* ignore */ } }
        }
      });

      log('[4/5] 连接 GATT…');
      const server = await withTimeout(device.gatt.connect(), 20000, 'gatt.connect');
      log('[4/5] GATT 已连接，取服务 0x' + SERVICE_UUID.toString(16).toUpperCase() + '…');
      const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), 15000, 'getPrimaryService');

      let ch = null;
      try {
        ch = await service.getCharacteristic(CHAR_WRITE);
        log('使用可写特征 0x' + CHAR_WRITE.toString(16).toUpperCase(), 'ok');
      } catch (e) {
        log('0xFFE1 取不到，改用 0xFFE3…', 'warn');
        ch = await service.getCharacteristic(CHAR_WRITE_2);
        log('使用可写特征 0x' + CHAR_WRITE_2.toString(16).toUpperCase(), 'ok');
      }

      /* 0xFFE4 是状态/进度通知口，订阅后能拿到 MTU 与设备状态 */
      let subscribed = false;
      try {
        const chN = await service.getCharacteristic(CHAR_NOTIFY);
        await chN.startNotifications();
        chN.addEventListener('characteristicvaluechanged', onNotify);
        log('已订阅状态通知 0xFFE4', 'ok');
        subscribed = true;
      } catch (e) {
        log('订阅 0xFFE4 失败（不影响发文本）：' + (e && e.message ? e.message : e), 'warn');
      }

      /* v7 起的固件一连接就会主动上报一次 MTU；收不到说明板子里跑的是旧固件 */
      if (subscribed) {
        const notiBefore = gNotiCount;
        setTimeout(() => {
          if (!S.connected || gNotiCount !== notiBefore) return;
          gFwOld = true;
          log('设备 8 秒内一条通知都没有——板子里是旧固件或根本没连上（新版一连接就会报 MTU）。', 'err');
          log('请先烧 firmware_ble_epd\\build\\ble_epd.hex（v7/v8），再用传图。', 'err');
          $('bleHint').textContent =
            '连上了，但设备没有回应。板子里应该是旧固件（只会显示文本）。' +
            '请先烧 v7/v8 固件，否则传图一定会卡在“等设备”。';
          $('bleHint').style.color = 'var(--warn)';
        }, 8000);
      }

      /* 主动问一次 MTU：v10 起固件支持 'M' 命令直接回 NTF_MTU。
         第一次会话就是没收到"连上推送"的 MTU，整张图按 19 字节分包，比 243 慢 16 倍。 */
      if (subscribed) {
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            if (!S.connected || !S.ch || gMtu > 23) return;
            try {
              const p = S.ch.writeValue(new Uint8Array([0x4d]));  /* 'M' */
              if (p && p.catch) p.catch(() => {});
            } catch (e) { /* 老固件不认识 'M'，会当文本收下，无副作用 */ }
          }, 400 + i * 500);
        }
      }

      S.device = device;
      S.server = server;
      S.ch = ch;
      S.connected = true;
      gState = ST.IDLE;
      gFwOld = false;
      gDevUpPrev = gDevUp;
      gDevUp = -1;

      const nm = device.name || '(无名字)';
      setStatus('connected', nm);
      $('deviceName').textContent = nm + ' · 已连接';
      $('disconnectBtn').disabled = false;
      $('connectBtn').disabled = false;
      $('sendBtn').disabled = false;
      $('sendImgBtn').disabled = !S.indices;
      $('otaBtn').disabled = false; $('otaSrvBtn').disabled = false;
      setFoot('已连接');
      log('[5/5] 设备就绪：' + nm, 'ok');
      startBattPoll();
      keepAwake();
    } catch (e) {
      const ename = (e && e.name) || '';
      const msg = e && e.message ? e.message : String(e);
      setStatus('error', '连接失败');
      $('connectBtn').disabled = false;
      setFoot('连接失败');
      log('连接失败：' + (ename ? ename + ' · ' : '') + msg, 'err');
      const platformUnsupported = /not supported on this platform/i.test(msg);
      if (!platformUnsupported && BLE_ERR[ename]) log('原因：' + BLE_ERR[ename], 'err');
      /* 小米/华为/UC 等厂商浏览器保留了 navigator.bluetooth 这个空壳对象，
         但底层平台没有实现，requestDevice 会直接抛 Chromium 的这句原文。
         这跟“没选到设备”是两回事，必须单独说清楚，否则会一直白试。 */
      if (/not supported on this platform/i.test(msg)) {
        log('这不是没选到设备：当前浏览器只有 Web Bluetooth 的“空壳 API”，底层没实现。', 'err');
        log('安卓请用 Chrome 或 Edge 打开本页；iPhone 请用 Bluefy 浏览器。', 'err');
        $('copyLinkBtn').hidden = false;
        $('bleHint').innerHTML = '当前浏览器（' + (UA_NAME[uaKind()] || '未知') +
          '）没有实现 Web Bluetooth，只有一个空的 API 壳子，网页层面绕不过去。<br>' +
          '安卓：复制链接到 <b>Chrome</b> / <b>Edge</b> 打开；iPhone：用 <b>Bluefy</b>。';
        $('bleHint').style.color = 'var(--warn)';
        renderBleDiag();
        setStatus('idle', '未连接');
        return;
      }
      if (/user cancelled|User cancelled|NotFound/i.test(msg + ' ' + ename)) {
        log('已取消选择设备；若列表里没有设备，勾选“列出所有设备”再试', 'warn');
        setStatus('idle', '未连接');
        return;
      }
      $('copyLinkBtn').hidden = false;
      $('bleHint').textContent = '连接失败：' +
        (BLE_ERR[ename] || msg) + '。如果换成 Chrome / Edge 仍然失败，把上面日志里这一行发我。';
      $('bleHint').style.color = 'var(--warn)';
      renderBleDiag();
    }
  }

  /* ---------------- 断线自动重连 ----------------
     目标：面板刷新期间如果链路被监督超时踢掉，页面自己把连接抢回来，
     不需要用户再点一次「连接设备」。不改变任何图像协议。 */
  let gReconnecting = false;
  let gUserDisconnect = false;

  function autoReconnect(device) {
    if (gReconnecting || gUserDisconnect || !device || !device.gatt) return;
    gReconnecting = true;
    (async () => {
      try {
        for (let i = 0; i < 20; i++) {
          if (S.connected || gUserDisconnect) return;
          await new Promise((r) => setTimeout(r, 1500));
          if (S.connected || gUserDisconnect) return;
          try {
            setStatus('scanning', '重连中 ' + (i + 1) + '/20');
            const server = await withTimeout(device.gatt.connect(), 8000, 'reconnect');
            const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), 10000, 'svc');
            let ch = null;
            try { ch = await service.getCharacteristic(CHAR_WRITE); }
            catch (_) { ch = await service.getCharacteristic(CHAR_WRITE_2); }
            try {
              const chN = await service.getCharacteristic(CHAR_NOTIFY);
              await chN.startNotifications();
              chN.addEventListener('characteristicvaluechanged', onNotify);
            } catch (_) { /* 通知打不开也允许重连成功 */ }
            S.device = device;
            S.server = server;
            S.ch = ch;
            S.connected = true;
            gState = ST.IDLE;
            gFwOld = false;
            const nm = device.name || '(未命名)';
            setStatus('connected', nm);
            $('deviceName').textContent = nm + ' · 已连接';
            $('disconnectBtn').disabled = false;
            $('connectBtn').disabled = false;
            $('sendBtn').disabled = false;
            $('sendImgBtn').disabled = !S.indices;
            $('otaBtn').disabled = false; $('otaSrvBtn').disabled = false;
            setFoot('已连接');
            log('已自动重连（第 ' + (i + 1) + ' 次尝试成功）', 'ok');
            keepAwake();
            return;
          } catch (_) { /* 继续重试 */ }
        }
        log('自动重连 20 次都没成功，请点「连接设备」重新连一次', 'err');
        setStatus('idle', '未连接');
      } finally {
        gReconnecting = false;
      }
    })();
  }


  /* ---------------- 屏幕常亮 ----------------
     64 色一次刷新要 2~4 分钟，期间页面没有任何操作。Android 默认 30~60 秒
     就熄屏，熄屏后浏览器会把 BLE 连接挂起甚至断掉 —— 这就是"传完图、屏还没
     刷完就掉线"的最主要原因。这里用 Wake Lock API 把屏幕钉住。 */
  let gWake = null;
  async function keepAwake() {
    try {
      if (!('wakeLock' in navigator)) return;
      if (gWake && !gWake.released) return;
      gWake = await navigator.wakeLock.request('screen');
      gWake.addEventListener('release', () => { gWake = null; });
      log('已开启屏幕常亮（传输期间请勿锁屏 / 切后台）', 'ok');
    } catch (e) {
      log('屏幕常亮申请失败（不影响传输）：' + (e && e.message ? e.message : e), 'warn');
    }
  }
  function releaseAwake() {
    try { if (gWake) { const w = gWake; gWake = null; w.release(); } } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (S.connected) keepAwake();
    } else if (S.connected) {
      log('页面切到后台了——部分手机会挂起蓝牙连接，建议保持本页在前台', 'warn');
    }
  });

  function disconnectDevice() {
    gUserDisconnect = true;
    if (S.device && S.device.gatt && S.device.gatt.connected) {
      S.device.gatt.disconnect();
      log('主动断开');
    }
  }

  $('connectBtn').addEventListener('click', connectDevice);
  $('disconnectBtn').addEventListener('click', disconnectDevice);

  $('allDevices').addEventListener('change', () => {
    log($('allDevices').checked ? '改为列出全部设备' : '改为按名字前缀过滤');
  });

  /* ---------------- NFC 名片（QQ 资料卡） ----------------
     网页改号码：'Q' + 口令(4) + 号码；查询：'q'。设备回 0xB5 + 结果码 + 当前号码。 */
  function nfcStatus(msg, bad) {
    const h = $('nfcHint');
    if (h) { h.textContent = msg; h.style.color = bad ? '#f87171' : ''; }
  }

  async function nfcQuery() {
    if (!S.connected || !S.ch) {
      nfcStatus('还没连接设备：请先点上面「蓝牙」里的「连接设备」', true);
      log('NFC 名片：未连接设备', 'err');
      return;
    }
    try {
      await writeChunk(S.ch, new Uint8Array([0x71]));   /* 'q' */
      nfcStatus('已请求设备回报当前号码…');
    } catch (e) {
      nfcStatus('发送失败：' + (e && e.message ? e.message : e), true);
    }
  }

  async function nfcWrite() {
    if (!S.connected || !S.ch) {
      nfcStatus('还没连接设备：请先点上面「蓝牙」里的「连接设备」', true);
      log('NFC 名片：未连接设备', 'err');
      return;
    }
    const uin = (($('nfcUin') && $('nfcUin').value) || '').trim();
    const pass = (($('nfcPass') && $('nfcPass').value) || '').trim();
    if (!/^\d{5,12}$/.test(uin)) { nfcStatus('QQ 号必须是 5–12 位纯数字', true); return; }
    if (!/^\d{4}$/.test(pass)) { nfcStatus('口令必须是 4 位数字', true); return; }

    const bytes = new Uint8Array(1 + 4 + uin.length);
    bytes[0] = 0x51;                                   /* 'Q' */
    for (let i = 0; i < 4; i++) bytes[1 + i] = pass.charCodeAt(i);
    for (let i = 0; i < uin.length; i++) bytes[5 + i] = uin.charCodeAt(i);

    try {
      await writeChunk(S.ch, bytes);
      nfcStatus('已发送（' + uin + '），等待设备回报…');
      log('NFC 名片：写入 ' + uin);
    } catch (e) {
      nfcStatus('发送失败：' + (e && e.message ? e.message : e), true);
    }
  }

  {
    const w = $('nfcWriteBtn');
    const r = $('nfcReadBtn');
    const pp = $('panelProbeBtn');
    if (w) w.addEventListener('click', nfcWrite);
    if (r) r.addEventListener('click', nfcQuery);
    if (pp) {
      pp.addEventListener('click', async () => {
        if (!S.connected || !S.ch) { log('面板自检：还没连接设备', 'err'); return; }
        try {
          log('面板自检：已发送，等设备回报…');
          await writeChunk(S.ch, new Uint8Array([0x70]));
        } catch (e) {
          log('面板自检发送失败：' + (e && e.message ? e.message : e), 'err');
        }
      });
    }
  }

  /* ============================ 发送 ============================ */
  const CHUNK = 20;

  function setProgress(p) {
    const box = $('progress');
    box.hidden = p <= 0;
    $('progressBar').style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
  }

  async function writeChunk(ch, part) {
    if (typeof ch.writeValueWithoutResponse === 'function') {
      try {
        await ch.writeValueWithoutResponse(part);
        return;
      } catch (_) {
        /* 落到 writeValue */
      }
    }
    await ch.writeValue(part);
  }

  async function sendText() {
    if (!S.connected || !S.ch) {
      log('还没连接设备', 'err');
      return;
    }
    const text = ($('payload').value || '').slice(0, 100);
    if (!text.length) {
      log('文本为空', 'err');
      return;
    }
    const bytes = new TextEncoder().encode('T' + text);
    const total = Math.ceil(bytes.length / CHUNK);
    log('发送 ' + bytes.length + ' 字节 / ' + total + ' 包：' + text);
    $('sendBtn').disabled = true;
    setFoot('发送中');
    try {
      for (let i = 0; i < total; i++) {
        const part = bytes.slice(i * CHUNK, (i + 1) * CHUNK);
        await writeChunk(S.ch, part);
        setProgress((i + 1) / total);
        await sleep(30);
      }
      log('发送完成，屏幕大约 1~2 秒后开始刷新（整屏约 70 秒）', 'ok');
      setFoot('发送完成');
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      log('发送失败：' + msg, 'err');
      setFoot('发送失败');
    } finally {
      setTimeout(() => setProgress(0), 900);
      $('sendBtn').disabled = false;
    }
  }

  $('sendBtn').addEventListener('click', sendText);

  /* ------------------------ 图像传输 ------------------------ */
  /* 协议：'I' <mode> → 等 ARMED → 平面0('D'…, 'E') → 等 ARMED
           → 平面1('D'…, 'E') → 等 DONE
     每个像素 4bit，平面字节高 nibble = 左像素。 */
  async function writeOne(bytes) {
    const part = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await writeChunk(S.ch, part);
  }

  /* CRC32（和固件同一张 nibble 表，poly 0xEDB88320 反射） */
  const CRC_NIB = new Uint32Array([
    0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac,
    0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
    0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c,
    0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c
  ]);

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc ^ bytes[i]) >>> 0;
      crc = ((crc >>> 4) ^ CRC_NIB[crc & 15]) >>> 0;
      crc = ((crc >>> 4) ^ CRC_NIB[crc & 15]) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function sendPlane(data, planeNo) {
    const step = Math.max(1, Math.min(509, gMtu - 3) - 1);
    const chunks = Math.ceil(data.length / step);
    const t0 = performance.now();
    const part = new Uint8Array(step + 1);
    part[0] = 0x44;                    /* 'D' */
    let sent = 0;

    log('平面 ' + planeNo + '：' + data.length + ' 字节 / ' + chunks + ' 包 × ' + step + ' 字节');
    for (let i = 0; i < chunks; i++) {
      const off = i * step;
      const n = Math.min(step, data.length - off);
      let buf;
      if (n === step) {
        part.set(data.subarray(off, off + n), 1);
        buf = part;
      } else {
        buf = new Uint8Array(n + 1);
        buf[0] = 0x44;
        buf.set(data.subarray(off, off + n), 1);
      }
      await writeOne(buf);             /* 全速推，不再人为 sleep */
      sent += n;
      if ((i & 63) === 63) {
        setProgress(sent / data.length);
        const el = (performance.now() - t0) / 1000;
        if (el > 0.3) {
          setFoot('平面 ' + planeNo + ' ' + Math.round((sent / data.length) * 100) +
            '% · ' + (sent / 1024 / el).toFixed(1) + ' KB/s');
        }
      }
    }

    const crc = crc32(data);
    const tail = new Uint8Array(5);
    tail[0] = 0x43;                    /* 'C' + CRC32(LE) */
    tail[1] = crc & 0xff;
    tail[2] = (crc >>> 8) & 0xff;
    tail[3] = (crc >>> 16) & 0xff;
    tail[4] = (crc >>> 24) & 0xff;
    await writeOne(tail);

    setProgress(1);
    const el2 = (performance.now() - t0) / 1000;
    log('平面 ' + planeNo + ' 发完：' + el2.toFixed(2) + ' 秒 · ' +
      (data.length / 1024 / Math.max(0.1, el2)).toFixed(1) + ' KB/s · CRC ' +
      ('0000000' + crc.toString(16)).slice(-8), 'ok');
  }

  async function sendPlaneWithRetry(data, planeNo, maxTry) {
    for (let attempt = 1; attempt <= maxTry; attempt++) {
      const mark = gStateSeq;
      await sendPlane(data, planeNo);
      const st = await waitAny(mark, [ST.ARMED, ST.DONE, ST.RETRY, ST.ERROR], 600000, 120000);
      if (st === ST.RETRY) {
        log('平面 ' + planeNo + ' 校验不一致，重发（第 ' + attempt + ' 次重试）', 'warn');
        continue;
      }
      return st;
    }
    throw new Error('平面 ' + planeNo + ' 重发 ' + maxTry + ' 次仍校验失败');
  }

  async function sendImage() {
    /* v86w：上一张还在传时不许开第二路。
       两路并发会把固件的阶段机打乱（日志里出现过两个流程同时发平面 1、
       阶段号在 写色相平面/写明度平面/刷新相 之间乱跳）。 */
    if (S.sending) {
      log('上一张还在传输中，等它结束再发（并发会把面板状态机打乱）', 'warn');
      return;
    }
    keepAwake();
    S.sending = true;
    log('开始传输：约需 2~4 分钟，请保持手机屏幕常亮、不要切后台或锁屏（锁屏会断蓝牙）', 'ok');
    if (!S.connected || !S.ch) {
      S.sending = false;
      log('还没连接设备', 'err');
      return;
    }
    if (!S.indices) {
      S.sending = false;
      log('还没有图片', 'err');
      return;
    }
    const { w, h } = targetSize();
    if (w !== 720 || h !== 480) {
      log('内部错误：画布必须是 720×480，当前 ' + w + '×' + h +
          '（固件按 360 字节/行读取，尺寸不符会撕裂画面）', 'err');
      S.sending = false;
      return;
    }
    const mode = MODES[S.mode];
    const code = mode.code;
    const N = w * h;
    const plane0 = new Uint8Array(N >> 1);
    const plane1 = new Uint8Array(N >> 1);

    for (let i = 0; i < plane0.length; i++) {
      const a = code[S.indices[i * 2]];
      const b = code[S.indices[i * 2 + 1]];
      plane0[i] = ((a >> 3) << 4) | (b >> 3);       /* 色相平面 */
      plane1[i] = ((a & 7) << 4) | (b & 7);         /* 明度平面 */
    }

    /* 6 色 / 黑白是单平面单相波形，比 64 色快约三倍。
       这两种模式不用色相/明度拆分，直接把面板色号塞进高半字节。 */
    let planes = [plane0, plane1];
    if (mode.nib) {
      const single = new Uint8Array(N >> 1);
      for (let i = 0; i < single.length; i++) {
        const a = mode.nib[S.indices[i * 2]];
        const b = mode.nib[S.indices[i * 2 + 1]];
        single[i] = (a << 4) | b;
      }
      planes = [single];
    }

    $('sendImgBtn').disabled = true;
    $('sendBtn').disabled = true;
    setFoot('开始传图');
    setProgress(0.001);
    const tAll = performance.now();

    try {
      log('传图开始：' + w + '×' + h + ' · ' + S.mode + ' · ' +
        planes.length + ' 个平面 × ' + planes[0].length + ' 字节');

      const markNoti = gNotiCount;
      await writeOne([0x49, mode.fwMode]); /* 'I' + 模式（0=64色两平面 1=六色 2=黑白） */
      setFoot('等面板启动…');
      let st;
      try {
        st = await waitArmedFresh();
      } catch (e) {
        throw new Error(gFwOld || gNotiCount === markNoti
          ? '设备没有任何回应——板子里是旧固件（只支持显示文本）'
          : '面板没有就绪：' + (e && e.message ? e.message : e));
      }
      if (st !== ST.ARMED) throw new Error('面板启动失败（状态 ' + stateName(st) + '）');

      for (let p = 0; p < planes.length; p++) {
        const last = (p === planes.length - 1);

        setFoot('发送第 ' + (p + 1) + '/' + planes.length + ' 个平面…');
        st = await sendPlaneWithRetry(planes[p], p + 1, 3);
        if (last) {
          if (st !== ST.DONE) throw new Error('刷屏失败：' + stateName(st));
        } else {
          if (st !== ST.ARMED) throw new Error('第一平面后状态异常：' + stateName(st));
          setFoot('第一平面完成，等第二相（屏幕会刷新约 2 分钟）…');
        }
      }

      log('整屏刷新完成，总用时 ' + ((performance.now() - tAll) / 1000).toFixed(1) + ' 秒', 'ok');
      setFoot('图像已上屏');
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      log('传图失败：' + msg, 'err');
      setFoot('传图失败');
    } finally {
      S.sending = false;
      setTimeout(() => setProgress(0), 800);
      $('sendImgBtn').disabled = !S.indices;
      $('sendBtn').disabled = !S.connected;
    }
  }

  $('sendImgBtn').addEventListener('click', sendImage);

  const calibBtn = $('calibBtn');
  if (calibBtn) calibBtn.addEventListener('click', buildCalibCard);

  /* ============================ OTA 固件升级 ============================ */
  function setOtaProgress(p) {
    $('otaProgress').hidden = false;
    $('otaBar').style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%';
  }

  

  async function otaFromServer() {
  /* 不用部署固件文件：直接从站点下载 fw/ble_epd.bin 再走同一条 OTA 流程 */
  try {
    log('正在从服务器下载最新固件…');
    const vt = await fetch('fw/version.txt', { cache: 'no-store' })
      .then(r => (r.ok ? r.text() : '')).catch(() => '');
    const res = await fetch('fw/ble_epd.bin', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'ble_epd.bin', { type: 'application/octet-stream' }));
    $('fwFile').files = dt.files;
    log('已获取固件 ' + blob.size + ' 字节' +
      (vt ? ' · ' + vt.trim() : '') + '，开始升级…');
    await otaUpdate();
  } catch (e) {
    log('从服务器获取固件失败：' + (e && e.message ? e.message : e), 'err');
  }
}

async function otaUpdate() {
    const inp = $('fwFile');

    if (!S.connected || !S.ch) { log('还没连接设备', 'err'); return; }
    if (!inp.files || !inp.files.length) { log('先选一个 .bin 固件文件', 'err'); return; }

    const file = inp.files[0];
    const buf = new Uint8Array(await file.arrayBuffer());

    if (buf.length < 1024 || buf.length > 194560) {
      log('固件大小不对：' + buf.length + ' 字节（应在 1 KB ~ 190 KB）', 'err');
      return;
    }

    const crc = crc32(buf);
    log('固件 ' + file.name + '：' + buf.length + ' 字节 · CRC ' +
      ('0000000' + crc.toString(16)).slice(-8));

    $('otaBtn').disabled = true; $('otaSrvBtn').disabled = true;
    $('sendBtn').disabled = true;
    $('sendImgBtn').disabled = true;
    setOtaProgress(0.001);

    try {
      const head = new Uint8Array(9);
      let mark = gStateSeq;

      head[0] = 0x4f;                                   /* 'O' + 长度(4) + CRC(4) */
      head[1] = buf.length & 0xff;
      head[2] = (buf.length >>> 8) & 0xff;
      head[3] = (buf.length >>> 16) & 0xff;
      head[4] = (buf.length >>> 24) & 0xff;
      head[5] = crc & 0xff;
      head[6] = (crc >>> 8) & 0xff;
      head[7] = (crc >>> 16) & 0xff;
      head[8] = (crc >>> 24) & 0xff;
      await writeOne(head);
      await waitAny(mark, [ST.OTA_READY, ST.ERROR], 30000, 15000);
      log('设备已就绪，开始上传固件…', 'ok');

      const step = Math.max(1, Math.min(509, gMtu - 3) - 5);
      const chunks = Math.ceil(buf.length / step);
      const part = new Uint8Array(step + 5);
      const t0 = performance.now();

      part[0] = 0x42;                                   /* 'B' + 偏移(4) + 数据 */
      for (let i = 0; i < chunks; i++) {
        const off = i * step;
        const n = Math.min(step, buf.length - off);

        part[1] = off & 0xff;
        part[2] = (off >>> 8) & 0xff;
        part[3] = (off >>> 16) & 0xff;
        part[4] = (off >>> 24) & 0xff;
        part.set(buf.subarray(off, off + n), 5);
        await writeOne(n === step ? part : part.subarray(0, n + 5));

        if ((i & 63) === 63) {
          const done = off + n;
          const el = (performance.now() - t0) / 1000;
          const pct = Math.round((done / buf.length) * 100);

          setOtaProgress(done / buf.length);
          if (pct >= gOtaPct + 50) {
            gOtaPct = pct - (pct % 50);
            log('固件写入 ' + pct + '%（' + (done / 1024).toFixed(0) + ' KB / ' +
              (el > 0.3 ? (done / 1024 / el).toFixed(1) + ' KB/s' : '…') + '）');
          }
          if (el > 0.3) {
            setFoot('固件 ' + pct + '% · ' + (done / 1024 / el).toFixed(1) + ' KB/s');
          }
        }
      }

      setOtaProgress(1);
      mark = gStateSeq;

      /* 提交后设备会写 Flash 然后复位，链路必断——这是正常流程。 */
      gOtaPhase = 1;
      const dis = new Promise((res) => gDiscWaiters.push(res));

      await writeOne(new Uint8Array([0x50]));
      log('固件上传完成，设备正在写入并重启…', 'ok');

      const r = await Promise.race([
        waitAny(gStateSeq, [ST.OTA_DONE, ST.ERROR], 180000, 180000)
          .then((v) => ({ k: 'noti', v }))
          .catch(() => ({ k: 'timeout' })),
        dis.then(() => ({ k: 'disc' }))
      ]);

      if (r.k === 'noti' && r.v === ST.ERROR) {
        throw new Error('设备报错：固件校验未通过，请重新上传');
      }

      setOtaProgress(1);
      setStatus('scanning', '设备重启中');
      log('✔ 上传完成：设备正在写入固件并重启。', 'ok');
      log('  请等待屏幕刷新（约 1~3 分钟），然后点「连接设备」重新连接。', 'ok');
      S.connected = false;
      gJustOta = true;
      if (S.device && S.device.gatt && S.device.gatt.connected) {
        try { S.device.gatt.disconnect(); } catch (e) {}
      }
      $('connectBtn').disabled = false;
      $('disconnectBtn').disabled = true;
      $('sendBtn').disabled = true;
      $('sendImgBtn').disabled = !S.indices;
      $('otaBtn').disabled = true;
      $('otaSrvBtn').disabled = true;
    } catch (e) {
      log('固件升级失败：' + (e && e.message ? e.message : String(e)), 'err');
      setFoot('固件升级失败');
    } finally {
      setTimeout(() => { $('otaProgress').hidden = true; }, 1200);
      $('otaBtn').disabled = !S.connected;
      $('sendBtn').disabled = !S.connected;
      $('sendImgBtn').disabled = !S.indices;
    }
  }

  $('otaBtn').addEventListener('click', otaUpdate);
  $('otaSrvBtn').addEventListener('click', otaFromServer);

  /* ============================ 尺寸变化 ============================ */
  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderStage();
      if (S.img) convert();
    }, 80);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(stage);
  }

  /* ============================ 启动 ============================ */
  function boot() {
      log('EPD Sender 网页 ' + WEB_VER + '  —  若这里不是 v49，请长按刷新 / Ctrl+F5 强制刷新，浏览器缓存了旧的 app.js');
  { const wv = document.getElementById('webVer'); const sc = document.querySelector('script[src*="app.js"]'); if (wv) { wv.textContent = '网页版本 ' + WEB_VER + (sc ? ' · ' + sc.getAttribute('src') : ''); } }
log('EPD Sender 就绪');
    log('目标：720×480 / 480×720，64 色 4bpp，整帧 172800 字节');
    checkBleSupport();
    if (location.protocol === 'file:') {
      log('提示：file:// 下蓝牙会被浏览器禁用，本地调试请用 http://localhost', 'warn');
    }
    updateStats();
    renderStage();
  }

  boot();

  /* 调试钩子：控制台里可以直接看内部状态，不影响正常使用 */
  /* 取色明细：鼠标停在预览上时显示「原色 -> 色号 -> 上屏色」，
     便于当场核对差异是量化（64 色里没有这个颜色）还是屏白校正造成的。 */
  (function bindPickInfo() {
    const info = document.getElementById('pickInfo');
    const hex = (r, g, b) => '#' + [r, g, b].map((v) => (v | 0).toString(16).toUpperCase().padStart(2, '0')).join('');
    if (!info) return;
    preview.addEventListener('pointermove', (ev) => {
      const src = S.lastSrc, idx = S.indices;
      if (!src || !idx || !S.img) return;
      const r = preview.getBoundingClientRect();
      const w = preview.width, h = preview.height;
      const x = Math.floor(((ev.clientX - r.left) / r.width) * w);
      const y = Math.floor(((ev.clientY - r.top) / r.height) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      const o = i * 4;
      const id = idx[i];
      const c = MODES[S.mode].pal[id] || [0, 0, 0];
      info.textContent = '原色 ' + hex(src[o], src[o + 1], src[o + 2])
        + '  ->  色号 0x' + (id == null ? '??' : id.toString(16).toUpperCase().padStart(2, '0'))
        + '  ->  上屏 ' + hex(c[0], c[1], c[2])
        + '    (' + x + ',' + y + ')';
    });
    preview.addEventListener('pointerleave', () => {
      info.textContent = '把鼠标移到预览上，可查看「原色 -> 色号 -> 上屏色」';
    });
  })();

  window.__EPD = { S: S, cropRect: cropRect, baseScale: baseScale, convert: convert, PAL64: PAL64 };
})();
