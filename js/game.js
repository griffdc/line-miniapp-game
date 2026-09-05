/**
 * ぷるぷるゼリータワー — ステップ1: 物理と積載の検証
 *
 * この段階の目的は「塔が安定して積めるか」を確かめること。
 * 見た目は角丸の矩形のみで、ぷるぷる変形はまだ入れていない（ステップ2）。
 *
 * 設計方針:
 *   物理は剛体で解く。ぷるぷるは後段の描画レイヤーで作る。
 *   ソフトボディで積むと接触が柔らかすぎて塔が安定せず、
 *   「くずれたら終了」の判定も曖昧になるため。
 */
(function () {
  'use strict';

  var CONFIG = window.APP_CONFIG.game;

  // Matter.js のエイリアス。defer 順で matter.min.js は読み込み済み。
  var Engine = Matter.Engine;
  var Composite = Matter.Composite;
  var Bodies = Matter.Bodies;
  var Events = Matter.Events;
  var Body = Matter.Body;
  var Sleeping = Matter.Sleeping;

  /** 物理は固定タイムステップで回す。可変dtだと接触が不安定になる。 */
  var FIXED_STEP = 1000 / 60;
  var MAX_STEPS_PER_FRAME = 5; // タブ復帰時のスパイラルを防ぐ

  var Game = {
    canvas: null,
    ctx: null,
    engine: null,
    ground: null,

    rafId: 0,
    lastTime: 0,
    accumulator: 0,
    state: 'idle', // 'idle' | 'playing' | 'over'

    round: 0,
    score: 0,
    best: 0,

    /** ワールド座標。地面の上面を y = 0 とし、上方向が負。 */
    camera: { y: 0, target: 0 },

    jellies: [],
    dropper: { x: 0, type: null, nextType: null, ready: false },

    debug: { on: false, fps: 0, stepMs: 0, drawMs: 0, frames: 0, fpsAt: 0 },

    session: { userId: null, isInClient: false },

    // ------------------------------------------------------------------
    // 起動
    // ------------------------------------------------------------------
    init: function (session) {
      this.session = session;
      this.canvas = document.getElementById('game-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.debug.on = /[?&]debug=1\b/.test(location.search);
      if (this.debug.on) document.getElementById('debug').hidden = false;

      this.best = this.loadBest();
      this.boundLoop = this.loop.bind(this); // 毎フレーム bind し直さない
      this.loadBackground();

      // 計測 → ワールド構築 → 描画 の順を守る。
      // resize() が draw() を呼ぶので、ワールドより先に走らせてはいけない。
      this.measure();
      this.buildWorld();

      var onResize = this.resize.bind(this);
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);

      // バックグラウンドに回ったら必ず止める。
      // 止めないと、見えていないゲームが CPU と広告インプレッションを浪費する。
      // 復帰時は自分でループを回し直す必要がある（放置すると固まったままになる）。
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          Game.pause();
        } else if (!Game.rafId) {
          Game.lastTime = performance.now();
          Game.accumulator = 0; // 溜まった時間を捨てる。まとめて進めると塔が壊れる
          Game.rafId = requestAnimationFrame(Game.boundLoop);
        }
      });

      this.bindInput();
      this.draw();
      this.tickDebug(performance.now());
    },

    /** DPR を考慮してキャンバスの実解像度を合わせる。描画はしない。 */
    measure: function () {
      if (!this.canvas) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2); // 2倍で頭打ち（描画コスト対策）
      var rect = this.canvas.getBoundingClientRect();
      this.viewW = rect.width;
      this.viewH = rect.height;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.computeBackground();

      // 地面が画面下寄りに来るようカメラの初期位置を決める
      this.camera.base = CONFIG.groundScreenMargin - this.viewH;
      if (this.state === 'idle') {
        this.camera.y = this.camera.base;
        this.camera.target = this.camera.base;
      }
    },

    resize: function () {
      this.measure();
      this.draw();
    },

    loadBackground: function () {
      var self = this;
      this.bgImage = new Image();
      this.bgImage.onload = function () { self.draw(); };
      this.bgImage.src = CONFIG.background.src;
    },

    /**
     * 背景を「皿の上面 = world y 0」に合わせて配置する。
     * 画像の実寸は config に持たせてあるので、読み込み完了を待たずに決まる。
     */
    computeBackground: function () {
      var B = CONFIG.background;
      var h = B.height * (this.viewW / B.width); // 横幅にぴったり合わせる
      this.bg = {
        w: this.viewW,
        h: h,
        top: -h * B.groundY // 画像上端の world y
      };
    },

    // ------------------------------------------------------------------
    // ワールド
    // ------------------------------------------------------------------
    buildWorld: function () {
      this.engine = Engine.create({ enableSleeping: true });

      // 静止接触を安定させるために反復回数を上げる。
      // 既定値（6/4/2）のままだと塔が10段を超えたあたりで微振動が蓄積する。
      this.engine.positionIterations = 10;
      this.engine.velocityIterations = 8;
      this.engine.constraintIterations = 4;
      this.engine.gravity.y = CONFIG.gravity;

      var self = this;
      Events.on(this.engine, 'collisionStart', function (ev) {
        var graph = self.contactGraph(); // 1イベントにつき1回だけ組み立てる
        for (var i = 0; i < ev.pairs.length; i++) {
          var p = ev.pairs[i];

          // 何かに接触した時点で「着地した」とみなす。
          // 落下中のゼリーを塔の高さに含めると、落とした瞬間にカメラが飛ぶ。
          // 速度で判定してはいけない（落とした直後は速度0なので即座に着地扱いになる）。
          if (p.bodyA.label === 'jelly') p.bodyA.landed = true;
          if (p.bodyB.label === 'jelly') p.bodyB.landed = true;

          self.applyWobble(p, graph);
        }
      });

      this.resetWorld();
    },

    resetWorld: function () {
      Composite.clear(this.engine.world, false);
      this.jellies = [];

      // 土台。壁は置かない。落ちたら終了、が唯一の失敗条件。
      // 幅は背景画像の皿に合わせる。ズレると「皿の上なのに落ちる」ことになる。
      var w = this.viewW * CONFIG.background.plateWidth;
      this.platformHalfW = w / 2;
      this.ground = Bodies.rectangle(0, CONFIG.platformThickness / 2, w, CONFIG.platformThickness, {
        isStatic: true,
        friction: 1,
        frictionStatic: 1,
        label: 'ground'
      });
      Composite.add(this.engine.world, this.ground);
    },

    // ------------------------------------------------------------------
    // 進行
    // ------------------------------------------------------------------
    start: function () {
      this.resetWorld();
      this.state = 'playing';
      this.score = 0;
      this.camera.y = this.camera.base;
      this.camera.target = this.camera.base;
      this.accumulator = 0;

      this.dropper.x = 0;
      this.dropper.type = this.pickType();
      this.dropper.nextType = this.pickType();
      this.dropper.ready = true;
      this.renderNextSwatch();

      document.getElementById('title').classList.add('title--hidden');
      document.getElementById('hud-hint').hidden = false;
      this.setScore(0);

      this.lastTime = performance.now();
      if (!this.rafId) this.rafId = requestAnimationFrame(this.boundLoop);
    },

    pause: function () {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    },

    loop: function (now) {
      this.rafId = requestAnimationFrame(this.boundLoop);

      var frameMs = Math.min(now - this.lastTime, FIXED_STEP * MAX_STEPS_PER_FRAME);
      this.lastTime = now;

      if (this.state === 'playing') {
        var t0 = performance.now();
        this.accumulator += frameMs;
        var steps = 0;
        while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
          Engine.update(this.engine, FIXED_STEP);
          Jelly.step(this.jellies); // 変形も物理と同じ固定ステップで進める
          this.accumulator -= FIXED_STEP;
          steps++;
        }
        this.debug.stepMs = performance.now() - t0;

        this.updateCamera();
        this.updateScore();
        this.checkCollapse();
      }

      var d0 = performance.now();
      this.draw();
      this.debug.drawMs = performance.now() - d0;
      this.tickDebug(now);
    },

    /**
     * 現在すれ違っているゼリー同士の隣接関係を作る。
     *
     * ゼリー同士の接触だけを辺にする。地面を経由させないことが重要で、
     * 経由させると「地面に乗っているだけの離れたゼリー」まで繋がってしまう。
     */
    contactGraph: function () {
      var g = {};
      var list = this.engine.pairs.list;
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p.isActive) continue;
        var a = p.bodyA, b = p.bodyB;
        if (a.label !== 'jelly' || b.label !== 'jelly') continue;
        (g[a.id] || (g[a.id] = [])).push(b);
        (g[b.id] || (g[b.id] = [])).push(a);
      }
      return g;
    },

    /**
     * 衝突を、ぷるぷる変形と塔の揺れに変換する。
     *
     * 伝わる先は「接触をたどって繋がっているゼリー」だけ。
     * 距離で判定してはいけない。触れていない離れたゼリーまで動いてしまい、
     * 左端に置いた1つめが、右端に落とした2つめのせいで転げ落ちる。
     */
    applyWobble: function (pair, graph) {
      var supports = pair.collision && pair.collision.supports;
      if (!supports || !supports.length) return;

      var point = supports[0];
      var va = pair.bodyA.velocity, vb = pair.bodyB.velocity;
      var strength = Math.hypot(va.x - vb.x, va.y - vb.y);
      if (strength < 0.2) return; // 静かな接触では揺らさない

      var W = CONFIG.wobble;
      var S = CONFIG.shake;

      // 衝突した当事者
      var queue = [];
      var hops = {};
      if (pair.bodyA.label === 'jelly') {
        Jelly.impact(pair.bodyA, point, strength);
        hops[pair.bodyA.id] = 0; queue.push(pair.bodyA);
      }
      if (pair.bodyB.label === 'jelly') {
        Jelly.impact(pair.bodyB, point, strength);
        hops[pair.bodyB.id] = 0; queue.push(pair.bodyB);
      }

      // 接触をたどって、1つ離れるごとに弱めながら伝える
      var shakeOn = S.scale > 0 && strength >= S.minStrength;
      for (var head = 0; head < queue.length; head++) {
        var cur = queue[head];
        var hop = hops[cur.id];
        if (hop >= S.maxHops) continue;

        var ns = graph[cur.id];
        if (!ns) continue;

        for (var i = 0; i < ns.length; i++) {
          var nb = ns[i];
          if (hops[nb.id] !== undefined) continue;
          hops[nb.id] = hop + 1;
          queue.push(nb);

          var fade = Math.pow(S.hopDecay, hop + 1);
          Jelly.impact(nb, point, strength * fade * W.neighborScale);

          // 塔を実際に揺らすのは、接触点より上にあるものだけ
          if (shakeOn && nb.position.y < point.y) {
            var dir = nb.position.x >= point.x ? 1 : -1;
            Sleeping.set(nb, false);
            Body.setVelocity(nb, {
              x: nb.velocity.x + dir * strength * S.scale * fade,
              y: nb.velocity.y
            });
          }
        }
      }
    },

    // ------------------------------------------------------------------
    // 落とす
    // ------------------------------------------------------------------
    pickType: function () {
      var types = CONFIG.jellyTypes;
      return types[Math.floor(Math.random() * types.length)];
    },

    /** ドロッパーは画面上部に固定。ワールド座標に変換して生成する。 */
    dropperWorldY: function () {
      return this.camera.y + CONFIG.dropperScreenY;
    },

    drop: function () {
      if (this.state !== 'playing' || !this.dropper.ready) return;

      var type = this.dropper.type;
      var r = Math.min(type.w, type.h) * CONFIG.chamferRatio;

      var body = Bodies.rectangle(this.dropper.x, this.dropperWorldY(), type.w, type.h, {
        chamfer: { radius: r },       // 丸めすぎると接触が点になり転がる。0.12前後が上限
        friction: CONFIG.friction,
        frictionStatic: CONFIG.frictionStatic,
        frictionAir: CONFIG.frictionAir, // 着地後の微振動を減衰させる
        restitution: CONFIG.restitution,  // 跳ねさせない。弾みは見た目で作る
        density: CONFIG.density,
        label: 'jelly'
      });
      body.jellyType = type;
      Jelly.attach(body); // 変形の状態を持たせる

      Composite.add(this.engine.world, body);
      this.jellies.push(body);

      this.dropper.ready = false;
      this.dropper.type = this.dropper.nextType;
      this.dropper.nextType = this.pickType();
      this.renderNextSwatch();

      var self = this;
      window.setTimeout(function () {
        if (self.state === 'playing') self.dropper.ready = true;
      }, CONFIG.dropCooldownMs);

      document.getElementById('hud-hint').hidden = true;
    },

    // ------------------------------------------------------------------
    // カメラ・スコア・崩壊判定
    // ------------------------------------------------------------------
    /**
     * 塔の高さ。着地済みのゼリーだけで測る。
     * 落下中のものを含めると、落とした瞬間にカメラとスコアが跳ね上がる。
     */
    towerTopY: function () {
      var top = 0;
      for (var i = 0; i < this.jellies.length; i++) {
        var b = this.jellies[i];
        if (!b.landed) continue;
        if (b.bounds.min.y < top) top = b.bounds.min.y;
      }
      return top;
    },

    updateCamera: function () {
      var top = this.towerTopY();
      var target = Math.min(this.camera.base, top - this.viewH * CONFIG.cameraHeadroom);
      this.camera.target = target;
      // 追従は緩やかに。急に動くと積む位置を見失う
      this.camera.y += (this.camera.target - this.camera.y) * CONFIG.cameraLerp;
    },

    updateScore: function () {
      var h = Math.max(0, Math.round(-this.towerTopY() / CONFIG.pxPerCm));
      if (h !== this.score) this.setScore(h);
    },

    /**
     * 失敗条件は「地面より十分下に落ちた」の一つだけ。
     * 傾きや揺れを条件にすると誤検知して理不尽になる。
     * 大きく傾いても持ち直せる余地を残すほうが体験が良い。
     */
    checkCollapse: function () {
      for (var i = 0; i < this.jellies.length; i++) {
        if (this.jellies[i].position.y > CONFIG.fallLimitY) {
          this.gameOver();
          return;
        }
      }
    },

    gameOver: function () {
      if (this.state !== 'playing') return;
      this.state = 'over';
      this.round += 1;

      if (this.score > this.best) {
        this.best = this.score;
        this.saveBest(this.best);
      }

      // 広告はここでは出さない。まずスコアを見せる。
      // 結果を見る前に広告を挟むと、何点だったのか分からないまま待たされる。
      this.showResult();
    },

    /**
     * リトライ時の広告。ここが広告との唯一の接点。
     * プレイ中に差し込むと体験を壊すので、必ずラウンドの切れ目に出す。
     *
     * @returns {Promise<void>} 広告が閉じられたら解決する
     */
    showRetryAd: function () {
      var every = window.APP_CONFIG.ads.interstitialEveryRounds;
      var shouldShow = every > 0 && this.round % every === 0;

      var next = shouldShow ? window.Ads.showInterstitial() : Promise.resolve();
      return next.then(function () {
        window.Ads.render('banner'); // 次のラウンドに向けて差し替え
      });
    },

    showResult: function () {
      document.getElementById('result-score').textContent = String(this.score);
      document.getElementById('result-best').textContent =
        this.best > 0 ? 'ベスト ' + this.best + 'cm' : '';
      document.getElementById('result').classList.remove('overlay--hidden');
      if (window.AppSession && window.AppSession.env.canShare) {
        document.getElementById('btn-share').hidden = false;
      }
    },

    // ------------------------------------------------------------------
    // 描画（ステップ1: 角丸矩形のみ。ぷるぷるはステップ2）
    // ------------------------------------------------------------------
    draw: function () {
      var ctx = this.ctx;
      if (!ctx) return;

      // 画像より上（塔が伸びたとき）に見える空
      ctx.fillStyle = CONFIG.background.skyColor;
      ctx.fillRect(0, 0, this.viewW, this.viewH);

      ctx.save();
      // ワールド原点を画面中央下に置く
      ctx.translate(this.viewW / 2, -this.camera.y);

      this.drawBackground(ctx);

      // 皿が地面の見た目そのものなので、通常は物理の台を描かない
      if (this.debug.on && this.ground) this.drawGround(ctx);
      for (var i = 0; i < this.jellies.length; i++) {
        this.drawBody(ctx, this.jellies[i]);
      }
      if (this.state === 'playing') this.drawDropper(ctx);

      ctx.restore();
    },

    drawBackground: function (ctx) {
      var bg = this.bg;
      if (!bg) return;

      // 画像より下（皿の脚より下）を塗る。空のままだと下が青く抜ける。
      ctx.fillStyle = CONFIG.background.floorColor;
      ctx.fillRect(-bg.w / 2, bg.top + bg.h - 1, bg.w, 1200);

      if (this.bgImage && this.bgImage.complete && this.bgImage.naturalWidth) {
        ctx.drawImage(this.bgImage, -bg.w / 2, bg.top, bg.w, bg.h);
      }
    },

    drawGround: function (ctx) {
      var g = this.ground;
      ctx.fillStyle = CONFIG.groundColor;
      this.pathVertices(ctx, g.vertices);
      ctx.fill();
    },

    drawBody: function (ctx, body) {
      Jelly.draw(ctx, body);

      // デバッグ時は物理形状（角ばった実体）を重ねて、見た目とのズレを確認できる
      if (this.debug.on) {
        ctx.strokeStyle = body.isSleeping ? 'rgba(0,255,180,.8)' : 'rgba(255,255,255,.28)';
        ctx.lineWidth = 1;
        this.pathVertices(ctx, body.vertices);
        ctx.stroke();
      }
    },

    /** 落下位置のガイド。指の位置と落下点を一致させる */
    drawDropper: function (ctx) {
      var y = this.dropperWorldY();
      var type = this.dropper.type;

      ctx.globalAlpha = this.dropper.ready ? 0.9 : 0.25;
      ctx.fillStyle = type.color;
      this.roundRect(ctx, this.dropper.x - type.w / 2, y - type.h / 2, type.w, type.h,
        Math.min(type.w, type.h) * CONFIG.chamferRatio);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(this.dropper.x, y + type.h / 2);
      ctx.lineTo(this.dropper.x, this.camera.y + this.viewH);
      ctx.stroke();
      ctx.setLineDash([]);
    },

    pathVertices: function (ctx, vs) {
      ctx.beginPath();
      ctx.moveTo(vs[0].x, vs[0].y);
      for (var i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y);
      ctx.closePath();
    },

    roundRect: function (ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },

    // ------------------------------------------------------------------
    // 入力（片手・横方向のみ。回転操作は持たせない）
    // ------------------------------------------------------------------
    bindInput: function () {
      var self = this;
      var el = this.canvas;
      var pointing = false;

      function toWorldX(clientX) {
        var rect = el.getBoundingClientRect();
        var x = clientX - rect.left - rect.width / 2;
        var limit = rect.width / 2 - CONFIG.dropperEdgeMargin;
        return Math.max(-limit, Math.min(limit, x));
      }

      el.addEventListener('pointerdown', function (e) {
        if (self.state !== 'playing') return;
        pointing = true;
        el.setPointerCapture(e.pointerId);
        self.dropper.x = toWorldX(e.clientX);
      });

      el.addEventListener('pointermove', function (e) {
        if (!pointing || self.state !== 'playing') return;
        self.dropper.x = toWorldX(e.clientX);
      });

      function release() {
        if (!pointing) return;
        pointing = false;
        self.drop();
      }
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', function () { pointing = false; });

      var retry = document.getElementById('result-retry');
      retry.addEventListener('click', function () {
        if (retry.disabled) return;
        retry.disabled = true; // 広告を出している間の二重タップを防ぐ

        document.getElementById('result').classList.add('overlay--hidden');
        self.showRetryAd().then(function () {
          retry.disabled = false;
          self.start();
        });
      });
    },

    // ------------------------------------------------------------------
    // 表示まわり
    // ------------------------------------------------------------------
    setScore: function (value) {
      this.score = value;
      var el = document.getElementById('hud-score');
      if (el) el.textContent = String(value);
    },

    renderNextSwatch: function () {
      var el = document.getElementById('hud-next');
      if (el && this.dropper.nextType) el.style.background = this.dropper.nextType.color;
    },

    loadBest: function () {
      try {
        return parseInt(localStorage.getItem(window.APP_CONFIG.storagePrefix + 'best') || '0', 10) || 0;
      } catch (e) { return 0; }
    },

    saveBest: function (v) {
      try { localStorage.setItem(window.APP_CONFIG.storagePrefix + 'best', String(v)); } catch (e) { /* 非対応環境は諦める */ }
    },

    /** 積載の安定性を数値で確認するための計器。?debug=1 で表示 */
    tickDebug: function (now) {
      if (!this.debug.on) return;
      this.debug.frames++;
      if (now - this.debug.fpsAt >= 500) {
        this.debug.fps = Math.round(this.debug.frames * 1000 / (now - this.debug.fpsAt));
        this.debug.frames = 0;
        this.debug.fpsAt = now;
      }

      var sleeping = 0;
      for (var i = 0; i < this.jellies.length; i++) if (this.jellies[i].isSleeping) sleeping++;

      document.getElementById('debug').textContent =
        'view     ' + Math.round(this.viewW) + ' x ' + Math.round(this.viewH) + '\n' +
        'dpr      ' + (window.devicePixelRatio || 1) + '\n' +
        'canvas   ' + this.canvas.width + ' x ' + this.canvas.height + '\n' +
        'platform ' + Math.round(this.platformHalfW * 2) + '\n' +
        'fps      ' + this.debug.fps + '\n' +
        'physics  ' + this.debug.stepMs.toFixed(2) + 'ms\n' +
        'draw     ' + this.debug.drawMs.toFixed(2) + 'ms\n' +
        'bodies   ' + this.jellies.length + '\n' +
        'sleeping ' + sleeping + ' / ' + this.jellies.length + '\n' +
        'height   ' + this.score + 'cm\n' +
        'camera   ' + Math.round(this.camera.y);
    }
  };

  window.Game = Game;
})();
