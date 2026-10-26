/* Palette From Image — k-means and median cut run on a downsampled copy of the image, all locally. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const MAX_AREA = 40e6, SAMPLE = 40000;
  const saved = S3.store("palette") || {};
  const o = { method: saved.method || "kmeans", count: saved.count || 6, fmt: saved.fmt || "css" };
  let src = null, palette = [], picked = [];

  // ---------- colour maths (pure) ----------
  const hex = c => "#" + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const lum = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  // Opaque pixels of an RGBA buffer as [r,g,b] triples, evenly subsampled to at most `max`.
  function pixels(data, max) {
    const n = data.length / 4, step = Math.max(1, n / max), out = [];
    for (let f = 0; f < n; f += step) {
      const i = Math.floor(f) * 4;
      if (data[i + 3] >= 128) out.push([data[i], data[i + 1], data[i + 2]]);
    }
    return out;
  }
  function finish(groups, total) {
    return groups.filter(g => g.n > 0).map(g => ({ rgb: g.c.map(Math.round), share: g.n / total }))
      .sort((a, b) => b.share - a.share);
  }
  function medianCut(px, k) {
    if (!px.length) return [];
    let boxes = [px];
    const range = b => { const lo = [255, 255, 255], hi = [0, 0, 0]; b.forEach(p => { for (let c = 0; c < 3; c++) { if (p[c] < lo[c]) lo[c] = p[c]; if (p[c] > hi[c]) hi[c] = p[c]; } }); return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]; };
    while (boxes.length < k) {
      let best = -1, bi = -1, bc = 0;
      boxes.forEach((b, i) => { if (b.length < 2) return; const r = range(b), c = r.indexOf(Math.max.apply(null, r)), score = r[c] * Math.sqrt(b.length); if (score > best) { best = score; bi = i; bc = c; } });
      if (bi < 0 || best <= 0) break;
      const b = boxes[bi].slice().sort((p, q) => p[bc] - q[bc]);
      // Cut at the median, nudged to the nearest change in value so identical colours never straddle two boxes.
      let lo = b.length >> 1, hi = lo;
      while (lo > 0 && b[lo - 1][bc] === b[lo][bc]) lo--;
      while (hi < b.length && b[hi - 1][bc] === b[hi][bc]) hi++;
      const mid = lo > 0 && (hi >= b.length || (b.length >> 1) - lo <= hi - (b.length >> 1)) ? lo : hi;
      boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
    }
    return finish(boxes.map(b => ({ n: b.length, c: [0, 1, 2].map(c => b.reduce((s, p) => s + p[c], 0) / b.length) })), px.length);
  }
  function kmeans(px, k) {
    if (!px.length) return [];
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    // k-means++ seeding (deterministic), then Lloyd iterations.
    const cents = [px[Math.floor(rnd() * px.length)].slice()], dist = new Float64Array(px.length).fill(Infinity);
    while (cents.length < k) {
      let sum = 0;
      const last = cents[cents.length - 1];
      for (let i = 0; i < px.length; i++) { const d = d2(px[i], last); if (d < dist[i]) dist[i] = d; sum += dist[i]; }
      if (sum === 0) break;
      let t = rnd() * sum, i = 0;
      while (i < px.length - 1 && (t -= dist[i]) > 0) i++;
      cents.push(px[i].slice());
    }
    const lab = new Int32Array(px.length);
    let counts = [];
    for (let it = 0; it < 16; it++) {
      const sums = cents.map(() => [0, 0, 0]); counts = cents.map(() => 0);
      let moved = 0;
      for (let i = 0; i < px.length; i++) {
        let b = 0, bd = Infinity;
        for (let c = 0; c < cents.length; c++) { const d = d2(px[i], cents[c]); if (d < bd) { bd = d; b = c; } }
        if (lab[i] !== b) moved++;
        lab[i] = b; counts[b]++; sums[b][0] += px[i][0]; sums[b][1] += px[i][1]; sums[b][2] += px[i][2];
      }
      cents.forEach((c, j) => { if (counts[j]) { c[0] = sums[j][0] / counts[j]; c[1] = sums[j][1] / counts[j]; c[2] = sums[j][2] / counts[j]; } });
      if (it > 0 && moved === 0) break;
    }
    return finish(cents.map((c, j) => ({ n: counts[j], c })), px.length);
  }
  function exportText(pal, fmt) {
    if (fmt === "json") return JSON.stringify(pal.map(p => ({ hex: hex(p.rgb), rgb: p.rgb, share: Math.round(p.share * 1000) / 1000 })), null, 2);
    return ":root {\n" + pal.map((p, i) => "  --color-" + (i + 1) + ": " + hex(p.rgb) + ";").join("\n") + "\n}";
  }
  function strip(pal) {
    const W = 160, H = 200, c = document.createElement("canvas"); c.width = W * pal.length; c.height = H;
    const x = c.getContext("2d");
    pal.forEach((p, i) => {
      x.fillStyle = hex(p.rgb); x.fillRect(i * W, 0, W, H);
      x.fillStyle = lum(p.rgb) > 0.55 ? "rgba(0,0,0,.78)" : "rgba(255,255,255,.92)";
      x.font = "600 20px Inter, sans-serif"; x.textAlign = "center";
      x.fillText(hex(p.rgb).toUpperCase(), i * W + W / 2, H - 22);
    });
    return c;
  }

  // ---------- image ----------
  const pic = $("#pic"), loupe = $("#loupe"), lctx = loupe.getContext("2d");
  async function load(file) {
    const url = URL.createObjectURL(file), img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); S3.toast("Can't read that image", "error"); return; }
    let w = img.naturalWidth || 800, h = img.naturalHeight || 600;
    if (w * h > MAX_AREA) { const s = Math.sqrt(MAX_AREA / (w * h)); w = Math.floor(w * s); h = Math.floor(h * s); }
    pic.width = w; pic.height = h;
    const x = pic.getContext("2d", { willReadFrequently: true });
    x.clearRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    // Analysis copy: at most ~200×200.
    const s = Math.min(1, Math.sqrt(SAMPLE / (w * h))), sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
    const a = document.createElement("canvas"); a.width = sw; a.height = sh;
    const ax = a.getContext("2d"); ax.imageSmoothingQuality = "high"; ax.drawImage(pic, 0, 0, sw, sh);
    src = { px: pixels(ax.getImageData(0, 0, sw, sh).data, SAMPLE), ctx: x };
    $("#drop").hidden = true; $("#stage").hidden = false; $("#change").hidden = false; $("#hoverRow").hidden = false;
    analyse(); S3.done();
  }
  function analyse() {
    S3.store("palette", o);
    $("#nv").textContent = o.count;
    if (!src) return;
    palette = (o.method === "median" ? medianCut : kmeans)(src.px, o.count);
    const sw = $("#swatches");
    sw.textContent = "";
    sw.appendChild(S3.h("div", { "class": "pl-bar", "aria-hidden": "true" }, palette.map(p => S3.h("span", { style: "background:" + hex(p.rgb) + ";flex:" + p.share }))));
    palette.forEach(p => {
      const hx = hex(p.rgb);
      sw.appendChild(S3.h("button", { "class": "pl-sw", "data-hex": hx, title: "Copy " + hx }, [
        S3.h("i", { "class": "pl-chip", style: "background:" + hx }),
        S3.h("div", {}, [S3.h("b", { text: hx.toUpperCase() }), S3.h("span", { text: "rgb(" + p.rgb.join(", ") + ")" })]),
        S3.h("span", { "class": "pl-share", text: (p.share * 100).toFixed(1) + "%" })
      ]));
    });
    $("#empty").hidden = true; $("#exportBox").hidden = !palette.length;
    $("#out").textContent = exportText(palette, o.fmt);
  }
  function pixelAt(x, y) { const d = src.ctx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]]; }
  function pos(e) {
    const r = pic.getBoundingClientRect();
    return { x: Math.min(pic.width - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * pic.width))), y: Math.min(pic.height - 1, Math.max(0, Math.floor((e.clientY - r.top) / r.height * pic.height))), cx: e.clientX - r.left, cy: e.clientY - r.top };
  }
  function showLoupe(e) {
    if (!src) return;
    const p = pos(e), N = 11, Z = 12;
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = "#000"; lctx.fillRect(0, 0, 132, 132);
    lctx.drawImage(pic, p.x - 5, p.y - 5, N, N, 0, 0, N * Z, N * Z);
    lctx.strokeStyle = "#fff"; lctx.lineWidth = 2; lctx.strokeRect(5 * Z, 5 * Z, Z, Z);
    loupe.hidden = false;
    loupe.style.left = Math.min(Math.max(p.cx - 66, -20), pic.clientWidth - 112) + "px";
    loupe.style.top = (p.cy > 150 ? p.cy - 150 : p.cy + 20) + "px";
    const c = pixelAt(p.x, p.y), hx = hex(c);
    $("#hoverHex").textContent = hx.toUpperCase() + "  rgb(" + c.slice(0, 3).join(", ") + ")" + (c[3] < 255 ? "  alpha " + (c[3] / 255).toFixed(2) : "");
    $("#hoverDot").style.background = hx;
  }
  function pick(e) {
    if (!src) return;
    const p = pos(e), hx = hex(pixelAt(p.x, p.y));
    picked = [hx].concat(picked.filter(h => h !== hx)).slice(0, 16);
    renderPicked(); S3.copy(hx.toUpperCase(), hx.toUpperCase() + " copied");
  }
  function renderPicked() {
    $("#pickedBox").hidden = !picked.length;
    const box = $("#picked"); box.textContent = "";
    picked.forEach(h => box.appendChild(S3.h("button", { "class": "pl-pk", "data-hex": h }, [S3.h("i", { style: "background:" + h }), h.toUpperCase()])));
  }
  pic.addEventListener("pointermove", showLoupe);
  pic.addEventListener("pointerdown", showLoupe);
  pic.addEventListener("pointerleave", () => { loupe.hidden = true; });
  pic.addEventListener("click", pick);

  document.addEventListener("click", e => {
    const b = e.target.closest(".pl-sw, .pl-pk"); if (!b) return;
    S3.copy(b.dataset.hex.toUpperCase(), b.dataset.hex.toUpperCase() + " copied");
  });
  $("#clearPicked").addEventListener("click", () => { picked = []; renderPicked(); });
  S3.drop($("#drop"), fs => load(fs[0]), { accept: "image/*", multiple: false });
  $("#change input").addEventListener("change", e => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ""; });
  document.addEventListener("paste", e => {
    const f = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type))[0];
    if (f) { e.preventDefault(); load(f); }
  });
  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
    });
  }
  seg($("#method"), o.method, v => { o.method = v; analyse(); });
  seg($("#fmt"), o.fmt, v => { o.fmt = v; analyse(); });
  $("#count").value = o.count;
  $("#count").addEventListener("input", S3.debounce(e => { o.count = +e.target.value; analyse(); }, 80));
  $("#count").addEventListener("input", e => { $("#nv").textContent = e.target.value; });
  $("#copyOut").addEventListener("click", () => { S3.copy(exportText(palette, o.fmt)); S3.done(); });
  $("#saveOut").addEventListener("click", () => {
    S3.download(exportText(palette, o.fmt), o.fmt === "json" ? "palette.json" : "palette.css", o.fmt === "json" ? "application/json" : "text/css"); S3.done();
  });
  $("#savePng").addEventListener("click", () => strip(palette).toBlob(b => { S3.download(b, "palette.png"); S3.done(); }, "image/png"));

  // ---------- sample (drawn locally) ----------
  function sample(w, h) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    const sky = x.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#1f2f6e"); sky.addColorStop(0.5, "#e2687f"); sky.addColorStop(1, "#ffc27a");
    x.fillStyle = sky; x.fillRect(0, 0, w, h);
    x.fillStyle = "#ffe8a8"; x.beginPath(); x.arc(w * 0.62, h * 0.55, h * 0.14, 0, Math.PI * 2); x.fill();
    [["#4b3470", 0.62, 4], ["#2c2350", 0.74, 7], ["#13112b", 0.88, 11]].forEach((m, i) => {
      x.fillStyle = m[0]; x.beginPath(); x.moveTo(0, h);
      for (let k = 0; k <= 60; k++) { const px = w * k / 60; x.lineTo(px, h * m[1] - Math.abs(Math.sin(px / w * m[2] + i)) * h * 0.15); }
      x.lineTo(w, h); x.fill();
    });
    return c;
  }
  window.S3_DEMO = async function () {
    const b = await new Promise(r => sample(1200, 800).toBlob(r, "image/png"));
    await load(new File([b], "sunset.png", { type: "image/png" }));
    picked = ["#ffe8a8", "#e2687f"]; renderPicked();
    const r = pic.getBoundingClientRect();
    showLoupe({ clientX: r.left + r.width * 0.56, clientY: r.top + r.height * 0.47 });
  };

  window.S3_SELFTEST = function () {
    // Four solid blocks: red 50%, blue 25%, green 15%, yellow 10%.
    const c = document.createElement("canvas"); c.width = 100; c.height = 100;
    const x = c.getContext("2d");
    [["#ff0000", 0, 50], ["#0000ff", 50, 25], ["#00ff00", 75, 15], ["#ffff00", 90, 10]].forEach(b => { x.fillStyle = b[0]; x.fillRect(b[1], 0, b[2], 100); });
    const px = pixels(x.getImageData(0, 0, 100, 100).data, 1e6);
    const want = ["#ff0000", "#0000ff", "#00ff00", "#ffff00"], shares = [0.5, 0.25, 0.15, 0.1];
    const good = pal => pal.length === 4 && pal.every((p, i) => hex(p.rgb) === want[i] && Math.abs(p.share - shares[i]) < 0.001);
    const km = kmeans(px, 4), mc = medianCut(px, 4);
    // Transparent pixels are ignored; exports are well-formed.
    const t = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]);
    const css = exportText(km, "css"), json = JSON.parse(exportText(km, "json"));
    const ok = good(km) && good(mc) && pixels(t, 10).length === 1 && hex([15, 128, 255]) === "#0f80ff" &&
      css === ":root {\n  --color-1: #ff0000;\n  --color-2: #0000ff;\n  --color-3: #00ff00;\n  --color-4: #ffff00;\n}" &&
      json[1].hex === "#0000ff" && json[1].share === 0.25 && strip(km).width === 640;
    return ok || { km: km.map(p => hex(p.rgb) + ":" + p.share), mc: mc.map(p => hex(p.rgb) + ":" + p.share) };
  };
})();
