/**
 * ぷるぷる変形の描画レイヤー。
 *
 * 物理には一切干渉しない。剛体が持つ位置・角度・衝突イベントを受け取り、
 * 輪郭を変形させて「柔らかさ」だけを演出する。
 *
 * なぜ分けるか:
 *   物理をソフトボディにすると接触が柔らかすぎて塔が安定せず、
 *   「くずれたら終了」の判定も曖昧になる。
 *   プレイヤーが感じる気持ちよさは描画から来ていて、物理の正確さからは来ていない。
 *
 * 描画用の輪郭は物理形状より角を丸めてある。
 * 物理を丸めると接触が点になって転がり、塔が崩れるため
 * （chamferRatio 0.34 で実際に破綻することを実測済み）。
 */
(function () {
  'use strict';

  var W = window.APP_CONFIG.game.wobble;

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

  /** #rrggbb を明暗に振った色を作る。ゼリーの照りと厚みに使う。 */
  function shade(hex, amount) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var t = amount > 0 ? 255 : 0;
    var p = Math.abs(amount);
    return 'rgb(' + Math.round(r + (t - r) * p) + ',' +
                    Math.round(g + (t - g) * p) + ',' +
                    Math.round(b + (t - b) * p) + ')';
  }

  /** 種類ごとに配色を一度だけ計算しておく */
  function paletteFor(type) {
    if (!type._pal) {
      type._pal = {
        top: shade(type.color, 0.30),   // 上面。光が当たる
        mid: type.color,
        bottom: shade(type.color, -0.28) // 底面。厚みの影
      };
    }
    return type._pal;
  }

  var Jelly = {
    /** ゼリー1個に変形の状態を持たせる */
    attach: function (body) {
      var n = W.points;
      var t = body.jellyType;
      body.wobOutline = outlineFor(t);
      body.wobOff = new Float32Array(n); // 法線方向の変位。負=へこむ
      body.wobVel = new Float32Array(n);

      // へこみの上限はサイズ比で決める。
      // 絶対値で固定すると、小さいゼリーだけ相対的に大きく凹んで
      // 涙型や三日月型に崩れてしまう。
      body.wobMax = Math.min(t.w, t.h) * W.maxOffsetRatio;
    },

    /**
     * 衝突による変形を注入する。
     * 接触点に近い輪郭ほど大きくへこませる。
     *
     * @param {object} body     変形させる剛体
     * @param {{x,y}} worldPoint 接触点（ワールド座標）
     * @param {number} strength  衝突の強さ
     */
    impact: function (body, worldPoint, strength) {
      if (!body.wobOff) return;

      // 接触点をボディのローカル座標へ移す
      var dx = worldPoint.x - body.position.x;
      var dy = worldPoint.y - body.position.y;
      var cos = Math.cos(-body.angle), sin = Math.sin(-body.angle);
      var lx = dx * cos - dy * sin;
      var ly = dx * sin + dy * cos;

      var amount = Math.min(strength * W.impactScale, body.wobMax);
      var pts = body.wobOutline;

      for (var i = 0; i < pts.length; i++) {
        var d = Math.hypot(pts[i].x - lx, pts[i].y - ly);
        var falloff = 1 / (1 + d * d * W.falloff);
        body.wobVel[i] -= amount * falloff;
      }
    },

    /**
     * バネで復元させる。物理と同じ固定ステップで呼ぶこと。
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
        var off = bodies[b].wobOff, vel = bodies[b].wobVel;
        if (!off) continue;

        snap.set(off);

        for (var i = 0; i < n; i++) {
          var laplacian = (snap[(i - 1 + n) % n] + snap[(i + 1) % n]) * 0.5 - snap[i];

          vel[i] += -W.stiffness * snap[i] + W.spread * laplacian;
          vel[i] *= W.damping;
          off[i] += vel[i];

          // 保険。数値が暴れても形が破綻しないようにする
          var lim = bodies[b].wobMax;
          if (off[i] > lim) off[i] = lim;
          else if (off[i] < -lim) off[i] = -lim;
        }
      }
    },

    /**
     * 変形した輪郭を滑らかな閉曲線として描く。
     *
     * ボディのローカル座標系に移してから描く。こうすると
     * グラデーションを種類ごとに一度作るだけで済む
     * （ワールド座標で描くと、位置が動くたびに作り直しになる）。
     */
    draw: function (ctx, body) {
      var pts = body.wobOutline;
      if (!pts) return;

      var n = pts.length;
      var type = body.jellyType;

      ctx.save();
      ctx.translate(body.position.x, body.position.y);

      // スカッシュ＆ストレッチ。
      // 進行方向に伸ばし、直交方向を縮める（体積が変わらないように見せる）。
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

      // 中点を通る二次曲線でつなぐと、頂点数が少なくても角が出ない
      ctx.beginPath();
      ctx.moveTo((vx[n - 1] + vx[0]) / 2, (vy[n - 1] + vy[0]) / 2);
      for (var j = 0; j < n; j++) {
        var k = (j + 1) % n;
        ctx.quadraticCurveTo(vx[j], vy[j], (vx[j] + vx[k]) / 2, (vy[j] + vy[k]) / 2);
      }
      ctx.closePath();

      ctx.fillStyle = this.gradientFor(ctx, type);
      ctx.fill();

      // 縁の光。ゼリーらしい透明感はここで出る
      ctx.strokeStyle = 'rgba(255,255,255,.30)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();
    },

    /** 上から下への明暗。種類ごとに一度だけ作って使い回す。 */
    gradientFor: function (ctx, type) {
      if (!type._grad) {
        var pal = paletteFor(type);
        var half = type.h * 0.5 * W.renderScale;
        var g = ctx.createLinearGradient(0, -half, 0, half);
        g.addColorStop(0, pal.top);
        g.addColorStop(0.55, pal.mid);
        g.addColorStop(1, pal.bottom);
        type._grad = g;
      }
      return type._grad;
    }
  };

  window.Jelly = Jelly;
})();
