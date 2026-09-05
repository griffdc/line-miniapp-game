/**
 * LIFF の初期化と実行環境の判定。
 * 最後に読み込まれ、初期化が終わったら Ads と Game を起動する。
 */
(function () {
  'use strict';

  var config = window.APP_CONFIG;

  var els = {
    boot: document.getElementById('boot'),
    error: document.getElementById('error'),
    errorMessage: document.getElementById('error-message'),
    errorRetry: document.getElementById('error-retry'),
    noticeExternal: document.getElementById('notice-external'),
    app: document.getElementById('app'),
    btnStart: document.getElementById('btn-start'),
    btnShare: document.getElementById('btn-share')
  };

  /** 実行環境と、そこで使える機能の一覧 */
  var env = {
    isInClient: false,   // LINEアプリ内（LIFFブラウザ）か
    isLoggedIn: false,
    os: 'web',           // 'ios' | 'android' | 'web'
    canShare: false,     // シェアターゲットピッカーが使えるか
    canSendMessages: false,
    canUseIap: false,    // アプリ内課金。外部ブラウザでは常に false
    userId: null
  };

  function showError(message) {
    els.boot.classList.add('overlay--hidden');
    els.errorMessage.textContent = message;
    els.error.classList.remove('overlay--hidden');
  }

  /**
   * 実行環境を確定する。
   * 外部ブラウザ（2025年10月1日以降、LINE未使用ユーザーも含めて到達しうる）では
   * sendMessages / openWindow / closeWindow / scanCode / iap が動かない。
   */
  function detectEnv() {
    env.isInClient = liff.isInClient();
    env.isLoggedIn = liff.isLoggedIn();
    env.os = liff.getOS();
    env.canShare = liff.isApiAvailable('shareTargetPicker');
    env.canSendMessages = env.isInClient;
    env.canUseIap = env.isInClient && liff.isApiAvailable('iap');
    return env;
  }

  /**
   * ユーザー識別子の取得。
   *
   * openid スコープだけでは liff.getProfile() は呼べない（profile スコープが必要）。
   * ID トークンの sub がユーザーIDなので、同意画面を出さずに識別だけ済ませられる。
   * 表示名やアイコンが本当に要るようになった画面で、はじめて
   * liff.permission.requestAll() → liff.getProfile() を呼ぶこと。
   */
  function resolveUserId() {
    if (!env.isLoggedIn) return null;
    try {
      var idToken = liff.getDecodedIDToken();
      return idToken ? idToken.sub : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * ログインが必要になった時点で初めて呼ぶ。
   * 未ログインなら LINE の認証画面へ遷移する（そのまま戻ってこない）。
   * ログイン不要で遊べる部分を先に見せてから呼ぶこと。
   * @returns {boolean} すでにログイン済みなら true
   */
  function ensureLogin() {
    if (env.isLoggedIn) return true;
    liff.login({ redirectUri: location.href });
    return false;
  }

  /**
   * 表示名などが必要になった時点で呼ぶ。起動時には呼ばない。
   * @returns {Promise<object|null>}
   */
  function requestProfile() {
    if (!liff.permission) return Promise.resolve(null);
    if (!ensureLogin()) return Promise.resolve(null);

    return liff.permission.query('profile').then(function (status) {
      if (status.state === 'granted') return liff.getProfile();
      return liff.permission.requestAll().then(function () {
        return liff.getProfile();
      });
    }).catch(function () {
      return null;
    });
  }

  /**
   * 結果シェア。カスタムアクションボタンのレギュレーションに注意:
   *  - Flex Message の bubble コンテナのみ（carousel は不可）
   *  - ボタンは最大3つ、最低1つは詳細ページへ遷移させる
   *  - スタイルは最上部のみ primary、他は link。secondary は使用禁止
   *  - ボタンとフッター以外にアクションを設定しない
   */
  function shareResult(score) {
    if (!env.canShare) return Promise.resolve();

    var message = {
      type: 'flex',
      altText: 'スコア ' + score + ' 点でした',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: 'ゲーム結果', weight: 'bold', size: 'lg' },
            { type: 'text', text: score + ' 点', size: 'xl', margin: 'md' }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              action: {
                type: 'uri',
                label: 'あそんでみる',
                // TODO: パーマネントリンク（https://miniapp.line.me/{liffId}）に置き換える
                uri: location.origin + '/'
              }
            }
          ]
        }
      }
    };

    return liff.shareTargetPicker([message]).catch(function () { /* キャンセルは無視 */ });
  }

  function bindUi() {
    els.btnStart.addEventListener('click', function () {
      window.Game.start();
    });

    if (env.canShare) {
      els.btnShare.hidden = false;
      els.btnShare.addEventListener('click', function () {
        shareResult(window.Game.score);
      });
    }

    // LINEアプリ外では使えない機能があることを一度だけ知らせる
    if (!env.isInClient) {
      els.noticeExternal.classList.remove('notice--hidden');
      els.noticeExternal.querySelector('.notice__close').addEventListener('click', function () {
        els.noticeExternal.classList.add('notice--hidden');
      });
    }

    els.errorRetry.addEventListener('click', function () {
      location.reload();
    });
  }

  function boot() {
    if (!config.liffId) {
      showError('LIFF ID が設定されていません。js/config.js を確認してください。');
      return;
    }

    liff.init({
      liffId: config.liffId,
      withLoginOnExternalBrowser: config.loginOnExternalBrowser
    }).then(function () {
      detectEnv();
      env.userId = resolveUserId();

      els.boot.classList.add('overlay--hidden');
      els.app.hidden = false;

      bindUi();
      window.Ads.init();
      window.Game.init({ userId: env.userId, isInClient: env.isInClient });
    }).catch(function (err) {
      showError('起動に失敗しました。時間をおいて再度お試しください。');
      if (window.console) console.error('[liff.init]', err);
    });
  }

  // 外から使えるように公開しておく（プロフィールは必要になった画面で取得する）
  window.AppSession = {
    env: env,
    ensureLogin: ensureLogin,
    requestProfile: requestProfile,
    shareResult: shareResult
  };

  boot();
})();
