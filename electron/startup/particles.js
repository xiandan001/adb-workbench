(() => {
  const bridge = window.startupOverlay;
  let started = false; let finished = false; let disposed = false; let frame;
  const finish = () => {
    if (finished || disposed) return; finished = true;
    try { bridge?.finished(); } catch { /* The native watchdog handles a lost bridge. */ }
  };
  window.addEventListener('pagehide', () => { disposed = true; if (frame !== undefined) cancelAnimationFrame(frame); });
  function play(message) {
    if (started || disposed) return; started = true;
    try {
      const canvas = document.getElementById('particles'); const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      const width = innerWidth; const height = innerHeight; const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); context.scale(ratio, ratio);
      const center = { x: width / 2, y: height / 2 };
      let target = message?.target;
      if (target === undefined) {
        target = { width: Math.min(width * .84, 1560), height: Math.min(height * .84, 880) };
        target.x = (width - target.width) / 2; target.y = (height - target.height) / 2;
      } else {
        if (!target || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(target[key]) && Math.abs(target[key]) <= 100000)
          || target.width <= 0 || target.height <= 0) throw new Error('Invalid target rectangle');
        target = { x: target.x, y: target.y, width: target.width, height: target.height };
      }
      const sources = []; const targets = []; const segments = [];
      function line(x1, y1, x2, y2, spacing = 9) {
        segments.push([x1, y1, x2, y2]);
        const count = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / spacing));
        for (let i = 0; i < count; i++) targets.push({ x: x1 + (x2 - x1) * i / count, y: y1 + (y2 - y1) * i / count });
      }
      const box = (x, y, w, h, spacing = 12) => { line(x, y, x + w, y, spacing); line(x + w, y, x + w, y + h, spacing); line(x + w, y + h, x, y + h, spacing); line(x, y + h, x, y, spacing); };
      const x = target.x; const y = target.y; const w = target.width; const h = target.height; const sidebar = Math.min(230, w * .18);
      box(x, y, w, h, 10); line(x + sidebar, y, x + sidebar, y + h, 10); line(x + sidebar, y + 74, x + w, y + 74, 11);
      for (let row = 0; row < 7; row++) line(x + 32, y + 112 + row * Math.min(62, h / 10), x + sidebar - 30, y + 112 + row * Math.min(62, h / 10), 8);
      const content = x + sidebar + 26; const contentWidth = w - sidebar - 52;
      box(content, y + 98, contentWidth, 42); box(content, y + 158, contentWidth, 48);
      const cardWidth = Math.min(contentWidth * .67, 630); const cardHeight = Math.max(180, h - 250);
      box(content, y + 230, cardWidth, cardHeight); line(content, y + 310, content + cardWidth, y + 310);
      for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) box(content + 18 + col * (cardWidth - 36) / 4, y + 340 + row * 58, (cardWidth - 64) / 4, 36, 20);

      const mask = document.createElement('canvas'); mask.width = 460; mask.height = 280; const ink = mask.getContext('2d');
      ink.strokeStyle = '#fff'; ink.lineWidth = 5; ink.beginPath(); ink.roundRect(201, 24, 58, 96, 13); ink.stroke();
      ink.beginPath(); ink.moveTo(218, 39); ink.lineTo(242, 39); ink.stroke(); ink.beginPath(); ink.arc(230, 104, 2.5, 0, Math.PI * 2); ink.fillStyle = '#fff'; ink.fill();
      ink.font = '600 54px "Microsoft YaHei", sans-serif'; ink.textAlign = 'center'; ink.fillText('卓控台', 230, 203);
      const pixels = ink.getImageData(0, 0, mask.width, mask.height).data;
      for (let py = 0; py < mask.height; py += 4) for (let px = 0; px < mask.width; px += 4) if (pixels[(py * mask.width + px) * 4 + 3] > 100) sources.push({ x: center.x + px - 230, y: center.y + py - 140 });
      if (!sources.length) throw new Error('Startup artwork is unavailable');
      const sprite = document.createElement('canvas'); sprite.width = sprite.height = 24; const glow = sprite.getContext('2d');
      const gradient = glow.createRadialGradient(12, 12, 0, 12, 12, 12); gradient.addColorStop(0, '#e6fff9'); gradient.addColorStop(.15, '#62f5d6'); gradient.addColorStop(.4, '#20cbaa80'); gradient.addColorStop(1, '#10b7d000');
      glow.fillStyle = gradient; glow.fillRect(0, 0, 24, 24);
      const count = Math.min(820, targets.length); const particles = Array.from({ length: count }, (_, index) => {
        const start = sources[(index * 37) % sources.length]; const end = targets[Math.floor(index * targets.length / count)];
        const angle = index * 2.399963; const reach = 100 + index % 130;
        return { start, end, control: { x: center.x + Math.cos(angle) * reach, y: center.y + Math.sin(angle) * reach * .6 }, size: 3 + index % 3, phase: index * .41 };
      });
      const ease = value => value < .5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
      const holdExtraMs = 1000; const morphMs = 2900; const endFadeAt = 4180; const durationMs = 4400;
      let startTime;
      function paint(time) {
        frame = undefined; if (disposed || finished) return;
        try {
          if (startTime === undefined) startTime = time;
          const elapsed = time - startTime; const progress = Math.min(1, Math.max(0, (elapsed - holdExtraMs - 180) / morphMs)); const t = ease(progress); const endFade = Math.max(0, 1 - Math.max(0, elapsed - endFadeAt) / 220);
          context.clearRect(0, 0, width, height);
          if (elapsed < holdExtraMs + 230) {
            context.save(); context.globalAlpha = Math.min(1, Math.max(0, 1 - (elapsed - holdExtraMs) / 230)); context.shadowColor = '#00d3ab'; context.shadowBlur = 20;
            context.drawImage(mask, center.x - 230, center.y - 140); context.restore();
          }
          if (progress > .52) {
            context.save(); context.globalAlpha = Math.min(.32, (progress - .52) * .8) * endFade; context.strokeStyle = '#47e8c6'; context.lineWidth = 1;
            context.beginPath(); for (const segment of segments) { context.moveTo(segment[0], segment[1]); context.lineTo(segment[2], segment[3]); } context.stroke(); context.restore();
          }
          for (const particle of elapsed >= holdExtraMs ? particles : []) {
            const inverse = 1 - t; const ripple = Math.sin(progress * Math.PI) * 20;
            const px = inverse * inverse * particle.start.x + 2 * inverse * t * particle.control.x + t * t * particle.end.x + Math.sin(particle.phase + t * 6) * ripple;
            const py = inverse * inverse * particle.start.y + 2 * inverse * t * particle.control.y + t * t * particle.end.y + Math.cos(particle.phase + t * 6) * ripple;
            context.globalAlpha = Math.min(1, (elapsed - holdExtraMs) / 230) * (.6 + .4 * Math.sin(particle.phase + elapsed / 200) ** 2) * endFade;
            const size = particle.size * (1 + Math.sin(progress * Math.PI) * .8);
            context.drawImage(sprite, px - size / 2, py - size / 2, size, size);
          }
          context.globalAlpha = 1;
          if (elapsed < durationMs) frame = requestAnimationFrame(paint); else finish();
        } catch { finish(); }
      }
      frame = requestAnimationFrame(paint);
    } catch { finish(); }
  }
  if (bridge) { bridge.onPlay(play); bridge.ready(); }
  else play();
})();
