/**
 * ぷるぷる変形の描画レイヤー。
 *
 * 物理には一切干渉しない。剛体が持つ位置・角度・接触・衝突イベントを受け取り、
 * 輪郭を変形させて「柔らかさ」だけを演出する。
 *
 * なぜ分けるか:
 *   物理をソフトボディにすると接触が柔らかすぎて塔が安定せず、
 *   「くずれたら終了」の判定も曖昧になる（実測で破綻）。
 *   プレイヤーが感じる気持ちよさは描画から来ていて、物理の正確さからは来ていない。
 *
 * 変形の要素は2つ:
 *   1. 衝突の瞬間のへこみ（impact）— 着地の「ぷるん」
 *   2. 載っている重さによる押し潰れ（press）— 下のゼリーが平たく広がる
 *      接触面を平らに押し、押し出された分だけ横へふくらむ（体積を保つ）。
 *      C4D のソフトボディ動画で一番目を引くのはこれ。
 *
 * 描画用の輪郭は物理形状より角を丸めてある。
 * 物理を丸めると接触が点になって転がり、塔が崩れるため
 * （chamferRatio 0.34 で実際に破綻することを実測済み）。
 */
(function () {
  'use strict';

  var G = window.APP_CONFIG.game;
  var W = G.wobble;
  var P = G.press || {};
  var L = G.look || {};

  /**
   * 角丸矩形の輪郭を等間隔にサンプリングする。
   * 形状ごとに一度だけ計算してキャッシュする。
   *
   * @returns {Array<{x:number, y:number, nx:number, ny:number}>} 位置と外向き法線
   */
  function buildOutline(w, h, r, count) {
    var hw = w / 2, hh = h / 2;
    r = Math.min(r, hw, hh);

    // 直線4本と角の円弧4つを、周長で按分して点を配る
    var straightX = w - 2 * r;      // 上下の直線長
    var straightY = h - 2 * r;      // 左右の直線長
    var arc = Math.PI * r / 2;      // 角1つぶんの弧長
    var perimeter = 2 * straightX + 2 * straightY + 4 * arc;

    // 右上の角から時計回りに1周する
    var segments = [
      { type: 'arc',  len: arc,       cx:  hw - r, cy: -hh + r, a0: -Math.PI / 2, a1: 0 },
      { type: 'line', len: straightY, x0:  hw, y0: -hh + r, x1:  hw, y1:  hh - r, nx:  1, ny:  0 },
      { type: 'arc',  len: arc,       cx:  hw - r, cy:  hh - r, a0: 0, a1: Math.PI / 2 },
      { type: 'line', len: straightX, x0:  hw - r, y0:  hh, x1: -hw + r, y1:  hh, nx:  0, ny:  1 },
      { type: 'arc',  len: arc,       cx: -hw + r, cy:  hh - r, a0: Math.PI / 2, a1: Math.PI },
      { type: 'line', len: straightY, x0: -hw, y0:  hh - r, x1: -hw, y1: -hh + r, nx: -1, ny:  0 },
      { type: 'arc',  len: arc,       cx: -hw + r, cy: -hh + r, a0: Math.PI, a1: Math.PI * 1.5 },
      { type: 'line', len: straightX, x0: -hw + r, y0: -hh, x1:  hw - r, y1: -hh, nx:  0, ny: -1 }
    ];

    var points = [];
    for (var i = 0; i < count; i++) {
      var target = perimeter * i / count;
      var acc = 0;

      for (var s = 0; s < segments.length; s++) {
        var seg = segments[s];
        if (target > acc + seg.len && s < segments.length - 1) { acc += seg.len; continue; }

        var t = seg.len > 0 ? (target - acc) / seg.len : 0;
        if (seg.type === 'line') {
          points.push({
            x: seg.x0 + (seg.x1 - seg.x0) * t,
            y: seg.y0 + (seg.y1 - seg.y0) * t,
            nx: seg.nx, ny: seg.ny
          });
        } else {
          var a = seg.a0 + (seg.a1 - seg.a0) * t;
          var nx = Math.cos(a), ny = Math.sin(a);
          points.push({ x: seg.cx + nx * r, y: seg.cy + ny * r, nx: nx, ny: ny });
        }
        break;
      }
    }
    return points;
  }

  var outlineCache = {};
  function outlineFor(type) {
    var key = type.w + 'x' + type.h;
    if (!outlineCache[key]) {
      // 物理形状よりわずかに大きく描く。
      // 同じ大きさだと積んだときに角の丸みぶんだけ隙間が空き、
      // ゼリーが触れ合っていないように見える。少し重ねると押し合って見える。
      var w = type.w * W.renderScale;
      var h = type.h * W.renderScale;
      outlineCache[key] = buildOutline(w, h, Math.min(w, h) * W.renderChamferRatio, W.points);
    }
    return outlineCache[key];
  }

  /** #rrggbb → [h, s, l]（0-360, 0-1, 0-1） */
  function hexToHsl(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var l = (max + min) / 2, h = 0, s = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [h, s, l];
  }

  /** 明度・彩度を動かした色。白黒と混ぜると彩度が抜けるので HSL で動かす */
  function tint(hsl, dl, ds, a) {
    var l = Math.min(0.94, Math.max(0.08, hsl[2] + dl));
    var s = Math.min(1, Math.max(0, hsl[1] + (ds || 0)));
    return 'hsla(' + hsl[0].toFixed(1) + ',' + (s * 100).toFixed(1) + '%,' +
           (l * 100).toFixed(1) + '%,' + (a === undefined ? 1 : a) + ')';
  }

  /** 種類ごとの配色。ガラスのグミ: 透けた本体、濃い縁、明るい上面 */
  function paletteFor(type) {
    if (!type._pal) {
      var hsl = hexToHsl(type.color);
      var alpha = L.alpha === undefined ? 0.8 : L.alpha;
      type._pal = {
        top:    tint(hsl,  0.10, 0.05, alpha),        // 上面。光が入る
        mid:    tint(hsl,  0.00, 0.05, alpha),
        bottom: tint(hsl, -0.14, 0.05, Math.min(1, alpha + 0.12)), // 底は濃く
        edge:   tint(hsl, -0.24, 0.10, L.edgeAlpha === undefined ? 0.5 : L.edgeAlpha) // 厚みの縁（屈折で濃く見える）
      };
    }
    return type._pal;
  }

  /** 変形後の頂点を滑らかな閉曲線としてパスにする */
  function tracePath(ctx, vx, vy, n) {
    ctx.beginPath();
    ctx.moveTo((vx[n - 1] + vx[0]) / 2, (vy[n - 1] + vy[0]) / 2);
    for (var j = 0; j < n; j++) {
      var k = (j + 1) % n;
      ctx.quadraticCurveTo(vx[j], vy[j], (vx[j] + vx[k]) / 2, (vy[j] + vy[k]) / 2);
    }
    ctx.closePath();
  }

  var Jelly = {
    /** ゼリー1個に変形の状態を持たせる */
    attach: function (body) {
      var n = W.points;
      var t = body.jellyType;
      body.wobOutline = outlineFor(t);
      body.wobOff = new Float32Array(n);    // 法線方向の変位。負=へこむ
      body.wobVel = new Float32Array(n);
      body.wobTarget = new Float32Array(n); // 押し潰れで目指す変位（毎ステップ作り直す）

      // へこみの上限はサイズ比で決める。
      // 絶対値で固定すると、小さいゼリーだけ相対的に大きく凹んで崩れる。
      body.wobMax = Math.min(t.w, t.h) * W.maxOffsetRatio;
    },

    /**
     * 衝突の瞬間の変形を注入する。接触点に近い輪郭ほど大きくへこませる。
     * @param {object} body     変形させる剛体
     * @param {{x,y}} worldPoint 接触点（ワールド座標）
     * @param {number} strength  衝突の強さ
     */
    impact: function (body, worldPoint, strength) {
      if (!body.wobOff) return;
      var l = toLocal(body, worldPoint);
      var amount = Math.min(strength * W.impactScale, body.wobMax);
      var pts = body.wobOutline;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.hypot(pts[i].x - l.x, pts[i].y - l.y);
        body.wobVel[i] -= amount / (1 + d * d * W.falloff);
      }
    },

    /**
     * 載っている重さで押し潰す。物理の接触情報から毎ステップ目標変位を作る。
     *
     * 上から順に重さを積み上げ（自分の質量 + 上に載っている物の合計）、
     * 接触面に向いた輪郭を重さに応じて平らに押し込む。
     * 押し込んだ分の面積は、接触から遠い側面へ振り分けてふくらませる。
     *
     * @param {Array} pairs   engine.pairs.list
     * @param {Array} jellies ゼリーの剛体
     */
    press: function (pairs, jellies) {
      if (!P.perMass) return;
      var n = W.points, i, j;

      for (i = 0; i < jellies.length; i++) {
        var b0 = jellies[i];
        if (b0.wobTarget) b0.wobTarget.fill(0);
        b0._load = b0.mass;      // 自分の重さから始める
        b0._below = null;
      }

      // 接触している相手を集める（上→下の向きだけ持つ）。
      //
      // Matter は眠っている body 同士の接触ペアを「非アクティブ」にするので、
      // 落ち着いた塔（この効果が一番要る場面）では pairs から何も取れない。
      // 起きている間に見えた接触を body ごとに覚えておき、眠っている間はそれを使う。
      var contacts = [], touched = {};
      for (i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (!p.isActive || !p.collision || !p.collision.supports.length) continue;
        var A = p.bodyA, B = p.bodyB;
        var aJ = A.label === 'jelly', bJ = B.label === 'jelly';
        if (!aJ && !bJ) continue;
        var pt = { x: p.collision.supports[0].x, y: p.collision.supports[0].y };

        var c;
        if (aJ && bJ) {
          var upper = A.position.y < B.position.y ? A : B, lower = upper === A ? B : A;
          c = { upper: upper, lower: lower, pt: pt };
        } else {
          c = { upper: aJ ? A : B, lower: null, pt: pt }; // 地面などの静的物。ゼリー側が上
        }
        contacts.push(c);
        // 起きている body の接触は毎回作り直す
        for (j = 0; j < 2; j++) {
          var jb = j === 0 ? c.upper : c.lower;
          if (!jb) continue;
          if (!touched[jb.id]) { touched[jb.id] = true; jb._contacts = []; }
          jb._contacts.push(c);
        }
      }
      // 眠っている body は、最後に見えた接触をそのまま使う
      for (i = 0; i < jellies.length; i++) {
        var sb = jellies[i];
        if (touched[sb.id]) continue;
        if (sb.isSleeping && sb._contacts) {
          for (j = 0; j < sb._contacts.length; j++) {
            var cc = sb._contacts[j];
            // 相手側から既に入っている接触は二重に数えない
            if (cc.upper === sb || cc.lower === sb) {
              var other = cc.upper === sb ? cc.lower : cc.upper;
              if (other && touched[other.id]) continue;
              if (contacts.indexOf(cc) < 0) contacts.push(cc);
            }
          }
        } else if (!sb.isSleeping) {
          sb._contacts = null; // 起きていて接触が無い = 空中
        }
      }
      for (i = 0; i < contacts.length; i++) {
        var k = contacts[i];
        if (k.lower) (k.upper._below || (k.upper._below = [])).push(k.lower);
      }

      // 上にあるものから順に重さを下へ渡す
      var order = jellies.slice().sort(function (a, b) { return a.position.y - b.position.y; });
      for (i = 0; i < order.length; i++) {
        var u = order[i];
        if (!u._below) continue;
        var share = u._load / u._below.length;
        for (j = 0; j < u._below.length; j++) u._below[j]._load += share;
      }

      // 接触面を押す
      for (i = 0; i < contacts.length; i++) {
        var c = contacts[i];
        // 下側: 上に載っている合計の重さで押される
        if (c.lower) pressFace(c.lower, c.pt, c.upper._load * P.perMass, c.upper);
        // 上側: 自分の重さ（と、その上の分）で支えに押し付けられる
        pressFace(c.upper, c.pt, c.upper._load * P.perMass * (P.selfRatio === undefined ? 0.6 : P.selfRatio));
      }

      // 体積保存: 押し込んだ分を、接触から遠い横方向へふくらませる
      for (i = 0; i < jellies.length; i++) {
        var b = jellies[i], tg = b.wobTarget;
        if (!tg) continue;
        var pushed = 0, free = 0, pts = b.wobOutline;
        for (j = 0; j < n; j++) { if (tg[j] < 0) pushed -= tg[j]; else free += Math.abs(pts[j].nx); }
        if (pushed > 0 && free > 0) {
          var bulge = pushed * P.bulge / free;
          for (j = 0; j < n; j++) if (tg[j] >= 0) tg[j] += bulge * Math.abs(pts[j].nx);
        }
        for (j = 0; j < n; j++) {
          if (tg[j] < -b.wobMax) tg[j] = -b.wobMax;
          else if (tg[j] > b.wobMax) tg[j] = b.wobMax;
        }
      }
    },

    /**
     * バネで目標へ寄せる。物理と同じ固定ステップで呼ぶこと。
     * 隣の点へ伝播させることで、波が輪郭を回る「ぷるん」が出る。
     */
    step: function (bodies) {
      var n = W.points;

      // 前ステップの状態を保持する。
      // off[i] を更新しながら隣の off を読むと、更新済みの値が混ざって
      // エネルギーが注入され、変形が発散する（実際に発散した）。
      var snap = this._snap;
      if (!snap || snap.length !== n) snap = this._snap = new Float32Array(n);

      for (var b = 0; b < bodies.length; b++) {
        var off = bodies[b].wobOff, vel = bodies[b].wobVel, tg = bodies[b].wobTarget;
        if (!off) continue;
        snap.set(off);
        var lim = bodies[b].wobMax;
        for (var i = 0; i < n; i++) {
          var laplacian = (snap[(i - 1 + n) % n] + snap[(i + 1) % n]) * 0.5 - snap[i];
          var target = tg ? tg[i] : 0;
          vel[i] += -W.stiffness * (snap[i] - target) + W.spread * laplacian;
          vel[i] *= W.damping;
          off[i] += vel[i];
          if (off[i] > lim) off[i] = lim;           // 保険。数値が暴れても形が破綻しないようにする
          else if (off[i] < -lim) off[i] = -lim;
        }
      }
    },

    /**
     * 描く。ガラスのグミ:
     *   1. 透けた本体（上が明るく下が濃い）
     *   2. 厚みの縁（輪郭の内側に濃い色。屈折で縁が濃く見える表現）
     *   3. 上面の大きなやわらかい光（ラジアル）
     *   4. 縁のリムライト
     * すべて変形後の輪郭にクリップするので、押し潰れに追従する。
     */
    draw: function (ctx, body) {
      var pts = body.wobOutline;
      if (!pts) return;

      var n = pts.length;
      var type = body.jellyType;
      var pal = paletteFor(type);
      var w = type.w * W.renderScale, h = type.h * W.renderScale;
      var hw = w / 2, hh = h / 2;

      ctx.save();
      ctx.translate(body.position.x, body.position.y);

      // スカッシュ＆ストレッチ。進行方向に伸ばし、直交方向を縮める。
      // ボディの回転より先に適用することで、傾いていても落下方向に伸びる。
      var sp = Math.hypot(body.velocity.x, body.velocity.y);
      var st = Math.min(sp * W.squashScale, W.squashMax);
      if (st > 0.01) {
        var dir = Math.atan2(body.velocity.y, body.velocity.x);
        ctx.rotate(dir);
        ctx.scale(1 + st, 1 / (1 + st));
        ctx.rotate(-dir);
      }
      ctx.rotate(body.angle);

      // 変形後の頂点をローカル座標で用意する
      var vx = this._vx || (this._vx = []);
      var vy = this._vy || (this._vy = []);
      for (var i = 0; i < n; i++) {
        var o = body.wobOff[i];
        vx[i] = pts[i].x + pts[i].nx * o;
        vy[i] = pts[i].y + pts[i].ny * o;
      }

      var g = this.gradientsFor(ctx, type, w, h);

      ctx.save();
      tracePath(ctx, vx, vy, n);
      ctx.clip();

      // 1. 透けた本体
      ctx.fillStyle = g.body;
      ctx.fillRect(-w, -h, w * 2, h * 2);

      // 2. 厚みの縁。クリップ内に半分だけ入るので、内側に細い濃い帯になる
      tracePath(ctx, vx, vy, n);
      ctx.strokeStyle = pal.edge;
      ctx.lineWidth = Math.min(w, h) * (L.edge === undefined ? 0.05 : L.edge) * 2;
      ctx.stroke();

      // 3. 上面の大きなやわらかい光
      ctx.fillStyle = g.spec;
      ctx.fillRect(-w, -h, w * 2, h * 2);

      ctx.restore();

      // 4. 縁。暗い細い影の上に白いリムライト。
      //    本体が透けていても、隣のゼリーや背景との境界が読めるようにする
      tracePath(ctx, vx, vy, n);
      ctx.strokeStyle = 'rgba(10,20,50,.22)';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,' + (L.rim === undefined ? 0.6 : L.rim) + ')';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.restore();
    },

    /** 種類ごとに一度だけ作って使い回す（ローカル座標なので位置が変わっても使える） */
    gradientsFor: function (ctx, type, w, h) {
      if (!type._grads) {
        var pal = paletteFor(type), hh = h / 2, hw = w / 2;
        var body = ctx.createLinearGradient(0, -hh, 0, hh);
        body.addColorStop(0, pal.top);
        body.addColorStop(0.5, pal.mid);
        body.addColorStop(1, pal.bottom);

        // 上面の光: 明るい芯 + やわらかい裾。広く薄いと「白いもや」に見えるので芯を強く、裾を短く
        var spec = ctx.createRadialGradient(-hw * 0.40, -hh * 0.52, 1, -hw * 0.30, -hh * 0.36, Math.max(w, h) * 0.42);
        var sa = L.specular === undefined ? 0.7 : L.specular;
        spec.addColorStop(0, 'rgba(255,255,255,' + sa + ')');
        spec.addColorStop(0.18, 'rgba(255,255,255,' + (sa * 0.45) + ')');
        spec.addColorStop(0.55, 'rgba(255,255,255,' + (sa * 0.1) + ')');
        spec.addColorStop(1, 'rgba(255,255,255,0)');

        type._grads = { body: body, spec: spec };
      }
      return type._grads;
    }
  };

  /** ワールド座標の点をボディのローカル座標へ */
  function toLocal(body, pt) {
    var dx = pt.x - body.position.x, dy = pt.y - body.position.y;
    var cos = Math.cos(-body.angle), sin = Math.sin(-body.angle);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  /**
   * 接触点に向いている面を、重さに応じて平らに押し込む。
   * 法線が接触方向を向いている点ほど、また接触点に近い点ほど強く押す。
   *
   * other（上に載っているゼリー）を渡すと、その幅の内側だけを押し込み、
   * 幅のすぐ外側は逆に盛り上げる。上のゼリーが下のゼリーに
   * めり込んで、縁が包み込むように見える。
   */
  function pressFace(body, worldPoint, amount, other) {
    if (!body.wobTarget || amount <= 0) return;
    var l = toLocal(body, worldPoint);
    var len = Math.hypot(l.x, l.y) || 1;
    var dxn = l.x / len, dyn = l.y / len;   // 中心から接触点への向き
    var px = -dyn, py = dxn;                // 接触面に沿った向き
    var pts = body.wobOutline, i, s;

    // 相手の幅（接触面に沿った区間）。接触点は相手の角なので、区間は左右非対称になる
    var sMin = -Infinity, sMax = Infinity, cx = l.x, cy = l.y;
    if (other && other.vertices && P.cushion) {
      sMin = Infinity; sMax = -Infinity;
      for (i = 0; i < other.vertices.length; i++) {
        var v = toLocal(body, other.vertices[i]);
        s = (v.x - l.x) * px + (v.y - l.y) * py;
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
      }
      var mid = (sMin + sMax) / 2;          // へこみの中心は相手の中心に置く（角ではなく）
      cx = l.x + px * mid; cy = l.y + py * mid;
    }
    var rimW = P.cushionWidth || 16;

    for (i = 0; i < pts.length; i++) {
      var facing = pts[i].nx * dxn + pts[i].ny * dyn;      // 1 = 接触面のど真ん中
      if (facing <= 0.35) continue;
      s = (pts[i].x - l.x) * px + (pts[i].y - l.y) * py;
      if (s >= sMin && s <= sMax) {
        // 相手の真下: 平らに押し込む
        var d = Math.hypot(pts[i].x - cx, pts[i].y - cy);
        body.wobTarget[i] -= amount * facing * facing / (1 + d * d * P.falloff);
      } else {
        // 相手の幅のすぐ外側: 押し出された分が縁として盛り上がる（外へ行くほど低く）
        var out = s < sMin ? sMin - s : s - sMax;
        if (out < rimW) body.wobTarget[i] += amount * P.cushion * facing * facing * (1 - out / rimW);
      }
    }
  }

  window.Jelly = Jelly;
})();
