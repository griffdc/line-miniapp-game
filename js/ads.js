/**
 * 広告スロット管理。
 *
 * 前提:
 *  - LINEミニアプリで掲載できるのは「LINEヤフー広告ネットワーク
 *    ディスプレイ広告（Web）」のみ。他のアドネットワークは使えない。
 *  - 広告タグはネットワークパートナー契約 + サイト審査の通過後に発行される。
 *    そのため、このモジュールはタグ未発行でも動くように作ってある。
 *
 * 設計方針:
 *  - 枠の高さは CSS で先に予約する（CLS を出さない）
 *  - 広告スクリプトは初回描画の後に読み込む（Lighthouse Performance 50以上を守る）
 *  - 読み込み失敗・ブロックされた場合も、ゲーム本体は必ず動く
 */
(function () {
  'use strict';

  var config = window.APP_CONFIG.ads;

  /** 広告タグの読み込みは1度だけ */
  var tagPromise = null;

  function loadTag() {
    if (tagPromise) return tagPromise;

    tagPromise = new Promise(function (resolve, reject) {
      if (!config.tagSrc) {
        reject(new Error('ad tag is not configured'));
        return;
      }
      var s = document.createElement('script');
      s.src = config.tagSrc;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('ad tag failed to load')); };
      document.head.appendChild(s);
    });

    return tagPromise;
  }

  /**
   * 初回描画を邪魔しないタイミングまで待つ。
   * requestIdleCallback があればそれを使い、無ければタイマーで代替する。
   */
  function whenIdle(delayMs) {
    return new Promise(function (resolve) {
      var fire = function () {
        if (window.requestIdleCallback) {
          window.requestIdleCallback(resolve, { timeout: 2000 });
        } else {
          resolve();
        }
      };
      window.setTimeout(fire, delayMs);
    });
  }

  var Ads = {
    /** @type {Record<string, HTMLElement>} */
    slots: {},

    /** 起動時に1度だけ呼ぶ。DOM 上のスロットを集めて広告タグの読み込みを予約する。 */
    init: function () {
      var nodes = document.querySelectorAll('[data-ad-slot]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        this.slots[el.dataset.adSlot] = el;
        el.dataset.adState = 'idle';
      }

      var self = this;
      whenIdle(config.loadDelayMs)
        .then(loadTag)
        .then(function () {
          self.render('banner');
        })
        .catch(function (err) {
          self.markAll('blocked');
          if (window.console) console.info('[ads]', err.message);
        });
    },

    /**
     * 指定スロットに広告を描画する。
     *
     * TODO: 発行された広告タグの仕様に合わせて中身を差し替える。
     *   多くのネットワークタグは
     *     - スロット要素に所定の id / data 属性を付ける
     *     - グローバル関数（例: window.YjAdsDisplay(...)）を呼ぶ
     *   のいずれか。ここはその呼び出し1行を置く場所として空けてある。
     */
    render: function (name) {
      var el = this.slots[name];
      if (!el) return;

      if (!config.tagSrc) {
        el.dataset.adState = 'blocked';
        return;
      }

      try {
        // ---- ここに発行された広告タグの表示処理を書く ----
        // 例: window.YjAdsDisplay && window.YjAdsDisplay(el.id);
        // -------------------------------------------------
        el.dataset.adState = 'filled';
      } catch (e) {
        el.dataset.adState = 'failed';
      }
    },

    /**
     * ラウンド間のインタースティシャル表示。
     * 表示中はゲームを止める前提で、閉じられたら resolve する。
     * @returns {Promise<void>}
     */
    showInterstitial: function () {
      var overlay = document.getElementById('ad-interstitial');
      var closeBtn = document.getElementById('ad-interstitial-close');
      var slot = this.slots['interstitial'];

      // タグ未設定・読み込み失敗時は出さずに即座に進める
      if (!config.tagSrc || !overlay || !slot) return Promise.resolve();

      this.render('interstitial');
      if (slot.dataset.adState !== 'filled') return Promise.resolve();

      overlay.classList.remove('overlay--hidden');
      closeBtn.disabled = true;

      // ユーザーを閉じ込めないよう、最短表示時間の後に必ず閉じられるようにする
      window.setTimeout(function () {
        closeBtn.disabled = false;
      }, config.interstitialMinVisibleMs);

      return new Promise(function (resolve) {
        var onClose = function () {
          closeBtn.removeEventListener('click', onClose);
          overlay.classList.add('overlay--hidden');
          resolve();
        };
        closeBtn.addEventListener('click', onClose);
      });
    },

    markAll: function (state) {
      for (var name in this.slots) {
        if (Object.prototype.hasOwnProperty.call(this.slots, name)) {
          this.slots[name].dataset.adState = state;
        }
      }
    }
  };

  window.Ads = Ads;
})();
