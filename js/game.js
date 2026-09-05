/**
 * ゲーム本体のスケルトン。
 * ここには「ゲームの中身」ではなく、ライフサイクルと広告との接点だけを置く。
 * 実装時は update() / draw() の中だけを書き換えれば済むようにしてある。
 */
(function () {
  'use strict';

  var Game = {
    canvas: null,
    ctx: null,
    rafId: 0,
    lastTime: 0,
    running: false,
    round: 0,
    score: 0,

    /** @type {{userId: string|null, isInClient: boolean}} */
    session: { userId: null, isInClient: false },

    init: function (session) {
      this.session = session;
      this.canvas = document.getElementById('game-canvas');
      this.ctx = this.canvas.getContext('2d');

      this.resize();
      window.addEventListener('resize', this.resize.bind(this));
      window.addEventListener('orientationchange', this.resize.bind(this));

      // バックグラウンドに回ったら必ず止める。
      // 止めないと、見えていないゲームが CPU と広告インプレッションを浪費する。
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) Game.pause();
      });

      this.draw();
    },

    /** DPR を考慮してキャンバスの実解像度を合わせる */
    resize: function () {
      if (!this.canvas) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2); // 2倍で頭打ち（描画コスト対策）
      var rect = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    },

    start: function () {
      if (this.running) return;
      this.running = true;
      this.score = 0;
      this.lastTime = performance.now();
      this.loop(this.lastTime);
    },

    pause: function () {
      this.running = false;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    },

    loop: function (now) {
      if (!this.running) return;
      var dt = Math.min((now - this.lastTime) / 1000, 0.1); // タブ復帰時の巨大 dt を抑制
      this.lastTime = now;

      this.update(dt);
      this.draw();

      this.rafId = requestAnimationFrame(this.loop.bind(this));
    },

    /** TODO: ゲームロジック */
    update: function (dt) {
      void dt;
    },

    /** TODO: 描画 */
    draw: function () {
      if (!this.ctx) return;
      var w = this.canvas.clientWidth;
      var h = this.canvas.clientHeight;
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.fillStyle = '#98a2b3';
      this.ctx.font = '14px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('ゲーム描画領域', w / 2, h / 2);
    },

    /**
     * 1ラウンド終了時。ここが広告との唯一の接点。
     * 一定ラウンドごとにインタースティシャルを挟み、閉じられたら次に進む。
     */
    endRound: function () {
      this.pause();
      this.round += 1;

      var every = window.APP_CONFIG.ads.interstitialEveryRounds;
      var shouldShow = every > 0 && this.round % every === 0;

      var next = shouldShow ? window.Ads.showInterstitial() : Promise.resolve();
      return next.then(function () {
        // バナーは新しいラウンドの開始時に差し替える
        window.Ads.render('banner');
      });
    },

    setScore: function (value) {
      this.score = value;
      var el = document.getElementById('hud-score');
      if (el) el.textContent = String(value);
    }
  };

  window.Game = Game;
})();
